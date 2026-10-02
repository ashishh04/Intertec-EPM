import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
// Sign-in reaches OpenProject directly rather than through OpenProjectClient,
// so it needs the same header for the same reason — see the constant's comment.
// Without it the token endpoint answers 301 to a host with no TLS listener, the
// fetch throws, and the failure surfaces as "the account service could not be
// reached", which reads like OpenProject is down rather than misaddressed.
import { FORWARDED_HEADERS } from '../openproject/client.js';
import { decryptToken, encryptToken } from './crypto.js';

/**
 * Sign-in against OpenProject, without OpenProject ever being visible.
 *
 * Users enter their credentials on EPM's own form. The backend exchanges them
 * for that user's OAuth tokens using the Resource Owner Password Credentials
 * grant, keeps the tokens server-side, and hands the browser nothing but an
 * opaque session id. There is no redirect, no consent screen, and no sign of
 * the upstream system anywhere in the client.
 *
 * The password is used once, in this process, and is never stored or logged.
 * OpenProject still owns authentication itself — password policy, account
 * status, LDAP and brute-force blocking all apply, because the grant is
 * validated by `User.try_to_login` on that side.
 *
 * The grant requires the companion initializer in `backend/openproject/` to be
 * installed on the OpenProject instance; without it the token endpoint answers
 * `unsupported_grant_type`.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Refresh a little early; a token that expires mid-flight reads as a 401. */
const REFRESH_SKEW_MS = 60_000;

export const SESSION_COOKIE = 'epm.sid';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

interface OAuthError {
  error?: string;
  error_description?: string;
}

function oauthConfig() {
  const clientId = env.OPENPROJECT_OAUTH_CLIENT_ID;
  const clientSecret = env.OPENPROJECT_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw EpmError.internal(
      'Sign-in is not configured. Set OPENPROJECT_OAUTH_CLIENT_ID and OPENPROJECT_OAUTH_CLIENT_SECRET.',
    );
  }

  const base = env.OPENPROJECT_BASE_URL.replace(/\/+$/, '');
  return { clientId, clientSecret, tokenUrl: `${base}/oauth/token`, base };
}

/**
 * Exchanges parameters at the token endpoint.
 *
 * Upstream errors are deliberately flattened: an invalid password, an unknown
 * user and a locked account all come back as `invalid_grant`, and relaying the
 * distinction would let the form be used to enumerate accounts.
 */
async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  const config = oauthConfig();

  // A network failure here is the sign-in service being down, not a fault in
  // this process. Say so, rather than letting it fall through as a generic 500.
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { ...FORWARDED_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: 'api_v3',
        ...body,
      }),
    });
  } catch (cause) {
    throw EpmError.unavailable(
      'Sign-in is unavailable right now: the account service could not be reached. Try again shortly.',
      cause,
    );
  }

  if (response.ok) return (await response.json()) as TokenResponse;

  const failure = (await response.json().catch(() => ({}))) as OAuthError;

  if (failure.error === 'unsupported_grant_type') {
    throw EpmError.internal(
      'Sign-in is unavailable: this OpenProject instance does not accept password sign-in.',
    );
  }

  throw EpmError.unauthorized('Those sign-in details were not accepted.');
}

export interface EstablishedSession {
  sessionId: string;
  userId: string;
}

/** Verifies credentials and opens a session. */
export async function signInWithPassword(
  username: string,
  password: string,
  userAgent?: string,
): Promise<EstablishedSession> {
  const config = oauthConfig();

  const tokens = await exchange({ grant_type: 'password', username, password });

  // Identify the caller with their own token rather than trusting the form.
  const meResponse = await fetch(`${config.base}/api/v3/users/me`, {
    headers: {
      ...FORWARDED_HEADERS,
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/hal+json',
    },
  });
  if (!meResponse.ok) {
    throw EpmError.unauthorized('Could not read your account after sign-in.');
  }
  const me = (await meResponse.json()) as { id: number };

  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId,
      openProjectId: String(me.id),
      userAgent,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      accessToken: encryptToken(tokens.access_token),
      refreshToken: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
      tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    },
  });

  return { sessionId, userId: String(me.id) };
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  accessToken: string;
}

/**
 * Refreshes in flight, keyed on session.
 *
 * OpenProject rotates the refresh token on use, so the token is a single-use
 * credential. A page firing several requests at once puts all of them inside
 * the same expiry window: the first refresh succeeds and invalidates the token
 * the others are still holding, their exchanges fail, and the failure path
 * deletes the session — signing the person out mid-action for no reason they
 * could see. Once every two hours, per active session, under exactly the
 * concurrency real use produces and a single developer never does.
 *
 * So one refresh runs and the rest await its result. Scoped to this process,
 * which matches how the service is deployed; more than one instance would need
 * the same guard in the database, since the token is shared state.
 */
const refreshing = new Map<string, Promise<string | undefined>>();

async function performRefresh(
  sessionId: string,
  refreshToken: string,
  storedRefreshToken: string | null,
): Promise<string | undefined> {
  try {
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: refreshToken });

    await prisma.session.update({
      where: { id: sessionId },
      data: {
        accessToken: encryptToken(refreshed.access_token),
        // Keep the newest or the next refresh fails and the user is signed out
        // for no reason.
        refreshToken: refreshed.refresh_token
          ? encryptToken(refreshed.refresh_token)
          : storedRefreshToken,
        tokenExpiresAt: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null,
      },
    });

    return refreshed.access_token;
  } catch {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
    return undefined;
  }
}

function refreshOnce(
  sessionId: string,
  refreshToken: string,
  storedRefreshToken: string | null,
): Promise<string | undefined> {
  const inFlight = refreshing.get(sessionId);
  if (inFlight) return inFlight;

  const run = performRefresh(sessionId, refreshToken, storedRefreshToken).finally(() => {
    refreshing.delete(sessionId);
  });

  refreshing.set(sessionId, run);
  return run;
}

/**
 * Returns a usable token for a session id, refreshing first if it is about to
 * expire. Any failure resolves to undefined, which callers treat as signed out.
 */
export async function resolveSession(sessionId?: string): Promise<ResolvedSession | undefined> {
  if (!sessionId) return undefined;

  const session = await prisma.session.findUnique({ where: { id: sessionId } }).catch(() => null);
  if (!session) return undefined;

  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
    return undefined;
  }

  let accessToken = decryptToken(session.accessToken);
  const refreshToken = decryptToken(session.refreshToken);
  const expiresAt = session.tokenExpiresAt?.getTime();
  const expiringSoon = expiresAt !== undefined && expiresAt - REFRESH_SKEW_MS < Date.now();

  if (expiringSoon && refreshToken) {
    accessToken = (await refreshOnce(sessionId, refreshToken, session.refreshToken)) ?? '';
    if (!accessToken) return undefined;
  } else if (expiringSoon) {
    // Expired with nothing to refresh from.
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
    return undefined;
  }

  if (!accessToken) return undefined;

  // Best-effort liveness marker; never block a request on it.
  void prisma.session
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return { sessionId, userId: session.openProjectId, accessToken };
}

export async function destroySession(sessionId?: string): Promise<void> {
  if (!sessionId) return;
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

export function isSignInConfigured(): boolean {
  return Boolean(env.OPENPROJECT_OAUTH_CLIENT_ID && env.OPENPROJECT_OAUTH_CLIENT_SECRET);
}
