import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { GRANTABLE_PERMISSIONS } from './grants.js';
import type { Permission, PermissionSet } from './permissions.js';

/**
 * EPM roles: what kind of person someone is in the organisation, as opposed
 * to what they may do inside one project (their OpenProject role there).
 *
 * A role does two things. It picks the screens and the sidebar the person
 * works in, and it carries a bundle of EPM's own permissions, so a project
 * or delivery manager does not need a dozen grants one by one. Individual grants
 * still apply on top (`grants.ts`); a role never takes one away.
 *
 * Administrators are not assigned here. They are whoever OpenProject says
 * may manage users, plus anyone named in EPM_ADMIN_USER_IDS — so the role
 * cannot drift from the account that actually runs the instance.
 *
 * External — a client or a vendor (BR-611) — is the profile's `external`
 * flag, the switch the portal gate already reads (`auth/hook.ts`) and that
 * granting external access sets (`domain/external-access.ts`). It is not a
 * second copy of that switch, so the two cannot disagree. What an external
 * person may do is the portal's own matrix, per project: their client or
 * vendor role there.
 */

export const APP_ROLES = [
  'admin',
  'bu_head',
  'portfolio_manager',
  'program_manager',
  'project_manager',
  'delivery_manager',
  'manager',
  'employee',
  'external',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

/** The roles an administrator may give someone. */
export const ASSIGNABLE_ROLES = [
  'bu_head',
  'portfolio_manager',
  'program_manager',
  'project_manager',
  'delivery_manager',
  'manager',
  'employee',
  'external',
] as const satisfies readonly AppRole[];

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly unknown[]).includes(value);
}

/**
 * The roles that lead work rather than do it: they plan, review and decide.
 * Work only such a role may do — a review task, for one (`task-categories.ts`)
 * — names this list, so a new leadership role is added here once.
 */
export const MANAGEMENT_ROLES = [
  'admin',
  'bu_head',
  'portfolio_manager',
  'program_manager',
  'project_manager',
  'delivery_manager',
  'manager',
] as const satisfies readonly AppRole[];

export function isManagementRole(role: AppRole): boolean {
  return (MANAGEMENT_ROLES as readonly AppRole[]).includes(role);
}

/**
 * The roles kept in `user_profiles.appRole`: the internal ones other than the
 * default. Employee is the absence of a value, and External is the profile's
 * `external` flag. A stored value is kept while someone is external, so they
 * return to it if they are made internal again.
 */
const STORED_ROLES = [
  'bu_head',
  'portfolio_manager',
  'program_manager',
  'project_manager',
  'delivery_manager',
  'manager',
] as const;

export type StoredRole = (typeof STORED_ROLES)[number];

export function isStoredRole(value: unknown): value is StoredRole {
  return (STORED_ROLES as readonly unknown[]).includes(value);
}

/**
 * Roles EPM no longer has, and what someone still holding one works as. HR was
 * retired in November 2026: looking after people and their timesheets is the
 * Delivery Manager's now, and the departments are the BU Head's. A migration
 * moves the stored values; this covers a row it has not reached.
 */
const RETIRED_ROLES: Record<string, StoredRole> = { hr: 'delivery_manager' };

/**
 * What each role brings with it. Only EPM-owned permissions: anything
 * OpenProject answers stays OpenProject's, whatever the role.
 */
export const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  admin: GRANTABLE_PERMISSIONS,
  // Heads a business unit: its departments, teams and people, its portfolios
  // and the money, the project intake, and reports beyond the organisation.
  // The executive sponsor's view (PMI): everything that decides what the unit
  // invests in and how it is staffed; the instance's own settings stay with
  // the administrators.
  bu_head: [
    'departments:manage',
    'teams:manage',
    'employees:manage',
    'rates:view',
    'timesheets:manage',
    'portfolios:manage',
    'programs:manage',
    'requests:review',
    'scenarios:manage',
    'health:manage',
    'resources:plan',
    'finance:view',
    'finance:manage',
    'reports:schedule',
    'reports:approve',
    'audit:view',
  ],
  // Chooses and balances the work (PMI portfolio management): the portfolios
  // and the programs in them, the project intake, scenarios, health across
  // them, capacity, and the money they are judged on.
  portfolio_manager: [
    'portfolios:manage',
    'programs:manage',
    'requests:review',
    'scenarios:manage',
    'health:manage',
    'resources:plan',
    'timesheets:view',
    'finance:view',
    'reports:schedule',
  ],
  // Runs a program's projects together (PMI program management): programs,
  // the requests that start their projects, health, shared resources,
  // scenarios, the program's money and reports.
  program_manager: [
    'programs:manage',
    'requests:review',
    'health:manage',
    'resources:plan',
    'scenarios:manage',
    'timesheets:view',
    'finance:view',
    'reports:schedule',
  ],
  // Runs projects through their life cycle (PMI project management): the
  // project itself is theirs through its project role; EPM adds planning
  // resources, seeing the team's timesheets, the project's money and reports.
  // Overriding health stays with program and portfolio governance.
  project_manager: ['resources:plan', 'timesheets:view', 'finance:view', 'reports:schedule'],
  // Sees work delivered across projects and teams: staffing and capacity, the
  // teams, everyone's timesheets (reopening approved ones, which HR did),
  // rates for cost, health, money and reports.
  delivery_manager: [
    'resources:plan',
    'employees:manage',
    'teams:manage',
    'timesheets:manage',
    'rates:view',
    'health:manage',
    'finance:view',
    'reports:schedule',
  ],
  // A line manager running projects and people: plans resources, follows
  // everyone's timesheets, reads project health and money, compares scenarios
  // and sends reports, runs programs and reviews the project intake.
  manager: [
    'health:manage',
    'resources:plan',
    'timesheets:view',
    'scenarios:manage',
    'reports:schedule',
    'finance:view',
    'programs:manage',
    'requests:review',
  ],
  employee: [],
  // Nothing of EPM's: every route outside the portal refuses them, and in the
  // portal their client or vendor role on each project decides.
  external: [],
};

/** What each role is called and is for, in English; translated where shown. */
export const ROLE_TEXT: Record<AppRole, { label: string; description: string }> = {
  admin: {
    label: 'Administrator',
    description: 'Runs the instance: users, settings, integrations and every EPM permission.',
  },
  bu_head: {
    label: 'BU Head',
    description: 'Heads a business unit: its departments, teams and people, portfolios, money and the project intake.',
  },
  portfolio_manager: {
    label: 'Portfolio Manager',
    description: 'Chooses and balances the work: portfolios, programs, project requests, scenarios, health, capacity and money.',
  },
  program_manager: {
    label: 'Program Manager',
    description: "Runs a program's projects together: programs, project requests, health, shared resources, scenarios and money.",
  },
  project_manager: {
    label: 'Project Manager',
    description: "Runs projects through their life cycle: resources, the team's timesheets, the project's money and reports.",
  },
  delivery_manager: {
    label: 'Delivery Manager',
    description: "Sees work delivered across projects and teams: staffing, capacity, teams, everyone's timesheets, health and money.",
  },
  manager: {
    label: 'Manager',
    description: 'Runs projects, programs and people\'s time: resources, health, scenarios, finance, reports and the project requests.',
  },
  employee: {
    label: 'Employee',
    description: 'Does the work: their tasks, time, timesheets, expenses and collaboration.',
  },
  external: {
    label: 'External',
    description: 'A client or vendor: sees only the portal, and in it only the projects granted to them, with a client or vendor role on each.',
  },
};

/**
 * The person's role.
 *
 * External first: the portal gate holds an external person to the portal
 * whatever else is true of them, so that is what they are. A database failure
 * reads as `employee` — guessing upwards would hand out permissions — and the
 * portal gate reads the flag for itself.
 */
export async function resolveRole(userId: string, global: PermissionSet): Promise<AppRole> {
  const profile = await prisma.userProfile
    .findUnique({ where: { openProjectId: userId }, select: { appRole: true, external: true } })
    .catch(() => null);

  return roleOfAccount(userId, global['users:manage'] === true, profile?.appRole, profile?.external);
}

/**
 * The role an account works in, from its administrator flag, its stored role
 * and whether it is external, for screens that list accounts rather than load
 * permissions.
 */
export function roleOfAccount(
  userId: string,
  admin: boolean,
  stored: string | null | undefined,
  external = false,
): AppRole {
  if (external) return 'external';
  if (admin || env.EPM_ADMIN_USER_IDS.includes(userId)) return 'admin';
  if (isStoredRole(stored)) return stored;
  return (stored ? RETIRED_ROLES[stored] : undefined) ?? 'employee';
}

/** Adds a role's bundle to a permission set. */
export function applyRole(role: AppRole, global: PermissionSet): void {
  for (const permission of ROLE_PERMISSIONS[role]) global[permission] = true;
}
