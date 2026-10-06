import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The credential the current request should use against OpenProject.
 *
 * Every route ultimately calls `openProject.request`, and threading a token
 * through thirty call sites would mean touching every mapping function that
 * sits between them. Async context carries it instead: the auth hook puts the
 * signed-in user's token here, and the client reads it at the moment it builds
 * the Authorization header.
 *
 * When nothing is set the client falls back to the configured API key. That
 * path is for unattended work — the health probe, scheduled sync — not for
 * user requests, which `requireSession` refuses without a session.
 */

export interface AuthContext {
  /** OAuth2 access token for the signed-in user. */
  accessToken: string;
  /** OpenProject user id, for logging and cache scoping. */
  userId: string;
  sessionId: string;
}

const storage = new AsyncLocalStorage<AuthContext>();

export function runWithAuth<T>(context: AuthContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentAuth(): AuthContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with no signed-in user, so OpenProject calls fall back to the
 * configured service key.
 *
 * For work that must see every project regardless of who caused it: health is
 * one authoritative value per project, so it cannot be calculated from
 * whatever the person whose edit triggered it happens to be able to see. Not
 * incidental either — timers and promises created inside a request inherit
 * that request's context, so a recalculation queued by a user's edit would
 * otherwise run on their token long after the request finished.
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.exit(fn);
}
