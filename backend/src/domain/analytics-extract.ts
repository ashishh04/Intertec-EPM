import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { linkId, openProject } from '../openproject/client.js';
import type {
  HalLink,
  OpMembership,
  OpPrincipal,
  OpPriority,
  OpProject,
  OpStatus,
  OpTimeEntry,
  OpType,
  OpVersion,
  OpWorkPackage,
} from '../openproject/types.js';
import { classifyPriority, classifyStatus, classifyType } from '../mapping/catalog.js';
import { labourCost } from './costs.js';

/**
 * The analytics model's sources, read as rows (BR-402).
 *
 * Three places, each for what only it has. OpenProject's API v3 for the current
 * state of projects, people, the reference lists and time; OpenProject's own
 * journal tables, through the read-only export in
 * `openproject/zzz_epm_analytics_api.rb`, for every version of every work
 * package and for unit costs, neither of which API v3 lists; and EPM's database
 * for what OpenProject has no home for — portfolios, departments, teams,
 * capacity, owners, plans, budgets and rates.
 *
 * Everything here is read with the service key, whoever asked for the refresh:
 * the model holds the whole instance, and what a viewer may see of it is
 * decided when it is read, not when it is loaded.
 */

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

export interface StatusRow {
  statusId: number;
  name: string;
  isClosed: boolean;
  /** EPM's reading: `done` is delivered; Rejected is closed but `blocked`. */
  category: string;
  isDefault: boolean;
  position: number | null;
}

export interface TypeRow {
  typeId: number;
  name: string;
  isMilestone: boolean;
  category: string;
  position: number | null;
}

export interface PriorityRow {
  priorityId: number;
  name: string;
  category: string;
  position: number | null;
  isDefault: boolean;
}

export interface ProjectRow {
  projectId: number;
  identifier: string | null;
  name: string;
  parentProjectId: number | null;
  active: boolean;
  public: boolean;
  portfolioId: string | null;
  ownerUserId: number | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  budgetTotal: number | null;
  createdAt: string | null;
}

export interface PortfolioRow {
  portfolioId: string;
  code: string | null;
  name: string;
  active: boolean;
  createdAt: string | null;
}

export interface DepartmentRow {
  departmentId: string;
  code: string | null;
  name: string;
  managerUserId: number | null;
  active: boolean;
  createdAt: string | null;
}

export interface TeamRow {
  teamId: string;
  code: string | null;
  name: string;
  departmentId: string | null;
  leadUserId: number | null;
  active: boolean;
  createdAt: string | null;
}

export interface UserRow {
  userId: number;
  name: string;
  status: string;
  /** `service` for EPM's automation account, which is not a person. */
  kind: 'person' | 'service';
  departmentId: string | null;
  teamId: string | null;
  /** Null for anyone without an EPM profile: not planned, rather than zero. */
  weeklyCapacityHours: number | null;
  createdAt: string | null;
}

export interface MembershipRow {
  projectId: number;
  userId: number;
  roles: string[];
}

export interface VersionRow {
  versionId: number;
  projectId: number | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
  committedPoints: number | null;
}

/** One version of one work package, as the export returns it. */
export interface JournalVersion {
  id: number;
  workPackageId: number;
  version: number;
  userId: number | null;
  changedAt: string;
  validFrom: string;
  hasNotes: boolean;
  projectId: number;
  typeId: number;
  statusId: number;
  priorityId: number | null;
  assigneeId: number | null;
  accountableId: number | null;
  authorId: number | null;
  parentId: number | null;
  versionId: number | null;
  categoryId: number | null;
  subject: string | null;
  startDate: string | null;
  dueDate: string | null;
  duration: number | null;
  doneRatio: number | null;
  derivedDoneRatio: number | null;
  estimatedHours: number | null;
  derivedEstimatedHours: number | null;
  remainingHours: number | null;
  storyPoints: number | null;
  scheduleManually: boolean | null;
  customValues: Record<string, (string | null)[]> | null;
}

export interface JournalSummary {
  journals: number;
  journaledWorkPackages: number;
  lastChangedAt: string | null;
  workPackages: number;
  costEntries: number;
  workPackageIds: number[];
  serverTime: string;
  aggregationMinutes: number;
}

export interface TimeEntryRow {
  timeEntryId: number;
  spentOn: string;
  userId: number | null;
  projectId: number | null;
  workPackageId: number | null;
  activityId: number | null;
  activityName: string | null;
  hours: number;
  cost: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CostEntryRow {
  id: number;
  projectId: number;
  workPackageId: number | null;
  userId: number | null;
  costTypeId: number | null;
  costTypeName: string | null;
  unit: string | null;
  units: number | null;
  amount: number | null;
  spentOn: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A work package as API v3 reports it now — the independent capture's source. */
export interface ApiWorkPackageRow {
  workPackageId: number;
  lockVersion: number;
  projectId: number;
  typeId: number;
  statusId: number;
  priorityId: number | null;
  assigneeUserId: number | null;
  accountableUserId: number | null;
  parentId: number | null;
  versionId: number | null;
  subject: string;
  startDate: string | null;
  dueDate: string | null;
  doneRatio: number | null;
  estimatedHours: number | null;
  /** When the page holding this row was read. */
  readAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const num = (value: string | undefined | null): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const dayOf = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** Every page of a collection, or a refusal: a model loaded from part of the data is worse than none. */
async function everything<T>(path: string, query: Parameters<typeof openProject.getAll>[1], signal?: AbortSignal) {
  const result = await openProject.getAll<T>(path, query, { signal, maxPages: 10_000 });
  if (result.truncated) {
    throw new Error(`${path} returned ${result.items.length} of ${result.total} rows; the refresh needs all of them.`);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Reference lists                                                            */
/* -------------------------------------------------------------------------- */

export interface CalendarRow {
  /** ISO weekdays worked: 1 Monday … 7 Sunday. */
  workingWeekdays: number[];
  /** One-off non-working days — holidays — as `YYYY-MM-DD`. */
  nonWorkingDays: string[];
}

/**
 * The instance's working calendar: its working week and its non-working days,
 * across the date dimension's whole range. What OpenProject schedules in, and
 * what earned value spreads a plan over.
 */
export function readCalendar(signal?: AbortSignal): Promise<CalendarRow> {
  return runAsSystem(async () => {
    const [week, holidays] = await Promise.all([
      everything<{ day: number; working: boolean }>('/days/week', {}, signal),
      everything<{ date: string }>(
        '/days/non_working',
        { filters: [{ field: 'date', operator: '<>d', values: ['2015-01-01', '2040-12-31'] }] },
        signal,
      ),
    ]);
    return {
      workingWeekdays: week.items.filter((day) => day.working).map((day) => day.day),
      nonWorkingDays: holidays.items.map((day) => day.date),
    };
  });
}

export function readStatuses(signal?: AbortSignal): Promise<StatusRow[]> {
  return runAsSystem(async () => {
    const { items } = await everything<OpStatus>('/statuses', {}, signal);
    return items.map((status) => ({
      statusId: status.id,
      name: status.name,
      isClosed: status.isClosed,
      category: classifyStatus(status),
      isDefault: status.isDefault,
      position: status.position ?? null,
    }));
  });
}

export function readTypes(signal?: AbortSignal): Promise<TypeRow[]> {
  return runAsSystem(async () => {
    const { items } = await everything<OpType>('/types', {}, signal);
    return items.map((type) => ({
      typeId: type.id,
      name: type.name,
      isMilestone: type.isMilestone,
      category: classifyType(type),
      position: type.position ?? null,
    }));
  });
}

export function readPriorities(signal?: AbortSignal): Promise<PriorityRow[]> {
  return runAsSystem(async () => {
    const { items } = await everything<OpPriority>('/priorities', {}, signal);
    return items.map((priority) => ({
      priorityId: priority.id,
      name: priority.name,
      category: classifyPriority(priority),
      position: priority.position ?? null,
      isDefault: priority.isDefault,
    }));
  });
}

/* -------------------------------------------------------------------------- */
/* Projects, portfolios and the organisation                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every project, archived ones included — their history is still history —
 * with EPM's overlay: portfolio, owner, plan and budget. The `active` filter
 * takes one value at a time, so archived projects are a second read.
 */
export function readProjects(signal?: AbortSignal): Promise<{ rows: ProjectRow[]; sourceTotal: number }> {
  return runAsSystem(async () => {
    const [active, archived, profiles] = await Promise.all([
      everything<OpProject>('/projects', { filters: [{ field: 'active', operator: '=', values: ['t'] }] }, signal),
      everything<OpProject>('/projects', { filters: [{ field: 'active', operator: '=', values: ['f'] }] }, signal),
      prisma.projectProfile.findMany({
        select: {
          openProjectId: true,
          portfolioId: true,
          ownerId: true,
          plannedStart: true,
          plannedFinish: true,
          budgetTotal: true,
        },
      }),
    ]);
    const overlay = new Map(profiles.map((profile) => [profile.openProjectId, profile]));

    const rows = [...active.items, ...archived.items].map((project): ProjectRow => {
      const profile = overlay.get(String(project.id));
      return {
        projectId: project.id,
        identifier: project.identifier ?? null,
        name: project.name,
        parentProjectId: num(linkId(project._links, 'parent')),
        active: project.active,
        public: project.public,
        portfolioId: profile?.portfolioId ?? null,
        ownerUserId: num(profile?.ownerId),
        plannedStart: dayOf(profile?.plannedStart),
        plannedFinish: dayOf(profile?.plannedFinish),
        budgetTotal: profile?.budgetTotal ?? null,
        createdAt: project.createdAt ?? null,
      };
    });

    return { rows, sourceTotal: active.total + archived.total };
  });
}

export async function readPortfolios(): Promise<PortfolioRow[]> {
  const rows = await prisma.portfolio.findMany({
    select: { id: true, code: true, name: true, active: true, createdAt: true },
  });
  return rows.map((row) => ({
    portfolioId: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function readDepartments(): Promise<DepartmentRow[]> {
  const rows = await prisma.department.findMany({
    select: { id: true, code: true, name: true, managerId: true, active: true, createdAt: true },
  });
  return rows.map((row) => ({
    departmentId: row.id,
    code: row.code,
    name: row.name,
    managerUserId: num(row.managerId),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function readTeams(): Promise<TeamRow[]> {
  const rows = await prisma.team.findMany({
    select: { id: true, code: true, name: true, departmentId: true, leadId: true, active: true, createdAt: true },
  });
  return rows.map((row) => ({
    teamId: row.id,
    code: row.code,
    name: row.name,
    departmentId: row.departmentId,
    leadUserId: num(row.leadId),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Every account, with where EPM places it and its weekly capacity. The
 * automation account is kept, marked `service`: it is who made a rule's
 * changes, so the journal needs it, and it is nobody's capacity.
 */
export function readUsers(
  automationUserId: string | undefined,
  signal?: AbortSignal,
): Promise<{ rows: UserRow[]; sourceTotal: number }> {
  return runAsSystem(async () => {
    const [users, profiles] = await Promise.all([
      everything<OpPrincipal>('/users', { pageSize: 200 }, signal),
      prisma.userProfile.findMany({
        select: { openProjectId: true, departmentId: true, teamId: true, hoursCapacity: true },
      }),
    ]);
    const overlay = new Map(profiles.map((profile) => [profile.openProjectId, profile]));

    const rows = users.items.map((user): UserRow => {
      const profile = overlay.get(String(user.id));
      const service = automationUserId !== undefined && String(user.id) === automationUserId;
      return {
        userId: user.id,
        name: user.name,
        status: user.status ?? 'active',
        kind: service ? 'service' : 'person',
        departmentId: profile?.departmentId ?? null,
        teamId: profile?.teamId ?? null,
        weeklyCapacityHours: service ? null : (profile?.hoursCapacity ?? null),
        createdAt: user.createdAt ?? null,
      };
    });
    return { rows, sourceTotal: users.total };
  });
}

/**
 * Project memberships of people. A group's membership is not a person's; the
 * automation account is left out, as everywhere people are counted.
 */
export function readMemberships(
  automationUserId: string | undefined,
  signal?: AbortSignal,
): Promise<{ rows: MembershipRow[]; sourceTotal: number }> {
  return runAsSystem(async () => {
    const memberships = await everything<OpMembership>('/memberships', { pageSize: 200 }, signal);
    const byKey = new Map<string, MembershipRow>();
    for (const membership of memberships.items) {
      const principal = membership._links?.principal as HalLink | undefined;
      const projectId = num(linkId(membership._links, 'project'));
      const userId = num(linkId(membership._links, 'principal'));
      if (projectId === null || userId === null) continue;
      if (!principal?.href?.includes('/users/')) continue;
      if (automationUserId !== undefined && String(userId) === automationUserId) continue;

      const roles = ((membership._links?.roles as HalLink[] | undefined) ?? [])
        .map((role) => role.title ?? '')
        .filter(Boolean);
      const key = `${projectId}:${userId}`;
      const existing = byKey.get(key);
      if (existing) existing.roles = [...new Set([...existing.roles, ...roles])];
      else byKey.set(key, { projectId, userId, roles });
    }
    return { rows: [...byKey.values()], sourceTotal: byKey.size };
  });
}

/** Every version, with the committed points EPM keeps for a sprint. */
export function readVersions(signal?: AbortSignal): Promise<VersionRow[]> {
  return runAsSystem(async () => {
    const [versions, sprints] = await Promise.all([
      everything<OpVersion>('/versions', { pageSize: 200 }, signal),
      prisma.sprintProfile.findMany({ select: { openProjectId: true, committedPoints: true } }),
    ]);
    const committed = new Map(sprints.map((row) => [row.openProjectId, row.committedPoints]));
    return versions.items.map((version) => ({
      versionId: version.id,
      projectId: num(linkId(version._links, 'definingProject')),
      name: version.name,
      startDate: version.startDate ?? null,
      endDate: version.endDate ?? null,
      status: version.status,
      committedPoints: committed.get(String(version.id)) ?? null,
    }));
  });
}

/* -------------------------------------------------------------------------- */
/* Work package history and unit costs (the export)                           */
/* -------------------------------------------------------------------------- */

const EXPORT_PAGE = 2000;

/**
 * Work package versions changed after `cursor`, a page at a time, oldest
 * change first. The cursor is the export's own and is passed back verbatim:
 * it carries microseconds a `Date` would round away.
 */
export async function* journalPages(
  cursor: string | null,
  signal?: AbortSignal,
): AsyncGenerator<{ rows: JournalVersion[]; next: string | null }> {
  let at = cursor;
  for (;;) {
    const page = await runAsSystem(() =>
      openProject.request<{ journals: JournalVersion[]; count: number; next: string | null }>(
        '/epm_admin/analytics/journals',
        { root: true, query: { limit: EXPORT_PAGE, cursor: at ?? undefined }, signal },
      ),
    );
    yield { rows: page.journals, next: page.next };
    if (!page.next) return;
    at = page.next;
  }
}

export function readJournalSummary(signal?: AbortSignal): Promise<JournalSummary> {
  return runAsSystem(() =>
    openProject.request<JournalSummary>('/epm_admin/analytics/journals/summary', { root: true, signal }),
  );
}

export async function* costEntryPages(
  cursor: string | null,
  signal?: AbortSignal,
): AsyncGenerator<{ rows: CostEntryRow[]; next: string | null }> {
  let at = cursor;
  for (;;) {
    const page = await runAsSystem(() =>
      openProject.request<{ costEntries: CostEntryRow[]; count: number; next: string | null }>(
        '/epm_admin/analytics/cost_entries',
        { root: true, query: { limit: EXPORT_PAGE, cursor: at ?? undefined }, signal },
      ),
    );
    yield { rows: page.costEntries, next: page.next };
    if (!page.next) return;
    at = page.next;
  }
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Time entries — every one, or those changed since `since` — with labour cost
 * at the person's hourly rate, priced by the same rule as `domain/costs.ts`:
 * the current rate, and no cost at all for someone without one.
 */
export function readTimeEntries(
  since: string | null,
  signal?: AbortSignal,
): Promise<{ rows: TimeEntryRow[]; sourceTotal: number }> {
  return runAsSystem(async () => {
    const [entries, rates] = await Promise.all([
      everything<OpTimeEntry>(
        '/time_entries',
        {
          filters: since ? [{ field: 'updatedAt', operator: '<>d', values: [since, ''] }] : [],
          pageSize: 200,
        },
        signal,
      ),
      prisma.userProfile.findMany({
        where: { hourlyRate: { not: null } },
        select: { openProjectId: true, hourlyRate: true },
      }),
    ]);
    const rateOf = new Map(rates.map((row) => [row.openProjectId, row.hourlyRate ?? 0]));

    const rows = entries.items.map((entry): TimeEntryRow => {
      const userId = linkId(entry._links, 'user');
      const hours = durationToHours(entry.hours) ?? 0;
      const rate = userId ? rateOf.get(userId) : undefined;
      return {
        timeEntryId: entry.id,
        spentOn: entry.spentOn,
        userId: num(userId),
        projectId: num(linkId(entry._links, 'project')),
        workPackageId: num(linkId(entry._links, 'workPackage')),
        activityId: num(linkId(entry._links, 'activity')),
        activityName: (entry._links?.activity as { title?: string } | undefined)?.title ?? null,
        hours,
        cost: rate === undefined ? null : labourCost(hours, rate),
        createdAt: entry.createdAt ?? null,
        updatedAt: entry.updatedAt ?? null,
      };
    });
    return { rows, sourceTotal: entries.total };
  });
}

/** How many time entries API v3 holds in all — for reconciliation. */
export function countTimeEntries(signal?: AbortSignal): Promise<number> {
  return runAsSystem(async () => {
    const page = await openProject.getCollection<OpTimeEntry>('/time_entries', { filters: [], pageSize: 1 }, signal);
    return page.total ?? 0;
  });
}

/* -------------------------------------------------------------------------- */
/* Current work package state, from API v3                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every work package as API v3 reports it now, with when each page was read.
 *
 * Deliberately not from the journals: this is the independent capture that
 * reconstruction from the journals is checked against (BR-403), so it must
 * reach the answer by another route.
 */
export function readWorkPackagesFromApi(signal?: AbortSignal): Promise<ApiWorkPackageRow[]> {
  return runAsSystem(async () => {
    const rows: ApiWorkPackageRow[] = [];
    let offset = 1;
    for (;;) {
      const page = await openProject.getCollection<OpWorkPackage & { storyPoints?: number | null }>(
        '/work_packages',
        {
          filters: [{ field: 'status', operator: '*', values: [] }],
          sortBy: [['id', 'asc']],
          offset,
          pageSize: 200,
        },
        signal,
      );
      const readAt = new Date();
      const elements = page._embedded?.elements ?? [];
      for (const wp of elements) {
        // A milestone has one date, which OpenProject stores as both start and finish.
        const date = wp.date ?? null;
        rows.push({
          workPackageId: wp.id,
          lockVersion: wp.lockVersion,
          projectId: Number(linkId(wp._links, 'project')),
          typeId: Number(linkId(wp._links, 'type')),
          statusId: Number(linkId(wp._links, 'status')),
          priorityId: num(linkId(wp._links, 'priority')),
          assigneeUserId: num(linkId(wp._links, 'assignee')),
          accountableUserId: num(linkId(wp._links, 'responsible')),
          parentId: num(linkId(wp._links, 'parent')),
          versionId: num(linkId(wp._links, 'version')),
          subject: wp.subject,
          startDate: date ?? wp.startDate ?? null,
          dueDate: date ?? wp.dueDate ?? null,
          doneRatio: wp.percentageDone ?? null,
          estimatedHours: durationToHours(wp.estimatedTime) ?? null,
          readAt,
        });
      }
      if (elements.length === 0 || rows.length >= (page.total ?? 0)) break;
      offset += 1;
    }
    return rows;
  });
}
