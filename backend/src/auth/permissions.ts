/**
 * EPM permission vocabulary, and how it derives from OpenProject.
 *
 * OpenProject stays authoritative. Nothing here invents an allowance: every
 * permission is either mapped from a capability OpenProject reports for the
 * signed-in user, or — where OpenProject has no capability for it — denied and
 * recorded in `UNMAPPED` below.
 *
 * Two authoritative sources are combined, because neither covers everything:
 *
 *   1. `GET /api/v3/capabilities` answers "may this user do X, globally or in
 *      project N". It defines 48 actions and is the source for create/read/
 *      update style permissions.
 *
 *   2. The HAL link rels on a specific record answer "may this user do X to
 *      *this* row". The capabilities vocabulary has no delete action at all, so
 *      deletion is resolved per record at enforcement time — which is also more
 *      accurate, since it accounts for workflow rules and record state.
 *
 * A permission that cannot be sourced from either is denied. That is deliberate:
 * a fabricated `true` here becomes a button that leads to a 403, or worse, an
 * action the backend wrongly allows.
 */

export const PERMISSIONS = [
  // Project
  'project:view',
  'project:create',
  'project:edit',
  'project:archive',

  // Work package
  'task:view',
  'task:create',
  'task:edit',
  'task:delete',
  'task:assign',
  'task:status_change',

  // Membership
  'member:view',
  'member:manage',

  // Sprint (OpenProject versions)
  'sprint:view',
  'sprint:manage',

  // Time
  'time:view',
  'time:log',

  // Document
  'document:view',
  'document:upload',

  // Administration
  'users:manage',
  'groups:manage',
  'departments:manage',
  'teams:manage',
  'roles:manage',
  'system:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionSet = Record<Permission, boolean>;

/**
 * Permissions with no capability behind them in OpenProject 15.5.1.
 *
 * These are denied rather than guessed. Each notes what an authoritative
 * source would have to be before the permission can be granted.
 */
export const UNMAPPED: Partial<Record<Permission, string>> = {
  'task:delete':
    'No delete action exists in the capabilities vocabulary. Resolved per record from the work package\'s `delete` HAL link at enforcement time.',
  'sprint:manage':
    'No versions action exists. Resolved per project from the project\'s version-creation affordance.',
  'time:view': 'No time_entries action exists in the capabilities vocabulary.',
  'time:log': 'No time_entries action exists in the capabilities vocabulary.',
  'document:upload': 'No documents action exists in the capabilities vocabulary.',
  'groups:manage': 'No groups action exists in the capabilities vocabulary.',
  // Still unmapped from OpenProject, and deliberately so — nothing upstream
  // implies it. It is granted from EPM's own `epm_permission_grants` instead,
  // which is where a permission belongs when EPM owns the domain. See
  // `auth/grants.ts`.
  'departments:manage':
    'Department is EPM-owned metadata; no upstream equivalent. Granted from EPM permission grants instead.',
  'teams:manage': 'Teams map to OpenProject groups, which expose no capability.',
  'roles:manage': 'No roles action exists in the capabilities vocabulary.',
  'system:manage': 'Instance administration has no API; OpenProject admin UI only.',
};

/**
 * OpenProject action -> the EPM permissions it grants.
 *
 * Read as: holding the action on the left implies the permissions on the right,
 * in whatever scope the capability was reported for.
 */
const ACTION_GRANTS: Record<string, Permission[]> = {
  // Projects
  'projects/create': ['project:create'],
  // Archiving is a PATCH of `active` on the project, so it is gated by the same
  // capability as any other project edit — this is how the API behaves, not an
  // assumption about intent.
  'projects/update': ['project:edit', 'project:archive'],

  // Work packages
  'work_packages/read': ['task:view', 'project:view', 'sprint:view', 'document:view'],
  'work_packages/create': ['task:create'],
  // Assignee and status are ordinary fields of a work package, so the ability to
  // set them is the ability to update it.
  'work_packages/update': ['task:edit', 'task:assign', 'task:status_change'],

  // Memberships
  'memberships/read': ['member:view'],
  'memberships/create': ['member:manage'],
  'memberships/update': ['member:manage'],
  'memberships/destroy': ['member:manage'],

  // Users
  'users/create': ['users:manage'],
  'users/update': ['users:manage'],
};

export function emptyPermissions(): PermissionSet {
  return Object.fromEntries(PERMISSIONS.map((name) => [name, false])) as PermissionSet;
}

/** Applies one OpenProject action to a permission set. */
export function grantFromAction(set: PermissionSet, action: string): void {
  for (const permission of ACTION_GRANTS[action] ?? []) {
    set[permission] = true;
  }
}

/**
 * Nested view of a permission set, for the `/me` contract.
 *
 * `task:edit` becomes `{ task: { edit: true } }`, which is what the frontend
 * permission hooks read.
 */
export function toNested(set: PermissionSet): Record<string, Record<string, boolean>> {
  const nested: Record<string, Record<string, boolean>> = {};

  for (const permission of PERMISSIONS) {
    const [group, action] = permission.split(':') as [string, string];
    nested[group] ??= {};
    nested[group][action] = set[permission];
  }

  return nested;
}
