import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { OpenProjectError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import { openProject } from '../openproject/client.js';
import {
  computeCriticalPath,
  type FloatResult,
  type NetworkItem,
  type NetworkRelation,
  type WorkingCalendar,
} from './critical-path.js';
import { withLease } from './job-lease.js';
import type {
  ProjectCriticalPath,
  ScheduleItem,
  ScheduleLink,
  ScheduleMeta,
  ScheduleRun,
  ScheduleStatus,
  WorkPackageSchedule,
} from '../types/epm.js';

/**
 * The critical path pass, end to end (BR-101 to BR-104).
 *
 * One pass reads the whole scheduling network from OpenProject in a single
 * request (`zzz_epm_schedule.rb`), runs the forward and backward passes over it
 * (`critical-path.ts`), stores what changed in EPM's own tables — the source
 * of truth the Gantt, the task view and the API read — and then mirrors the
 * figures into OpenProject's three schedule fields, so its query engine, which
 * EPM's saved views run on, can filter, sort, group and sum on them.
 *
 * The whole network, every time: relations cross projects, so a date moved in
 * one can change the float of work in another, and the pass is fast enough
 * that working out which part to recompute would cost more than it saves.
 *
 * When it runs:
 * - EPM changed a date, a relation or the shape of the tree: queued, debounced
 *   and run in the background. The request that made the change never waits.
 * - Anything else — a change made in OpenProject's own screens, a holiday
 *   added: the check asks OpenProject for a digest of the network every
 *   `EPM_SCHEDULE_CHECK_SECONDS` and runs a pass only when it has moved.
 * - Someone asks: "Recalculate now".
 *
 * Reads are served from the stored figures. While a pass is pending, a read
 * waits for it if the network is small (`EPM_SCHEDULE_SYNC_LIMIT`), and
 * otherwise answers at once and says a pass is on its way.
 */

export type ScheduleTrigger = 'change' | 'check' | 'manual' | 'startup';

type FieldKey = 'totalFloat' | 'freeFloat' | 'critical';

interface NetworkWorkPackage extends NetworkItem {
  /** Its type holds the schedule fields, so the mirror can write them. */
  mirrorable: boolean;
  /** What OpenProject's schedule fields hold now. */
  values: { totalFloat: number | null; freeFloat: number | null; critical: boolean | null };
}

export interface ScheduleNetwork {
  workPackages: NetworkWorkPackage[];
  relations: (NetworkRelation & { id: number })[];
  calendar: { workingDays: number[]; nonWorkingDays: string[] };
  fields: Record<FieldKey, { id: number | null; problem: string | null; name: string }>;
  fingerprint: { network: string; values: string };
}

interface Fingerprint {
  network: string;
  values: string;
  workPackages: number;
  relations: number;
}

/** How long one pass may hold the lease before another server may take over. */
const LEASE_MS = 10 * 60_000;
/** Changes arrive in bursts — a dragged bar moves its successors too. */
const DEBOUNCE_MS = 1_500;
/** Values per write to OpenProject. */
const MIRROR_BATCH = 2_000;
/** How long a read waits for a pending pass on a small network. */
const SYNC_WAIT_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* OpenProject                                                                */
/* -------------------------------------------------------------------------- */

export function readNetwork(): Promise<ScheduleNetwork> {
  return runAsSystem(() =>
    openProject.request<ScheduleNetwork>('/epm_admin/schedule/network', { root: true, timeoutMs: 120_000 }),
  );
}

function readFingerprint(): Promise<Fingerprint> {
  return runAsSystem(() => openProject.request<Fingerprint>('/epm_admin/schedule/fingerprint', { root: true }));
}

interface MirrorOutcome {
  written: number;
  cleared: number;
  unchanged: number;
  skipped: number;
  touched: number;
}

function writeValues(
  values: { id: number; totalFloat: number | null; freeFloat: number | null; critical: boolean | null }[],
): Promise<MirrorOutcome> {
  return runAsSystem(() =>
    openProject.request<MirrorOutcome>('/epm_admin/schedule/values', {
      method: 'POST',
      root: true,
      body: { values },
      timeoutMs: 120_000,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* One pass                                                                   */
/* -------------------------------------------------------------------------- */

type RunRow = Awaited<ReturnType<typeof prisma.scheduleRun.findFirstOrThrow>>;

function toRunView(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    workPackages: row.workPackages,
    relations: row.relations,
    scheduled: row.scheduled,
    unscheduled: row.unscheduled,
    cycles: Array.isArray(row.cycles) ? (row.cycles as number[][]) : [],
    changed: row.changed,
    removed: row.removed,
    mirrored: row.mirrored,
    mirrorSkipped: row.mirrorSkipped,
    mirrorError: row.mirrorError ?? undefined,
    readMs: row.readMs ?? undefined,
    computeMs: row.computeMs ?? undefined,
    storeMs: row.storeMs ?? undefined,
    mirrorMs: row.mirrorMs ?? undefined,
    durationMs: row.durationMs ?? undefined,
    error: row.error ?? undefined,
  };
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const asDate = (value: string): Date => new Date(`${value}T00:00:00Z`);

/** OpenProject treats an empty working week as every day worked. */
export function calendarOf(network: Pick<ScheduleNetwork, 'calendar'>): WorkingCalendar {
  const weekdays = network.calendar.workingDays.length > 0 ? network.calendar.workingDays : [1, 2, 3, 4, 5, 6, 7];
  return { weekdays: new Set(weekdays), holidays: new Set(network.calendar.nonWorkingDays) };
}

interface PassOptions {
  /** Where the network comes from; OpenProject unless a check supplies one. */
  source?: () => Promise<ScheduleNetwork>;
  /** Write OpenProject's fields too. On when the setting is. */
  mirror?: boolean;
}

/**
 * Reads, computes, stores and mirrors, recording the pass as it goes. A pass
 * that fails is recorded as failed and leaves the stored figures as they were.
 */
export async function runSchedulePass(trigger: ScheduleTrigger, options: PassOptions = {}): Promise<ScheduleRun> {
  const source = options.source ?? readNetwork;
  const mirror = options.mirror ?? env.EPM_SCHEDULE_MIRROR_ENABLED;
  const started = performance.now();
  const run = await prisma.scheduleRun.create({ data: { trigger } });
  const times: { readMs?: number; computeMs?: number; storeMs?: number; mirrorMs?: number } = {};

  try {
    let at = performance.now();
    const network = await source();
    times.readMs = Math.round(performance.now() - at);

    at = performance.now();
    const outcome = computeCriticalPath(network.workPackages, network.relations, calendarOf(network));
    times.computeMs = Math.round(performance.now() - at);

    at = performance.now();
    const stored = await storeOutcome(run.id, network, outcome);
    times.storeMs = Math.round(performance.now() - at);

    at = performance.now();
    const mirrored = mirror ? await mirrorValues(network, outcome.results) : { mirrored: 0, skipped: 0, valuesFingerprint: network.fingerprint.values };
    times.mirrorMs = Math.round(performance.now() - at);

    const row = await prisma.scheduleRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        networkFingerprint: network.fingerprint.network,
        valuesFingerprint: mirrored.valuesFingerprint,
        workPackages: network.workPackages.length,
        relations: network.relations.length,
        scheduled: outcome.results.size,
        unscheduled: outcome.unscheduled.length,
        cycles: outcome.cycles,
        changed: stored.changed,
        removed: stored.removed,
        mirrored: mirrored.mirrored,
        mirrorSkipped: mirrored.skipped,
        mirrorError: mirrored.error ?? null,
        ...times,
        durationMs: Math.round(performance.now() - started),
      },
    });
    return toRunView(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const row = await prisma.scheduleRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date(), error: message.slice(0, 2000), ...times, durationMs: Math.round(performance.now() - started) },
    });
    appLog.warn({ err: error, runId: run.id }, 'Critical path pass failed; the stored figures are unchanged');
    return toRunView(row);
  } finally {
    await pruneRuns().catch(() => undefined);
  }
}

/**
 * Writes the rows that changed and removes the ones that left the network, in
 * one transaction: a reader sees the last pass or this one, never half of each.
 */
async function storeOutcome(
  runId: string,
  network: ScheduleNetwork,
  outcome: ReturnType<typeof computeCriticalPath>,
): Promise<{ changed: number; removed: number }> {
  const [floats, links] = await Promise.all([prisma.scheduleFloat.findMany(), prisma.scheduleLink.findMany()]);
  const existing = new Map(floats.map((row) => [row.workPackageId, row]));

  const changedRows = [...outcome.results.values()].filter((result) => {
    const row = existing.get(result.id);
    return (
      !row ||
      row.projectId !== result.projectId ||
      iso(row.earlyStart) !== result.earlyStart ||
      iso(row.earlyFinish) !== result.earlyFinish ||
      iso(row.lateStart) !== result.lateStart ||
      iso(row.lateFinish) !== result.lateFinish ||
      row.totalFloat !== result.totalFloat ||
      row.freeFloat !== result.freeFloat ||
      row.critical !== result.critical ||
      row.summary !== result.summary ||
      row.inCycle !== result.inCycle
    );
  });
  const removedIds = floats.filter((row) => !outcome.results.has(row.workPackageId)).map((row) => row.workPackageId);

  const projectOf = new Map(network.workPackages.map((item) => [item.id, item.projectId]));
  const wantedLinks = network.relations.map((relation, index) => ({
    relationId: relation.id,
    predecessorId: relation.predecessorId,
    successorId: relation.successorId,
    predecessorProjectId: projectOf.get(relation.predecessorId) ?? null,
    successorProjectId: projectOf.get(relation.successorId) ?? null,
    lag: outcome.links[index]!.lag,
    driving: outcome.links[index]!.driving,
  }));
  const linkById = new Map(links.map((link) => [link.relationId, link]));
  const changedLinks = wantedLinks.filter((link) => {
    const row = linkById.get(link.relationId);
    return (
      !row ||
      row.predecessorId !== link.predecessorId ||
      row.successorId !== link.successorId ||
      row.predecessorProjectId !== link.predecessorProjectId ||
      row.successorProjectId !== link.successorProjectId ||
      row.lag !== link.lag ||
      row.driving !== link.driving
    );
  });
  const keptLinks = new Set(wantedLinks.map((link) => link.relationId));
  const removedLinks = links.filter((link) => !keptLinks.has(link.relationId)).map((link) => link.relationId);

  if (changedRows.length + removedIds.length + changedLinks.length + removedLinks.length === 0) {
    return { changed: 0, removed: 0 };
  }

  await prisma.$transaction(async (tx) => {
    if (removedIds.length > 0) {
      await tx.$executeRaw`DELETE FROM schedule_floats WHERE "workPackageId" = ANY(${removedIds}::int[])`;
    }
    if (changedRows.length > 0) {
      const column = <T>(pick: (result: FloatResult) => T) => changedRows.map(pick);
      await tx.$executeRaw`
        INSERT INTO schedule_floats ("workPackageId", "projectId", "earlyStart", "earlyFinish", "lateStart", "lateFinish",
                                     "totalFloat", "freeFloat", "critical", "summary", "inCycle", "runId", "updatedAt")
        SELECT u.id, u.project, u.es::date, u.ef::date, u.ls::date, u.lf::date, u.tf, u.ff, u.crit, u.summ, u.cyc, ${runId}, now()
          FROM UNNEST(${column((r) => r.id)}::int[], ${column((r) => r.projectId)}::int[],
                      ${column((r) => r.earlyStart)}::text[], ${column((r) => r.earlyFinish)}::text[],
                      ${column((r) => r.lateStart)}::text[], ${column((r) => r.lateFinish)}::text[],
                      ${column((r) => r.totalFloat)}::int[], ${column((r) => r.freeFloat)}::int[],
                      ${column((r) => r.critical)}::boolean[], ${column((r) => r.summary)}::boolean[],
                      ${column((r) => r.inCycle)}::boolean[])
               AS u(id, project, es, ef, ls, lf, tf, ff, crit, summ, cyc)
        ON CONFLICT ("workPackageId") DO UPDATE SET
          "projectId" = EXCLUDED."projectId", "earlyStart" = EXCLUDED."earlyStart", "earlyFinish" = EXCLUDED."earlyFinish",
          "lateStart" = EXCLUDED."lateStart", "lateFinish" = EXCLUDED."lateFinish", "totalFloat" = EXCLUDED."totalFloat",
          "freeFloat" = EXCLUDED."freeFloat", "critical" = EXCLUDED."critical", "summary" = EXCLUDED."summary",
          "inCycle" = EXCLUDED."inCycle", "runId" = EXCLUDED."runId", "updatedAt" = EXCLUDED."updatedAt"`;
    }
    if (removedLinks.length > 0) {
      await tx.$executeRaw`DELETE FROM schedule_links WHERE "relationId" = ANY(${removedLinks}::int[])`;
    }
    if (changedLinks.length > 0) {
      const column = <T>(pick: (link: (typeof changedLinks)[number]) => T) => changedLinks.map(pick);
      await tx.$executeRaw`
        INSERT INTO schedule_links ("relationId", "predecessorId", "successorId", "predecessorProjectId", "successorProjectId", "lag", "driving")
        SELECT * FROM UNNEST(${column((l) => l.relationId)}::int[], ${column((l) => l.predecessorId)}::int[],
                             ${column((l) => l.successorId)}::int[], ${column((l) => l.predecessorProjectId)}::int[],
                             ${column((l) => l.successorProjectId)}::int[], ${column((l) => l.lag)}::int[],
                             ${column((l) => l.driving)}::boolean[])
        ON CONFLICT ("relationId") DO UPDATE SET
          "predecessorId" = EXCLUDED."predecessorId", "successorId" = EXCLUDED."successorId",
          "predecessorProjectId" = EXCLUDED."predecessorProjectId", "successorProjectId" = EXCLUDED."successorProjectId",
          "lag" = EXCLUDED."lag", "driving" = EXCLUDED."driving"`;
    }
  });

  return { changed: changedRows.length, removed: removedIds.length };
}

/**
 * Brings OpenProject's fields in line with the figures: every work package
 * that can hold them gets its three values — or none, if it is not scheduled —
 * and only those that differ from what the fields hold now are sent.
 */
async function mirrorValues(
  network: ScheduleNetwork,
  results: Map<number, FloatResult>,
): Promise<{ mirrored: number; skipped: number; valuesFingerprint: string | null; error?: string }> {
  const problems = Object.values(network.fields).filter((field) => field.problem);
  if (problems.length > 0) {
    return {
      mirrored: 0,
      skipped: 0,
      // Nothing to retry until the fields change, and that changes the network digest.
      valuesFingerprint: network.fingerprint.values,
      error:
        `The schedule fields on work packages are not set up (${problems.map((field) => `${field.name}: ${field.problem}`).join('; ')}). ` +
        'They are created by the schedule fields setup on the server.',
    };
  }

  let skipped = 0;
  const pending: Parameters<typeof writeValues>[0] = [];
  for (const item of network.workPackages) {
    const result = results.get(item.id);
    if (!item.mirrorable) {
      if (result) skipped += 1;
      continue;
    }
    const want = result
      ? { totalFloat: result.totalFloat, freeFloat: result.freeFloat, critical: result.critical }
      : { totalFloat: null, freeFloat: null, critical: null };
    const have = item.values;
    if (have.totalFloat !== want.totalFloat || have.freeFloat !== want.freeFloat || have.critical !== want.critical) {
      pending.push({ id: item.id, ...want });
    }
  }
  if (pending.length === 0) return { mirrored: 0, skipped, valuesFingerprint: network.fingerprint.values };

  let touched = 0;
  try {
    for (let at = 0; at < pending.length; at += MIRROR_BATCH) {
      touched += (await writeValues(pending.slice(at, at + MIRROR_BATCH))).touched;
    }
    // The values digest after writing, so the check does not take EPM's own
    // writes for someone else's.
    const after = await readFingerprint();
    return { mirrored: touched, skipped, valuesFingerprint: after.values };
  } catch (error) {
    const reason =
      error instanceof OpenProjectError && error.upstreamStatus === 409
        ? 'The schedule fields on work packages are not set up. They are created by the schedule fields setup on the server.'
        : `Writing the schedule fields failed: ${error instanceof Error ? error.message : String(error)}`;
    appLog.warn({ err: error }, 'Critical path mirror failed; the next check retries it');
    // No digest: the next check sees a difference and tries again.
    return { mirrored: touched, skipped, valuesFingerprint: null, error: reason };
  }
}

async function pruneRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - env.EPM_SCHEDULE_RUN_RETENTION_DAYS * 86_400_000);
  await prisma.scheduleRun.deleteMany({ where: { startedAt: { lt: cutoff }, status: { not: 'running' } } });
}

/* -------------------------------------------------------------------------- */
/* When a pass runs                                                           */
/* -------------------------------------------------------------------------- */

let running: Promise<ScheduleRun | null> | null = null;
let again: ScheduleTrigger | null = null;
let timer: NodeJS.Timeout | undefined;

/** One pass here, behind the lease; null when another server holds it. */
async function leasedPass(trigger: ScheduleTrigger): Promise<ScheduleRun | null> {
  const outcome = await withLease('schedule-pass', LEASE_MS, () => runSchedulePass(trigger));
  if (outcome.ran) return outcome.result;
  // Another server is mid-pass and may have read the network before this
  // change. Ask again shortly; the check would catch it anyway.
  const retry = runAsSystem(() => setTimeout(() => requestScheduleRecalc(trigger), 5_000));
  retry.unref();
  return null;
}

/**
 * Starts a pass now, or — if one is running — makes sure another follows it,
 * so a change that arrives mid-pass is never lost. Resolves with the last pass.
 */
export function startSchedulePass(trigger: ScheduleTrigger): Promise<ScheduleRun | null> {
  if (running) {
    again = again === 'manual' ? again : trigger;
    return running;
  }
  running = (async () => {
    try {
      let outcome = await leasedPass(trigger);
      while (again) {
        const next = again;
        again = null;
        outcome = await leasedPass(next);
      }
      return outcome;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Queues a pass after a change EPM made: a date, a relation, a parent, a type,
 * a work package created or deleted. Never awaited by the request that made
 * the change (BR-104); a burst of changes becomes one pass.
 */
export function requestScheduleRecalc(trigger: ScheduleTrigger = 'change'): void {
  if (!env.EPM_SCHEDULE_ENABLED) return;
  if (timer) clearTimeout(timer);
  // Out of whatever request queued this, so the timer cannot carry its token.
  timer = runAsSystem(() =>
    setTimeout(() => {
      timer = undefined;
      void startSchedulePass(trigger).catch((error: unknown) =>
        appLog.warn({ err: error }, 'Critical path pass could not start'),
      );
    }, DEBOUNCE_MS),
  );
  timer.unref();
}

/** A pass is queued or running in this process. */
export function schedulePending(): boolean {
  return timer !== undefined || running !== null;
}

/** Resolves once nothing is queued or running here. */
export async function scheduleIdle(): Promise<void> {
  while (timer || running) {
    if (running) await running.catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function lastCompletedRun(): Promise<RunRow | null> {
  return prisma.scheduleRun.findFirst({ where: { status: 'completed' }, orderBy: { startedAt: 'desc' } });
}

/**
 * The check: has anything that bears on the schedule moved since the last
 * pass? One small query on OpenProject; a pass only when the answer is yes.
 */
export async function checkSchedule(): Promise<{ ran: boolean; reason: string }> {
  if (running) return { ran: false, reason: 'a pass is running' };
  const [last, now] = await Promise.all([lastCompletedRun(), readFingerprint()]);
  const reason = !last
    ? 'no pass yet'
    : last.networkFingerprint !== now.network
      ? 'the network moved'
      : last.valuesFingerprint !== now.values
        ? "OpenProject's schedule fields differ from the figures"
        : null;
  if (!reason) return { ran: false, reason: 'nothing moved' };
  await startSchedulePass(last ? 'check' : 'startup');
  return { ran: true, reason };
}

/**
 * For a read: wait for a pending pass when the network is small enough that
 * the wait is short (BR-104), so what is shown reflects the change just made.
 * Above the limit the read answers at once, and says a pass is on its way.
 */
async function settleForRead(): Promise<void> {
  if (!env.EPM_SCHEDULE_ENABLED) return;
  const last = await lastCompletedRun();
  if (!last && !running) void startSchedulePass('startup');
  if (!schedulePending()) return;
  const size = last?.workPackages ?? 0;
  if (size > env.EPM_SCHEDULE_SYNC_LIMIT) return;
  await Promise.race([scheduleIdle(), new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type FloatRow = Awaited<ReturnType<typeof prisma.scheduleFloat.findMany>>[number];

function toItemView(row: FloatRow, nearDays: number): ScheduleItem {
  return {
    id: String(row.workPackageId),
    earlyStart: iso(row.earlyStart),
    earlyFinish: iso(row.earlyFinish),
    lateStart: iso(row.lateStart),
    lateFinish: iso(row.lateFinish),
    totalFloat: row.totalFloat,
    freeFloat: row.freeFloat,
    critical: row.critical,
    nearCritical: !row.critical && row.totalFloat <= nearDays,
    summary: row.summary,
    inCycle: row.inCycle,
  };
}

export function nearCriticalDays(asked: unknown): number {
  const value = typeof asked === 'string' && asked.trim() !== '' ? Number(asked) : typeof asked === 'number' ? asked : NaN;
  return Number.isInteger(value) && value >= 0 && value <= 365 ? value : env.EPM_SCHEDULE_NEAR_CRITICAL_DAYS;
}

async function meta(nearDays: number): Promise<ScheduleMeta> {
  const last = await lastCompletedRun();
  return {
    computedAt: last?.finishedAt?.toISOString(),
    pending: schedulePending(),
    nearCriticalDays: nearDays,
    defaultNearCriticalDays: env.EPM_SCHEDULE_NEAR_CRITICAL_DAYS,
    enabled: env.EPM_SCHEDULE_ENABLED,
  };
}

/** A project's work with its float, and the relations between it (BR-102). */
export async function projectCriticalPath(projectId: string, asked?: unknown): Promise<ProjectCriticalPath> {
  const nearDays = nearCriticalDays(asked);
  await settleForRead();
  const id = Number(projectId);
  const [rows, links, last] = await Promise.all([
    prisma.scheduleFloat.findMany({ where: { projectId: id }, orderBy: { workPackageId: 'asc' } }),
    prisma.scheduleLink.findMany({ where: { predecessorProjectId: id, successorProjectId: id }, orderBy: { relationId: 'asc' } }),
    lastCompletedRun(),
  ]);
  const items = rows.map((row) => toItemView(row, nearDays));
  const critical = new Set(items.filter((item) => item.critical).map((item) => item.id));
  const inProject = new Set(items.map((item) => item.id));
  const cycles = (Array.isArray(last?.cycles) ? (last!.cycles as number[][]) : [])
    .map((members) => members.map(String))
    .filter((members) => members.some((member) => inProject.has(member)));
  const leaves = items.filter((item) => !item.summary);
  return {
    ...(await meta(nearDays)),
    projectId,
    items,
    links: links.map((link) => ({
      id: String(link.relationId),
      predecessorId: String(link.predecessorId),
      successorId: String(link.successorId),
      lag: link.lag,
      driving: link.driving,
      critical: link.driving && critical.has(String(link.predecessorId)) && critical.has(String(link.successorId)),
    })),
    finish: leaves.length > 0 ? leaves.map((item) => item.earlyFinish).sort().at(-1) : undefined,
    cycles,
    counts: {
      scheduled: leaves.length,
      critical: leaves.filter((item) => item.critical).length,
      nearCritical: leaves.filter((item) => item.nearCritical).length,
    },
  };
}

/** One work package's figures, for its task view (BR-103). */
export async function workPackageSchedule(workPackageId: string, asked?: unknown): Promise<WorkPackageSchedule> {
  const nearDays = nearCriticalDays(asked);
  await settleForRead();
  const id = Number(workPackageId);
  const [row, links] = await Promise.all([
    prisma.scheduleFloat.findUnique({ where: { workPackageId: id } }),
    prisma.scheduleLink.findMany({ where: { OR: [{ predecessorId: id }, { successorId: id }] }, orderBy: { relationId: 'asc' } }),
  ]);
  const ends = await prisma.scheduleFloat.findMany({
    where: { workPackageId: { in: [...new Set(links.flatMap((link) => [link.predecessorId, link.successorId]))] } },
    select: { workPackageId: true, critical: true },
  });
  const critical = new Set(ends.filter((end) => end.critical).map((end) => end.workPackageId));
  const view = (link: (typeof links)[number]): ScheduleLink => ({
    id: String(link.relationId),
    predecessorId: String(link.predecessorId),
    successorId: String(link.successorId),
    lag: link.lag,
    driving: link.driving,
    critical: link.driving && critical.has(link.predecessorId) && critical.has(link.successorId),
  });
  return {
    ...(await meta(nearDays)),
    workPackageId,
    item: row ? toItemView(row, nearDays) : undefined,
    predecessors: links.filter((link) => link.successorId === id).map(view),
    successors: links.filter((link) => link.predecessorId === id).map(view),
  };
}

export async function scheduleStatus(): Promise<ScheduleStatus> {
  const [lastRun, lastCompleted] = await Promise.all([
    prisma.scheduleRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    lastCompletedRun(),
  ]);
  return {
    enabled: env.EPM_SCHEDULE_ENABLED,
    mirrorEnabled: env.EPM_SCHEDULE_MIRROR_ENABLED,
    checkSeconds: env.EPM_SCHEDULE_CHECK_SECONDS,
    syncLimit: env.EPM_SCHEDULE_SYNC_LIMIT,
    defaultNearCriticalDays: env.EPM_SCHEDULE_NEAR_CRITICAL_DAYS,
    pending: schedulePending(),
    lastRun: lastRun ? toRunView(lastRun) : undefined,
    lastCompleted: lastCompleted ? toRunView(lastCompleted) : undefined,
  };
}
