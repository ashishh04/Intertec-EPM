import { referenceCache } from '../lib/cache.js';
import { openProject } from '../openproject/client.js';
import { applyEpmGrants } from './grants.js';
import {
  emptyPermissions,
  grantFromAction,
  type Permission,
  type PermissionSet,
} from './permissions.js';

/**
 * Effective permissions for the signed-in user, read from OpenProject.
 *
 * Capabilities are reported per (action, context, principal). Context is either
 * a project or global, so the same user can hold `work_packages/update` in one
 * project and not in another. That distinction is preserved here rather than
 * flattened, because flattening it is exactly how a user ends up able to edit a
 * project they only have read access to.
 *
 * Everything is fetched with the caller's own token, so OpenProject decides what
 * it will admit to — this cannot report more than the user actually has.
 */

interface OpCapability {
  id: string;
  _links: {
    action?: { href?: string };
    context?: { href?: string; title?: string };
    principal?: { href?: string };
  };
}

export interface EffectivePermissions {
  /** Permissions that hold regardless of project. */
  global: PermissionSet;
  /** Project id -> permissions within that project. */
  byProject: Map<string, PermissionSet>;
}

function actionOf(capability: OpCapability): string | undefined {
  // "/api/v3/actions/work_packages/update" -> "work_packages/update"
  const href = capability._links.action?.href;
  return href?.split('/api/v3/actions/')[1];
}

function projectOf(capability: OpCapability): string | undefined {
  const href = capability._links.context?.href;
  if (!href?.startsWith('/api/v3/projects/')) return undefined;
  return href.slice('/api/v3/projects/'.length);
}

/**
 * Reads every capability OpenProject reports for a user.
 *
 * A failure here resolves to "no permissions" rather than throwing. Denying
 * everything degrades the UI to read-only; letting the error propagate would
 * take down the session entirely, and guessing would be worse than both.
 */
/**
 * How long a permission set is reused before being read again.
 *
 * Permissions were being fetched on *every* authenticated request: `guard`
 * caches them on the request object, which covers one handler asking twice but
 * nothing beyond it. A dashboard load is fourteen requests, so it was fourteen
 * `/capabilities` round trips for an answer that had not changed — the single
 * largest avoidable cost in the product, and worst exactly when the instance is
 * slow and every round trip hurts.
 *
 * A minute is short enough that a permission change is felt almost immediately,
 * and `forgetPermissions` below shortens it to nothing for the case that
 * actually matters: the person who just created a project expecting to be able
 * to edit it.
 */
const PERMISSION_TTL_MS = 60_000;

/** Cache key prefix. Shared with `forgetPermissions`, so the two cannot drift. */
const permissionKey = (userId: string) => `permissions:${userId}`;

/**
 * Drops a person's cached permissions.
 *
 * Called after any successful write, for the caller. Creating a project grants
 * the creator rights on it, and waiting out the TTL to discover that is the one
 * staleness anybody would actually notice.
 */
export function forgetPermissions(userId: string): void {
  referenceCache.invalidate(permissionKey(userId));
}

export async function loadPermissions(
  userId: string,
  signal?: AbortSignal,
): Promise<EffectivePermissions> {
  try {
    return await referenceCache.get(
      permissionKey(userId),
      () => readPermissions(userId, signal),
      PERMISSION_TTL_MS,
    );
  } catch {
    /*
     * Upstream could not be asked, so this person's permissions are unknown.
     *
     * Degrading to "EPM grants only" is the long-standing behaviour and is the
     * safe direction — it denies rather than invents. What matters here is that
     * it is **not cached**: a rejected loader stores nothing, so one failed
     * capabilities read costs one request rather than locking the person out of
     * everything for the life of the cache entry. Caching the degraded set was a
     * real regression when this cache was introduced; it turned a momentary
     * upstream timeout into a minute of 403s.
     */
    const global = emptyPermissions();
    await applyEpmGrants(userId, global).catch(() => undefined);
    return { global, byProject: new Map() };
  }
}

async function readPermissions(
  userId: string,
  signal?: AbortSignal,
): Promise<EffectivePermissions> {
  const global = emptyPermissions();
  const byProject = new Map<string, PermissionSet>();

  // EPM-owned permissions first, so they survive an upstream failure: they do
  // not depend on OpenProject and should not be lost when it is unreachable.
  await applyEpmGrants(userId, global);

  // Allowed to throw, and must: the caller distinguishes "no permissions" from
  // "could not find out", and only the first is worth remembering.
  const response = await openProject.getAll<OpCapability>(
    '/capabilities',
    {
      filters: [{ field: 'principal', operator: '=', values: [userId] }],
      pageSize: 200,
    },
    { signal },
  );
  const items = response.items;

  for (const capability of items) {
    const action = actionOf(capability);
    if (!action) continue;

    const projectId = projectOf(capability);

    if (projectId === undefined) {
      grantFromAction(global, action);
      continue;
    }

    let set = byProject.get(projectId);
    if (!set) {
      set = emptyPermissions();
      byProject.set(projectId, set);
    }
    grantFromAction(set, action);
  }

  return { global, byProject };
}

/**
 * Whether a permission holds, in a project when one is given.
 *
 * A project-scoped question is answered only by that project's capabilities.
 * Global permissions are not folded in: `projects/create` being global must not
 * make a user look like an editor of every project.
 */
export function allows(
  permissions: EffectivePermissions,
  permission: Permission,
  projectId?: string,
): boolean {
  if (projectId === undefined) return permissions.global[permission] === true;
  return permissions.byProject.get(projectId)?.[permission] === true;
}

/**
 * Union of global and every project permission.
 *
 * Only for "should this navigation entry exist at all" questions. Never for
 * authorising an operation — use `allows` with the target project for that.
 */
export function anywhere(permissions: EffectivePermissions, permission: Permission): boolean {
  if (permissions.global[permission]) return true;
  for (const set of permissions.byProject.values()) {
    if (set[permission]) return true;
  }
  return false;
}
