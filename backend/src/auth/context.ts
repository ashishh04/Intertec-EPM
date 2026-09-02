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
