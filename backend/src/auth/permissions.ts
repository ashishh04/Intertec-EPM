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
  'employees:manage',
  'health:manage',
  'health:configure',
  'approvals:configure',
  'rules:configure',
  'portfolios:manage',
  'analytics:manage',
  'reports:schedule',
  'reports:approve',
  'rates:view',
  'audit:view',
  'evm:configure',
  'fields:configure',
  'resources:plan',
  'resources:configure',
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
  'time:view':
    'No time_entries action exists in the capabilities vocabulary. Resolved per project at enforcement time: the time entry routes forward the token and OpenProject applies `view_time_entries` itself.',
  'time:log':
    'No time_entries action exists in the capabilities vocabulary. Resolved per project at enforcement time: `POST /forms/time-entries` and the time entry writes are authorised by OpenProject, which applies `log_time` and answers with its own reason.',
  'document:upload':
    'No documents action exists in the capabilities vocabulary. Resolved at enforcement time: the upload creates an OpenProject attachment, which OpenProject authorises against the project itself.',
  'groups:manage': 'No groups action exists in the capabilities vocabulary.',
  // Still unmapped from OpenProject, and deliberately so — nothing upstream
  // implies it. It is granted from EPM's own `epm_permission_grants` instead,
  // which is where a permission belongs when EPM owns the domain. See
  // `auth/grants.ts`.
  'departments:manage':
    'Department is EPM-owned metadata; no upstream equivalent. Granted from EPM permission grants instead.',
  // Teams were once a reading of OpenProject groups; they are now EPM-owned, so
  // there is no upstream capability to map — not because groups expose none,
  // but because a team is not an OpenProject concept. Granted from EPM's own
  // permission grants. See `auth/grants.ts`.
  'teams:manage': 'Team is EPM-owned metadata; no upstream equivalent. Granted from EPM permission grants instead.',
  // Assigning people into EPM's org structure is a different responsibility
  // from designing it: staffing a team is not the same as being able to retire
  // one, and requiring both would mean nobody could do the first without the
  // second. OpenProject has no concept of an EPM department, so nothing
  // upstream implies this either. Granted from EPM's own permission grants.
  'employees:manage':
    'Employee mapping is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // Health is EPM's own management read on a project, so its authority is EPM's
  // to grant. Deliberately not derived from `projects/update`: being able to
  // edit a project upstream is not the same as being trusted to overrule what
  // EPM's rules say about its delivery.
  'health:manage':
    'Project health is an EPM judgement; no upstream equivalent. Granted from EPM permission grants instead.',
  // Setting the rules every project's health is computed by is a different
  // responsibility from overruling one project's result: an override is a
  // judgement about one project, the rules are policy for all of them. Kept
  // apart so a project manager trusted with the first is not handed the second.
  'health:configure':
    'The health rules are EPM-owned policy; no upstream equivalent. Granted from EPM permission grants instead.',
  // Approval chains decide who signs off what across every project: policy, like
  // the health rules. Deciding an approval needs no permission at all — only
  // being the approver the chain named, or their delegate.
  'approvals:configure':
    'Approval chains are EPM-owned policy; no upstream equivalent. Granted from EPM permission grants instead.',
  // Rules act on any project's work as the automation account, and escalation
  // policies decide who is chased about it: policy again, and powerful enough
  // to keep apart from the approval chains.
  'rules:configure':
    'Automation rules and escalation policies are EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // Grouping projects into portfolios is a structural responsibility of its
  // own, like departments and teams, and OpenProject has no portfolio concept
  // to derive it from. Granted from EPM's own permission grants.
  'portfolios:manage':
    'Portfolio is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // Reading analytics needs only a session. Capturing a snapshot writes the
  // historical record, and a bad or partial run is not something an ordinary
  // user should be able to cause — a real distinction, not an invented one.
  'analytics:manage':
    'Capturing metric snapshots is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // Scheduled reports send portfolio figures by email on a timetable, to people
  // and to addresses outside the organisation: a distribution responsibility,
  // granted rather than implied by any project role.
  'reports:schedule':
    'Scheduled report distribution is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // Approving external recipients is kept apart from defining the report, so
  // the person who adds an outside address is not the one who lets it receive.
  'reports:approve':
    'Approving external recipients of scheduled reports is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // A person's internal hourly rate, and the cost of one person's time, are
  // pay information: not something every signed-in colleague should read
  // (BRL-01). The rates are EPM's, so the permission is too. Whoever sets
  // rates (employees:manage) sees them without it.
  'rates:view':
    'Hourly rates are EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // Reading the whole journal — every change EPM recorded, across projects and
  // organisation data — is an oversight role (audit, security), kept apart
  // from administering anything.
  'audit:view':
    'The instance-wide journal is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // How each type of work earns value is policy for every project's figures,
  // like the health rules: granted, not implied by a project role.
  'evm:configure':
    'The earned value rules are EPM-owned policy; no upstream equivalent. Granted from EPM permission grants instead.',
  // A calculated field's formula sets figures on every project's work, and
  // EPM makes and owns the OpenProject field behind it: a definition for the
  // whole instance, granted rather than implied by a project role.
  'fields:configure':
    'Calculated fields are EPM-owned definitions; no upstream equivalent. Granted from EPM permission grants instead.',
  // Planning people's time across every project — the heatmap, over-allocation,
  // levelling — reads work in projects the planner may not belong to, so it is
  // a responsibility granted, not implied by any project role. Levelling still
  // moves only work the planner may edit.
  'resources:plan':
    'Resource planning is EPM-owned; no upstream equivalent. Granted from EPM permission grants instead.',
  // The heatmap's thresholds and what counts as billable are policy for every
  // utilisation figure, like the health rules.
  'resources:configure':
    'The resource settings are EPM-owned policy; no upstream equivalent. Granted from EPM permission grants instead.',
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
