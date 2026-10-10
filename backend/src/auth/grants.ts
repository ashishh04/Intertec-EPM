import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { PERMISSIONS, type Permission, type PermissionSet } from './permissions.js';

/**
 * EPM-owned permissions.
 *
 * Everything OpenProject can answer is still answered by OpenProject. This
 * covers only the permissions it has no concept of — the ones already recorded
 * in `UNMAPPED` as having no upstream equivalent — `departments:manage`,
 * `teams:manage`, `employees:manage` and `health:manage` — because none of a
 * department, a team, where a person sits in them, or EPM's read on how a
 * project is going is an OpenProject thing.
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
  'resources:plan',
  'resources:configure',
]);

export function isGrantable(permission: string): permission is Permission {
  return GRANTABLE.has(permission as Permission);
}

/**
 * What each grantable permission is called and lets someone do, as the
 * administration page shows it. Every grantable permission has an entry.
 */
export const GRANT_CATALOGUE: { permission: Permission; label: string; description: string }[] = [
  { permission: 'departments:manage', label: 'Manage departments', description: 'Create, rename, archive and delete departments.' },
  { permission: 'teams:manage', label: 'Manage teams', description: 'Create teams, set their lead and department, archive and delete them.' },
  { permission: 'employees:manage', label: 'Staff people', description: 'Place people in departments and teams, and set their capacity and hourly rate.' },
  { permission: 'health:manage', label: 'Override project health', description: "Set a project's health by hand, with a reason; the calculated health stays visible." },
  { permission: 'health:configure', label: 'Set the health rules', description: "Change the criteria and thresholds every project's health is calculated from." },
  { permission: 'approvals:configure', label: 'Configure approval chains', description: 'Decide who signs off what, and in what order, across every project.' },
  { permission: 'rules:configure', label: 'Configure rules and escalation', description: 'Automation rules that act as the automation account, and who is chased when work stalls.' },
  { permission: 'portfolios:manage', label: 'Manage portfolios', description: 'Create portfolios and move projects between them.' },
  { permission: 'analytics:manage', label: 'Manage analytics', description: 'Refresh the analytics model, capture snapshots and read organisation-wide trends.' },
  { permission: 'reports:schedule', label: 'Schedule reports', description: 'Send dashboards by email on a timetable.' },
  { permission: 'reports:approve', label: 'Approve report recipients', description: 'Let scheduled reports go to addresses outside the organisation.' },
  { permission: 'rates:view', label: 'Read hourly rates', description: "See people's hourly rates and the cost of one person's time." },
  { permission: 'audit:view', label: 'Read the audit journal', description: 'Read every change EPM has recorded, across projects and organisation data.' },
  { permission: 'evm:configure', label: 'Set the earned value rules', description: 'Change how each type of work earns value, and the rate for unpriced work, for every project.' },
  { permission: 'resources:plan', label: 'Plan resources', description: "See everyone's load across every project, book planned work, and level schedules — moving only work they may edit." },
  { permission: 'resources:configure', label: 'Set the resource rules', description: 'Change the heatmap thresholds, what counts as billable time, and the length of a working day.' },
];

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
  // An instance administrator reads the journal and the rates too. They can
  // grant either to themselves on the EPM permissions page, so implying them
  // widens nobody's reach — it saves a step and keeps the screens and the API
  // agreeing. Nobody can change the journal; the database refuses. Granting
  // these is for people who are not administrators: audit, finance.
  if (global['users:manage']) {
    global['audit:view'] = true;
    global['rates:view'] = true;
  }

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
