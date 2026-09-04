import type { HalLinks, OpPrincipal } from '../openproject/types.js';
import type { AccountStatus, EpmAccount } from '../types/epm.js';

/**
 * User accounts, translated from OpenProject.
 *
 * Accounts are OpenProject's and are not stored here. This is the
 * administration view of a person — login, email, account state — as opposed
 * to `EpmUser`, the read-only directory entry every other screen uses.
 *
 * What the caller may do is read from the resource's own links, because
 * OpenProject varies them by state and reports nothing equivalent in
 * capabilities:
 *
 *   active   self memberships showUser updateImmediately lock   delete
 *   invited  self memberships showUser updateImmediately        delete
 *   locked   self memberships          updateImmediately unlock delete
 *
 * Verified against 15.5.1. `delete` is absent entirely unless the instance
 * permits admins to delete users, which is off by default — so a UI that
 * offered it unconditionally would be offering something upstream refuses.
 */

const STATUSES: AccountStatus[] = ['active', 'invited', 'registered', 'locked'];

function statusOf(value: unknown): AccountStatus {
  return STATUSES.includes(value as AccountStatus) ? (value as AccountStatus) : 'registered';
}

const has = (links: HalLinks | undefined, key: string) => Boolean(links && Object.hasOwn(links, key));

export function toEpmAccount(principal: OpPrincipal): EpmAccount {
  const links = principal._links;

  return {
    id: String(principal.id),
    login: principal.login ?? '',
    firstName: principal.firstName ?? '',
    lastName: principal.lastName ?? '',
    name: principal.name,
    email: principal.email ?? '',
    admin: principal.admin ?? false,
    status: statusOf(principal.status),
    language: principal.language,
    createdAt: principal.createdAt ?? '',
    can: {
      update: has(links, 'updateImmediately'),
      lock: has(links, 'lock'),
      unlock: has(links, 'unlock'),
      // Named `remove` rather than `delete`, which is a reserved word and
      // reads badly on a property.
      remove: has(links, 'delete'),
    },
  };
}
