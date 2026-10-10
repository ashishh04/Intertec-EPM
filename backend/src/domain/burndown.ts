import { runAsSystem } from '../auth/context.js';
import { optional, prisma } from '../db/prisma.js';
import { aggregateCache } from '../lib/cache.js';
import { getCatalog } from '../mapping/catalog.js';
import { linkId, openProject } from '../openproject/client.js';
import type { OpVersion, OpWorkPackage } from '../openproject/types.js';
import type { SprintState } from '../types/epm.js';

/**
 * The samples behind a sprint's burndown chart (`EpmSprint.burndown`): one row
 * per sprint per day, with the points still to do and the points done.
 *
 * The chart draws today from live figures and every other day from these rows,
 * so without them a sprint's past is blank. Two ways a row is written:
 * - today's is rewritten on every pass, so the last pass of a day leaves the
 *   figure as it stood at the end of that day;
 * - a past day with no row — before this job existed, or while no server was
 *   running — is rebuilt from the analytics history of each work package (its
 *   journals), as it stood at the end of that day (UTC). A row once written is
 *   kept.
 *
 * The figures are the chart's own: the points committed when the sprint was
 * started through EPM, or else the points in the sprint that day, less the
 * points on work whose status counts as done.
 */

type SprintWorkPackage = OpWorkPackage & { storyPoints?: number | null };

/** How far back a sprint is rebuilt, and how long after its end it is finished off. */
const MAX_DAYS = 90;
const FINISH_OFF_DAYS = 14;

export function sprintStateOf(version: Pick<OpVersion, 'status' | 'startDate' | 'endDate'>, today: string): SprintState {
  if (version.status === 'closed') return 'completed';
  // A version with no dates is a backlog, not a sprint that is running. It
  // reads as planned until someone starts it, which gives it a start date.
  if (!version.startDate && !version.endDate) return 'planned';
  if (version.startDate && version.startDate > today) return 'planned';
  if (version.endDate && version.endDate < today) return 'completed';
  return 'active';
}

export interface DayFigures {
  committed: number;
  completed: number;
}

/** Points in the sprint and points done, from each work package's points and whether it is done. */
export function figuresOf(items: readonly { points: number | null | undefined; done: boolean }[]): DayFigures {
  let committed = 0;
  let completed = 0;
  for (const item of items) {
    const points = typeof item.points === 'number' && Number.isFinite(item.points) ? item.points : 0;
    committed += points;
    if (item.done) completed += points;
  }
  return { committed: round(committed), completed: round(completed) };
}

/** What the chart calls remaining: the points committed at the start when fixed, else that day's, less those done. */
export function remainingOf(figures: DayFigures, committedAtStart: number | null): number {
  return round((committedAtStart ?? figures.committed) - figures.completed);
}

/** Calendar days from `start` to `end`, both included, at most `MAX_DAYS`. */
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && days.length < MAX_DAYS) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface SampleOutcome {
  sprints: number;
  /** Today's rows written or rewritten. */
  today: number;
  /** Past days rebuilt from history. */
  rebuilt: number;
  /** Past days left blank: the history does not reach them yet, or there is none. */
  unrebuilt: number;
}

/** Until when the analytics history is complete: the journal cursor of its last refresh. */
async function historyReaches(): Promise<Date | null> {
  const rows = await optional(
    () =>
      prisma.$queryRawUnsafe<{ value: string }[]>(
        `SELECT value FROM analytics.refresh_state WHERE key = 'journals.cursor'`,
      ),
    [],
  );
  const stamp = rows[0]?.value.split('|')[0];
  const at = stamp ? new Date(stamp) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/** Each day's (points, status) of the work in a sprint, as it stood at the end of that day (UTC). */
async function historyOf(sprintId: number, days: string[]): Promise<Map<string, { points: number | null; statusId: number }[]>> {
  const rows = await prisma.$queryRawUnsafe<{ day: string; story_points: number | null; status_id: number }[]>(
    `SELECT d.day::text AS day, v.story_points, v.status_id
       FROM unnest($2::date[]) AS d(day)
       JOIN analytics.fact_work_package_version v
         ON v.version_id = $1
        AND v.valid_from < ((d.day + 1)::timestamp AT TIME ZONE 'UTC')
        AND (v.valid_to IS NULL OR v.valid_to >= ((d.day + 1)::timestamp AT TIME ZONE 'UTC'))`,
    sprintId,
    days,
  );
  const byDay = new Map<string, { points: number | null; statusId: number }[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? [];
    bucket.push({ points: row.story_points, statusId: row.status_id });
    byDay.set(row.day, bucket);
  }
  return byDay;
}

/**
 * One pass: today's row for every running sprint, and the missing past days of
 * every sprint running or ended within the last fortnight.
 */
export async function sampleBurndown(now = new Date()): Promise<SampleOutcome> {
  return runAsSystem(async () => {
    const today = now.toISOString().slice(0, 10);
    const outcome: SampleOutcome = { sprints: 0, today: 0, rebuilt: 0, unrebuilt: 0 };

    const versions = (await openProject.getAll<OpVersion>('/versions', { pageSize: 100 })).items;
    const finishedSince = new Date(now.getTime() - FINISH_OFF_DAYS * 86_400_000).toISOString().slice(0, 10);
    const sprints = versions.filter((version) => {
      if (!version.startDate) return false;
      const state = sprintStateOf(version, today);
      return state === 'active' || (state === 'completed' && (version.endDate ?? today) >= finishedSince);
    });
    outcome.sprints = sprints.length;
    if (sprints.length === 0) return outcome;

    const ids = sprints.map((version) => String(version.id));
    const [catalog, work, overlays, existing, reaches] = await Promise.all([
      getCatalog(),
      openProject.getAll<SprintWorkPackage>(
        '/work_packages',
        { filters: [{ field: 'version', operator: '=', values: ids }], pageSize: 200 },
      ),
      optional(() => prisma.sprintProfile.findMany({ where: { openProjectId: { in: ids } } }), []),
      prisma.burndownSample.findMany({ where: { sprintId: { in: ids } }, select: { sprintId: true, sampledOn: true } }),
      historyReaches(),
    ]);
    const isDone = (statusId: string | number | null | undefined) =>
      statusId !== null && statusId !== undefined && catalog.statusById.get(String(statusId))?.epm === 'done';
    const committedAtStart = new Map(overlays.map((row) => [row.openProjectId, row.committedPoints ?? null]));
    const sampled = new Set(existing.map((row) => `${row.sprintId}|${row.sampledOn.toISOString().slice(0, 10)}`));

    for (const version of sprints) {
      const id = String(version.id);
      const atStart = committedAtStart.get(id) ?? null;

      // Today, from the live figures, as the chart computes it.
      if (sprintStateOf(version, today) === 'active') {
        const items = work.items
          .filter((workPackage) => linkId(workPackage._links, 'version') === id)
          .map((workPackage) => ({ points: workPackage.storyPoints, done: isDone(linkId(workPackage._links, 'status')) }));
        const figures = figuresOf(items);
        const sampledOn = new Date(`${today}T00:00:00Z`);
        await prisma.burndownSample.upsert({
          where: { sprintId_sampledOn: { sprintId: id, sampledOn } },
          create: { sprintId: id, sampledOn, remainingPoints: remainingOf(figures, atStart), completedPoints: figures.completed },
          update: { remainingPoints: remainingOf(figures, atStart), completedPoints: figures.completed },
        });
        outcome.today += 1;
      }

      // Past days with no row, from history, where the history reaches them.
      const lastPast = (version.endDate && version.endDate < today ? version.endDate : null) ?? previousDay(today);
      const missing = daysBetween(version.startDate!, lastPast).filter((day) => !sampled.has(`${id}|${day}`));
      if (missing.length === 0) continue;
      const covered = missing.filter((day) => reaches !== null && endOfDay(day) <= reaches);
      outcome.unrebuilt += missing.length - covered.length;
      if (covered.length === 0) continue;
      const history = await historyOf(Number(id), covered);
      const rows = covered.map((day) => {
        const figures = figuresOf((history.get(day) ?? []).map((item) => ({ points: item.points, done: isDone(item.statusId) })));
        return {
          sprintId: id,
          sampledOn: new Date(`${day}T00:00:00Z`),
          remainingPoints: remainingOf(figures, atStart),
          completedPoints: figures.completed,
        };
      });
      const written = await prisma.burndownSample.createMany({ data: rows, skipDuplicates: true });
      outcome.rebuilt += written.count;
    }

    if (outcome.today > 0 || outcome.rebuilt > 0) aggregateCache.invalidatePrefix('sprints');
    return outcome;
  });
}

function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function endOfDay(day: string): Date {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}
