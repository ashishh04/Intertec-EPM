import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { SESSION_COOKIE, confirmPassword, openSession } from '../auth/oauth.js';
import { permissionsFor } from '../auth/guard.js';
import { roleOfAccount } from '../auth/roles.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import {
  cancelMfaChallenge,
  completeMfaChallenge,
  confirmMfaSetup,
  disableMfa,
  getMfaPolicy,
  mfaStates,
  mfaStatus,
  regenerateRecoveryCodes,
  resetMfa,
  saveMfaPolicy,
  startMfaSetup,
} from '../domain/mfa.js';
import { EpmError } from '../lib/errors.js';
import { message, msg } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCurrentUser, getUsers } from '../mapping/users.js';
import type { MfaAdminView, MfaConfirmed, MfaPersonRow, MfaPolicyView, MfaSetup, MfaStatus } from '../types/epm.js';
import { MFA_COOKIE, SESSION_COOKIE_OPTIONS } from './auth.js';

/**
 * Two-factor authentication (`domain/mfa.ts`).
 *
 * Under `/auth/` because an external user, held to the portal by `auth/hook.ts`,
 * has to reach these as well: a client or vendor can be required to use it too.
 * The first two are public, like signing in: the challenge cookie is what they
 * act on. Everything else needs a session.
 */

/** Long enough for a recovery code with its dashes; a code is only ever this short. */
const codeSchema = z.string().trim().min(1, msg('Enter the code from your authenticator app.')).max(64);

const verifyBody = z.object({ code: codeSchema });
const setupBody = z.object({ password: z.string().max(256).optional() });
const disableBody = z.object({ code: codeSchema, password: z.string().max(256).optional() });

/**
 * How recently the person proved their password. Inside this, the screen they
 * reach straight after signing in does not ask for it again; after it, a session
 * someone walked away from cannot change how the account is protected.
 */
const PASSWORD_FRESH_MS = 10 * 60_000;

async function passwordIsFresh(request: FastifyRequest): Promise<boolean> {
  const session = await prisma.session.findUnique({
    where: { id: request.auth!.sessionId },
    select: { createdAt: true },
  });
  return Boolean(session && Date.now() - session.createdAt.getTime() < PASSWORD_FRESH_MS);
}

/**
 * `details` tells the page it is the password that is wanted, so a screen left
 * open past the ten minutes can ask for it rather than repeating a refusal.
 */
async function requirePassword(request: FastifyRequest, password: string | undefined): Promise<void> {
  if (await passwordIsFresh(request)) return;
  if (!password) throw EpmError.badRequest('Enter your password.', { field: 'password' });
  await confirmPassword(request.auth!.userId, password, requestSignal(request));
}

const challengeIdOf = (request: FastifyRequest): string | undefined => {
  const raw = request.cookies[MFA_COOKIE];
  const unsigned = raw ? request.unsignCookie(raw) : undefined;
  return unsigned?.valid && unsigned.value ? unsigned.value : undefined;
};

/** A handful a minute: each is a guess at a code, or a look at a password. */
const TIGHT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export const mfaRoutes: FastifyPluginAsync = async (app) => {
  /** The second half of signing in. */
  app.post<{ Body: unknown }>('/auth/mfa/verify', TIGHT, async (request, reply) => {
    const { code } = verifyBody.parse(request.body ?? {});

    const completed = await completeMfaChallenge(challengeIdOf(request), code);
    const session = await openSession(completed.userId, completed.tokens, completed.userAgent);

    reply.clearCookie(MFA_COOKIE, { path: '/' });
    reply.setCookie(SESSION_COOKIE, session.sessionId, SESSION_COOKIE_OPTIONS);
    return {
      userId: session.userId,
      authenticated: true,
      via: completed.via,
      recoveryCodesLeft: completed.recoveryCodesLeft,
    };
  });

  /** "Back": gives up the waiting sign-in rather than leaving its tokens to expire. */
  app.post('/auth/mfa/cancel', async (request, reply) => {
    await cancelMfaChallenge(challengeIdOf(request));
    reply.clearCookie(MFA_COOKIE, { path: '/' });
    reply.code(204);
  });

  app.get('/auth/mfa', async (request): Promise<MfaStatus> => {
    const { role } = await permissionsFor(request);
    return mfaStatus(request.auth!.userId, role, !(await passwordIsFresh(request)));
  });

  app.post<{ Body: unknown }>('/auth/mfa/setup', TIGHT, async (request): Promise<MfaSetup> => {
    const { password } = setupBody.parse(request.body ?? {});
    await requirePassword(request, password);

    const user = await getCurrentUser(requestSignal(request));
    return startMfaSetup(request.auth!.userId, user.email || user.name);
  });

  app.post<{ Body: unknown }>('/auth/mfa/confirm', TIGHT, async (request): Promise<MfaConfirmed> => {
    const { code } = verifyBody.parse(request.body ?? {});
    const user = await getCurrentUser(requestSignal(request));
    return confirmMfaSetup({
      userId: request.auth!.userId,
      code,
      sessionId: request.auth!.sessionId,
      firstName: user.firstName,
    });
  });

  app.post<{ Body: unknown }>('/auth/mfa/recovery-codes', TIGHT, async (request): Promise<MfaConfirmed> => {
    const { code } = verifyBody.parse(request.body ?? {});
    return regenerateRecoveryCodes(request.auth!.userId, code);
  });

  app.post<{ Body: unknown }>('/auth/mfa/disable', TIGHT, async (request, reply) => {
    const { code, password } = disableBody.parse(request.body ?? {});
    await requirePassword(request, password);

    const user = await getCurrentUser(requestSignal(request));
    await disableMfa({ userId: request.auth!.userId, code, firstName: user.firstName });
    reply.code(204);
  });

  /* ------------------------------------------------------------------------ */
  /* Administration                                                            */
  /* ------------------------------------------------------------------------ */

  app.get('/admin/mfa', async (request): Promise<MfaAdminView> => {
    await guard.require(request, 'users:manage');

    const [users, states, policy, profiles] = await Promise.all([
      getUsers(requestSignal(request)),
      mfaStates(),
      getMfaPolicy(),
      prisma.userProfile.findMany({
        where: { OR: [{ appRole: { not: null } }, { external: true }] },
        select: { openProjectId: true, appRole: true, external: true },
      }),
    ]);
    const profileOf = new Map(profiles.map((row) => [row.openProjectId, row]));

    const people = users
      .map((user): MfaPersonRow => {
        const administrator = user.role === 'Administrator' || env.EPM_ADMIN_USER_IDS.includes(user.id);
        const profile = profileOf.get(user.id);
        const role = roleOfAccount(user.id, administrator, profile?.appRole, profile?.external);
        const state = states.get(user.id);
        return {
          userId: user.id,
          userName: user.name,
          email: user.email,
          role,
          required: policy.requiredRoles.includes(role),
          enabled: state?.enabled ?? false,
          enabledAt: state?.enabledAt ?? null,
          lastUsedAt: state?.lastUsedAt ?? null,
          recoveryCodesLeft: state?.recoveryCodesLeft ?? 0,
          lockedUntil: state?.lockedUntil ?? null,
        };
      })
      .sort((a, b) => a.userName.localeCompare(b.userName));

    return { policy, people };
  });

  app.put<{ Body: unknown }>('/admin/mfa/policy', async (request): Promise<MfaPolicyView> => {
    await guard.require(request, 'users:manage');
    return saveMfaPolicy(request.body, request.auth!.userId);
  });

  app.post<{ Params: { userId: string } }>('/admin/mfa/users/:userId/reset', async (request, reply) => {
    await guard.require(request, 'users:manage');
    const { userId } = request.params;

    const users = await getUsers(requestSignal(request));
    const person = users.find((user) => user.id === userId);
    if (!person) throw EpmError.notFound('That person');

    const removed = await resetMfa({ userId, name: person.name, actorId: request.auth!.userId });
    if (!removed) throw EpmError.conflict(message('{person} has no authenticator set up.', { person: person.name }));
    reply.code(204);
  });
};
