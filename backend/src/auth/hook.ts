import type { FastifyInstance, FastifyRequest } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { runWithAuth, type AuthContext } from './context.js';
import { isExternal } from '../domain/external-access.js';
import { mfaGateApplies, mfaSetupRequired } from '../domain/mfa.js';
import { permissionsFor } from './guard.js';
import { SESSION_COOKIE, isSignInConfigured, resolveSession, sessionPolicy, type SessionEnd } from './oauth.js';
import { message } from '../lib/i18n.js';

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
    /** The session this request came with was ended by it, and why. */
    sessionEnded?: SessionEnd;
  }
}

/**
 * Whether a request is the person doing something, which keeps their session
 * from ending for want of activity.
 *
 * Any write is. A read is not when a browser makes it behind an open page —
 * its fetches and images say so (`Sec-Fetch-Dest`), and the app marks its own
 * (`X-EPM-Activity: passive`) — or a tab left open would never be signed out:
 * it refreshes what it shows on its own. Opening an address is. A caller that
 * is no browser (a script, a test) sends neither header, and everything it does
 * is its activity.
 */
function isActivity(request: FastifyRequest): boolean {
  if (request.method === 'OPTIONS') return false;
  if (request.headers['x-epm-activity'] === 'passive') return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return true;
  const destination = request.headers['sec-fetch-dest'];
  if (typeof destination === 'string') return destination === 'document';
  return true;
}

/** The refusal for a request whose session this server has just ended. */
function sessionEndedError(reason: SessionEnd): EpmError {
  const policy = sessionPolicy();
  return reason === 'idle'
    ? new EpmError(
        401,
        'SESSION_IDLE',
        message('You were signed out after {minutes, plural, one {# minute} other {# minutes}} without activity. Sign in again to continue.', {
          minutes: policy.idleMinutes,
        }),
      )
    : new EpmError(
        401,
        'SESSION_EXPIRED',
        message('Your session ended {hours, plural, one {# hour} other {# hours}} after you signed in. Sign in again to continue.', {
          hours: policy.maxHours,
        }),
      );
}

/**
 * Reachable without a session: sign-in itself, its second half (the challenge
 * cookie is what those act on), liveness, and the doors that exist for callers
 * who cannot have one — an invitee who has no password yet, someone who has
 * forgotten theirs, and OpenProject delivering a webhook, which proves itself
 * with a signature instead.
 */
const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/config',
  '/auth/mfa/verify',
  '/auth/mfa/cancel',
  '/password-reset',
  '/webhooks/delivery',
  '/webhooks/openproject',
]);

/**
 * Everything under here is public: the token in the path is the credential.
 * `/feed/` is a person's Atom feeds (routes/feeds.ts); `/feeds/token`, which
 * makes that token, is not under it and needs a session.
 */
const PUBLIC_PREFIXES = ['/invites/', '/password-reset/', '/feed/'];

/**
 * What someone held at a door can still reach: signing in or out, who they are,
 * their own password, and their own preferences (the page's language and theme).
 */
function reachableWhileHeld(path: string, method: string): boolean {
  return (
    path.startsWith('/auth/') ||
    (path === '/me' && method === 'GET') ||
    (path === '/me/password-policy' && method === 'GET') ||
    (path === '/me/password' && method === 'POST') ||
    (path === '/preferences' && ['GET', 'PUT', 'PATCH'].includes(method))
  );
}

function isPublic(request: FastifyRequest, apiPrefix: string): boolean {
  const path = request.url.split('?')[0] ?? '';
  // /metrics checks its own bearer token (routes/metrics.ts).
  if (path === '/health' || path === '/ready' || path === '/metrics') return true;

  const relative = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return PUBLIC_PATHS.has(relative) || PUBLIC_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

export function registerAuth(app: FastifyInstance, apiPrefix: string): void {
  app.addHook('onRequest', async (request) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (!cookie) return;

    const unsigned = request.unsignCookie(cookie);
    if (!unsigned.valid || !unsigned.value) return;

    const session = await resolveSession(unsigned.value, {
      active: isActivity(request),
      onEnd: (reason) => {
        request.sessionEnded = reason;
      },
    });
    if (!session) return;

    request.auth = {
      accessToken: session.accessToken,
      userId: session.userId,
      sessionId: session.sessionId,
    };
    // Who made the request, on its log lines from here on (NFR12) — the id,
    // never a name or a token.
    (request.log as { setBindings?: (bindings: Record<string, unknown>) => void }).setBindings?.({
      userId: session.userId,
    });
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
      // Ended just now by this request: say why, so the sign-in page can.
      if (request.sessionEnded) throw sessionEndedError(request.sessionEnded);
      // Without a registered OAuth application there is no way to sign in, so
      // say that rather than looping the user through a broken login.
      throw isSignInConfigured()
        ? EpmError.unauthorized()
        : EpmError.internal('Sign-in is unavailable: this deployment is not configured for it.');
    }

    runWithAuth(request.auth, () => done());
  });

  /**
   * External users (BR-611 to BR-613) reach the portal and nothing else.
   *
   * Deny by default: whatever they type, an external user's request is refused
   * unless it is the portal's API, signing in or out, who they are, their own
   * password, or their own preferences. Every internal page's data and every
   * administrative function is out of reach here, before any route runs — not
   * left to each route to remember.
   *
   * Their own password because an account handed a temporary one is held at
   * 'Choose your password' before the portal opens (App.tsx), and that screen
   * lists the rules and saves through these two routes. Without them it could
   * do neither, and the person was stuck there (DEF-010).
   */
  app.addHook('preHandler', async (request) => {
    if (isPublic(request, apiPrefix) || !request.auth) return;
    if (!(await isExternal(request.auth.userId))) return;
    const path = (request.url.split('?')[0] ?? '').slice(apiPrefix.length);
    const allowed = path.startsWith('/portal/') || reachableWhileHeld(path, request.method);
    if (!allowed) throw EpmError.forbidden('This is not available to external users.');
  });

  /**
   * Two-factor authentication, where an administrator has required it for
   * someone's role and they have not set it up: they are held at the set-up
   * screen (App.tsx), and here as well, so the requirement means something to a
   * client that is not this application's pages. Also applies to sessions opened
   * before it was required. After the external check, so a client or vendor
   * who may reach the portal still has to set it up first.
   *
   * Only one cached read for nearly everyone: their role is worked out only when
   * something is required and they have no authenticator.
   */
  app.addHook('preHandler', async (request) => {
    if (isPublic(request, apiPrefix) || !request.auth) return;
    if (!(await mfaGateApplies(request.auth.userId))) return;
    const path = (request.url.split('?')[0] ?? '').slice(apiPrefix.length);
    if (reachableWhileHeld(path, request.method)) return;
    const { role } = await permissionsFor(request);
    if (await mfaSetupRequired(request.auth.userId, role)) {
      throw EpmError.forbidden('Set up two-factor authentication to continue.');
    }
  });
}
