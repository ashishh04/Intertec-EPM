import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { readWorkPackagesFromApi } from './analytics-extract.js';
import { modelAsOf, refreshModel } from './analytics-model.js';

/**
 * Point-in-time reconstruction, and the check that keeps it honest (BR-403).
 *
 * The model holds every version of every work package from OpenProject's
 * journals, so the state of the portfolio as at any past instant is a query:
 * each work package's version current at that instant. That is only worth
 * trusting if it agrees with what was actually there, so a second, independent
 * record is kept — a capture of every work package as API v3 reported it,
 * taken daily and on demand without reference to the journals — and any
 * capture can be compared with the reconstruction for the instant it was
 * taken. Two routes to the same answer; a difference is a defect in one.
 */

/* -------------------------------------------------------------------------- */
/* Captures                                                                   */
/* -------------------------------------------------------------------------- */

export interface Capture {
  id: string;
  capturedAt: string;
  trigger: string;
  workPackages: number;
}

const CAPTURE_RECORD = `work_package_id int, read_at timestamptz, lock_version int, project_id int, type_id int,
  status_id int, priority_id int, assignee_user_id int, accountable_user_id int, parent_id int, version_id int,
  subject text, start_date date, due_date date, done_ratio int, estimated_hours double precision`;
const CAPTURE_COLUMNS = `work_package_id, read_at, lock_version, project_id, type_id, status_id, priority_id,
  assignee_user_id, accountable_user_id, parent_id, version_id, subject, start_date, due_date, done_ratio,
  estimated_hours`;

/** Captures every work package as API v3 reports it now, and drops captures past retention. */
export async function captureWorkPackages(trigger: 'schedule' | 'manual'): Promise<Capture> {
  const capturedAt = new Date();
  const rows = await readWorkPackagesFromApi(AbortSignal.timeout(10 * 60_000));

  const capture = await prisma.$transaction(
    async (tx) => {
      const [created] = await tx.$queryRawUnsafe<{ capture_id: bigint }[]>(
        `INSERT INTO analytics.snapshot_capture (captured_at, trigger, work_packages)
         VALUES ($1::timestamptz, $2, $3) RETURNING capture_id`,
        capturedAt.toISOString(),
        trigger,
        rows.length,
      );
      const id = created!.capture_id;

      for (let at = 0; at < rows.length; at += 2000) {
        const chunk = rows.slice(at, at + 2000).map((row) => ({
          work_package_id: row.workPackageId,
          read_at: row.readAt.toISOString(),
          lock_version: row.lockVersion,
          project_id: row.projectId,
          type_id: row.typeId,
          status_id: row.statusId,
          priority_id: row.priorityId,
          assignee_user_id: row.assigneeUserId,
          accountable_user_id: row.accountableUserId,
          parent_id: row.parentId,
          version_id: row.versionId,
          subject: row.subject,
          start_date: row.startDate,
          due_date: row.dueDate,
          done_ratio: row.doneRatio,
          estimated_hours: row.estimatedHours,
        }));
        await tx.$executeRawUnsafe(
          `INSERT INTO analytics.snapshot_work_package (capture_id, ${CAPTURE_COLUMNS})
           SELECT $2::bigint, ${CAPTURE_COLUMNS} FROM jsonb_to_recordset($1::jsonb) AS r(${CAPTURE_RECORD})`,
          JSON.stringify(chunk),
          id,
        );
      }

      await tx.$executeRawUnsafe(
        `DELETE FROM analytics.snapshot_capture WHERE captured_at < now() - make_interval(days => $1::int)`,
        env.EPM_ANALYTICS_CAPTURE_RETENTION_DAYS,
      );
      return id;
    },
    { maxWait: 30_000, timeout: 10 * 60_000 },
  );

  return { id: String(capture), capturedAt: capturedAt.toISOString(), trigger, workPackages: rows.length };
}

export async function listCaptures(options: {
  page: number;
  pageSize: number;
}): Promise<{ items: Capture[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
  const [count] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    'SELECT count(*) AS total FROM analytics.snapshot_capture',
  );
  const total = Number(count?.total ?? 0);
  const page = Math.min(Math.max(options.page, 1), Math.max(1, Math.ceil(total / pageSize)));
  const rows = await prisma.$queryRawUnsafe<
    { capture_id: bigint; captured_at: Date; trigger: string; work_packages: number }[]
  >(
    `SELECT capture_id, captured_at, trigger, work_packages FROM analytics.snapshot_capture
      ORDER BY captured_at DESC LIMIT $1 OFFSET $2`,
    pageSize,
    (page - 1) * pageSize,
  );
  return {
    items: rows.map((row) => ({
      id: String(row.capture_id),
      capturedAt: row.captured_at.toISOString(),
      trigger: row.trigger,
      workPackages: row.work_packages,
    })),
    total,
    page,
    pageSize,
  };
}

/** The capture taken at or most recently before `at`, if any. */
export async function captureNear(at: Date): Promise<Capture | null> {
  const [row] = await prisma.$queryRawUnsafe<
    { capture_id: bigint; captured_at: Date; trigger: string; work_packages: number }[]
  >(
    `SELECT capture_id, captured_at, trigger, work_packages FROM analytics.snapshot_capture
      WHERE captured_at <= $1::timestamptz ORDER BY captured_at DESC LIMIT 1`,
    at.toISOString(),
  );
  return row
    ? { id: String(row.capture_id), capturedAt: row.captured_at.toISOString(), trigger: row.trigger, workPackages: row.work_packages }
    : null;
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

/** The attributes compared, as the capture and the history both hold them. */
export const COMPARED_FIELDS = [
  'project_id',
  'type_id',
  'status_id',
  'priority_id',
  'assignee_user_id',
  'accountable_user_id',
  'parent_id',
  'version_id',
  'subject',
  'start_date',
  'due_date',
  'done_ratio',
  'estimated_hours',
] as const;

export type ComparedField = (typeof COMPARED_FIELDS)[number];

const FIELD_LABELS: Record<ComparedField, string> = {
  project_id: 'Project',
  type_id: 'Type',
  status_id: 'Status',
  priority_id: 'Priority',
  assignee_user_id: 'Assignee',
  accountable_user_id: 'Accountable',
  parent_id: 'Parent',
  version_id: 'Version',
  subject: 'Subject',
  start_date: 'Start',
  due_date: 'Finish',
  done_ratio: '% complete',
  estimated_hours: 'Estimate',
};

export interface Difference {
  workPackageId: number;
  subject: string | null;
  field: ComparedField;
  label: string;
  captured: string | null;
  reconstructed: string | null;
}

export interface ReconstructionCheck {
  capture: Capture;
  /** When the model was last refreshed; it must be after the capture for a fair comparison. */
  modelAsOf: string | null;
  compared: number;
  matched: number;
  mismatched: number;
  /** Captured, but deleted since: OpenProject removed its history with it. */
  deletedSince: number;
  /** Captured and still there, yet no version covers the instant it was read. */
  missingFromHistory: number;
  differences: Difference[];
  /** True when every comparable work package agrees field for field. */
  matches: boolean;
}

/**
 * Compares a capture with the reconstruction for the instant each of its rows
 * was read.
 *
 * Per row, not per capture: a capture of a large instance takes a while to
 * read, and a change made during it is in the capture for the pages read
 * after it and not for those before. Each row is compared with the version
 * current when its own page was read.
 *
 * If the model was last refreshed before the capture finished, versions made
 * in between would be missing and show as differences that are not; the model
 * is refreshed first in that case.
 */
export async function compareCapture(captureId: string, options: { limit?: number } = {}): Promise<ReconstructionCheck> {
  const [captureRow] = await prisma.$queryRawUnsafe<
    { capture_id: bigint; captured_at: Date; trigger: string; work_packages: number; last_read: Date | null }[]
  >(
    `SELECT c.capture_id, c.captured_at, c.trigger, c.work_packages,
            (SELECT max(read_at) FROM analytics.snapshot_work_package s WHERE s.capture_id = c.capture_id) AS last_read
       FROM analytics.snapshot_capture c WHERE c.capture_id = $1::bigint`,
    captureId,
  );
  if (!captureRow) throw new Error('No such capture.');

  const lastRead = captureRow.last_read ?? captureRow.captured_at;
  let asOf = await modelAsOf();
  if (!asOf || new Date(asOf) < lastRead) {
    await refreshModel('incremental', 'manual');
    asOf = await modelAsOf();
  }

  // Normalised to text on both sides, so a date, a number and a string are
  // compared the same way; estimates are rounded as API v3 rounds them.
  const norm = (alias: string, field: ComparedField) =>
    field === 'estimated_hours'
      ? `CASE WHEN ${alias}.${field} IS NULL OR ${alias}.${field} = 0 THEN NULL ELSE round(${alias}.${field}::numeric, 2)::text END`
      : field === 'start_date' || field === 'due_date'
        ? `to_char(${alias}.${field}, 'YYYY-MM-DD')`
        : `${alias}.${field}::text`;

  const rows = await prisma.$queryRawUnsafe<
    ({ work_package_id: number; subject: string | null; status: string } & Record<string, string | null>)[]
  >(
    `SELECT s.work_package_id, s.subject,
            CASE
              WHEN v.journal_id IS NOT NULL THEN 'compared'
              WHEN NOT EXISTS (SELECT 1 FROM analytics.fact_work_package f WHERE f.work_package_id = s.work_package_id)
                   THEN 'deleted'
              ELSE 'missing'
            END AS status,
            ${COMPARED_FIELDS.map((field) => `${norm('s', field)} AS "c_${field}", ${norm('v', field)} AS "r_${field}"`).join(',\n            ')}
       FROM analytics.snapshot_work_package s
       LEFT JOIN analytics.fact_work_package_version v
              ON v.work_package_id = s.work_package_id
             AND v.valid_from <= s.read_at
             AND (v.valid_to IS NULL OR v.valid_to > s.read_at)
      WHERE s.capture_id = $1::bigint
      ORDER BY s.work_package_id`,
    captureId,
  );

  const differences: Difference[] = [];
  let compared = 0;
  let matched = 0;
  let deletedSince = 0;
  let missingFromHistory = 0;

  for (const row of rows) {
    if (row.status === 'deleted') {
      deletedSince += 1;
      continue;
    }
    if (row.status === 'missing') {
      missingFromHistory += 1;
      continue;
    }
    compared += 1;
    let same = true;
    for (const field of COMPARED_FIELDS) {
      const captured = row[`c_${field}`] ?? null;
      const reconstructed = row[`r_${field}`] ?? null;
      if (captured !== reconstructed) {
        same = false;
        differences.push({
          workPackageId: row.work_package_id,
          subject: row.subject,
          field,
          label: FIELD_LABELS[field],
          captured,
          reconstructed,
        });
      }
    }
    if (same) matched += 1;
  }

  const limit = options.limit ?? 200;
  return {
    capture: {
      id: String(captureRow.capture_id),
      capturedAt: captureRow.captured_at.toISOString(),
      trigger: captureRow.trigger,
      workPackages: captureRow.work_packages,
    },
    modelAsOf: asOf,
    compared,
    matched,
    mismatched: compared - matched,
    deletedSince,
    missingFromHistory,
    differences: differences.slice(0, limit),
    matches: compared === matched && missingFromHistory === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* State as at                                                                */
/* -------------------------------------------------------------------------- */

export interface StateAsAt {
  at: string;
  /** The calendar day `at` falls on (UTC), against which "overdue" is judged. */
  day: string;
  total: number;
  open: number;
  closed: number;
  overdue: number;
  byStatus: { statusId: number; name: string; category: string; count: number }[];
  byProject: { projectId: number; name: string; total: number; open: number; overdue: number }[];
}

/**
 * The projects in a portfolio as it was composed at `at`, from the project
 * dimension's history — a project moved between portfolios since counts where
 * it was then.
 */
export async function portfolioProjectsAsAt(portfolioId: string, at: Date): Promise<number[]> {
  const rows = await prisma.$queryRawUnsafe<{ project_id: number }[]>(
    `SELECT DISTINCT project_id FROM analytics.dim_project
      WHERE portfolio_id = $1 AND valid_from <= $2::timestamptz AND (valid_to IS NULL OR valid_to > $2::timestamptz)`,
    portfolioId,
    at.toISOString(),
  );
  return rows.map((row) => row.project_id);
}

/**
 * The state of the work in `projectIds` as it stood at `at`, rebuilt from
 * the journals. "Overdue" is judged against that day, not today: what was
 * late then. Statuses are read as the model knows them now.
 */
export async function stateAsAt(at: Date, projectIds: number[] | null): Promise<StateAsAt> {
  const day = at.toISOString().slice(0, 10);
  const scope = projectIds === null ? 'TRUE' : 'v.project_id IN (SELECT (value)::int FROM jsonb_array_elements_text($3::jsonb))';
  const params: unknown[] = [at.toISOString(), day];
  if (projectIds !== null) params.push(JSON.stringify(projectIds));

  const statusRows = await prisma.$queryRawUnsafe<{ status_id: number; name: string | null; category: string | null; count: bigint }[]>(
    `SELECT v.status_id, s.name, s.category, count(*) AS count
       FROM analytics.work_packages_as_at($1::timestamptz) v
       LEFT JOIN analytics.dim_status s ON s.status_id = v.status_id
      WHERE ${scope} AND $2::date IS NOT NULL
      GROUP BY v.status_id, s.name, s.category, s.position
      ORDER BY s.position NULLS LAST, v.status_id`,
    ...params,
  );

  const projectRows = await prisma.$queryRawUnsafe<
    { project_id: number; name: string | null; total: bigint; open: bigint; overdue: bigint }[]
  >(
    `SELECT v.project_id,
            (SELECT p.name FROM analytics.dim_project p
              WHERE p.project_id = v.project_id AND p.valid_from <= $1::timestamptz
                AND (p.valid_to IS NULL OR p.valid_to > $1::timestamptz)
              ORDER BY p.valid_from DESC LIMIT 1) AS name,
            count(*) AS total,
            count(*) FILTER (WHERE NOT COALESCE(v.is_closed, false)) AS open,
            count(*) FILTER (WHERE NOT COALESCE(v.is_closed, false) AND v.due_date < $2::date) AS overdue
       FROM analytics.work_packages_as_at($1::timestamptz) v
      WHERE ${scope}
      GROUP BY v.project_id
      ORDER BY v.project_id`,
    ...params,
  );

  const byProject = projectRows.map((row) => ({
    projectId: row.project_id,
    name: row.name ?? `Project ${row.project_id}`,
    total: Number(row.total),
    open: Number(row.open),
    overdue: Number(row.overdue),
  }));
  const total = byProject.reduce((sum, row) => sum + row.total, 0);
  const open = byProject.reduce((sum, row) => sum + row.open, 0);

  return {
    at: at.toISOString(),
    day,
    total,
    open,
    closed: total - open,
    overdue: byProject.reduce((sum, row) => sum + row.overdue, 0),
    byStatus: statusRows.map((row) => ({
      statusId: row.status_id,
      name: row.name ?? `Status ${row.status_id}`,
      category: row.category ?? 'todo',
      count: Number(row.count),
    })),
    byProject,
  };
}
