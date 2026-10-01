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
  /** Internal cost of an hour. Absent when nobody has costed this person. */
  hourlyRate?: number;
}

export interface MappingInput {
  departmentId?: unknown;
  teamId?: unknown;
}

export interface CapacityInput {
  hoursCapacity?: unknown;
}

export interface RateInput {
  /** `null` clears the rate, which is not the same as setting it to zero. */
  hourlyRate?: unknown;
}

/** Hours in a week. A physical bound on capacity, not a policy one. */
const CAPACITY_MAX = 168;
/** Applied to anyone with no profile row, and the schema's own default. */
export const CAPACITY_DEFAULT = 40;
/**
 * A sanity bound on an hourly rate, not a policy one. It exists so a stray
 * keystroke cannot turn a report into a number nobody can read.
 */
const RATE_MAX = 100_000;

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
    hoursCapacity: profile?.hoursCapacity ?? CAPACITY_DEFAULT,
    // Nullable upstream of here, and stays absent rather than becoming 0: a
    // person nobody has costed is not a person who works for nothing.
    hourlyRate: profile?.hourlyRate ?? undefined,
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
  referenceCache.invalidatePrefix('users');

  return toEpmEmployee(user, profile);
}

/**
 * Validates a weekly capacity.
 *
 * Zero is allowed and meaningful — someone who contributes no hours is still a
 * member — so the lower bound is not "greater than zero". Decimals are allowed
 * because 37.5 is a real contract. There is no null: the column is NOT NULL, so
 * every person has a number, and an unmapped one reports the default.
 */
function validateCapacity(value: unknown): number {
  if (value === undefined || value === null) {
    throw EpmError.badRequest('An hoursCapacity value is required.');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw EpmError.badRequest('Capacity must be a number of hours.');
  }
  if (value < 0) throw EpmError.badRequest('Capacity cannot be negative.');
  if (value > CAPACITY_MAX) {
    throw EpmError.badRequest(`Capacity cannot exceed ${CAPACITY_MAX} hours a week.`);
  }

  // Quarter-hour resolution. Anything finer is noise in a weekly figure, and
  // storing it would show up as 37.500000001 somewhere later.
  return Math.round(value * 4) / 4;
}

/** Sets a person's weekly capacity. Independent of their org placement. */
export async function setCapacity(
  id: string,
  input: CapacityInput,
  signal: AbortSignal,
): Promise<EpmEmployee> {
  const users = await getUsers(signal);
  const user = users.find((candidate) => candidate.id === id);
  if (!user) throw EpmError.notFound('That employee');

  const hoursCapacity = validateCapacity(input.hoursCapacity);

  // What it was. A person with no row is on the documented default, which is
  // what the workload calculation would have assumed for them too.
  const existing = await prisma.userProfile
    .findUnique({ where: { openProjectId: id }, select: { hoursCapacity: true } })
    .catch(() => null);
  const previous = existing?.hoursCapacity ?? CAPACITY_DEFAULT;

  const profile = await prisma.userProfile.upsert({
    where: { openProjectId: id },
    create: { openProjectId: id, hoursCapacity },
    update: { hoursCapacity },
    include: { departmentRef: true, team: true },
  });

  // Only on a real change. Values are already quarter-hour rounded, so there is
  // no float noise to threshold against and a no-op write notifies nobody.
  if (previous !== hoursCapacity) {
    const { notifyCapacityChange } = await import('./notifications.js');
    await notifyCapacityChange({
      employeeId: id,
      employeeName: user.name,
      from: previous,
      to: hoursCapacity,
    }).catch(() => undefined);
  }

  // The directory does not carry capacity, so it does not need invalidating —
  // but it is cached per user id and a create here adds a row that other reads
  // join against, so it is dropped for consistency with the mapping write.
  referenceCache.invalidatePrefix('users');

  return toEpmEmployee(user, profile);
}

/**
 * Validates an hourly rate.
 *
 * `null` is a value here, unlike capacity: clearing a rate means "not costed",
 * and the Time & Costs report treats that differently from a rate of zero —
 * zero prices the hours at nothing, absent excludes them from the total and
 * says how many were excluded.
 */
function validateRate(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw EpmError.badRequest('An hourly rate must be a number.');
  }
  if (value < 0) throw EpmError.badRequest('An hourly rate cannot be negative.');
  if (value > RATE_MAX) {
    throw EpmError.badRequest(`An hourly rate cannot exceed ${RATE_MAX}.`);
  }

  // Currency resolution. Rates are quoted per hour, so cents are meaningful
  // where quarter-hours were not.
  return Math.round(value * 100) / 100;
}

/**
 * Sets a person's internal hourly rate.
 *
 * Its own route for the same reason capacity has one: the mapping write sends
 * department and team as a unit, and a rate edit must not be able to clear a
 * person's placement. Nobody is notified — unlike a capacity change, this is a
 * finance attribute rather than something that changes the person's week.
 */
export async function setRate(
  id: string,
  input: RateInput,
  signal: AbortSignal,
): Promise<EpmEmployee> {
  const users = await getUsers(signal);
  const user = users.find((candidate) => candidate.id === id);
  if (!user) throw EpmError.notFound('That employee');

  const hourlyRate = validateRate(input.hourlyRate);

  const profile = await prisma.userProfile.upsert({
    where: { openProjectId: id },
    create: { openProjectId: id, hourlyRate },
    update: { hourlyRate },
    include: { departmentRef: true, team: true },
  });

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

export interface Rollup {
  memberCount: number;
  capacityHours: number;
}

/**
 * Member counts and capacity totals, per team and per department.
 *
 * Aggregated over people who are actually in the directory. A profile row left
 * behind by an upstream deletion is not a person: counting one would inflate
 * both figures invisibly, and would make the count disagree with the member
 * list rendered from the same data.
 *
 * Someone with zero capacity is counted as a member contributing nothing, which
 * is a different fact from not being a member at all. Archived teams and
 * departments still aggregate — archiving is a visibility decision, and their
 * people have not gone anywhere. Department totals come from `departmentId`
 * directly rather than by summing teams, so a person with a department and no
 * team is still counted, and an archived team does not change them.
 */
export async function rollups(signal: AbortSignal): Promise<{
  byTeam: Map<string, Rollup>;
  byDepartment: Map<string, Rollup>;
}> {
  const [users, profiles, placeholders] = await Promise.all([
    getUsers(signal).catch(() => []),
    prisma.userProfile.findMany({
      select: { openProjectId: true, teamId: true, departmentId: true, hoursCapacity: true },
    }),
    // Planned headcount that has no account yet. Counted here because that is
    // the whole point of a placeholder: a team that is two people short should
    // read as short, not as fully staffed with an invisible gap. Converted ones
    // are excluded — by then the capacity is on the real person's profile and
    // counting both would double it.
    prisma.placeholderPerson.findMany({
      where: { convertedTo: null },
      select: { teamId: true, departmentId: true, hoursCapacity: true },
    }),
  ]);

  const directory = new Set(users.map((user) => user.id));
  const byTeam = new Map<string, Rollup>();
  const byDepartment = new Map<string, Rollup>();

  const add = (into: Map<string, Rollup>, key: string, hours: number) => {
    const current = into.get(key) ?? { memberCount: 0, capacityHours: 0 };
    current.memberCount += 1;
    current.capacityHours += hours;
    into.set(key, current);
  };

  for (const profile of profiles) {
    if (!directory.has(profile.openProjectId)) continue;

    if (profile.teamId) add(byTeam, profile.teamId, profile.hoursCapacity);
    if (profile.departmentId) add(byDepartment, profile.departmentId, profile.hoursCapacity);
  }

  for (const placeholder of placeholders) {
    if (placeholder.teamId) add(byTeam, placeholder.teamId, placeholder.hoursCapacity);
    if (placeholder.departmentId) {
      add(byDepartment, placeholder.departmentId, placeholder.hoursCapacity);
    }
  }

  // Float addition leaves 37.5 + 37.5 + 0.1 looking like 75.10000000000001.
  for (const rollup of [...byTeam.values(), ...byDepartment.values()]) {
    rollup.capacityHours = Math.round(rollup.capacityHours * 100) / 100;
  }

  return { byTeam, byDepartment };
}
