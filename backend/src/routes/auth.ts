import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  SESSION_COOKIE,
  destroySession,
  isSignInConfigured,
  noteActivity,
  openSession,
  sessionClock,
  verifyPassword,
} from '../auth/oauth.js';
import { isProduction } from '../config/env.js';
import { mfaEnabled, openMfaChallenge } from '../domain/mfa.js';
import { EpmError } from '../lib/errors.js';

/**
 * Sign-in endpoints.
 *
 * Credentials are posted to EPM, verified against OpenProject server-side, and
 * exchanged for tokens that never leave this process. The browser receives an
 * opaque, HTTP-only session id and nothing else — no token, no upstream URL, no
 * indication that OpenProject exists.
 */

/**
 * A session cookie, with no lifetime of its own: the browser drops it when it
 * closes. It used to be kept for thirty days, so a browser left signed in
 * stayed signed in for a month. How long a session lasts is the server's to
 * decide (auth/oauth.ts `sessionPolicy`), not the cookie's.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProduction,
  path: '/',
  signed: true,
};

/**
 * Names a sign-in waiting on its second factor. Opaque and HTTP-only like the
 * session's, because it stands for a password already proved, and it lasts only
 * as long as the challenge does.
 */
export const MFA_COOKIE = 'epm.mfa';

const MFA_COOKIE_OPTIONS = { ...SESSION_COOKIE_OPTIONS, sameSite: 'strict' as const, maxAge: 5 * 60 };

const credentials = z.object({
  username: z.string().min(1, 'Username is required.'),
  password: z.string().min(1, 'Password is required.'),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  /** Lets the sign-in screen explain a misconfiguration instead of failing blankly. */
  app.get('/auth/config', async () => ({ signInAvailable: isSignInConfigured() }));

  app.post<{ Body: unknown }>(
    '/auth/login',
    {
      /**
       * Far tighter than the global allowance.
       *
       * Sign-in is the one endpoint where the request count *is* the attack:
       * the global 600/minute would let an attacker try six hundred passwords a
       * minute from one address. OpenProject blocks per account after repeated
       * failures, which does not help when the attacker sprays one password
       * across many accounts, so the caller is limited here as well.
       */
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = credentials.safeParse(request.body);
      if (!parsed.success) {
        throw EpmError.badRequest('Enter your username or email, and your password.');
      }

      const { username, password } = parsed.data;

      const verified = await verifyPassword(username, password);
      const userAgent = request.headers['user-agent'];

      // Read fresh and not caught: if it cannot be told whether this account
      // needs a second factor, the answer must not be a session.
      if (await mfaEnabled(verified.userId)) {
        const challengeId = await openMfaChallenge(verified.userId, verified.tokens, userAgent);
        reply.setCookie(MFA_COOKIE, challengeId, MFA_COOKIE_OPTIONS);
        return { authenticated: false, mfaRequired: true };
      }

      const session = await openSession(verified.userId, verified.tokens, userAgent);

      reply.setCookie(SESSION_COOKIE, session.sessionId, SESSION_COOKIE_OPTIONS);
      return { userId: session.userId, authenticated: true };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const cookie = request.cookies[SESSION_COOKIE];
    const unsigned = cookie ? request.unsignCookie(cookie) : undefined;

    await destroySession(unsigned?.valid ? unsigned.value : undefined);

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    // And the browser's cache for the app: nothing of the session is left behind.
    reply.header('Clear-Site-Data', '"cache"');
    reply.code(204);
  });

  /**
   * Whether this browser currently has a usable session, and its clock: when it
   * ends for want of activity, when it ends regardless, and the policy behind
   * both — what the page counts down from and reminds the person at.
   */
  app.get('/auth/session', async (request) => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized('You are not signed in.');
    return { userId: auth.userId, authenticated: true, session: await sessionClock(auth.sessionId) };
  });

  /**
   * The person is here: the page reports their activity (a click, a key) at most
   * once a minute, and "Stay signed in" on the reminder. Being a write, the auth
   * hook has already counted it; this answers with the clock as it now stands.
   */
  app.post('/auth/activity', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized('You are not signed in.');
    return { session: await noteActivity(auth.sessionId) };
  });
};
