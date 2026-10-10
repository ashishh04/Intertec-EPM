import { prisma } from '../db/prisma.js';
import type { WorkState } from './work-definitions.js';

/**
 * The facts the semantic layer measures (BR-404), read from the analytics
 * model and nowhere else.
 *
 * Every dashboard, report and scheduled report computes its measures from
 * these, so two of them asking the same question of the same scope cannot
 * disagree: they read the same rows, at the same refresh, through the same
 * definitions. The whole model is read once per refresh and kept, keyed by the
 * refresh it came from — the next refresh, on any server, is a new key.
 *
 * What a viewer may see is applied afterwards, by project: the model holds
 * everything, and a person's view of it is the projects in which OpenProject
 * lets them read work packages.
 */

export interface WorkFact extends WorkState {
  id: number;
  projectId: number;
  typeId: number;
  statusId: number;
  priorityId: number | null;
  assigneeId: number | null;
  accountableId: number | null;
  parentId: number | null;
  versionId: number | null;
  subject: string;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string | null;
  /** When it last became closed; null while open, and in reconstructed history. */
  closedAt: string | null;
  isClosed: boolean;
  isMilestone: boolean;
  statusCategory: string;
  typeCategory: string;
  priorityCategory: string;
  estimatedHours: number | null;
  spentHours: number;
  doneRatio: number | null;
  storyPoints: number | null;
}

export interface TimeFact {
  id: number;
  spentOn: string;
  userId: number | null;
  projectId: number | null;
  workPackageId: number | null;
  hours: number;
  /** Null for hours logged by someone with no rate: not costed, rather than free. */
  cost: number | null;
}

export interface ProjectFact {
  id: number;
  name: string;
  identifier: string | null;
  parentId: number | null;
  active: boolean;
  portfolioId: string | null;
  ownerId: number | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  budget: number | null;
}

export interface PersonFact {
  id: number;
  name: string;
  status: string;
  departmentId: string | null;
  teamId: string | null;
  /** Weekly hours; the default for anyone whose capacity is not set. */
  weeklyCapacityHours: number;
  capacitySet: boolean;
}

export interface VersionFact {
  id: number;
  projectId: number | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
  committedPoints: number | null;
}

export interface NamedFact {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
  departmentId?: string | null;
}

export interface ModelFacts {
  /** The refresh these came from; null for an empty model. */
  runId: string | null;
  /**
   * The instance's non-working days, as day numbers (days since 1970-01-01),
   * over the date dimension's range: weekends off its working week, and its
   * holidays. Outside that range, Monday to Friday is assumed.
   */
  calendar: { nonWorking: Set<number>; from: number; to: number };
  /** When the data was read: the start of that refresh. */
  asOf: string | null;
  projects: Map<number, ProjectFact>;
  workPackages: WorkFact[];
  time: TimeFact[];
  people: Map<number, PersonFact>;
  /** Project → its members (people only). */
  members: Map<number, Set<number>>;
  versions: Map<number, VersionFact>;
  portfolios: Map<string, NamedFact>;
  departments: Map<string, NamedFact>;
  teams: Map<string, NamedFact>;
  statuses: Map<number, { name: string; isClosed: boolean; category: string }>;
  types: Map<number, { name: string; isMilestone: boolean; category: string }>;
  priorities: Map<number, { name: string; category: string; position: number | null }>;
  users: Map<number, { name: string; kind: string }>;
}

/**
 * Weekly capacity for a person whose own is not set — the same default the
 * people directory and the team rollups apply (`domain/employees.ts`).
 */
export const DEFAULT_WEEKLY_CAPACITY = 40;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);
const numberOrNull = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

async function latestRun(): Promise<{ runId: string; asOf: string } | null> {
  const rows = await prisma.$queryRawUnsafe<{ run_id: bigint; started_at: Date }[]>(
    `SELECT run_id, started_at FROM analytics.refresh_run WHERE status = 'succeeded' ORDER BY run_id DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? { runId: String(row.run_id), asOf: row.started_at.toISOString() } : null;
}

const DAY_MS = 86_400_000;
const dayNumber = (value: Date) => Math.round(value.getTime() / DAY_MS);

/** The non-working days of the date dimension, and the range it covers. */
async function readCalendarFacts(): Promise<ModelFacts['calendar']> {
  const [range, rows] = await Promise.all([
    prisma.$queryRawUnsafe<{ first: Date; last: Date }[]>('SELECT min(date) AS first, max(date) AS last FROM analytics.dim_date'),
    prisma.$queryRawUnsafe<{ date: Date }[]>('SELECT date FROM analytics.dim_date WHERE NOT is_working_day'),
  ]);
  return {
    nonWorking: new Set(rows.map((row) => dayNumber(row.date))),
    from: range[0]?.first ? dayNumber(range[0].first) : 0,
    to: range[0]?.last ? dayNumber(range[0].last) : -1,
  };
}

async function readModel(runId: string | null, asOf: string | null): Promise<ModelFacts> {
  const [statuses, types, priorities, projects, people, users, members, versions, portfolios, departments, teams, work, time] =
    await Promise.all([
      prisma.$queryRawUnsafe<{ status_id: number; name: string; is_closed: boolean; category: string }[]>(
        'SELECT status_id, name, is_closed, category FROM analytics.dim_status',
      ),
      prisma.$queryRawUnsafe<{ type_id: number; name: string; is_milestone: boolean; category: string }[]>(
        'SELECT type_id, name, is_milestone, category FROM analytics.dim_type',
      ),
      prisma.$queryRawUnsafe<{ priority_id: number; name: string; category: string; position: number | null }[]>(
        'SELECT priority_id, name, category, position FROM analytics.dim_priority',
      ),
      prisma.$queryRawUnsafe<
        {
          project_id: number;
          name: string;
          identifier: string | null;
          parent_project_id: number | null;
          active: boolean;
          portfolio_id: string | null;
          owner_user_id: number | null;
          planned_start: Date | null;
          planned_finish: Date | null;
          budget_total: number | null;
        }[]
      >(
        `SELECT project_id, name, identifier, parent_project_id, active, portfolio_id, owner_user_id,
                planned_start, planned_finish, budget_total
           FROM analytics.dim_project WHERE is_current`,
      ),
      prisma.$queryRawUnsafe<
        {
          user_id: number;
          name: string;
          status: string;
          department_id: string | null;
          team_id: string | null;
          weekly_capacity_hours: number | null;
          team_department_id: string | null;
        }[]
      >(
        `SELECT u.user_id, u.name, u.status, u.department_id, u.team_id, u.weekly_capacity_hours,
                t.department_id AS team_department_id
           FROM analytics.dim_user u
           LEFT JOIN analytics.dim_team t ON t.team_id = u.team_id AND t.is_current
          WHERE u.is_current AND u.kind = 'person'`,
      ),
      prisma.$queryRawUnsafe<{ user_id: number; name: string; kind: string }[]>(
        'SELECT user_id, name, kind FROM analytics.dim_user WHERE is_current',
      ),
      prisma.$queryRawUnsafe<{ project_id: number; user_id: number }[]>(
        'SELECT project_id, user_id FROM analytics.bridge_project_member',
      ),
      prisma.$queryRawUnsafe<
        {
          version_id: number;
          project_id: number | null;
          name: string;
          start_date: Date | null;
          end_date: Date | null;
          status: string;
          committed_points: number | null;
        }[]
      >(
        'SELECT version_id, project_id, name, start_date, end_date, status, committed_points FROM analytics.dim_version WHERE present',
      ),
      prisma.$queryRawUnsafe<{ portfolio_id: string; name: string; code: string | null; active: boolean }[]>(
        'SELECT portfolio_id, name, code, active FROM analytics.dim_portfolio WHERE is_current',
      ),
      prisma.$queryRawUnsafe<{ department_id: string; name: string; code: string | null; active: boolean }[]>(
        'SELECT department_id, name, code, active FROM analytics.dim_department WHERE is_current',
      ),
      prisma.$queryRawUnsafe<
        { team_id: string; name: string; code: string | null; active: boolean; department_id: string | null }[]
      >('SELECT team_id, name, code, active, department_id FROM analytics.dim_team WHERE is_current'),
      prisma.$queryRawUnsafe<
        {
          work_package_id: number;
          project_id: number;
          type_id: number;
          status_id: number;
          priority_id: number | null;
          assignee_user_id: number | null;
          accountable_user_id: number | null;
          parent_id: number | null;
          version_id: number | null;
          subject: string;
          start_date: Date | null;
          due_date: Date | null;
          created_at: Date | null;
          closed_at: Date | null;
          is_closed: boolean;
          is_milestone: boolean;
          estimated_hours: number | null;
          spent_hours: number;
          done_ratio: number | null;
          story_points: number | null;
        }[]
      >(
        `SELECT work_package_id, project_id, type_id, status_id, priority_id, assignee_user_id, accountable_user_id,
                parent_id, version_id, subject, start_date, due_date, created_at, closed_at, is_closed, is_milestone,
                estimated_hours, spent_hours, done_ratio, story_points
           FROM analytics.fact_work_package`,
      ),
      prisma.$queryRawUnsafe<
        {
          time_entry_id: number;
          spent_on: Date;
          user_id: number | null;
          project_id: number | null;
          work_package_id: number | null;
          hours: number;
          cost: number | null;
        }[]
      >('SELECT time_entry_id, spent_on, user_id, project_id, work_package_id, hours, cost FROM analytics.fact_time_entry'),
    ]);
  const calendar = await readCalendarFacts();

  const statusMap = new Map(
    statuses.map((row) => [row.status_id, { name: row.name, isClosed: row.is_closed, category: row.category }]),
  );
  const typeMap = new Map(
    types.map((row) => [row.type_id, { name: row.name, isMilestone: row.is_milestone, category: row.category }]),
  );
  const priorityMap = new Map(
    priorities.map((row) => [row.priority_id, { name: row.name, category: row.category, position: row.position }]),
  );

  const memberMap = new Map<number, Set<number>>();
  for (const row of members) {
    const set = memberMap.get(row.project_id) ?? new Set<number>();
    set.add(row.user_id);
    memberMap.set(row.project_id, set);
  }

  return {
    runId,
    asOf,
    calendar,
    statuses: statusMap,
    types: typeMap,
    priorities: priorityMap,
    projects: new Map(
      projects.map((row) => [
        row.project_id,
        {
          id: row.project_id,
          name: row.name,
          identifier: row.identifier,
          parentId: row.parent_project_id,
          active: row.active,
          portfolioId: row.portfolio_id,
          ownerId: row.owner_user_id,
          plannedStart: day(row.planned_start),
          plannedFinish: day(row.planned_finish),
          budget: numberOrNull(row.budget_total),
        },
      ]),
    ),
    people: new Map(
      people.map((row) => [
        row.user_id,
        {
          id: row.user_id,
          name: row.name,
          status: row.status,
          // A person's department follows their team's, where the team has one —
          // the rule `domain/employees.ts` applies when it maps people.
          departmentId: row.team_department_id ?? row.department_id,
          teamId: row.team_id,
          weeklyCapacityHours: row.weekly_capacity_hours ?? DEFAULT_WEEKLY_CAPACITY,
          capacitySet: row.weekly_capacity_hours !== null,
        },
      ]),
    ),
    users: new Map(users.map((row) => [row.user_id, { name: row.name, kind: row.kind }])),
    members: memberMap,
    versions: new Map(
      versions.map((row) => [
        row.version_id,
        {
          id: row.version_id,
          projectId: row.project_id,
          name: row.name,
          startDate: day(row.start_date),
          endDate: day(row.end_date),
          status: row.status,
          committedPoints: numberOrNull(row.committed_points),
        },
      ]),
    ),
    portfolios: new Map(
      portfolios.map((row) => [row.portfolio_id, { id: row.portfolio_id, name: row.name, code: row.code, active: row.active }]),
    ),
    departments: new Map(
      departments.map((row) => [
        row.department_id,
        { id: row.department_id, name: row.name, code: row.code, active: row.active },
      ]),
    ),
    teams: new Map(
      teams.map((row) => [
        row.team_id,
        { id: row.team_id, name: row.name, code: row.code, active: row.active, departmentId: row.department_id },
      ]),
    ),
    workPackages: work.map((row) => ({
      id: row.work_package_id,
      projectId: row.project_id,
      typeId: row.type_id,
      statusId: row.status_id,
      priorityId: row.priority_id,
      assigneeId: row.assignee_user_id,
      accountableId: row.accountable_user_id,
      parentId: row.parent_id,
      versionId: row.version_id,
      subject: row.subject,
      startDate: day(row.start_date),
      dueDate: day(row.due_date),
      createdAt: iso(row.created_at),
      closedAt: iso(row.closed_at),
      isClosed: row.is_closed,
      isMilestone: row.is_milestone,
      statusCategory: statusMap.get(row.status_id)?.category ?? (row.is_closed ? 'done' : 'todo'),
      typeCategory: typeMap.get(row.type_id)?.category ?? 'task',
      priorityCategory: (row.priority_id !== null ? priorityMap.get(row.priority_id)?.category : undefined) ?? 'medium',
      estimatedHours: numberOrNull(row.estimated_hours),
      spentHours: Number(row.spent_hours ?? 0),
      doneRatio: numberOrNull(row.done_ratio),
      storyPoints: numberOrNull(row.story_points),
    })),
    time: time.map((row) => ({
      id: row.time_entry_id,
      spentOn: row.spent_on.toISOString().slice(0, 10),
      userId: row.user_id,
      projectId: row.project_id,
      workPackageId: row.work_package_id,
      hours: Number(row.hours),
      cost: numberOrNull(row.cost),
    })),
  };
}

let cached: { runId: string | null; facts: Promise<ModelFacts> } | undefined;

/** The whole model as of its latest refresh, read once per refresh. */
export async function modelFacts(): Promise<ModelFacts> {
  const run = await latestRun();
  const runId = run?.runId ?? null;
  if (!cached || cached.runId !== runId) {
    const facts = readModel(runId, run?.asOf ?? null);
    cached = { runId, facts };
    // A failed read must not be kept: the next request tries again.
    facts.catch(() => {
      if (cached?.facts === facts) cached = undefined;
    });
  }
  return cached.facts;
}

/**
 * Work packages as they stood at `at`, rebuilt from their versions (BR-403),
 * in the same shape as the current facts so the same definitions measure
 * them. When each was closed is not rebuilt: history measures do not need it.
 */
export async function workFactsAsAt(at: Date, facts: ModelFacts): Promise<WorkFact[]> {
  const rows = await prisma.$queryRawUnsafe<
    {
      work_package_id: number;
      project_id: number;
      type_id: number;
      status_id: number;
      priority_id: number | null;
      assignee_user_id: number | null;
      accountable_user_id: number | null;
      parent_id: number | null;
      version_id: number | null;
      subject: string | null;
      start_date: Date | null;
      due_date: Date | null;
      is_closed: boolean | null;
      estimated_hours: number | null;
      done_ratio: number | null;
      story_points: number | null;
    }[]
  >(
    `SELECT work_package_id, project_id, type_id, status_id, priority_id, assignee_user_id, accountable_user_id,
            parent_id, version_id, subject, start_date, due_date, is_closed, estimated_hours, done_ratio, story_points
       FROM analytics.work_packages_as_at($1::timestamptz)`,
    at.toISOString(),
  );
  return rows.map((row) => {
    const status = facts.statuses.get(row.status_id);
    const type = facts.types.get(row.type_id);
    return {
      id: row.work_package_id,
      projectId: row.project_id,
      typeId: row.type_id,
      statusId: row.status_id,
      priorityId: row.priority_id,
      assigneeId: row.assignee_user_id,
      accountableId: row.accountable_user_id,
      parentId: row.parent_id,
      versionId: row.version_id,
      subject: row.subject ?? '',
      startDate: day(row.start_date),
      dueDate: day(row.due_date),
      createdAt: null,
      closedAt: null,
      isClosed: row.is_closed ?? status?.isClosed ?? false,
      isMilestone: type?.isMilestone ?? false,
      statusCategory: status?.category ?? 'todo',
      typeCategory: type?.category ?? 'task',
      priorityCategory: (row.priority_id !== null ? facts.priorities.get(row.priority_id)?.category : undefined) ?? 'medium',
      estimatedHours: numberOrNull(row.estimated_hours),
      spentHours: 0,
      doneRatio: numberOrNull(row.done_ratio),
      storyPoints: numberOrNull(row.story_points),
    };
  });
}

/** Due-date changes per work package in a period, from the versions — for churn and drift. */
export async function dueDateChanges(
  from: string,
  to: string,
): Promise<{ workPackageId: number; changedAt: string; before: string | null; after: string | null }[]> {
  const rows = await prisma.$queryRawUnsafe<
    { work_package_id: number; valid_from: Date; before: Date | null; after: Date | null }[]
  >(
    `SELECT work_package_id, valid_from, before, after FROM (
       SELECT work_package_id, valid_from, due_date AS after,
              LAG(due_date) OVER (PARTITION BY work_package_id ORDER BY version) AS before,
              LAG(version) OVER (PARTITION BY work_package_id ORDER BY version) AS previous
         FROM analytics.fact_work_package_version
     ) v
     WHERE previous IS NOT NULL
       AND before IS DISTINCT FROM after
       AND valid_from >= $1::date AND valid_from < $2::date + 1`,
    from,
    to,
  );
  return rows.map((row) => ({
    workPackageId: row.work_package_id,
    changedAt: row.valid_from.toISOString(),
    before: day(row.before),
    after: day(row.after),
  }));
}

/** When each work package first left a not-started status, for cycle time. */
export async function startedAt(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<{ work_package_id: number; started: Date }[]>(
    `SELECT v.work_package_id, MIN(v.valid_from) AS started
       FROM analytics.fact_work_package_version v
       JOIN analytics.dim_status s ON s.status_id = v.status_id
      WHERE v.work_package_id IN (SELECT (value)::int FROM jsonb_array_elements_text($1::jsonb))
        AND s.category NOT IN ('todo', 'backlog')
      GROUP BY v.work_package_id`,
    JSON.stringify(ids),
  );
  return new Map(rows.map((row) => [row.work_package_id, row.started.toISOString()]));
}
