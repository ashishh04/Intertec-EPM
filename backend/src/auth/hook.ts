import type { FastifyInstance, FastifyRequest } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { runWithAuth, type AuthContext } from './context.js';
import { SESSION_COOKIE, isSignInConfigured, resolveSession } from './oauth.js';

/**
 * Resolves the session on every request and enforces it on data routes.
 *
 * Two things happen here that have to happen together: the caller's token is
 * put into async context so `OpenProjectClient` picks it up, and requests
 * without a session are refused. Doing only the first would leave every
 * unauthenticated request silently falling back to the API key — which is
 * exactly the administrator-for-everyone problem this replaces.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Reachable without a session: sign-in itself, and liveness. */
const PUBLIC_PATHS = new Set(['/auth/login', '/auth/logout', '/auth/config']);

function isPublic(request: FastifyRequest, apiPrefix: string): boolean {
  const path = request.url.split('?')[0] ?? '';
  if (path === '/health') return true;

  const relative = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return PUBLIC_PATHS.has(relative);
}

export function registerAuth(app: FastifyInstance, apiPrefix: string): void {
  app.addHook('onRequest', async (request) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (!cookie) return;

    const unsigned = request.unsignCookie(cookie);
    if (!unsigned.valid || !unsigned.value) return;

    const session = await resolveSession(unsigned.value);
    if (!session) return;

    request.auth = {
      accessToken: session.accessToken,
      userId: session.userId,
      sessionId: session.sessionId,
    };
  });

  /**
   * Runs the handler inside the caller's credential.
   *
   * `preHandler` rather than `onRequest` because the async context has to still
   * be active when the route handler runs, and Fastify's hook chain preserves
   * it from here on.
   */
  app.addHook('preHandler', (request, reply, done) => {
    if (isPublic(request, apiPrefix)) return done();

    if (!request.auth) {
      // Without a registered OAuth application there is no way to sign in, so
      // say that rather than looping the user through a broken login.
      throw isSignInConfigured()
        ? EpmError.unauthorized()
        : EpmError.internal('Sign-in is unavailable: this deployment is not configured for it.');
    }

    runWithAuth(request.auth, () => done());
  });
}
