import { createHash, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { decryptMfaSecret, encryptMfaSecret } from '../auth/crypto.js';
import type { SessionTokens } from '../auth/oauth.js';
import { APP_ROLES, ROLE_TEXT, type AppRole } from '../auth/roles.js';
import { generateTotpSecret, matchTotpStep, otpauthUri } from '../auth/totp.js';
import { prisma } from '../db/prisma.js';
import type { SecurityNoticeKind } from '../email/templates/security-notice.js';
import { enqueueEmail } from '../email/outbox.js';
import { EpmError } from '../lib/errors.js';
import { message, type Message } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import type { MfaConfirmed, MfaPolicyView, MfaSetup, MfaStatus } from '../types/epm.js';
import { recordAuditQuietly, withAudit } from './audit.js';

/**
 * Two-factor authentication: what a code means for a person.
 *
 * `auth/totp.ts` knows codes; this knows people. Someone sets up an authenticator
 * app in Security settings, and from then on a password alone does not open a
 * session: it opens a challenge (`MfaChallenge`), which becomes a session when
 * the code is right. An administrator can require it per EPM role; someone in
 * such a role who has no authenticator is held at the set-up screen, on the
 * server as well as in the browser (`auth/hook.ts`).
 *
 * Why EPM and not OpenProject, which has TOTP devices of its own: its devices
 * guard only its own HTML sign-in, which nobody uses here. EPM signs in through
 * the password grant, which never consults them; they have no API, and they
 * keep the secret in plain text. The second factor has to stand at EPM's door,
 * and EPM owns that door.
 *
 * Every refusal here is deliberately specific, because everyone reaching one
 * already has the person's password or session: there is nothing left to hide
 * from them, and the real owner needs to know what to do next.
 */

/** What authenticator apps show above the code. Never the delivery system's name. */
const ISSUER = 'Intertec EPM';

/** How long a sign-in may wait for its code. */
const CHALLENGE_TTL_MS = 5 * 60_000;
/** Wrong codes one challenge allows before the password has to be entered again. */
const CHALLENGE_ATTEMPTS = 5;
/** How long a person has between seeing the QR code and proving a code from it. */
const SETUP_TTL_MS = 15 * 60_000;
/**
 * Wrong codes in a row, across challenges, before six-digit codes are refused
 * for a while: a quarter of an hour, doubling with every further ten up to a
 * day, until a right code ends the run. A guess is right three times in a
 * million, since three steps are accepted, so the doubling is what counts: a
 * fixed lock would give someone who has the password 960 guesses a day (one
 * chance in 350), where this gives about 70 on the first day and 10 on each one
 * after (one in 33,000), with the owner being told. A recovery code still works
 * during the lock: it cannot be guessed, and it lets the real owner in while
 * someone else is hammering the account.
 */
const FAILURES_BEFORE_LOCK = 10;
const FIRST_LOCK_MS = 15 * 60_000;
const LONGEST_LOCK_MS = 24 * 60 * 60_000;

const RECOVERY_CODE_COUNT = 10;
/** No 0, 1, i, l or o, so a code survives being read off paper. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Sixteen characters of 31: just under eighty bits, which is why a plain hash is enough. */
const RECOVERY_LENGTH = 16;

/* -------------------------------------------------------------------------- */
/* Whether someone has it, and whether they must                              */
/* -------------------------------------------------------------------------- */

const CACHE_MS = 15_000;
const enrolledCache = new Map<string, { at: number; value: boolean }>();
let policyCache: { at: number; value: MfaPolicyView } | undefined;

/** Called on every change, so this server acts on it at once; others within fifteen seconds. */
export function forgetMfa(userId: string): void {
  enrolledCache.delete(userId);
}

/** Read fresh: this decides whether a password alone opens a session. Fails closed by throwing. */
export async function mfaEnabled(userId: string): Promise<boolean> {
  const row = await prisma.userMfa.findUnique({ where: { openProjectId: userId }, select: { confirmedAt: true } });
  return Boolean(row?.confirmedAt);
}

async function enrolledCached(userId: string): Promise<boolean> {
  const cached = enrolledCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await mfaEnabled(userId);
  enrolledCache.set(userId, { at: Date.now(), value });
  return value;
}

function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

export async function getMfaPolicy(): Promise<MfaPolicyView> {
  if (policyCache && Date.now() - policyCache.at < CACHE_MS) return policyCache.value;
  const row = await prisma.mfaPolicy.findUnique({ where: { id: 1 } });
  const value: MfaPolicyView = {
    requiredRoles: (row?.requiredRoles ?? []).filter(isAppRole),
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
  policyCache = { at: Date.now(), value };
  return value;
}

const policySchema = z.object({ requiredRoles: z.array(z.enum(APP_ROLES)).max(APP_ROLES.length) });

export async function saveMfaPolicy(input: unknown, actorId: string): Promise<MfaPolicyView> {
  const parsed = policySchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('Choose the roles that must use two-factor authentication.');
  const requiredRoles = [...new Set(parsed.data.requiredRoles)];

  const before = await getMfaPolicy();
  await withAudit(
    (tx) =>
      tx.mfaPolicy.upsert({
        where: { id: 1 },
        create: { id: 1, requiredRoles, updatedBy: actorId },
        update: { requiredRoles, updatedBy: actorId },
      }),
    {
      actorId,
      entityType: 'mfa-policy',
      entityId: '1',
      action: 'mfa.policy.updated',
      summary:
        requiredRoles.length === 0
          ? message('Two-factor authentication is no longer required for any role')
          : message('Two-factor authentication required for: {roles}', { roles: requiredRoles.map((role) => ROLE_TEXT[role].label).join(', ') }),
      before: { requiredRoles: before.requiredRoles },
      after: { requiredRoles },
    },
  );
  policyCache = undefined;
  return getMfaPolicy();
}

/** Whether this person must set it up before they can do anything else. */
export async function mfaSetupRequired(userId: string, role: AppRole): Promise<boolean> {
  const policy = await getMfaPolicy();
  if (!policy.requiredRoles.includes(role)) return false;
  return !(await enrolledCached(userId));
}

/**
 * The cheap half of the gate in `auth/hook.ts`: when nothing is required or the
 * person has an authenticator, there is no need to work out their role at all.
 */
export async function mfaGateApplies(userId: string): Promise<boolean> {
  const policy = await getMfaPolicy();
  if (policy.requiredRoles.length === 0) return false;
  return !(await enrolledCached(userId));
}

export async function mfaStatus(userId: string, role: AppRole, passwordRequired: boolean): Promise<MfaStatus> {
  const [row, policy] = await Promise.all([
    prisma.userMfa.findUnique({
      where: { openProjectId: userId },
      include: { recoveryCodes: { where: { usedAt: null }, select: { id: true } } },
    }),
    getMfaPolicy(),
  ]);
  const enabled = Boolean(row?.confirmedAt);
  return {
    enabled,
    enabledAt: enabled ? (row?.confirmedAt?.toISOString() ?? null) : null,
    lastUsedAt: enabled ? (row?.lastUsedAt?.toISOString() ?? null) : null,
    recoveryCodesLeft: enabled ? (row?.recoveryCodes.length ?? 0) : 0,
    required: policy.requiredRoles.includes(role),
    passwordRequired,
  };
}

/* -------------------------------------------------------------------------- */
/* Recovery codes                                                             */
/* -------------------------------------------------------------------------- */

const hashRecoveryCode = (normalised: string): string => createHash('sha256').update(normalised).digest('hex');

/** What people type, as stored: lower case, letters and digits only. */
const normaliseRecoveryCode = (input: string): string => input.toLowerCase().replace(/[^a-z0-9]/g, '');

function generateRecoveryCode(): string {
  let code = '';
  for (let index = 0; index < RECOVERY_LENGTH; index += 1) {
    code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return code;
}

/** xxxx-xxxx-xxxx-xxxx, because sixteen characters in a row are hard to copy by hand. */
const formatRecoveryCode = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1-');

function newRecoveryCodes(): { plain: string[]; rows: { codeHash: string }[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { plain: codes.map(formatRecoveryCode), rows: codes.map((code) => ({ codeHash: hashRecoveryCode(code) })) };
}

/* -------------------------------------------------------------------------- */
/* Telling the person                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sent whatever their email settings say: this is how someone finds out their
 * account is being changed or attacked. The outbox never throws, so a mail
 * problem cannot undo what already happened.
 */
function tellThem(userId: string, kind: SecurityNoticeKind, firstName = '', dedupeKey?: string): void {
  void enqueueEmail({
    recipientId: userId,
    template: 'security-notice',
    payload: { firstName, kind },
    channel: 'immediate',
    required: true,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Checking a code                                                            */
/* -------------------------------------------------------------------------- */

export interface FactorResult {
  via: 'totp' | 'recovery';
  /** What is left, so a person running low can be told while they can still act. */
  recoveryCodesLeft: number;
}

const minutesUntil = (when: Date): number => Math.max(1, Math.ceil((when.getTime() - Date.now()) / 60_000));

async function recoveryCodesLeft(userId: string): Promise<number> {
  return prisma.mfaRecoveryCode.count({ where: { openProjectId: userId, usedAt: null } });
}

/** A wrong code: counted across attempts, and every tenth locks six-digit codes for longer. */
async function recordFailure(userId: string): Promise<void> {
  const row = await prisma.userMfa.update({
    where: { openProjectId: userId },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  // Each count reaches exactly one request, so guesses sent together lock once.
  if (row.failedAttempts % FAILURES_BEFORE_LOCK !== 0) return;

  const lockMs = Math.min(FIRST_LOCK_MS * 2 ** (row.failedAttempts / FAILURES_BEFORE_LOCK - 1), LONGEST_LOCK_MS);
  await prisma.userMfa.update({
    where: { openProjectId: userId },
    data: { lockedUntil: new Date(Date.now() + lockMs) },
  });
  await recordAuditQuietly([
    {
      actorId: null,
      entityType: 'account',
      entityId: userId,
      action: 'mfa.locked',
      summary: message('Two-factor codes locked for {minutes} minutes after {count} wrong attempts', {
        minutes: lockMs / 60_000,
        count: row.failedAttempts,
      }),
    },
  ]);
  // At most one an hour: someone repeatedly tripping this should not also be
  // able to flood the owner's inbox.
  tellThem(userId, 'mfa-locked', '', `mfa-locked:${new Date().toISOString().slice(0, 13)}`);
}

async function checkTotp(userId: string, code: string): Promise<FactorResult> {
  const row = await prisma.userMfa.findUnique({ where: { openProjectId: userId } });
  if (!row?.confirmedAt) throw EpmError.badRequest('Two-factor authentication is not on for this account.');

  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    const minutes = minutesUntil(row.lockedUntil);
    throw EpmError.conflict(
      minutes < 120
        ? message('Too many wrong codes. Try again in {minutes, plural, one {# minute} other {# minutes}}, or use a recovery code.', { minutes })
        : message('Too many wrong codes. Try again in {hours, plural, one {# hour} other {# hours}}, or use a recovery code.', {
            hours: Math.ceil(minutes / 60),
          }),
    );
  }

  const secret = decryptMfaSecret(row.secret);
  if (!secret) {
    // Not the person's doing, and no code can succeed: the key changed or was lost.
    appLog.error({ userId }, 'A two-factor secret could not be decrypted: has EPM_MFA_KEY changed?');
    throw EpmError.conflict('Your authenticator could not be read. Use a recovery code, or ask an administrator to reset it.');
  }

  const step = matchTotpStep(secret, code);
  if (step === null) {
    await recordFailure(userId);
    throw EpmError.badRequest('That code is not right. Enter the one your app shows now, and check that the time on your phone is set automatically.');
  }

  // Spent once, even between two requests arriving together: only one of them
  // can move the step forward. Not counted as a failure, because a right code
  // used twice is someone signing in twice within thirty seconds.
  const now = new Date();
  const spent = await prisma.userMfa.updateMany({
    where: { openProjectId: userId, lastUsedStep: { lt: step } },
    data: { lastUsedStep: step, lastUsedAt: now, failedAttempts: 0, lockedUntil: null },
  });
  if (spent.count !== 1) throw EpmError.badRequest('That code has just been used. Wait for your app to show the next one.');

  return { via: 'totp', recoveryCodesLeft: await recoveryCodesLeft(userId) };
}

async function checkRecoveryCode(userId: string, input: string): Promise<FactorResult> {
  const row = await prisma.userMfa.findUnique({ where: { openProjectId: userId }, select: { confirmedAt: true } });
  if (!row?.confirmedAt) throw EpmError.badRequest('Two-factor authentication is not on for this account.');

  const normalised = normaliseRecoveryCode(input);
  const now = new Date();
  // Claimed atomically, so a code cannot be spent twice by two requests together.
  const claimed =
    normalised.length === RECOVERY_LENGTH
      ? await prisma.mfaRecoveryCode.updateMany({
          where: { openProjectId: userId, codeHash: hashRecoveryCode(normalised), usedAt: null },
          data: { usedAt: now },
        })
      : { count: 0 };
  if (claimed.count !== 1) {
    await recordFailure(userId);
    throw EpmError.badRequest('That recovery code is not right, or it has already been used.');
  }

  await prisma.userMfa.update({
    where: { openProjectId: userId },
    data: { lastUsedAt: now, failedAttempts: 0, lockedUntil: null },
  });
  const left = await recoveryCodesLeft(userId);
  await recordAuditQuietly([
    {
      actorId: userId,
      actorKind: 'user',
      entityType: 'account',
      entityId: userId,
      action: 'mfa.recovery-used',
      summary: message('A two-factor recovery code was used; {count, plural, one {# remains} other {# remain}}', { count: left }),
    },
  ]);
  tellThem(userId, 'mfa-recovery-used');
  return { via: 'recovery', recoveryCodesLeft: left };
}

/**
 * Checks a code from an authenticator, or a recovery code. The two are told
 * apart by their shape, so a person never has to say which they are giving.
 */
export function checkSecondFactor(userId: string, input: string): Promise<FactorResult> {
  const compact = input.replace(/\s/g, '');
  return /^\d{6}$/.test(compact) ? checkTotp(userId, compact) : checkRecoveryCode(userId, input);
}

/* -------------------------------------------------------------------------- */
/* Signing in                                                                 */
/* -------------------------------------------------------------------------- */

/** Holds a verified password's tokens until the code arrives. Only one waits per person. */
export async function openMfaChallenge(userId: string, tokens: SessionTokens, userAgent?: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await prisma.$transaction([
    prisma.mfaChallenge.deleteMany({ where: { OR: [{ openProjectId: userId }, { expiresAt: { lt: new Date(now) } }] } }),
    prisma.mfaChallenge.create({
      data: {
        id,
        openProjectId: userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.tokenExpiresAt,
        userAgent,
        expiresAt: new Date(now + CHALLENGE_TTL_MS),
      },
    }),
  ]);
  return id;
}

export async function cancelMfaChallenge(challengeId: string | undefined): Promise<void> {
  if (!challengeId) return;
  await prisma.mfaChallenge.deleteMany({ where: { id: challengeId } }).catch(() => undefined);
}

export interface CompletedChallenge extends FactorResult {
  userId: string;
  tokens: SessionTokens;
  userAgent?: string;
}

/** Turns a challenge and a right code into what a session is made from. */
export async function completeMfaChallenge(challengeId: string | undefined, code: string): Promise<CompletedChallenge> {
  const expired = () => EpmError.gone('Your sign-in has expired. Enter your password again.');
  if (!challengeId) throw expired();

  const challenge = await prisma.mfaChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge) throw expired();
  if (challenge.expiresAt.getTime() < Date.now()) {
    await cancelMfaChallenge(challengeId);
    throw expired();
  }

  // Counted before the code is looked at and atomically, so that guesses sent
  // in parallel share one allowance rather than each seeing a clean slate.
  const counted = await prisma.mfaChallenge.updateMany({
    where: { id: challengeId, attempts: { lt: CHALLENGE_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) {
    await cancelMfaChallenge(challengeId);
    throw EpmError.gone('Too many wrong codes. Enter your password again.');
  }

  const factor = await checkSecondFactor(challenge.openProjectId, code);

  // One challenge, one session: of two right answers together, only one gets it.
  const consumed = await prisma.mfaChallenge.deleteMany({ where: { id: challengeId } });
  if (consumed.count !== 1) throw expired();

  return {
    ...factor,
    userId: challenge.openProjectId,
    userAgent: challenge.userAgent ?? undefined,
    tokens: {
      accessToken: challenge.accessToken,
      refreshToken: challenge.refreshToken,
      tokenExpiresAt: challenge.tokenExpiresAt,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Setting it up, and turning it off                                          */
/* -------------------------------------------------------------------------- */

/** Starts over whatever an unfinished set-up left: only the newest QR code counts. */
export async function startMfaSetup(userId: string, account: string): Promise<MfaSetup> {
  const existing = await prisma.userMfa.findUnique({ where: { openProjectId: userId }, select: { confirmedAt: true } });
  if (existing?.confirmedAt) {
    throw EpmError.conflict('Two-factor authentication is already on. Turn it off first to set up a new authenticator.');
  }

  const secret = generateTotpSecret();
  const encrypted = encryptMfaSecret(secret);
  await prisma.userMfa.upsert({
    where: { openProjectId: userId },
    create: { openProjectId: userId, secret: encrypted },
    update: { secret: encrypted, createdAt: new Date(), lastUsedStep: 0, failedAttempts: 0, lockedUntil: null },
  });

  return { secret, uri: otpauthUri({ secret, issuer: ISSUER, account }), issuer: ISSUER, account };
}

/**
 * Proves the app holds the secret, which is what turns it on. Every other
 * session of theirs ends: if an intruder is why they are doing this, the intruder
 * should not stay signed in past it.
 */
export async function confirmMfaSetup(input: {
  userId: string;
  code: string;
  sessionId: string;
  firstName?: string;
}): Promise<MfaConfirmed> {
  const { userId, code, sessionId, firstName } = input;

  const row = await prisma.userMfa.findUnique({ where: { openProjectId: userId } });
  if (row?.confirmedAt) throw EpmError.conflict('Two-factor authentication is already on.');
  if (!row || row.createdAt.getTime() + SETUP_TTL_MS < Date.now()) {
    throw EpmError.gone('That set-up has expired. Start again to get a new QR code.');
  }

  const secret = decryptMfaSecret(row.secret);
  if (!secret) throw EpmError.gone('That set-up has expired. Start again to get a new QR code.');

  const step = matchTotpStep(secret, code.replace(/\s/g, ''));
  if (step === null) {
    throw EpmError.badRequest('That code is not right. Enter the one your app shows now, and check that the time on your phone is set automatically.');
  }

  const codes = newRecoveryCodes();
  const now = new Date();
  await withAudit(
    async (tx) => {
      // Spent here too, so the code that proved the app cannot also sign someone in.
      const claimed = await tx.userMfa.updateMany({
        where: { openProjectId: userId, confirmedAt: null },
        data: { confirmedAt: now, lastUsedStep: step, lastUsedAt: now, failedAttempts: 0, lockedUntil: null },
      });
      if (claimed.count !== 1) throw EpmError.conflict('Two-factor authentication is already on.');

      await tx.mfaRecoveryCode.deleteMany({ where: { openProjectId: userId } });
      await tx.mfaRecoveryCode.createMany({ data: codes.rows.map((entry) => ({ openProjectId: userId, ...entry })) });
      return tx.session.deleteMany({ where: { openProjectId: userId, id: { not: sessionId } } });
    },
    (ended) => ({
      actorId: userId,
      entityType: 'account',
      entityId: userId,
      action: 'mfa.enabled',
      summary: message('Turned on two-factor authentication; signed out of {count, plural, one {# other session} other {# other sessions}}', {
        count: ended.count,
      }),
    }),
  );
  forgetMfa(userId);
  tellThem(userId, 'mfa-enabled', firstName);

  return { recoveryCodes: codes.plain };
}

/**
 * Turning it off asks for a code as well as the password, so a stolen session
 * cannot quietly remove the very thing that would have stopped the thief. If
 * their role requires it, they are held at the set-up screen straight away,
 * which is how someone replaces a phone without an administrator's help.
 */
export async function disableMfa(input: { userId: string; code: string; firstName?: string }): Promise<void> {
  const { userId, code, firstName } = input;
  await checkSecondFactor(userId, code);

  await withAudit((tx) => tx.userMfa.delete({ where: { openProjectId: userId } }), {
    actorId: userId,
    entityType: 'account',
    entityId: userId,
    action: 'mfa.disabled',
    summary: message('Turned off two-factor authentication'),
  });
  forgetMfa(userId);
  tellThem(userId, 'mfa-disabled', firstName);
}

/** A fresh set, which is the only way to see codes again: the old ones stop working. */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<MfaConfirmed> {
  await checkSecondFactor(userId, code);

  const codes = newRecoveryCodes();
  await withAudit(
    async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { openProjectId: userId } });
      await tx.mfaRecoveryCode.createMany({ data: codes.rows.map((entry) => ({ openProjectId: userId, ...entry })) });
    },
    {
      actorId: userId,
      entityType: 'account',
      entityId: userId,
      action: 'mfa.recovery-regenerated',
      summary: message('Generated new two-factor recovery codes; the old ones no longer work'),
    },
  );
  return { recoveryCodes: codes.plain };
}

/**
 * For someone who has lost both their phone and their recovery codes. They are
 * signed out everywhere and told by email; if their role requires two-factor
 * authentication, they set it up again at their next sign-in. Whoever resets
 * this is in the journal, and nobody may reset their own: that would let a
 * stolen administrator session remove the factor protecting it.
 */
export async function resetMfa(input: {
  userId: string;
  name: string | Message;
  actorId: string | null;
  actorKind?: 'user' | 'system';
}): Promise<boolean> {
  const { userId, name, actorId, actorKind } = input;
  if (actorId !== null && userId === actorId) {
    throw EpmError.badRequest('You cannot reset your own two-factor authentication. Turn it off in Security settings, or ask another administrator.');
  }

  // An unfinished set-up is cleared too, but nothing they relied on changed, so
  // it is neither journalled nor mentioned to them, and their sessions stay.
  const removed = await withAudit(
    async (tx) => {
      const row = await tx.userMfa.findUnique({ where: { openProjectId: userId }, select: { confirmedAt: true } });
      if (!row) return false;
      await tx.userMfa.delete({ where: { openProjectId: userId } });
      await tx.mfaChallenge.deleteMany({ where: { openProjectId: userId } });
      if (!row.confirmedAt) return false;
      await tx.session.deleteMany({ where: { openProjectId: userId } });
      return true;
    },
    (wasOn) =>
      wasOn
        ? {
            actorId,
            ...(actorKind ? { actorKind } : {}),
            entityType: 'account',
            entityId: userId,
            action: 'mfa.reset',
            summary: message('Reset two-factor authentication for {name}, and signed them out everywhere', { name }),
          }
        : [],
  );
  forgetMfa(userId);
  if (removed) tellThem(userId, 'mfa-reset');
  return removed;
}

/* -------------------------------------------------------------------------- */
/* What an administrator sees                                                 */
/* -------------------------------------------------------------------------- */

export interface MfaStateRow {
  enabled: boolean;
  enabledAt: string | null;
  lastUsedAt: string | null;
  recoveryCodesLeft: number;
  lockedUntil: string | null;
}

/** Everyone's state, by user id. Never a secret, and only a count of recovery codes. */
export async function mfaStates(): Promise<Map<string, MfaStateRow>> {
  const rows = await prisma.userMfa.findMany({
    where: { confirmedAt: { not: null } },
    include: { recoveryCodes: { where: { usedAt: null }, select: { id: true } } },
  });
  const now = Date.now();
  return new Map(
    rows.map((row) => [
      row.openProjectId,
      {
        enabled: true,
        enabledAt: row.confirmedAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        recoveryCodesLeft: row.recoveryCodes.length,
        lockedUntil: row.lockedUntil && row.lockedUntil.getTime() > now ? row.lockedUntil.toISOString() : null,
      },
    ]),
  );
}
