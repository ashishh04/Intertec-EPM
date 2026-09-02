import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  SESSION_COOKIE,
  destroySession,
  isSignInConfigured,
  signInWithPassword,
} from '../auth/oauth.js';
import { isProduction } from '../config/env.js';
import { EpmError } from '../lib/errors.js';

/**
 * Sign-in endpoints.
 *
 * Credentials are posted to EPM, verified against OpenProject server-side, and
 * exchanged for tokens that never leave this process. The browser receives an
 * opaque, HTTP-only session id and nothing else — no token, no upstream URL, no
 * indication that OpenProject exists.
 */

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProduction,
  path: '/',
  signed: true,
  maxAge: 30 * 24 * 60 * 60,
};

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
        throw EpmError.badRequest('Enter your username and password.');
      }

      const { username, password } = parsed.data;

      const session = await signInWithPassword(
        username,
        password,
        request.headers['user-agent'],
      );

      reply.setCookie(SESSION_COOKIE, session.sessionId, COOKIE_OPTIONS);
      return { userId: session.userId, authenticated: true };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const cookie = request.cookies[SESSION_COOKIE];
    const unsigned = cookie ? request.unsignCookie(cookie) : undefined;

    await destroySession(unsigned?.valid ? unsigned.value : undefined);

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.code(204);
  });

  /** Whether this browser currently has a usable session. */
  app.get('/auth/session', async (request) => {
    const auth = request.auth;
    if (!auth) throw EpmError.unauthorized('You are not signed in.');
    return { userId: auth.userId, authenticated: true };
  });
};
