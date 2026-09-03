import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { PERMISSIONS, type Permission, type PermissionSet } from './permissions.js';

/**
 * EPM-owned permissions.
 *
 * Everything OpenProject can answer is still answered by OpenProject. This
 * covers only the permissions it has no concept of — the ones already recorded
 * in `UNMAPPED` as having no upstream equivalent — `departments:manage`,
 * `teams:manage` and `employees:manage` — because none of a department, a team
 * or where a person sits in them is an OpenProject thing.
 *
 * That makes this a second source rather than a competing one: it is consulted
 * for questions upstream cannot be asked, and never to widen an answer upstream
 * has already given.
 */

/** Permissions that may be granted here. Anything OpenProject can answer is not. */
const GRANTABLE = new Set<Permission>([
  'departments:manage',
  'teams:manage',
  'employees:manage',
]);

export function isGrantable(permission: string): permission is Permission {
  return GRANTABLE.has(permission as Permission);
}

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Applies this user's EPM-owned permissions to their global set.
 *
 * Two sources, in order: the configured bootstrap list, then rows in the grants
 * table. The bootstrap exists because the table starts empty and there is no
 * assignment UI until Roles — without it, nobody could ever hold the first
 * permission. It is read from the environment, so no user is named in code.
 *
 * A database failure grants nothing. Unlike the overlay tables, where a missing
 * row costs one display field, guessing here would hand out an allowance.
 */
export async function applyEpmGrants(userId: string, global: PermissionSet): Promise<void> {
  if (env.EPM_ADMIN_USER_IDS.includes(userId)) {
    for (const permission of GRANTABLE) global[permission] = true;
  }

  const granted = await prisma.epmPermissionGrant
    .findMany({ where: { openProjectId: userId }, select: { permission: true } })
    .catch(() => [] as { permission: string }[]);

  for (const row of granted) {
    // Guarded rather than trusted: the column is a string, and a stale row
    // naming a permission that no longer exists must not widen the set.
    if (isPermission(row.permission) && isGrantable(row.permission)) {
      global[row.permission] = true;
    }
  }
}
