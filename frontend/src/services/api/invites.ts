import { ApiError } from './client';
import type { InviteRepository } from '../repositories';
import { env } from '@/config/env';
import type { InviteInfo } from '@/types';

/**
 * Invitations, as seen by the person who received one.
 *
 * Both calls are made by someone with no session yet, so they deliberately do
 * not go through the shared client: it answers every 401 by sending the
 * browser to the sign-in page, and a person who has not set a password yet has
 * nothing to sign in with. Everything else — base URL, JSON, the error shape —
 * matches the shared client, so callers see the same `ApiError`.
 *
 * The token is only ever sent in the path. It is never logged, echoed in an
 * error, or rendered.
 */
async function publicRequest<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method: init.method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(
      'Unable to reach the EPM backend. Check your connection and try again.',
      0,
      'NETWORK',
    );
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { message?: string; code?: string };
      message = payload.message ?? message;
      code = payload.code;
    } catch {
      // Non-JSON error body — keep the status-based message.
    }
    throw new ApiError(message, response.status, code);
  }

  return (await response.json()) as T;
}

/** What accepting returns: the username to sign in with. Never a session. */
export interface AcceptedInvite {
  login: string;
}

export class ApiInviteRepository implements InviteRepository {
  /** 404 when the token is unknown; otherwise the state says whether it can still be used. */
  get(token: string): Promise<InviteInfo> {
    return publicRequest<InviteInfo>(`/invites/${encodeURIComponent(token)}`, { method: 'GET' });
  }

  /** 410 when the invitation expired or was already used between loading and submitting. */
  accept(token: string, password: string): Promise<AcceptedInvite> {
    return publicRequest<AcceptedInvite>(`/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: { password },
    });
  }
}
