import type { Department, Team, UserProfile } from '@prisma/client';

import { EpmError } from '../lib/errors.js';
import { getUsers } from '../mapping/users.js';
import { prisma } from '../db/prisma.js';
import { referenceCache } from '../lib/cache.js';
import type { EpmUser } from '../types/epm.js';

/**
 * Employee mapping — where a person sits in EPM's org structure.
 *
 * EPM adds no people. Identity stays OpenProject's: this joins the directory it
 * already serves onto EPM's departments and teams, keyed by the OpenProject
 * user id. A person with no mapping has no row, which is why every read below
 * treats a missing profile as "unmapped" rather than as an error — those are
 * exactly the people who need assigning, so they must still appear.
 *
 * The one rule worth stating plainly: a team belongs to at most one department,
 * so storing both a department and a team on a person makes a contradiction
 * expressible. `resolveMapping` is where that is made impossible.
 */

export interface EpmEmployee {
  /** The OpenProject user id. EPM mints no id of its own for a person. */
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  /** `active` is included so the UI can flag an assignment into an archived unit. */
  department?: { id: string; name: string; active: boolean };
  team?: { id: string; name: string; active: boolean };
  hoursCapacity: number;
}

export interface MappingInput {
  departmentId?: unknown;
  teamId?: unknown;
}

export interface EmployeeFilters {
  departmentId?: string;
  teamId?: string;
  /** Only people with neither a department nor a team. */
  unmapped?: boolean;
  /** Case-insensitive match on name or email. */
  q?: string;
}

type ProfileWithRefs = UserProfile & { departmentRef: Department | null; team: Team | null };

/** `null`, `''` and an absent key all mean "clear it". Anything else must be text. */
function asOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw EpmError.badRequest(`${field} must be text.`);
  return value.trim() || null;
}

function toEpmEmployee(user: EpmUser, profile: ProfileWithRefs | undefined): EpmEmployee {
  return {
    id: user.id,
    name: user.name,
    email: user.email || undefined,
    avatarUrl: user.avatarUrl,
    department: profile?.departmentRef
      ? {
          id: profile.departmentRef.id,
          name: profile.departmentRef.name,
          active: profile.departmentRef.active,
        }
      : undefined,
    team: profile?.team
      ? { id: profile.team.id, name: profile.team.name, active: profile.team.active }
      : undefined,
    // The schema default, applied here too so an unmapped person reports the
    // same capacity the workload endpoint would assume for them.
    hoursCapacity: profile?.hoursCapacity ?? 40,
  };
}

/**
 * Works out the department and team to store, refusing any pair that disagrees.
 *
 * A team that belongs to a department fixes the person's department: the value
 * is taken from the team rather than from the request, so the two cannot drift
 * apart later. A caller who also names a department is not silently overruled —
 * if it contradicts the team, the request is rejected and says so.
 *
 * Assignment into an archived department or team is refused, consistent with
 * the rule that a team cannot be moved into an archived department. Mappings
 * that already point at an archived unit are left alone; archiving stays a
 * visibility decision.
 */
async function resolveMapping(
  input: MappingInput,
): Promise<{ departmentId: string | null; teamId: string | null }> {
  const requestedDepartmentId = asOptionalId(input.departmentId, 'The department');
  const teamId = asOptionalId(input.teamId, 'The team');

  let team: Team | null = null;
  if (teamId) {
    team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw EpmError.badRequest('That team does not exist.');
    if (!team.active) {
      throw EpmError.badRequest('That team is archived, so nobody can be assigned to it.');
    }
  }

  // A team with a department settles the question.
  if (team?.departmentId) {
    if (requestedDepartmentId && requestedDepartmentId !== team.departmentId) {
      throw EpmError.badRequest('That team does not belong to the department given.');
    }

    // Re-read rather than trusting the team's column: the department could have
    // been archived after the team joined it, and a new assignment into it is
    // still an assignment into an archived unit.
    const department = await prisma.department.findUnique({ where: { id: team.departmentId } });
    if (!department) throw EpmError.badRequest('That team belongs to a department that no longer exists.');
    if (!department.active) {
      throw EpmError.badRequest(
        'That team belongs to an archived department, so nobody can be assigned to it.',
      );
    }

    return { departmentId: department.id, teamId: team.id };
  }

  // Either no team, or a team that belongs to no department. The department is
  // then independent, and validated on its own.
  if (requestedDepartmentId) {
    const department = await prisma.department.findUnique({ where: { id: requestedDepartmentId } });
    if (!department) throw EpmError.badRequest('That department does not exist.');
    if (!department.active) {
      throw EpmError.badRequest('That department is archived, so nobody can be assigned to it.');
    }
  }

  return { departmentId: requestedDepartmentId, teamId };
}

async function profilesById(): Promise<Map<string, ProfileWithRefs>> {
  const rows = await prisma.userProfile.findMany({
    include: { departmentRef: true, team: true },
  });
  return new Map(rows.map((row) => [row.openProjectId, row]));
}

export async function listEmployees(
  filters: EmployeeFilters,
  signal: AbortSignal,
): Promise<EpmEmployee[]> {
  const [users, profiles] = await Promise.all([getUsers(signal), profilesById()]);

  // The directory is the outer set, so people with no mapping still appear —
  // they are precisely the ones that need assigning.
  let employees = users.map((user) => toEpmEmployee(user, profiles.get(user.id)));

  if (filters.departmentId) {
    employees = employees.filter((e) => e.department?.id === filters.departmentId);
  }
  if (filters.teamId) {
    employees = employees.filter((e) => e.team?.id === filters.teamId);
  }
  if (filters.unmapped) {
    employees = employees.filter((e) => !e.department && !e.team);
  }
  if (filters.q) {
    // Filtered here rather than upstream: the directory endpoint offers no
    // search, and it is fetched whole and cached regardless.
    const term = filters.q.toLowerCase();
    employees = employees.filter(
      (e) => e.name.toLowerCase().includes(term) || (e.email ?? '').toLowerCase().includes(term),
    );
  }

  return employees.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getEmployee(id: string, signal: AbortSignal): Promise<EpmEmployee> {
  const users = await getUsers(signal);
  const user = users.find((candidate) => candidate.id === id);

  // Checked against the directory the caller can see, so this cannot be used to
  // discover whether an account exists.
  if (!user) throw EpmError.notFound('That employee');

  const profile = await prisma.userProfile.findUnique({
    where: { openProjectId: id },
    include: { departmentRef: true, team: true },
  });

  return toEpmEmployee(user, profile ?? undefined);
}

/**
 * Sets a person's department and team as one unit.
 *
 * Both fields are always written, so there is no intermediate state where the
 * pair disagrees, and clearing is expressed by sending nothing rather than by a
 * separate endpoint.
 */
export async function setMapping(
  id: string,
  input: MappingInput,
  signal: AbortSignal,
): Promise<EpmEmployee> {
  const users = await getUsers(signal);
  const user = users.find((candidate) => candidate.id === id);
  if (!user) throw EpmError.notFound('That employee');

  const { departmentId, teamId } = await resolveMapping(input);

  // Upsert: a person has no row until they are first mapped, and clearing a
  // mapping leaves the row rather than deleting it, because it also carries
  // capacity and timezone.
  const profile = await prisma.userProfile.upsert({
    where: { openProjectId: id },
    create: { openProjectId: id, departmentId, teamId },
    update: { departmentId, teamId },
    include: { departmentRef: true, team: true },
  });

  // The directory is cached for five minutes and carries the department name,
  // so it would otherwise keep reporting the old one.
  referenceCache.invalidate('users');

  return toEpmEmployee(user, profile);
}

/** People mapped to a team, for the team detail view. */
export async function listTeamMembers(teamId: string, signal: AbortSignal): Promise<EpmEmployee[]> {
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
  if (!team) throw EpmError.notFound('That team');

  return listEmployees({ teamId }, signal);
}

/** OpenProject user ids mapped to a team, for scoping workloads. */
export async function memberIdsOfTeam(teamId: string): Promise<string[]> {
  const rows = await prisma.userProfile.findMany({
    where: { teamId },
    select: { openProjectId: true },
  });
  return rows.map((row) => row.openProjectId);
}

/** Member counts per team, for the team list. */
export async function memberCounts(): Promise<Map<string, number>> {
  const grouped = await prisma.userProfile.groupBy({
    by: ['teamId'],
    where: { teamId: { not: null } },
    _count: { _all: true },
  });

  return new Map(
    grouped
      .filter((row): row is typeof row & { teamId: string } => row.teamId !== null)
      .map((row) => [row.teamId, row._count._all]),
  );
}
