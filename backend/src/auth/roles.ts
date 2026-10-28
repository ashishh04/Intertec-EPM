import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { GRANTABLE_PERMISSIONS } from './grants.js';
import type { Permission, PermissionSet } from './permissions.js';

/**
 * EPM roles: what kind of person someone is in the organisation, as opposed
 * to what they may do inside one project (their OpenProject role there).
 *
 * A role does two things. It picks the screens and the sidebar the person
 * works in, and it carries a bundle of EPM's own permissions, so a manager
 * or an HR officer does not need a dozen grants one by one. Individual grants
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

export const APP_ROLES = ['admin', 'manager', 'hr', 'employee', 'external'] as const;

export type AppRole = (typeof APP_ROLES)[number];

/** The roles an administrator may give someone. */
export const ASSIGNABLE_ROLES = ['manager', 'hr', 'employee', 'external'] as const satisfies readonly AppRole[];

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly unknown[]).includes(value);
}

/**
 * The roles kept in `user_profiles.appRole`: the internal ones other than the
 * default. Employee is the absence of a value, and External is the profile's
 * `external` flag. A stored value is kept while someone is external, so they
 * return to it if they are made internal again.
 */
const STORED_ROLES = ['manager', 'hr'] as const;

export type StoredRole = (typeof STORED_ROLES)[number];

export function isStoredRole(value: unknown): value is StoredRole {
  return (STORED_ROLES as readonly unknown[]).includes(value);
}

/**
 * What each role brings with it. Only EPM-owned permissions: anything
 * OpenProject answers stays OpenProject's, whatever the role.
 */
export const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  admin: GRANTABLE_PERMISSIONS,
  // Runs projects and people's time: plans resources, reads project health
  // and money, compares scenarios and sends reports.
  manager: [
    'health:manage',
    'resources:plan',
    'scenarios:manage',
    'reports:schedule',
    'finance:view',
  ],
  // Looks after the organisation and its people: departments, teams, who sits
  // where, their rates, and everyone's timesheets.
  hr: ['departments:manage', 'teams:manage', 'employees:manage', 'rates:view', 'timesheets:manage'],
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
  manager: {
    label: 'Manager',
    description: 'Runs projects and people\'s time: resources, health, scenarios, finance and reports.',
  },
  hr: {
    label: 'HR',
    description: 'Looks after people: departments, teams, staffing, rates and everyone\'s timesheets.',
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
  return isStoredRole(stored) ? stored : 'employee';
}

/** Adds a role's bundle to a permission set. */
export function applyRole(role: AppRole, global: PermissionSet): void {
  for (const permission of ROLE_PERMISSIONS[role]) global[permission] = true;
}
