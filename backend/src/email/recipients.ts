import { AsyncResource } from 'node:async_hooks';

import { TtlCache } from '../lib/cache.js';
import { openProject } from '../openproject/client.js';
import type { OpPrincipal } from '../openproject/types.js';

/**
 * Who an email goes to.
 *
 * EPM stores nothing about people, so an address has to be read from
 * OpenProject each time — through `/users/:id`, which only shows an email to
 * a caller allowed to see it. That is always the service key and never the
 * signed-in user: a team lead changing someone's capacity triggers a
 * notification to the department manager, and the lead's own token may not be
 * permitted to see the manager's address.
 *
 * Cached for ten minutes. A changed address takes that long to be noticed,
 * which is acceptable for mail that is already asynchronous.
 */

const TTL_MS = 10 * 60_000;

const cache = new TtlCache(TTL_MS);

/**
 * An execution context with no session in it.
 *
 * `OpenProjectClient` reads the caller's token from async-local storage and
 * falls back to the service key only when there is none. This resource is
 * created at module load, before any request exists, so running a call inside
 * it puts the client back in the no-session case whoever called us — without
 * the client needing a way to be told "use the service key this once".
 */
const serviceScope = new AsyncResource('epm.email.recipients');

const asService = <T>(fn: () => Promise<T>): Promise<T> => serviceScope.runInAsyncScope(fn);

export interface Recipient {
  email: string;
  firstName: string;
  name: string;
}

/**
 * The person's address and name, or undefined if they have no address, are
 * unknown, or cannot be read right now.
 */
export async function resolveRecipient(userId: string): Promise<Recipient | undefined> {
  if (!/^\d+$/.test(userId)) return undefined;

  const principal = await cache
    .get(`recipient:${userId}`, () =>
      asService(() => openProject.request<OpPrincipal>(`/users/${userId}`)).catch(() => null),
    )
    .catch(() => null);

  const email = principal?.email?.trim();
  if (!principal || !email) return undefined;

  return {
    email,
    firstName: principal.firstName?.trim() || principal.name,
    name: principal.name,
  };
}

export async function resolveEmail(userId: string): Promise<string | undefined> {
  return (await resolveRecipient(userId))?.email;
}

/** After an account's address changes, so the next email goes to the new one. */
export function forgetRecipient(userId: string): void {
  cache.invalidate(`recipient:${userId}`);
}
