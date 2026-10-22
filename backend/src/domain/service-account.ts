import { runAsSystem } from '../auth/context.js';
import { appLog } from '../lib/log.js';
import { openProject } from '../openproject/client.js';
import { automationUserId } from './automation-account.js';

/**
 * EPM's service account (NFR06): the principal the system key belongs to once
 * `backend/openproject/setup/service-account.rb` has made it — a user that is
 * not an administrator, holding a directory role and a role in every project.
 *
 * Like the automation account it is not a person, so it is kept out of every
 * list of people. Recognised by asking OpenProject whose the system key is:
 * a non-administrator with the service login. A server still on an
 * administrator's personal key hides nobody — the administrator is a person.
 */

export const SERVICE_LOGIN = process.env.EPM_SERVICE_LOGIN || 'epm-service';

export interface SystemIdentity {
  id: string;
  login: string | null;
  admin: boolean;
  /** Whether the system key is the service account's, not a person's. */
  service: boolean;
}

let identity: Promise<SystemIdentity | null> | undefined;

/** Whose the system key is. Cached; a failure is not, so a key fixed later is picked up. */
export function systemIdentity(): Promise<SystemIdentity | null> {
  identity ??= runAsSystem(() => openProject.request<{ id: number; login?: string; admin?: boolean }>('/users/me', { timeoutMs: 10_000 }))
    .then((me) => {
      const admin = me.admin === true;
      const login = me.login ?? null;
      return { id: String(me.id), login, admin, service: !admin && login === SERVICE_LOGIN };
    })
    .catch((error: unknown) => {
      identity = undefined;
      appLog.warn({ err: error }, 'Could not tell whose the system key is');
      return null;
    });
  return identity;
}

/** The service account's user id, when the system key is the service account's. */
export async function serviceUserId(): Promise<string | undefined> {
  const me = await systemIdentity();
  return me?.service ? me.id : undefined;
}

/** Every account that is not a person — the automation account and the service account — for keeping out of lists of people. */
export async function nonPersonIds(): Promise<Set<string>> {
  const [automation, service] = await Promise.all([automationUserId().catch(() => undefined), serviceUserId().catch(() => undefined)]);
  return new Set([automation, service].filter((id): id is string => Boolean(id)));
}
