import { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { message, msg } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import {
  costEntryPages,
  countTimeEntries,
  journalPages,
  readDepartments,
  readJournalSummary,
  readMemberships,
  readPortfolios,
  readPriorities,
  readProjects,
  readStatuses,
  readTeams,
  readTimeEntries,
  readTypes,
  readUsers,
  readVersions,
  type CostEntryRow,
  type DepartmentRow,
  type JournalSummary,
  type JournalVersion,
  type MembershipRow,
  type PortfolioRow,
  type PriorityRow,
  type ProjectRow,
  type StatusRow,
  type TeamRow,
  type TimeEntryRow,
  type TypeRow,
  type UserRow,
  type VersionRow,
} from './analytics-extract.js';
import { automationUserId } from './automation-account.js';
import { INSTANCE_ID, withLease } from './job-lease.js';
import { clauses, notifyAnalyticsProblem } from './notifications.js';

/**
 * The analytics model: loading it, and knowing how far to trust it (BR-402).
 *
 * A refresh reads every source first and writes nothing until it has all of
 * it, then loads the lot in one transaction — so a reader, a dashboard or a BI
 * tool on the replica, sees the model before the refresh or after it, never
 * halfway. Two kinds:
 *
 *   full         everything, every night and on demand, then reconciled: each
 *                table's rows counted against its source.
 *   incremental  what changed since the last refresh — work package versions
 *                and unit costs from the export's cursors, time entries from a
 *                watermark — plus the small lists in full, run soon after EPM
 *                hears of a change and every few minutes regardless.
 *
 * One server refreshes at a time, behind a lease. Every run is logged in
 * `analytics.refresh_run` with what it loaded, how long it took against the
 * agreed window, and how it reconciled.
 */

type Tx = Prisma.TransactionClient;

export type RefreshKind = 'full' | 'incremental';
export type RefreshTrigger = 'schedule' | 'manual' | 'change';

export interface ReconciliationLine {
  /** Stable key, e.g. `work_packages`. */
  entity: string;
  label: string;
  source: number;
  model: number;
  difference: number;
  /** How many rows of difference the tolerance allows for this entity. */
  allowed: number;
  ok: boolean;
}

export interface RefreshRun {
  id: string;
  kind: RefreshKind;
  trigger: RefreshTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  durationMs: number | null;
  windowMs: number | null;
  withinWindow: boolean | null;
  rows: Record<string, number> | null;
  reconciliation: ReconciliationLine[] | null;
  reconciled: boolean | null;
  error: string | null;
}

const LEASE = 'analytics-refresh';
const STATE = {
  journalCursor: 'journals.cursor',
  costCursor: 'cost_entries.cursor',
  timeSince: 'time_entries.since',
} as const;

/** Rows per INSERT. A JSON parameter of a few thousand rows is a few hundred kilobytes. */
const CHUNK = 2000;

/** Time entries are re-read from a little before the last refresh: their filter is by the minute. */
const TIME_OVERLAP_MS = 5 * 60_000;

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

interface Extract {
  statuses: StatusRow[];
  types: TypeRow[];
  priorities: PriorityRow[];
  projects: { rows: ProjectRow[]; sourceTotal: number };
  portfolios: PortfolioRow[];
  departments: DepartmentRow[];
  teams: TeamRow[];
  users: { rows: UserRow[]; sourceTotal: number };
  memberships: { rows: MembershipRow[]; sourceTotal: number };
  versions: VersionRow[];
  journals: JournalVersion[];
  journalCursor: string | null;
  costEntries: CostEntryRow[];
  costCursor: string | null;
  timeEntries: TimeEntryRow[];
  /** Whether `timeEntries` is every entry, rather than those changed since the watermark. */
  timeEntriesComplete: boolean;
  timeSourceTotal: number;
  timeSince: string;
  summary: JournalSummary;
}

/** The export's cursor for a row: its change time to the microsecond, then its id. */
const cursorOf = (changedAt: string, id: number) => `${changedAt}|${id}`;

async function readAll<T>(
  pages: AsyncGenerator<{ rows: T[]; next: string | null }>,
  cursorFor: (row: T) => string,
  start: string | null,
): Promise<{ rows: T[]; cursor: string | null }> {
  const rows: T[] = [];
  let cursor = start;
  for await (const page of pages) {
    rows.push(...page.rows);
    const last = page.rows[page.rows.length - 1];
    if (last) cursor = cursorFor(last);
  }
  return { rows, cursor };
}

async function extract(kind: RefreshKind, state: Map<string, string>, startedAt: Date, signal?: AbortSignal): Promise<Extract> {
  const full = kind === 'full';
  // An empty cursor is "from the beginning", stored so an instance with no
  // history yet still counts as having been loaded once.
  const journalStart = full ? null : state.get(STATE.journalCursor) || null;
  const costStart = full ? null : state.get(STATE.costCursor) || null;
  const timeSince = full ? null : state.get(STATE.timeSince) || null;
  const serviceId = await automationUserId().catch(() => undefined);

  // The small lists and the organisation, in full every time: cheap, and a
  // renamed project or a moved person is a change worth having promptly.
  const [statuses, types, priorities, projects, portfolios, departments, teams, users, memberships, versions] =
    await Promise.all([
      readStatuses(signal),
      readTypes(signal),
      readPriorities(signal),
      readProjects(signal),
      readPortfolios(),
      readDepartments(),
      readTeams(),
      readUsers(serviceId, signal),
      readMemberships(serviceId, signal),
      readVersions(signal),
    ]);

  const journals = await readAll(journalPages(journalStart, signal), (row) => cursorOf(row.changedAt, row.id), journalStart);
  const costs = await readAll(costEntryPages(costStart, signal), (row) => cursorOf(row.updatedAt ?? '', row.id), costStart);
  const time = await readTimeEntries(timeSince, signal);
  const timeSourceTotal = full ? time.sourceTotal : await countTimeEntries(signal);

  // Read last, so that anything created while the rest was being read is at
  // most one row of difference, which the tolerance is there for.
  const summary = await readJournalSummary(signal);

  return {
    statuses,
    types,
    priorities,
    projects,
    portfolios,
    departments,
    teams,
    users,
    memberships,
    versions,
    journals: journals.rows,
    journalCursor: journals.cursor,
    costEntries: costs.rows,
    costCursor: costs.cursor,
    timeEntries: time.rows,
    timeEntriesComplete: full,
    timeSourceTotal,
    timeSince: new Date(startedAt.getTime() - TIME_OVERLAP_MS).toISOString(),
    summary,
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += CHUNK) out.push(rows.slice(at, at + CHUNK));
  return out;
}

const dateKey = (column: string) => `CASE WHEN ${column} IS NULL THEN NULL ELSE to_char(${column}, 'YYYYMMDD')::int END`;

/**
 * Type 1: overwritten in place. Kept when deleted upstream, because history
 * still names them, and marked not present.
 */
async function loadReference(tx: Tx, data: Extract, now: string): Promise<number> {
  const statuses = data.statuses.map((row) => ({
    status_id: row.statusId,
    name: row.name,
    is_closed: row.isClosed,
    category: row.category,
    is_default: row.isDefault,
    position: row.position,
  }));
  const types = data.types.map((row) => ({
    type_id: row.typeId,
    name: row.name,
    is_milestone: row.isMilestone,
    category: row.category,
    position: row.position,
  }));
  const priorities = data.priorities.map((row) => ({
    priority_id: row.priorityId,
    name: row.name,
    category: row.category,
    position: row.position,
    is_default: row.isDefault,
  }));

  let written = 0;
  written += await tx.$executeRawUnsafe(
    `INSERT INTO analytics.dim_status (status_id, name, is_closed, category, is_default, position, loaded_at)
     SELECT r.status_id, r.name, r.is_closed, r.category, r.is_default, r.position, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS r(status_id int, name text, is_closed boolean, category text, is_default boolean, position int)
     ON CONFLICT (status_id) DO UPDATE SET name = EXCLUDED.name, is_closed = EXCLUDED.is_closed, category = EXCLUDED.category,
       is_default = EXCLUDED.is_default, position = EXCLUDED.position, loaded_at = EXCLUDED.loaded_at`,
    JSON.stringify(statuses),
    now,
  );
  written += await tx.$executeRawUnsafe(
    `INSERT INTO analytics.dim_type (type_id, name, is_milestone, category, position, loaded_at)
     SELECT r.type_id, r.name, r.is_milestone, r.category, r.position, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS r(type_id int, name text, is_milestone boolean, category text, position int)
     ON CONFLICT (type_id) DO UPDATE SET name = EXCLUDED.name, is_milestone = EXCLUDED.is_milestone,
       category = EXCLUDED.category, position = EXCLUDED.position, loaded_at = EXCLUDED.loaded_at`,
    JSON.stringify(types),
    now,
  );
  written += await tx.$executeRawUnsafe(
    `INSERT INTO analytics.dim_priority (priority_id, name, category, position, is_default, loaded_at)
     SELECT r.priority_id, r.name, r.category, r.position, r.is_default, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS r(priority_id int, name text, category text, position int, is_default boolean)
     ON CONFLICT (priority_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
       position = EXCLUDED.position, is_default = EXCLUDED.is_default, loaded_at = EXCLUDED.loaded_at`,
    JSON.stringify(priorities),
    now,
  );

  const present = async (table: string, key: string, ids: number[]) =>
    tx.$executeRawUnsafe(
      `UPDATE ${table} SET present = (${key} IN (SELECT (value)::int FROM jsonb_array_elements_text($1::jsonb)))
        WHERE present IS DISTINCT FROM (${key} IN (SELECT (value)::int FROM jsonb_array_elements_text($1::jsonb)))`,
      JSON.stringify(ids),
    );
  await present('analytics.dim_status', 'status_id', data.statuses.map((row) => row.statusId));
  await present('analytics.dim_type', 'type_id', data.types.map((row) => row.typeId));
  await present('analytics.dim_priority', 'priority_id', data.priorities.map((row) => row.priorityId));
  return written;
}

/** Versions (type 1, kept when deleted upstream) and project memberships (replaced every time). */
async function loadVersionsAndMembers(tx: Tx, data: Extract, now: string): Promise<Record<string, number>> {
  const versions = data.versions.map((row) => ({
    version_id: row.versionId,
    project_id: row.projectId,
    name: row.name,
    start_date: row.startDate,
    end_date: row.endDate,
    status: row.status,
    committed_points: row.committedPoints,
  }));
  const written = await tx.$executeRawUnsafe(
    `INSERT INTO analytics.dim_version (version_id, project_id, name, start_date, end_date, status, committed_points, loaded_at)
     SELECT r.version_id, r.project_id, r.name, r.start_date, r.end_date, r.status, r.committed_points, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS r(version_id int, project_id int, name text, start_date date, end_date date,
                                               status text, committed_points double precision)
     ON CONFLICT (version_id) DO UPDATE SET project_id = EXCLUDED.project_id, name = EXCLUDED.name,
       start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, status = EXCLUDED.status,
       committed_points = EXCLUDED.committed_points, loaded_at = EXCLUDED.loaded_at`,
    JSON.stringify(versions),
    now,
  );
  await tx.$executeRawUnsafe(
    `UPDATE analytics.dim_version SET present = (version_id IN (SELECT (value)::int FROM jsonb_array_elements_text($1::jsonb)))
      WHERE present IS DISTINCT FROM (version_id IN (SELECT (value)::int FROM jsonb_array_elements_text($1::jsonb)))`,
    JSON.stringify(data.versions.map((row) => row.versionId)),
  );

  await tx.$executeRawUnsafe('DELETE FROM analytics.bridge_project_member');
  let members = 0;
  for (const chunk of chunks(
    data.memberships.rows.map((row) => ({ project_id: row.projectId, user_id: row.userId, roles: row.roles })),
  )) {
    members += await tx.$executeRawUnsafe(
      `INSERT INTO analytics.bridge_project_member (project_id, user_id, roles, loaded_at)
       SELECT r.project_id, r.user_id, ARRAY(SELECT jsonb_array_elements_text(r.roles)), $2::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS r(project_id int, user_id int, roles jsonb)`,
      JSON.stringify(chunk),
      now,
    );
  }
  return { versions: written, members };
}

interface DimensionSpec {
  table: string;
  key: string;
  keyType: 'integer' | 'text';
  columns: { name: string; type: string }[];
}

const DIMENSIONS = {
  project: {
    table: 'analytics.dim_project',
    key: 'project_id',
    keyType: 'integer',
    columns: [
      { name: 'identifier', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'parent_project_id', type: 'integer' },
      { name: 'active', type: 'boolean' },
      { name: 'public', type: 'boolean' },
      { name: 'portfolio_id', type: 'text' },
      { name: 'owner_user_id', type: 'integer' },
      { name: 'planned_start', type: 'date' },
      { name: 'planned_finish', type: 'date' },
      { name: 'budget_total', type: 'double precision' },
    ],
  },
  portfolio: {
    table: 'analytics.dim_portfolio',
    key: 'portfolio_id',
    keyType: 'text',
    columns: [
      { name: 'code', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'active', type: 'boolean' },
    ],
  },
  department: {
    table: 'analytics.dim_department',
    key: 'department_id',
    keyType: 'text',
    columns: [
      { name: 'code', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'manager_user_id', type: 'integer' },
      { name: 'active', type: 'boolean' },
    ],
  },
  team: {
    table: 'analytics.dim_team',
    key: 'team_id',
    keyType: 'text',
    columns: [
      { name: 'code', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'department_id', type: 'text' },
      { name: 'lead_user_id', type: 'integer' },
      { name: 'active', type: 'boolean' },
    ],
  },
  user: {
    table: 'analytics.dim_user',
    key: 'user_id',
    keyType: 'integer',
    columns: [
      { name: 'name', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'kind', type: 'text' },
      { name: 'department_id', type: 'text' },
      { name: 'team_id', type: 'text' },
      { name: 'weekly_capacity_hours', type: 'double precision' },
    ],
  },
} satisfies Record<string, DimensionSpec>;

/**
 * Type 2: a changed entity's current row is closed at `now` and a new one
 * opened from `now`; a new entity's first row starts when it was created; an
 * entity gone upstream has its current row closed and none opened, so its
 * history stays. Whether anything changed is a hash of the attributes.
 */
async function mergeDimension(
  tx: Tx,
  spec: DimensionSpec,
  rows: Record<string, unknown>[],
  now: string,
): Promise<{ opened: number; closed: number }> {
  const names = spec.columns.map((column) => column.name);
  const definition = [
    `${spec.key} ${spec.keyType}`,
    ...spec.columns.map((column) => `${column.name} ${column.type}`),
    'created_at timestamptz',
  ].join(', ');
  const hash = (alias: string) => `md5(ROW(${names.map((name) => `${alias}.${name}`).join(', ')})::text)`;
  const stage = `stage_${spec.key}`;

  await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS pg_temp.${stage}`);
  await tx.$executeRawUnsafe(
    `CREATE TEMP TABLE ${stage} ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(${definition})`,
    JSON.stringify(rows),
  );

  const closed = await tx.$executeRawUnsafe(
    `UPDATE ${spec.table} d SET valid_to = $1::timestamptz, is_current = false
      WHERE d.is_current
        AND NOT EXISTS (SELECT 1 FROM ${stage} s WHERE s.${spec.key} = d.${spec.key} AND ${hash('s')} = d.row_hash)`,
    now,
  );

  const opened = await tx.$executeRawUnsafe(
    `INSERT INTO ${spec.table} (${spec.key}, ${names.join(', ')}, row_hash, valid_from, valid_to, is_current)
     SELECT s.${spec.key}, ${names.map((name) => `s.${name}`).join(', ')}, ${hash('s')},
            CASE WHEN EXISTS (SELECT 1 FROM ${spec.table} h WHERE h.${spec.key} = s.${spec.key})
                 THEN $1::timestamptz
                 ELSE LEAST(COALESCE(s.created_at, $1::timestamptz), $1::timestamptz) END,
            NULL, true
       FROM ${stage} s
      WHERE NOT EXISTS (SELECT 1 FROM ${spec.table} d WHERE d.${spec.key} = s.${spec.key} AND d.is_current)`,
    now,
  );

  return { opened, closed };
}

async function loadDimensions(tx: Tx, data: Extract, now: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const merge = async (name: keyof typeof DIMENSIONS, rows: Record<string, unknown>[]) => {
    const result = await mergeDimension(tx, DIMENSIONS[name], rows, now);
    counts[`dim_${name}.opened`] = result.opened;
    counts[`dim_${name}.closed`] = result.closed;
  };

  await merge(
    'project',
    data.projects.rows.map((row) => ({
      project_id: row.projectId,
      identifier: row.identifier,
      name: row.name,
      parent_project_id: row.parentProjectId,
      active: row.active,
      public: row.public,
      portfolio_id: row.portfolioId,
      owner_user_id: row.ownerUserId,
      planned_start: row.plannedStart,
      planned_finish: row.plannedFinish,
      budget_total: row.budgetTotal,
      created_at: row.createdAt,
    })),
  );
  await merge(
    'portfolio',
    data.portfolios.map((row) => ({
      portfolio_id: row.portfolioId,
      code: row.code,
      name: row.name,
      active: row.active,
      created_at: row.createdAt,
    })),
  );
  await merge(
    'department',
    data.departments.map((row) => ({
      department_id: row.departmentId,
      code: row.code,
      name: row.name,
      manager_user_id: row.managerUserId,
      active: row.active,
      created_at: row.createdAt,
    })),
  );
  await merge(
    'team',
    data.teams.map((row) => ({
      team_id: row.teamId,
      code: row.code,
      name: row.name,
      department_id: row.departmentId,
      lead_user_id: row.leadUserId,
      active: row.active,
      created_at: row.createdAt,
    })),
  );
  await merge(
    'user',
    data.users.rows.map((row) => ({
      user_id: row.userId,
      name: row.name,
      status: row.status,
      kind: row.kind,
      department_id: row.departmentId,
      team_id: row.teamId,
      weekly_capacity_hours: row.weeklyCapacityHours,
      created_at: row.createdAt,
    })),
  );
  return counts;
}

const VERSION_RECORD = `journal_id bigint, work_package_id int, version int, valid_from timestamptz, changed_at timestamptz,
  changed_by_user_id int, has_notes boolean, project_id int, type_id int, status_id int, priority_id int,
  assignee_user_id int, accountable_user_id int, author_user_id int, parent_id int, version_id int, category_id int,
  subject text, start_date date, due_date date, duration int, done_ratio int, derived_done_ratio int,
  estimated_hours double precision, derived_estimated_hours double precision, remaining_hours double precision,
  story_points int, schedule_manually boolean, custom_values jsonb`;

const VERSION_COLUMNS = `journal_id, work_package_id, version, valid_from, changed_at, changed_by_user_id, has_notes,
  project_id, type_id, status_id, priority_id, assignee_user_id, accountable_user_id, author_user_id, parent_id,
  version_id, category_id, subject, start_date, due_date, duration, done_ratio, derived_done_ratio, estimated_hours,
  derived_estimated_hours, remaining_hours, story_points, schedule_manually, custom_values`;

function versionRow(row: JournalVersion) {
  return {
    journal_id: row.id,
    work_package_id: row.workPackageId,
    version: row.version,
    valid_from: row.validFrom,
    changed_at: row.changedAt,
    changed_by_user_id: row.userId,
    has_notes: row.hasNotes,
    project_id: row.projectId,
    type_id: row.typeId,
    status_id: row.statusId,
    priority_id: row.priorityId,
    assignee_user_id: row.assigneeId,
    accountable_user_id: row.accountableId,
    author_user_id: row.authorId,
    parent_id: row.parentId,
    version_id: row.versionId,
    category_id: row.categoryId,
    subject: row.subject,
    start_date: row.startDate,
    due_date: row.dueDate,
    duration: row.duration,
    done_ratio: row.doneRatio,
    derived_done_ratio: row.derivedDoneRatio,
    estimated_hours: row.estimatedHours,
    derived_estimated_hours: row.derivedEstimatedHours,
    remaining_hours: row.remainingHours,
    story_points: row.storyPoints,
    schedule_manually: row.scheduleManually,
    custom_values: row.customValues,
  };
}

/**
 * Work package versions, then the current-state row of every work package
 * they touched.
 *
 * `valid_to` is the next version's `valid_from`, derived here rather than
 * read: the export does not carry OpenProject's upper bound (see the add-on).
 * Whether a version was closed is read from its status as the model knows it.
 */
async function loadWorkPackages(tx: Tx, data: Extract, kind: RefreshKind, now: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // What exists: every id the summary listed, and every work package whose
  // versions this run read — one created between the two reads is real, and
  // dropping it here would lose it until the next full refresh, because the
  // cursor has already moved past its versions.
  const existing = JSON.stringify([
    ...new Set([...data.summary.workPackageIds, ...data.journals.map((row) => row.workPackageId)]),
  ]);

  if (kind === 'full') {
    await tx.$executeRawUnsafe('DELETE FROM analytics.fact_work_package_version');
  }

  let versions = 0;
  for (const chunk of chunks(data.journals.map(versionRow))) {
    versions += await tx.$executeRawUnsafe(
      `INSERT INTO analytics.fact_work_package_version (${VERSION_COLUMNS}, loaded_at)
       SELECT ${VERSION_COLUMNS}, $2::timestamptz FROM jsonb_to_recordset($1::jsonb) AS r(${VERSION_RECORD})
       ON CONFLICT (journal_id) DO UPDATE SET
         (${VERSION_COLUMNS}, loaded_at) = (${VERSION_COLUMNS
           .split(',')
           .map((column) => `EXCLUDED.${column.trim()}`)
           .join(', ')}, EXCLUDED.loaded_at)`,
      JSON.stringify(chunk),
      now,
    );
  }
  counts.versions = versions;

  // Work packages deleted upstream take their history with them, as their
  // journals did.
  await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS pg_temp.existing_wp`);
  await tx.$executeRawUnsafe(
    `CREATE TEMP TABLE existing_wp ON COMMIT DROP AS
       SELECT DISTINCT (value)::int AS work_package_id FROM jsonb_array_elements_text($1::jsonb)`,
    existing,
  );
  counts.deleted = await tx.$executeRawUnsafe(
    `DELETE FROM analytics.fact_work_package_version v
      WHERE NOT EXISTS (SELECT 1 FROM existing_wp e WHERE e.work_package_id = v.work_package_id)`,
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM analytics.fact_work_package w
      WHERE NOT EXISTS (SELECT 1 FROM existing_wp e WHERE e.work_package_id = w.work_package_id)`,
  );

  // The work packages whose rows need rebuilding.
  await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS pg_temp.affected_wp`);
  if (kind === 'full') {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE affected_wp ON COMMIT DROP AS
         SELECT DISTINCT work_package_id FROM analytics.fact_work_package_version`,
    );
  } else {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE affected_wp ON COMMIT DROP AS
         SELECT DISTINCT (value)::int AS work_package_id FROM jsonb_array_elements_text($1::jsonb)`,
      JSON.stringify([...new Set(data.journals.map((row) => row.workPackageId))]),
    );
  }

  // A version whose status the model does not know (deleted upstream before
  // the model first loaded it) is left unknown rather than guessed open.
  await tx.$executeRawUnsafe(
    `UPDATE analytics.fact_work_package_version v
        SET valid_to = n.next_from,
            is_closed = (SELECT s.is_closed FROM analytics.dim_status s WHERE s.status_id = v.status_id)
       FROM (SELECT journal_id,
                    LEAD(valid_from) OVER (PARTITION BY work_package_id ORDER BY version) AS next_from
               FROM analytics.fact_work_package_version
              WHERE work_package_id IN (SELECT work_package_id FROM affected_wp)) n
      WHERE v.journal_id = n.journal_id`,
  );

  await tx.$executeRawUnsafe(
    `DELETE FROM analytics.fact_work_package WHERE work_package_id IN (SELECT work_package_id FROM affected_wp)`,
  );
  counts.workPackages = await tx.$executeRawUnsafe(
    `WITH history AS (
       SELECT v.*,
              MAX(v.version) FILTER (WHERE NOT COALESCE(v.is_closed, false))
                OVER (PARTITION BY v.work_package_id) AS last_open_version,
              MAX(v.version) OVER (PARTITION BY v.work_package_id) AS latest_version,
              MIN(v.valid_from) OVER (PARTITION BY v.work_package_id) AS first_from
         FROM analytics.fact_work_package_version v
        WHERE v.work_package_id IN (SELECT work_package_id FROM affected_wp)
     ),
     closed AS (
       SELECT work_package_id,
              MIN(valid_from) FILTER (WHERE version > COALESCE(last_open_version, 0)) AS closed_from
         FROM history
        GROUP BY work_package_id
     ),
     latest AS (
       SELECT * FROM history WHERE version = latest_version
     ),
     spent AS (
       SELECT work_package_id, SUM(hours) AS hours
         FROM analytics.fact_time_entry
        WHERE work_package_id IN (SELECT work_package_id FROM affected_wp)
        GROUP BY work_package_id
     )
     INSERT INTO analytics.fact_work_package (
       work_package_id, project_id, project_sk, type_id, status_id, priority_id, assignee_user_id,
       accountable_user_id, author_user_id, parent_id, version_id, subject, start_date, due_date,
       created_at, updated_at, closed_at, is_closed, is_milestone, estimated_hours, remaining_hours,
       spent_hours, done_ratio, story_points, custom_values, created_date_key, start_date_key,
       due_date_key, closed_date_key, loaded_at)
     SELECT l.work_package_id, l.project_id, p.project_sk, l.type_id, l.status_id, l.priority_id,
            l.assignee_user_id, l.accountable_user_id, l.author_user_id, l.parent_id, l.version_id,
            COALESCE(l.subject, ''), l.start_date, l.due_date, l.first_from, l.changed_at,
            CASE WHEN COALESCE(s.is_closed, false) THEN c.closed_from END,
            COALESCE(s.is_closed, false), COALESCE(t.is_milestone, false),
            l.estimated_hours, l.remaining_hours, COALESCE(sp.hours, 0), l.done_ratio, l.story_points,
            l.custom_values,
            ${dateKey('l.first_from AT TIME ZONE \'UTC\'')},
            ${dateKey('l.start_date')},
            ${dateKey('l.due_date')},
            CASE WHEN COALESCE(s.is_closed, false) THEN ${dateKey('c.closed_from AT TIME ZONE \'UTC\'')} END,
            $1::timestamptz
       FROM latest l
       JOIN closed c ON c.work_package_id = l.work_package_id
       LEFT JOIN analytics.dim_status s ON s.status_id = l.status_id
       LEFT JOIN analytics.dim_type t ON t.type_id = l.type_id
       LEFT JOIN analytics.dim_project p ON p.project_id = l.project_id AND p.is_current
       LEFT JOIN spent sp ON sp.work_package_id = l.work_package_id`,
    now,
  );

  return counts;
}

const TIME_RECORD = `time_entry_id int, spent_on date, user_id int, project_id int, work_package_id int,
  activity_id int, activity_name text, hours double precision, cost double precision,
  created_at timestamptz, updated_at timestamptz`;
const TIME_COLUMNS = `time_entry_id, spent_on, user_id, project_id, work_package_id, activity_id, activity_name,
  hours, cost, created_at, updated_at`;

async function loadTime(tx: Tx, data: Extract, now: string): Promise<Record<string, number>> {
  if (data.timeEntriesComplete) await tx.$executeRawUnsafe('DELETE FROM analytics.fact_time_entry');

  let written = 0;
  for (const chunk of chunks(
    data.timeEntries.map((row) => ({
      time_entry_id: row.timeEntryId,
      spent_on: row.spentOn,
      user_id: row.userId,
      project_id: row.projectId,
      work_package_id: row.workPackageId,
      activity_id: row.activityId,
      activity_name: row.activityName,
      hours: row.hours,
      cost: row.cost,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
  )) {
    written += await tx.$executeRawUnsafe(
      `INSERT INTO analytics.fact_time_entry (${TIME_COLUMNS}, spent_date_key, loaded_at)
       SELECT ${TIME_COLUMNS}, to_char(spent_on, 'YYYYMMDD')::int, $2::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS r(${TIME_RECORD})
       ON CONFLICT (time_entry_id) DO UPDATE SET
         (${TIME_COLUMNS}, spent_date_key, loaded_at) = (${TIME_COLUMNS
           .split(',')
           .map((column) => `EXCLUDED.${column.trim()}`)
           .join(', ')}, EXCLUDED.spent_date_key, EXCLUDED.loaded_at)`,
      JSON.stringify(chunk),
      now,
    );
  }
  return { timeEntries: written };
}

const COST_RECORD = `cost_entry_id int, spent_on date, user_id int, project_id int, work_package_id int,
  cost_type_id int, cost_type_name text, unit text, units double precision, amount double precision,
  created_at timestamptz, updated_at timestamptz`;
const COST_COLUMNS = `cost_entry_id, spent_on, user_id, project_id, work_package_id, cost_type_id, cost_type_name,
  unit, units, amount, created_at, updated_at`;

async function loadCosts(tx: Tx, data: Extract, kind: RefreshKind, now: string): Promise<Record<string, number>> {
  if (kind === 'full') await tx.$executeRawUnsafe('DELETE FROM analytics.fact_cost_entry');

  let written = 0;
  for (const chunk of chunks(
    data.costEntries.map((row) => ({
      cost_entry_id: row.id,
      spent_on: row.spentOn,
      user_id: row.userId,
      project_id: row.projectId,
      work_package_id: row.workPackageId,
      cost_type_id: row.costTypeId,
      cost_type_name: row.costTypeName,
      unit: row.unit,
      units: row.units,
      amount: row.amount,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
  )) {
    written += await tx.$executeRawUnsafe(
      `INSERT INTO analytics.fact_cost_entry (${COST_COLUMNS}, spent_date_key, loaded_at)
       SELECT ${COST_COLUMNS}, to_char(spent_on, 'YYYYMMDD')::int, $2::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS r(${COST_RECORD})
       ON CONFLICT (cost_entry_id) DO UPDATE SET
         (${COST_COLUMNS}, spent_date_key, loaded_at) = (${COST_COLUMNS
           .split(',')
           .map((column) => `EXCLUDED.${column.trim()}`)
           .join(', ')}, EXCLUDED.spent_date_key, EXCLUDED.loaded_at)`,
      JSON.stringify(chunk),
      now,
    );
  }
  return { costEntries: written };
}

/** Every work package's spent hours, from the time facts — after time is loaded. */
async function refreshSpentHours(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE analytics.fact_work_package w
        SET spent_hours = COALESCE(s.hours, 0)
       FROM (SELECT w2.work_package_id, SUM(t.hours) AS hours
               FROM analytics.fact_work_package w2
               LEFT JOIN analytics.fact_time_entry t ON t.work_package_id = w2.work_package_id
              GROUP BY w2.work_package_id) s
      WHERE s.work_package_id = w.work_package_id
        AND w.spent_hours IS DISTINCT FROM COALESCE(s.hours, 0)`,
  );
}

async function saveState(tx: Tx, entries: Record<string, string | null>, now: string): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) continue;
    await tx.$executeRawUnsafe(
      `INSERT INTO analytics.refresh_state (key, value, updated_at) VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      key,
      value,
      now,
    );
  }
}

async function readState(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
    'SELECT key, value FROM analytics.refresh_state',
  );
  return new Map(rows.map((row) => [row.key, row.value]));
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

async function modelCounts(): Promise<Record<string, number>> {
  const [row] = await prisma.$queryRawUnsafe<Record<string, bigint>[]>(
    `SELECT (SELECT count(*) FROM analytics.dim_status WHERE present) AS statuses,
            (SELECT count(*) FROM analytics.dim_type WHERE present) AS types,
            (SELECT count(*) FROM analytics.dim_priority WHERE present) AS priorities,
            (SELECT count(*) FROM analytics.dim_project WHERE is_current) AS projects,
            (SELECT count(*) FROM analytics.dim_portfolio WHERE is_current) AS portfolios,
            (SELECT count(*) FROM analytics.dim_department WHERE is_current) AS departments,
            (SELECT count(*) FROM analytics.dim_team WHERE is_current) AS teams,
            (SELECT count(*) FROM analytics.dim_user WHERE is_current) AS users,
            (SELECT count(*) FROM analytics.dim_version WHERE present) AS versions,
            (SELECT count(*) FROM analytics.bridge_project_member) AS memberships,
            (SELECT count(*) FROM analytics.fact_work_package) AS work_packages,
            (SELECT count(*) FROM analytics.fact_work_package_version) AS work_package_versions,
            (SELECT count(*) FROM analytics.fact_time_entry) AS time_entries,
            (SELECT count(*) FROM analytics.fact_cost_entry) AS cost_entries`,
  );
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));
}

/** Also the words a reconciliation notice names each line by, in the reader's language. */
const LABELS: Record<string, string> = {
  statuses: msg('Statuses'),
  types: msg('Types'),
  priorities: msg('Priorities'),
  projects: msg('Projects'),
  portfolios: msg('Portfolios'),
  departments: msg('Departments'),
  teams: msg('Teams'),
  users: msg('People'),
  versions: msg('Versions'),
  memberships: msg('Project memberships'),
  work_packages: msg('Work packages'),
  work_package_versions: msg('Work package versions'),
  time_entries: msg('Time entries'),
  cost_entries: msg('Unit cost entries'),
};

/** How many rows of difference `source` may show and still reconcile. */
export function allowedDifference(source: number, tolerancePct = env.EPM_ANALYTICS_RECONCILE_TOLERANCE_PCT): number {
  return Math.ceil((source * tolerancePct) / 100);
}

function reconcile(data: Extract, model: Record<string, number>): ReconciliationLine[] {
  const source: Record<string, number> = {
    statuses: data.statuses.length,
    types: data.types.length,
    priorities: data.priorities.length,
    projects: data.projects.sourceTotal,
    portfolios: data.portfolios.length,
    departments: data.departments.length,
    teams: data.teams.length,
    users: data.users.sourceTotal,
    versions: data.versions.length,
    memberships: data.memberships.sourceTotal,
    work_packages: data.summary.workPackages,
    work_package_versions: data.summary.journals,
    time_entries: data.timeSourceTotal,
    cost_entries: data.summary.costEntries,
  };

  return Object.entries(source).map(([entity, expected]) => {
    const actual = model[entity] ?? 0;
    const difference = actual - expected;
    const allowed = allowedDifference(expected);
    return {
      entity,
      label: LABELS[entity] ?? entity,
      source: expected,
      model: actual,
      difference,
      allowed,
      ok: Math.abs(difference) <= allowed,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

interface RunRow {
  run_id: bigint;
  kind: string;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  duration_ms: number | null;
  window_ms: number | null;
  within_window: boolean | null;
  rows: Record<string, number> | null;
  reconciliation: ReconciliationLine[] | null;
  reconciled: boolean | null;
  error: string | null;
}

function toRun(row: RunRow): RefreshRun {
  return {
    id: String(row.run_id),
    kind: row.kind as RefreshKind,
    trigger: row.trigger as RefreshTrigger,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    status: row.status as RefreshRun['status'],
    durationMs: row.duration_ms,
    windowMs: row.window_ms,
    withinWindow: row.within_window,
    rows: row.rows,
    reconciliation: row.reconciliation,
    reconciled: row.reconciled,
    error: row.error,
  };
}

const RUN_COLUMNS = `run_id, kind, trigger, started_at, finished_at, status, duration_ms, window_ms, within_window,
  rows, reconciliation, reconciled, error`;

async function openRun(kind: RefreshKind, trigger: RefreshTrigger, startedAt: Date): Promise<bigint> {
  const [row] = await prisma.$queryRawUnsafe<{ run_id: bigint }[]>(
    `INSERT INTO analytics.refresh_run (kind, trigger, started_at, status, window_ms, holder)
     VALUES ($1, $2, $3::timestamptz, 'running', $4, $5) RETURNING run_id`,
    kind,
    trigger,
    startedAt.toISOString(),
    kind === 'full' ? env.EPM_ANALYTICS_REFRESH_WINDOW_MINUTES * 60_000 : null,
    INSTANCE_ID,
  );
  return row!.run_id;
}

async function closeRun(
  runId: bigint,
  outcome: {
    status: 'succeeded' | 'failed';
    durationMs: number;
    withinWindow: boolean | null;
    rows?: Record<string, number>;
    reconciliation?: ReconciliationLine[];
    reconciled?: boolean | null;
    error?: string;
  },
): Promise<RefreshRun> {
  const [row] = await prisma.$queryRawUnsafe<RunRow[]>(
    `UPDATE analytics.refresh_run
        SET finished_at = now(), status = $2, duration_ms = $3, within_window = $4,
            rows = $5::jsonb, reconciliation = $6::jsonb, reconciled = $7, error = $8
      WHERE run_id = $1
      RETURNING ${RUN_COLUMNS}`,
    runId,
    outcome.status,
    outcome.durationMs,
    outcome.withinWindow,
    outcome.rows ? JSON.stringify(outcome.rows) : null,
    outcome.reconciliation ? JSON.stringify(outcome.reconciliation) : null,
    outcome.reconciled ?? null,
    outcome.error ?? null,
  );
  return toRun(row!);
}

/** A failure's message, without anything a person should not read in a notice. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : 'The refresh did not complete.';
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

let inFlight: { kind: RefreshKind; run: Promise<RefreshRun | null> } | null = null;

/**
 * Refreshes the model, or returns null when another server is refreshing it.
 *
 * An incremental refresh with nothing to resume from — no full refresh has
 * ever completed — is run as a full one: there is nothing to add changes to.
 */
export function refreshModel(kind: RefreshKind, trigger: RefreshTrigger): Promise<RefreshRun | null> {
  // One at a time in this process too: a change-triggered run and the timer
  // must not load the same rows twice. A request joins the run in progress
  // when that run does what it asks — anything joins a full refresh, an
  // incremental joins an incremental. A full refresh asked for while an
  // incremental one runs waits for it and then runs: handing back the
  // incremental's result answered a question nobody asked (no window, and no
  // run of the kind requested in the log).
  if (inFlight && (inFlight.kind === 'full' || kind === 'incremental')) return inFlight.run;
  const before = inFlight ? inFlight.run.catch(() => null) : Promise.resolve(null);
  const run: Promise<RefreshRun | null> = before
    .then(() => runRefresh(kind, trigger))
    .finally(() => {
      if (inFlight?.run === run) inFlight = null;
    });
  inFlight = { kind, run };
  return run;
}

async function runRefresh(requested: RefreshKind, trigger: RefreshTrigger): Promise<RefreshRun | null> {
  const windowMs = env.EPM_ANALYTICS_REFRESH_WINDOW_MINUTES * 60_000;
  const outcome = await withLease(LEASE, windowMs + 5 * 60_000, async () => {
    const state = await readState();
    const kind: RefreshKind = requested === 'incremental' && !state.has(STATE.journalCursor) ? 'full' : requested;
    const startedAt = new Date();
    const now = startedAt.toISOString();
    const runId = await openRun(kind, trigger, startedAt);
    const signal = AbortSignal.timeout(windowMs + 5 * 60_000);

    try {
      const data = await extract(kind, state, startedAt, signal);

      const rows = await prisma.$transaction(
        async (tx) => {
          const counts: Record<string, number> = {};
          counts.reference = await loadReference(tx, data, now);
          Object.assign(counts, await loadVersionsAndMembers(tx, data, now));
          Object.assign(counts, await loadDimensions(tx, data, now));
          Object.assign(counts, await loadTime(tx, data, now));
          Object.assign(counts, await loadWorkPackages(tx, data, kind, now));
          Object.assign(counts, await loadCosts(tx, data, kind, now));
          await refreshSpentHours(tx);
          await saveState(
            tx,
            {
              [STATE.journalCursor]: data.journalCursor ?? '',
              [STATE.costCursor]: data.costCursor ?? '',
              [STATE.timeSince]: data.timeSince,
            },
            now,
          );
          return counts;
        },
        { maxWait: 30_000, timeout: windowMs },
      );

      const model = await modelCounts();
      let reconciliation = reconcile(data, model);

      // Time entries and unit costs deleted upstream are invisible to an
      // incremental read. A count that no longer matches is how that shows,
      // and the cure is to read those two in full.
      if (kind === 'incremental' && reconciliation.some((line) => !line.ok && (line.entity === 'time_entries' || line.entity === 'cost_entries'))) {
        await reloadTimeAndCosts(now, signal);
        reconciliation = reconcile(data, await modelCounts());
      }

      const durationMs = Date.now() - startedAt.getTime();
      const reconciled = reconciliation.every((line) => line.ok);
      const run = await closeRun(runId, {
        status: 'succeeded',
        durationMs,
        withinWindow: kind === 'full' ? durationMs <= windowMs : null,
        rows: { ...rows, ...Object.fromEntries(Object.entries(model).map(([key, value]) => [`model.${key}`, value])) },
        reconciliation,
        reconciled,
      });

      invalidateModelCaches();
      await reportProblems(run);
      return run;
    } catch (error) {
      const run = await closeRun(runId, {
        status: 'failed',
        durationMs: Date.now() - startedAt.getTime(),
        withinWindow: null,
        error: messageOf(error),
      }).catch(() => null);
      appLog.warn({ err: error, kind, trigger }, 'Analytics model refresh failed');
      await notifyAnalyticsProblem({
        title: message('Analytics refresh failed'),
        body: message(
          'The {kind, select, full {full} other {incremental}} refresh of the analytics model did not complete: {reason}. Dashboards show the model as of the last refresh that did.',
          { kind, reason: messageOf(error).replace(/[.!?]*$/, '') },
        ),
        dedupeKey: `analytics-refresh-failed:${now.slice(0, 10)}:${kind}`,
      }).catch(() => undefined);
      return run;
    }
  });

  return outcome.ran ? outcome.result : null;
}

/** Time entries and unit costs, read in full and replaced, in a transaction of their own. */
async function reloadTimeAndCosts(now: string, signal: AbortSignal): Promise<void> {
  const [time, costs] = await Promise.all([
    readTimeEntries(null, signal),
    readAll(costEntryPages(null, signal), (row) => cursorOf(row.updatedAt ?? '', row.id), null),
  ]);
  const partial = {
    timeEntries: time.rows,
    timeEntriesComplete: true,
    costEntries: costs.rows,
  } as Extract;
  await prisma.$transaction(
    async (tx) => {
      await loadTime(tx, partial, now);
      await loadCosts(tx, partial, 'full', now);
      await refreshSpentHours(tx);
      await saveState(tx, { [STATE.costCursor]: costs.cursor ?? '' }, now);
    },
    { maxWait: 30_000, timeout: env.EPM_ANALYTICS_REFRESH_WINDOW_MINUTES * 60_000 },
  );
}

/** Tells the analytics administrators when a full refresh did not reconcile or overran its window. */
async function reportProblems(run: RefreshRun): Promise<void> {
  if (run.kind !== 'full') return;
  const day = run.startedAt.slice(0, 10);

  const off = (run.reconciliation ?? []).filter((line) => !line.ok);
  if (off.length > 0) {
    await notifyAnalyticsProblem({
      title: message('Analytics model did not reconcile'),
      body: message('{lines}. The next full refresh reloads everything.', {
        lines: clauses(
          off.map((line) =>
            message('{label}: {model, number} in the model, {source, number} at source', {
              label: line.label,
              model: line.model,
              source: line.source,
            }),
          ),
        ),
      }),
      dedupeKey: `analytics-reconcile:${day}`,
    }).catch(() => undefined);
  }
  if (run.withinWindow === false) {
    await notifyAnalyticsProblem({
      title: message('Analytics refresh overran its window'),
      body: message(
        'The full refresh took {seconds, plural, one {# second} other {# seconds}}, beyond the agreed {minutes, plural, one {# minute} other {# minutes}}.',
        { seconds: Math.round((run.durationMs ?? 0) / 1000), minutes: env.EPM_ANALYTICS_REFRESH_WINDOW_MINUTES },
      ),
      dedupeKey: `analytics-window:${day}`,
    }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the model's own state                                              */
/* -------------------------------------------------------------------------- */

/**
 * Increments when the model changes, so anything computed from it can be
 * cached exactly: an answer keyed by this is right until the next refresh.
 */
let modelVersion = 0;
const listeners = new Set<() => void>();

function invalidateModelCaches(): void {
  modelVersion += 1;
  for (const listener of listeners) listener();
}

export function currentModelVersion(): number {
  return modelVersion;
}

export function onModelRefreshed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** When the data the model holds was read: the start of the last refresh that succeeded. */
export async function modelAsOf(): Promise<string | null> {
  const [row] = await prisma.$queryRawUnsafe<{ started_at: Date }[]>(
    `SELECT started_at FROM analytics.refresh_run WHERE status = 'succeeded' ORDER BY started_at DESC LIMIT 1`,
  );
  return row?.started_at.toISOString() ?? null;
}

export async function listRefreshRuns(options: {
  page: number;
  pageSize: number;
  kind?: RefreshKind;
}): Promise<{ items: RefreshRun[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
  const where = options.kind ? 'WHERE kind = $1' : 'WHERE $1::text IS NULL';
  const [count] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT count(*) AS total FROM analytics.refresh_run ${where}`,
    options.kind ?? null,
  );
  const total = Number(count?.total ?? 0);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(options.page, 1), lastPage);
  const rows = await prisma.$queryRawUnsafe<RunRow[]>(
    `SELECT ${RUN_COLUMNS} FROM analytics.refresh_run ${where} ORDER BY started_at DESC, run_id DESC LIMIT $2 OFFSET $3`,
    options.kind ?? null,
    pageSize,
    (page - 1) * pageSize,
  );
  return { items: rows.map(toRun), total, page, pageSize };
}

export interface ModelStatus {
  enabled: boolean;
  asOf: string | null;
  running: boolean;
  lastFull: RefreshRun | null;
  lastIncremental: RefreshRun | null;
  counts: Record<string, number>;
  windowMinutes: number;
  tolerancePct: number;
  fullRefreshHourUtc: number;
  intervalMinutes: number;
}

export async function modelStatus(): Promise<ModelStatus> {
  const [last, counts, asOf] = await Promise.all([
    prisma.$queryRawUnsafe<RunRow[]>(
      `SELECT DISTINCT ON (kind) ${RUN_COLUMNS}
         FROM analytics.refresh_run
        WHERE status <> 'running'
        ORDER BY kind, started_at DESC`,
    ),
    modelCounts(),
    modelAsOf(),
  ]);
  const byKind = new Map(last.map((row) => [row.kind, toRun(row)]));
  const [running] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM analytics.refresh_run WHERE status = 'running' AND started_at > now() - interval '1 hour'`,
  );

  return {
    enabled: env.EPM_ANALYTICS_MODEL_ENABLED,
    asOf,
    running: Number(running?.n ?? 0) > 0,
    lastFull: byKind.get('full') ?? null,
    lastIncremental: byKind.get('incremental') ?? null,
    counts,
    windowMinutes: env.EPM_ANALYTICS_REFRESH_WINDOW_MINUTES,
    tolerancePct: env.EPM_ANALYTICS_RECONCILE_TOLERANCE_PCT,
    fullRefreshHourUtc: env.EPM_ANALYTICS_FULL_REFRESH_HOUR_UTC,
    intervalMinutes: env.EPM_ANALYTICS_REFRESH_INTERVAL_MINUTES,
  };
}

/**
 * Whether anything EPM was told about has changed since the last refresh
 * began: an edit made through EPM or one OpenProject's webhook reported, both
 * of which queue a rule event, or time logged through EPM.
 */
export async function changedSinceLastRefresh(): Promise<boolean> {
  if (pendingChange) return true;
  const [row] = await prisma.$queryRawUnsafe<{ changed: boolean }[]>(
    // rule_events keeps UTC wall time without a zone, as Prisma writes it.
    `SELECT EXISTS (
       SELECT 1 FROM rule_events
        WHERE "receivedAt" > COALESCE(
                (SELECT max(started_at) FROM analytics.refresh_run WHERE status = 'succeeded') AT TIME ZONE 'UTC',
                '-infinity'::timestamp)
     ) AS changed`,
  );
  return Boolean(row?.changed);
}

let pendingChange = false;

/** Something the rule queue does not see changed — time logged, a rate, a profile. */
export function markModelStale(): void {
  pendingChange = true;
}

export function clearModelStale(): void {
  pendingChange = false;
}
