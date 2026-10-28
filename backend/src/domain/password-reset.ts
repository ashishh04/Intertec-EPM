import { createHash, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../email/outbox.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { listOf, message } from '../lib/i18n.js';
import { openProject } from '../openproject/client.js';
import { recordAuditQuietly } from './audit.js';
import { checkPassword, getPasswordPolicy, type PasswordPolicy } from './password-policy.js';

/**
 * Forgotten passwords (Module 1).
 *
 * Someone who cannot sign in asks for a link by login or email; the link,
 * emailed to the address on the account, lets them choose a new password once
 * within the hour. It works like an invitation: the token exists only in the
 * email, the database keeps a SHA-256 of it, and a newer link retires the
 * older one.
 *
 * Who may be reset is decided inside the instance (the admin add-on's
 * `password_status`), because EPM writes the password as its service account,
 * which is not an administrator (NFR06): an administrator who has signed in,
 * and EPM's own accounts, are never reset from an email. An administrator who
 * asks is emailed why, rather than left waiting for a link that never comes.
 */

/** How long a link works. Short: it opens the account, and it sits in an inbox. */
export const RESET_TTL_MINUTES = 60;

/** Links per account per hour, so the form cannot be used to flood an inbox. */
const LINKS_PER_HOUR = 3;

/** What a token looks like: base64url of 32 bytes. Anything else is not ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const hashResetToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The page the frontend serves for a reset link. */
const resetUrl = (token: string): string => `${env.APP_BASE_URL}/reset-password/${token}`;

interface ResetTarget {
  id: string;
  email: string;
  firstName: string;
  /** settable, administrator (signed in before: never by email) or unavailable. */
  status: 'settable' | 'administrator' | 'unavailable';
}

const upstreamStatus = (error: unknown) => (error instanceof OpenProjectError ? error.upstreamStatus : undefined);

/** The account a login or an email names, or null. */
async function targetFor(identifier: string): Promise<ResetTarget | null> {
  try {
    // A POST so the identifier travels in the body, not in a URL a log keeps.
    return await openProject.request<ResetTarget>('/epm_admin/users/password_reset_target', {
      method: 'POST',
      root: true,
      body: { identifier },
    });
  } catch (error) {
    if (upstreamStatus(error) === 404) return null;
    throw error;
  }
}

export type ResetRequestOutcome = 'sent' | 'refused' | 'throttled' | 'unknown' | 'not-queued';

/**
 * Handles one request. The person asking is told the same thing whatever
 * happens here (routes/password-reset.ts), so this decides quietly and only
 * the log records which way it went.
 */
export async function requestPasswordReset(identifier: string, requestedFrom: string | null): Promise<ResetRequestOutcome> {
  const target = await targetFor(identifier);
  if (!target?.email || target.status === 'unavailable') return 'unknown';

  if (target.status === 'administrator') {
    // No link: told why instead, at most once an hour (the outbox's
    // per-recipient key makes a second one in the same hour a no-op).
    const outcome = await enqueueEmail({
      recipientId: target.id,
      template: 'password-reset',
      payload: { firstName: target.firstName },
      channel: 'immediate',
      required: true,
      dedupeKey: `password-reset-refused:${new Date().toISOString().slice(0, 13)}`,
    });
    return outcome === 'queued' || outcome === 'duplicate' ? 'refused' : 'not-queued';
  }

  const since = new Date(Date.now() - 60 * 60_000);
  const recent = await prisma.passwordResetToken.count({ where: { openProjectId: target.id, createdAt: { gt: since } } });
  if (recent >= LINKS_PER_HOUR) return 'throttled';

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
  const retiredAt = new Date();
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { openProjectId: target.id, usedAt: null },
      data: { usedAt: retiredAt, replacedAt: retiredAt },
    }),
    prisma.passwordResetToken.create({
      data: { openProjectId: target.id, tokenHash: hashResetToken(token), email: target.email, expiresAt, requestedFrom },
    }),
  ]);

  // Sent whatever the person's email settings say: turning email off, or
  // pausing notifications, must not lock someone out of their account.
  const outcome = await enqueueEmail({
    recipientId: target.id,
    template: 'password-reset',
    payload: { firstName: target.firstName, resetUrl: resetUrl(token), validMinutes: RESET_TTL_MINUTES },
    channel: 'immediate',
    required: true,
  });

  // Nobody is signed in: EPM sent the link, on a request it cannot attribute.
  await recordAuditQuietly([
    {
      actorId: null,
      entityType: 'account',
      entityId: target.id,
      action: 'password.reset-requested',
      summary: message('A password reset link was emailed to {email}', { email: target.email }),
    },
  ]);

  return outcome === 'queued' ? 'sent' : 'not-queued';
}

async function linkByToken(token: string) {
  if (!TOKEN_SHAPE.test(token)) throw EpmError.notFound('That reset link');

  const link = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashResetToken(token) } });
  if (!link) throw EpmError.notFound('That reset link');

  return link;
}

export type ResetLinkState = 'valid' | 'used' | 'expired' | 'replaced';

function stateOf(link: { usedAt: Date | null; replacedAt: Date | null; expiresAt: Date }): ResetLinkState {
  if (link.replacedAt) return 'replaced';
  if (link.usedAt) return 'used';
  if (link.expiresAt.getTime() < Date.now()) return 'expired';
  return 'valid';
}

export interface ResetLinkInfo {
  state: ResetLinkState;
  firstName: string;
  /** ISO. */
  expiresAt: string;
  /** The rules the new password must meet, so the page can show them as it is typed. */
  policy: PasswordPolicy;
}

/** What the reset page shows before the form: whose link, whether it still works, and the rules. */
export async function resetLinkInfo(token: string, signal?: AbortSignal): Promise<ResetLinkInfo> {
  const link = await linkByToken(token);

  // The first name is read live, like an invitation's, so a correction made
  // after the email went out shows on the page. Through the add-on, by the
  // address the link went to: the service key's view of a user leaves the
  // first name out. Used only if it is still the same account.
  const [target, policy] = await Promise.all([
    targetFor(link.email).catch(() => null),
    getPasswordPolicy(signal).catch((): PasswordPolicy => ({ minLength: 0, activeRules: [], minAdheredRules: 0 })),
  ]);

  return {
    state: stateOf(link),
    firstName: target?.id === link.openProjectId ? target.firstName.trim() : '',
    expiresAt: link.expiresAt.toISOString(),
    policy,
  };
}

/** Sets the new password with a valid link, signs the person out everywhere, and returns their username. */
export async function completePasswordReset(token: string, password: string): Promise<{ login: string }> {
  const link = await linkByToken(token);

  const state = stateOf(link);
  if (state === 'replaced') throw EpmError.gone('A newer reset link replaced this one. Use the link in your latest email.');
  if (state === 'used') throw EpmError.gone('This reset link has already been used.');
  if (state === 'expired') throw EpmError.gone('This reset link has expired. Ask for a new one.');

  // The instance's own rules, checked before the write so the message comes
  // in the reader's language; the instance checks them again as it saves.
  const failures = await checkPassword(password);
  if (failures.length > 0) {
    throw EpmError.badRequest(message('That password needs: {failures}.', { failures: listOf(failures) }));
  }

  // Claimed before the write, atomically, so two requests racing with one
  // link cannot both set a password; released if the write fails for a
  // reason that is not the person's.
  const claimedAt = new Date();
  const claim = await prisma.passwordResetToken.updateMany({
    where: { id: link.id, usedAt: null, expiresAt: { gt: claimedAt } },
    data: { usedAt: claimedAt },
  });
  if (claim.count !== 1) throw EpmError.gone('This reset link has already been used.');

  let login: string;
  try {
    // Once: a retried write could be refused as a recently used password
    // after the first one had already succeeded.
    ({ login } = await openProject.request<{ login: string }>(`/epm_admin/users/${link.openProjectId}/password`, {
      method: 'PATCH',
      root: true,
      body: { password },
      once: true,
    }));
  } catch (error) {
    const status = upstreamStatus(error);
    // The account became one that is never reset by email: the link stays spent.
    if (status === 403) {
      throw EpmError.gone("This account's password cannot be reset by email. Ask an administrator to reset it.");
    }
    await prisma.passwordResetToken
      .updateMany({ where: { id: link.id, usedAt: claimedAt }, data: { usedAt: null } })
      .catch(() => undefined);
    // The instance refused the password itself, for instance as recently used.
    if (status === 422 && error instanceof Error) throw EpmError.badRequest(error.message);
    throw error;
  }

  // A password the person chose themselves: nothing left to hand over.
  await prisma.userProfile
    .updateMany({ where: { openProjectId: link.openProjectId }, data: { mustChangePassword: false } })
    .catch(() => undefined);

  // Signed out everywhere. The instance revoked the OAuth tokens as it saved;
  // EPM's own sessions go as well, so the next request anywhere signs in again.
  const sessions = await prisma.session
    .deleteMany({ where: { openProjectId: link.openProjectId } })
    .catch(() => ({ count: 0 }));

  // Journalled with the person as the actor: the link is what identified them.
  // The password is set already, so a journal failure is logged, not thrown.
  await recordAuditQuietly([
    {
      actorId: link.openProjectId,
      actorKind: 'user',
      entityType: 'account',
      entityId: link.openProjectId,
      action: 'password.reset',
      summary: message('Password reset from an emailed link; signed out of {count, plural, one {# session} other {# sessions}}', {
        count: sessions.count,
      }),
    },
  ]);

  return { login };
}
