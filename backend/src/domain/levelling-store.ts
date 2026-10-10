import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { message, render, renderStored, type Message } from '../lib/i18n.js';
import { linkId, openProject } from '../openproject/client.js';
import type {
  LevellingMove,
  LevellingRunSummary,
  LevellingRunView,
  LevellingStatus,
  LevellingWeek,
  WorkPackagePin,
} from '../types/epm.js';
import { withAudit } from './audit.js';
import { dayOf, isoOf } from './critical-path.js';
import { level, type FixedReason, type LevelItem } from './levelling.js';
import { loadOf, round2, type CarrierWeek, type DemandItem } from './resource-model.js';
import { forgetShared, loadResourceShared, remainingOf, type ResourceShared } from './resources-store.js';
import { calendarOf, readNetwork, requestScheduleRecalc } from './schedule.js';

/**
 * Levelling's records and its writes (BR-111, BR-112): a proposal computed
 * from the live network and stored, then applied as one change — every move or
 * none — and undone as one.
 *
 * OpenProject has no transaction across work packages, so "all or none" is
 * done by hand: before anything is written, every item must still have the
 * dates the proposal started from; the moves are then written in order,
 * predecessors first; if any write is refused, the ones already made are put
 * back; and at the end every item is read again and must have its new dates,
 * or all of them are put back. Undo is the same in reverse, and refuses while
 * anything it would put back has been changed since.
 *
 * OpenProject keeps the dates of manually scheduled work only — it starts
 * automatically scheduled work as soon as its predecessors allow — so work
 * levelling delays is switched to manual scheduling, and undo switches it back.
 */

interface WorkPackageJson {
  id: number;
  subject: string;
  startDate: string | null;
  dueDate: string | null;
  /** A milestone's one date: OpenProject renders it instead of the two. */
  date?: string | null;
  scheduleManually: boolean;
  lockVersion: number;
  _links?: { project?: { href?: string | null } };
}

const DEFAULT_HORIZON_WEEKS = 26;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const dateOnly = (value: string) => new Date(`${value}T00:00:00Z`);

/**
 * A work package as OpenProject has it, a milestone's date read as both its
 * start and its finish — OpenProject renders a milestone with `date` alone,
 * though it takes a start and finish when written.
 */
async function readWork(id: number | string): Promise<WorkPackageJson> {
  const work = await openProject.request<WorkPackageJson>(`/work_packages/${id}`);
  return { ...work, startDate: work.startDate ?? work.date ?? null, dueDate: work.dueDate ?? work.date ?? null };
}

/* -------------------------------------------------------------------------- */
/* Pins                                                                       */
/* -------------------------------------------------------------------------- */

const toPin = (row: {
  workPackageId: number;
  projectId: number;
  reason: string | null;
  pinnedBy: string;
  pinnedAt: Date;
  previousScheduleManually: boolean;
}): WorkPackagePin => ({
  workPackageId: String(row.workPackageId),
  projectId: String(row.projectId),
  reason: row.reason,
  pinnedBy: row.pinnedBy,
  pinnedAt: row.pinnedAt.toISOString(),
  previousScheduleManually: row.previousScheduleManually,
});

export async function listPins(projectId?: string): Promise<WorkPackagePin[]> {
  const rows = await prisma.workPackagePin.findMany({
    where: projectId ? { projectId: Number(projectId) } : {},
    orderBy: { pinnedAt: 'desc' },
  });
  return rows.map(toPin);
}

export async function pinOf(workPackageId: string): Promise<WorkPackagePin | null> {
  const row = await prisma.workPackagePin.findUnique({ where: { workPackageId: Number(workPackageId) } });
  return row ? toPin(row) : null;
}

/**
 * Pins a work package: levelling will not move it. It is also switched to
 * manual scheduling, so OpenProject keeps it where it is when its predecessors
 * move; the mode it had is kept, for unpinning.
 */
export async function pinWorkPackage(workPackageId: string, reason: string | null, actorId: string): Promise<WorkPackagePin> {
  if (await pinOf(workPackageId)) throw EpmError.conflict('That work package is already pinned.');
  const current = await readWork(workPackageId);
  const projectId = Number(linkId(current._links as Parameters<typeof linkId>[0], 'project'));
  if (!current.scheduleManually) {
    await openProject.request(`/work_packages/${workPackageId}`, {
      method: 'PATCH',
      query: { notify: 'false' },
      body: { lockVersion: current.lockVersion, scheduleManually: true },
    });
  }
  const row = await withAudit(
    (tx) =>
      tx.workPackagePin.create({
        data: {
          workPackageId: Number(workPackageId),
          projectId,
          reason: reason?.trim().slice(0, 500) || null,
          pinnedBy: actorId,
          previousScheduleManually: current.scheduleManually,
        },
      }),
    () => ({
      actorId,
      entityType: 'work-package',
      entityId: workPackageId,
      action: 'work-package.pinned',
      summary: message('Work package {id} pinned: levelling will not move it.', { id: workPackageId }),
      after: { reason, previousScheduleManually: current.scheduleManually, dates: [current.startDate, current.dueDate] },
    }),
  );
  requestScheduleRecalc();
  return toPin(row);
}

/** Unpins it, and puts back the scheduling mode it had before it was pinned. */
export async function unpinWorkPackage(workPackageId: string, actorId: string): Promise<void> {
  const pin = await prisma.workPackagePin.findUnique({ where: { workPackageId: Number(workPackageId) } });
  if (!pin) throw EpmError.notFound('That pin');
  if (!pin.previousScheduleManually) {
    const current = await readWork(workPackageId);
    if (current.scheduleManually) {
      await openProject.request(`/work_packages/${workPackageId}`, {
        method: 'PATCH',
        query: { notify: 'false' },
        body: { lockVersion: current.lockVersion, scheduleManually: false },
      });
    }
  }
  await withAudit(
    (tx) => tx.workPackagePin.delete({ where: { workPackageId: Number(workPackageId) } }),
    () => ({
      actorId,
      entityType: 'work-package',
      entityId: workPackageId,
      action: 'work-package.unpinned',
      summary: message('Work package {id} unpinned.', { id: workPackageId }),
      before: { reason: pin.reason, previousScheduleManually: pin.previousScheduleManually },
    }),
  );
  requestScheduleRecalc();
}

/* -------------------------------------------------------------------------- */
/* Proposing (BR-111)                                                         */
/* -------------------------------------------------------------------------- */

const requestSchema = z.object({
  scope: z.object({
    kind: z.enum(['team', 'role', 'people']),
    id: z.string().optional(),
    people: z.array(z.union([z.string(), z.number()]).transform(String)).max(500).optional(),
  }),
  keepManual: z.boolean().optional(),
  horizonWeeks: z.number().int().min(1).max(104).optional(),
});

export interface Caller {
  id: string;
  /** Projects whose work the caller may edit: levelling moves only those. */
  mayEdit: (projectId: number) => boolean;
}

interface StoredSummary {
  scope: LevellingRunView['scope'];
  before: LevellingWeek[];
  after: LevellingWeek[];
  conflicts: LevellingRunView['conflicts'];
  fixed: LevellingRunView['fixed'];
}

const weeksOf = (weeks: CarrierWeek[], data: ResourceShared): LevellingWeek[] =>
  weeks.map((week) => ({
    key: week.carrier,
    name: data.carriers.get(week.carrier)?.name ?? week.carrier,
    week: isoOf(week.week),
    available: round2(week.available),
    load: round2(loadOf(week)),
    excess: round2(loadOf(week) - week.available),
  }));

/**
 * Levels the work of a team, a role or named people: reads the network as it
 * is now, books everything that may not move, places the rest, and stores the
 * outcome as a proposal for a preview.
 */
export async function proposeLevelling(input: unknown, caller: Caller): Promise<LevellingRunView> {
  const parsed = requestSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('Levelling needs a team, a role or the people to level.', parsed.error.issues);
  const { scope, keepManual = false, horizonWeeks = DEFAULT_HORIZON_WEEKS } = parsed.data;
  const data = await loadResourceShared();

  const people = [...data.carriers.values()].filter((carrier) => carrier.kind === 'person');
  let inScope: typeof people;
  let scopeName: string;
  if (scope.kind === 'team') {
    if (!scope.id || !data.teams.has(scope.id)) throw EpmError.notFound('That team');
    inScope = people.filter((person) => person.teamId === scope.id);
    scopeName = data.teams.get(scope.id)!;
  } else if (scope.kind === 'role') {
    if (!scope.id || !data.roles.has(scope.id)) throw EpmError.notFound('That role');
    inScope = people.filter((person) => person.roleId === scope.id);
    scopeName = data.roles.get(scope.id)!.name;
  } else {
    const wanted = new Set(scope.people ?? []);
    inScope = people.filter((person) => wanted.has(person.id));
    scopeName = inScope.map((person) => person.name).join(', ');
  }
  if (inScope.length === 0) throw EpmError.validation('There is nobody to level there.');
  const carriers = new Set(inScope.map((person) => person.key));

  const network = await readNetwork();
  const calendar = calendarOf(network);
  const today = dayOf(todayIso());
  const pins = new Set((await prisma.workPackagePin.findMany({ select: { workPackageId: true } })).map((row) => row.workPackageId));
  const work = new Map(data.facts.workPackages.map((entry) => [entry.id, entry]));
  const parents = new Set(network.workPackages.map((entry) => entry.parentId).filter((id): id is number => id !== null));

  const items: LevelItem[] = [];
  const inNetwork = new Set<number>();
  const fixed = { pinned: 0, started: 0, manual: 0, parent: 0, notEditable: 0 };
  for (const entry of network.workPackages) {
    const fact = work.get(entry.id);
    if (!fact || fact.isClosed) continue;
    const start = entry.startDate ?? entry.dueDate;
    const due = entry.dueDate ?? entry.startDate;
    if (!start || !due) continue;
    inNetwork.add(entry.id);
    const carrier = fact.assigneeId === null ? null : String(fact.assigneeId);
    let reason: FixedReason | null = null;
    if (pins.has(entry.id)) reason = 'pinned';
    else if (parents.has(entry.id)) reason = 'parent';
    // Started: under way, or time already logged against it. Work merely late
    // to start may still move — for capacity, not for being late.
    else if (['in_progress', 'review'].includes(fact.statusCategory) || fact.spentHours > 0) reason = 'started';
    else if (keepManual && entry.scheduleManually) reason = 'manual';
    else if (!caller.mayEdit(entry.projectId)) reason = 'not-editable';
    if (reason && carrier !== null && carriers.has(carrier)) {
      fixed[reason === 'not-editable' ? 'notEditable' : reason] += 1;
    }
    items.push({
      id: entry.id,
      projectId: entry.projectId,
      subject: entry.subject,
      carrier,
      hours: remainingOf(fact),
      start: dayOf(start),
      due: dayOf(due),
      scheduleManually: entry.scheduleManually,
      ignoreNonWorkingDays: entry.ignoreNonWorkingDays,
      fixed: reason,
    });
  }
  // Demand on the people in scope that is not in the network — work in a
  // project the network does not cover, planned allocations — is booked as is.
  const otherDemand: DemandItem[] = data.demand.filter(
    (item) => item.carrier !== null && carriers.has(item.carrier) && !(item.kind === 'work' && inNetwork.has(Number(item.id.slice(3)))),
  );

  const outcome = level({
    items,
    relations: network.relations.map((relation) => ({
      predecessorId: relation.predecessorId,
      successorId: relation.successorId,
      lag: relation.lag,
    })),
    calendar,
    availability: data.availability,
    otherDemand,
    carriers,
    today,
    horizonDays: horizonWeeks * 7,
  });

  const byId = new Map(items.map((item) => [item.id, item]));
  const manual = new Map(network.workPackages.map((entry) => [entry.id, entry.scheduleManually]));
  const summary: StoredSummary = {
    scope: { kind: scope.kind, ...(scope.id ? { id: scope.id } : {}), name: scopeName, people: inScope.length },
    before: weeksOf(outcome.before, data),
    after: weeksOf(outcome.after, data),
    conflicts: outcome.conflicts.map((conflict) => ({
      workPackageId: String(conflict.id),
      subject: byId.get(conflict.id)?.subject ?? `#${conflict.id}`,
      reason: conflict.reason,
    })),
    fixed,
  };

  const run = await withAudit(
    (tx) =>
      tx.levellingRun.create({
        data: {
          createdBy: caller.id,
          scope: { ...scope } as object,
          options: { keepManual, horizonWeeks },
          summary: summary as unknown as object,
          items: {
            create: outcome.moves.map((move, position) => {
              const item = byId.get(move.id)!;
              return {
                workPackageId: move.id,
                projectId: item.projectId,
                subject: item.subject,
                assigneeId: item.carrier === null ? null : Number(item.carrier),
                hours: round2(item.hours),
                beforeStart: dateOnly(isoOf(move.start)),
                beforeDue: dateOnly(isoOf(move.due)),
                afterStart: dateOnly(isoOf(move.newStart)),
                afterDue: dateOnly(isoOf(move.newDue)),
                beforeManual: manual.get(move.id) ?? true,
                reason: move.reason,
                position,
              };
            }),
          },
        },
      }),
    (created) => ({
      actorId: caller.id,
      entityType: 'levelling-run',
      entityId: created.id,
      action: 'resources.levelling.proposed',
      summary: message('Levelling proposed for {scope}: {count, plural, one {# move} other {# moves}}.', {
        scope: scopeName,
        count: outcome.moves.length,
      }),
      after: { moves: outcome.moves.length, overBefore: outcome.before.length, overAfter: outcome.after.length },
    }),
  );
  return getLevellingRun(run.id);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export async function getLevellingRun(id: string): Promise<LevellingRunView> {
  const run = await prisma.levellingRun.findUnique({ where: { id }, include: { items: { orderBy: { position: 'asc' } } } });
  if (!run) throw EpmError.notFound('That levelling run');
  const data = await loadResourceShared();
  const summary = run.summary as unknown as StoredSummary;
  const options = run.options as { keepManual?: boolean; horizonWeeks?: number };
  const workingCalendar = data.calendar;
  const isWorking = (day: number) =>
    (workingCalendar.workingWeekdays.size === 0 || workingCalendar.workingWeekdays.has((((day + 3) % 7) + 7) % 7)) &&
    !workingCalendar.holidays.has(day);
  const shift = (from: number, to: number) => {
    let count = 0;
    for (let day = from; day < to; day += 1) if (isWorking(day)) count += 1;
    return count;
  };
  const moves: LevellingMove[] = run.items.map((item) => ({
    workPackageId: String(item.workPackageId),
    projectId: String(item.projectId),
    projectName: data.facts.projects.get(item.projectId)?.name ?? `#${item.projectId}`,
    subject: item.subject,
    assigneeId: item.assigneeId === null ? null : String(item.assigneeId),
    assigneeName: item.assigneeId === null ? null : (data.carriers.get(String(item.assigneeId))?.name ?? null),
    hours: item.hours,
    beforeStart: isoDate(item.beforeStart),
    beforeDue: isoDate(item.beforeDue),
    afterStart: isoDate(item.afterStart),
    afterDue: isoDate(item.afterDue),
    beforeManual: item.beforeManual,
    reason: item.reason as LevellingMove['reason'],
    state: item.state as LevellingMove['state'],
    shiftDays: shift(dayOf(isoDate(item.beforeStart)), dayOf(isoDate(item.afterStart))),
  }));
  return {
    id: run.id,
    status: run.status as LevellingStatus,
    createdAt: run.createdAt.toISOString(),
    createdBy: run.createdBy,
    appliedAt: run.appliedAt?.toISOString() ?? null,
    appliedBy: run.appliedBy,
    undoneAt: run.undoneAt?.toISOString() ?? null,
    undoneBy: run.undoneBy,
    error: run.error === null ? null : renderStored(run.error, run.errorMessage),
    scope: summary.scope,
    options: { keepManual: options.keepManual ?? false, horizonWeeks: options.horizonWeeks ?? DEFAULT_HORIZON_WEEKS },
    moves,
    before: summary.before,
    after: summary.after,
    conflicts: summary.conflicts,
    fixed: summary.fixed,
  };
}

export async function listLevellingRuns(limit = 20): Promise<LevellingRunSummary[]> {
  const runs = await prisma.levellingRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    include: { _count: { select: { items: true } } },
  });
  return runs.map((run) => {
    const summary = run.summary as unknown as StoredSummary;
    return {
      id: run.id,
      status: run.status as LevellingStatus,
      createdAt: run.createdAt.toISOString(),
      createdBy: run.createdBy,
      scopeName: summary.scope?.name ?? '',
      moves: run._count.items,
      overBefore: summary.before?.length ?? 0,
      overAfter: summary.after?.length ?? 0,
    };
  });
}

export async function discardLevelling(id: string, actorId: string): Promise<LevellingRunView> {
  const claimed = await prisma.levellingRun.updateMany({ where: { id, status: 'proposed' }, data: { status: 'discarded' } });
  if (claimed.count === 0) await refuseState(id, 'proposed');
  await withAudit(
    async () => null,
    () => ({
      actorId,
      entityType: 'levelling-run',
      entityId: id,
      action: 'resources.levelling.discarded',
      summary: message('Levelling proposal {id} discarded.', { id }),
    }),
  );
  return getLevellingRun(id);
}

async function refuseState(id: string, wanted: 'proposed' | 'applied'): Promise<never> {
  const run = await prisma.levellingRun.findUnique({ where: { id }, select: { status: true } });
  if (!run) throw EpmError.notFound('That levelling run');
  throw EpmError.conflict(
    wanted === 'proposed'
      ? message('That levelling run is {status}: only a proposal can be applied or discarded.', { status: run.status })
      : message('That levelling run is {status}: only applied levelling can be undone.', { status: run.status }),
  );
}

/* -------------------------------------------------------------------------- */
/* Applying and undoing (BR-112)                                              */
/* -------------------------------------------------------------------------- */

interface Target {
  workPackageId: number;
  start: string;
  due: string;
  /** Set the mode too: true to switch to manual, false to switch back. */
  manual: boolean | null;
}

const read = (id: number) => readWork(id);

async function write(target: Target): Promise<void> {
  const current = await read(target.workPackageId);
  await openProject.request(`/work_packages/${target.workPackageId}`, {
    method: 'PATCH',
    query: { notify: 'false' },
    body: {
      lockVersion: current.lockVersion,
      // Switching an item back to automatic lets OpenProject date it from its
      // predecessors, which are restored first: the dates are not sent then.
      ...(target.manual === false ? { scheduleManually: false } : { startDate: target.start, dueDate: target.due }),
      ...(target.manual === true ? { scheduleManually: true } : {}),
    },
  });
}

/** Writes the targets in order; on the first refusal, puts back those written, and throws. */
async function writeAll(
  targets: Target[],
  restoreOf: (target: Target) => Target,
  onWritten: (target: Target) => Promise<void>,
): Promise<void> {
  const written: Target[] = [];
  try {
    for (const target of targets) {
      await write(target);
      written.push(target);
      await onWritten(target);
    }
  } catch (error) {
    // Put back in reverse, successors first; OpenProject re-dates automatic
    // work as each predecessor returns, so the order converges either way.
    for (const target of [...written].reverse()) {
      await write(restoreOf(target)).catch(() => undefined);
    }
    throw error;
  }
}

/** A failure levelling describes itself: its words are kept as a message, for each reader's language. */
class LevellingFailure extends Error {
  constructor(readonly why: Message) {
    super(render('en', why));
  }
}

/**
 * What went wrong, for the run's record: the English the journal keeps, and
 * the message it came from where there is one — OpenProject's own refusals are
 * its words, in English.
 */
function failureOf(error: unknown): { error: string; errorMessage: Prisma.InputJsonValue | typeof Prisma.DbNull } {
  const why = error instanceof LevellingFailure ? error.why : error instanceof EpmError ? error.source : undefined;
  return {
    error: error instanceof Error ? error.message : String(error),
    errorMessage: why ? (why as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
  };
}

/** The same, as an argument to a message: translated where it can be. */
const reasonOf = (error: unknown): Message | string =>
  error instanceof LevellingFailure ? error.why : error instanceof EpmError ? error.source : error instanceof Error ? error.message : String(error);

/**
 * Applies a proposal: every move, or none (BR-112). Refused when any item has
 * changed since it was proposed — the proposal is then stale, and nothing is
 * written.
 */
export async function applyLevelling(id: string, actorId: string): Promise<LevellingRunView> {
  const claimed = await prisma.levellingRun.updateMany({ where: { id, status: 'proposed' }, data: { status: 'applying' } });
  if (claimed.count === 0) await refuseState(id, 'proposed');
  const items = await prisma.levellingItem.findMany({ where: { runId: id }, orderBy: { position: 'asc' } });

  // Still as proposed?
  const changed: string[] = [];
  for (const item of items) {
    const current = await read(item.workPackageId).catch(() => null);
    if (
      !current ||
      current.startDate !== isoDate(item.beforeStart) ||
      current.dueDate !== isoDate(item.beforeDue) ||
      current.scheduleManually !== item.beforeManual
    ) {
      changed.push(`#${item.workPackageId}`);
    }
  }
  if (changed.length > 0) {
    await prisma.levellingRun.update({
      where: { id },
      data: { status: 'stale', ...failureOf(new LevellingFailure(message('Changed since the proposal: {items}.', { items: changed.join(', ') }))) },
    });
    throw EpmError.conflict(message('The plan changed after this proposal ({items}): level again.', { items: changed.join(', ') }));
  }

  const forward: Target[] = items.map((item) => ({
    workPackageId: item.workPackageId,
    start: isoDate(item.afterStart),
    due: isoDate(item.afterDue),
    manual: item.beforeManual ? null : true,
  }));
  const back = (target: Target): Target => {
    const item = items.find((entry) => entry.workPackageId === target.workPackageId)!;
    return { workPackageId: item.workPackageId, start: isoDate(item.beforeStart), due: isoDate(item.beforeDue), manual: item.beforeManual ? null : false };
  };
  const markState = (state: string) => async (target: Target) => {
    await prisma.levellingItem.update({ where: { runId_workPackageId: { runId: id, workPackageId: target.workPackageId } }, data: { state } });
  };

  try {
    await writeAll(forward, back, markState('applied'));
    // Read back: every item where the proposal put it.
    const off: string[] = [];
    for (const target of forward) {
      const current = await read(target.workPackageId);
      if (current.startDate !== target.start || current.dueDate !== target.due) off.push(`#${target.workPackageId}`);
    }
    if (off.length > 0) {
      for (const target of [...forward].reverse()) await write(back(target)).catch(() => undefined);
      throw new LevellingFailure(message('OpenProject did not keep the new dates of {items}; everything was put back.', { items: off.join(', ') }));
    }
  } catch (error) {
    await prisma.levellingItem.updateMany({ where: { runId: id }, data: { state: 'pending' } });
    await prisma.levellingRun.update({ where: { id }, data: { status: 'failed', ...failureOf(error) } });
    requestScheduleRecalc();
    forgetShared();
    throw EpmError.conflict(message('Levelling was not applied, and nothing was changed: {reason}', { reason: reasonOf(error) }));
  }

  await withAudit(
    (tx) => tx.levellingRun.update({ where: { id }, data: { status: 'applied', appliedAt: new Date(), appliedBy: actorId, error: null, errorMessage: Prisma.DbNull } }),
    () => ({
      actorId,
      entityType: 'levelling-run',
      entityId: id,
      action: 'resources.levelling.applied',
      summary: message('Levelling applied: {count, plural, one {# work package} other {# work packages}} moved.', { count: items.length }),
      after: { moves: items.map((item) => ({ id: item.workPackageId, from: isoDate(item.beforeStart), to: isoDate(item.afterStart) })) },
    }),
  );
  requestScheduleRecalc();
  forgetShared();
  return getLevellingRun(id);
}

/**
 * Undoes applied levelling in one action (BR-112): every item back to its
 * dates and mode before. Refused while any of them has been changed since —
 * undoing would overwrite that change.
 */
export async function undoLevelling(id: string, actorId: string): Promise<LevellingRunView> {
  const claimed = await prisma.levellingRun.updateMany({ where: { id, status: 'applied' }, data: { status: 'undoing' } });
  if (claimed.count === 0) await refuseState(id, 'applied');
  const items = await prisma.levellingItem.findMany({ where: { runId: id }, orderBy: { position: 'asc' } });

  const changed: string[] = [];
  for (const item of items) {
    const current = await read(item.workPackageId).catch(() => null);
    if (!current || current.startDate !== isoDate(item.afterStart) || current.dueDate !== isoDate(item.afterDue)) {
      changed.push(`#${item.workPackageId}`);
    }
  }
  if (changed.length > 0) {
    await prisma.levellingRun.update({ where: { id }, data: { status: 'applied' } });
    throw EpmError.conflict(message('Some of this work changed after levelling ({items}): undoing would overwrite that.', { items: changed.join(', ') }));
  }

  // Predecessors first, so work returning to automatic scheduling is dated
  // from predecessors that are already back.
  const backward: Target[] = items.map((item) => ({
    workPackageId: item.workPackageId,
    start: isoDate(item.beforeStart),
    due: isoDate(item.beforeDue),
    manual: item.beforeManual ? null : false,
  }));
  const again = (target: Target): Target => {
    const item = items.find((entry) => entry.workPackageId === target.workPackageId)!;
    return { workPackageId: item.workPackageId, start: isoDate(item.afterStart), due: isoDate(item.afterDue), manual: item.beforeManual ? null : true };
  };
  try {
    await writeAll(backward, again, async (target) => {
      await prisma.levellingItem.update({
        where: { runId_workPackageId: { runId: id, workPackageId: target.workPackageId } },
        data: { state: 'undone' },
      });
    });
    const off: string[] = [];
    for (const target of backward) {
      const current = await read(target.workPackageId);
      if (current.startDate !== target.start || current.dueDate !== target.due) off.push(`#${target.workPackageId}`);
    }
    if (off.length > 0) throw new LevellingFailure(message('OpenProject did not return {items} to the dates before.', { items: off.join(', ') }));
  } catch (error) {
    await prisma.levellingItem.updateMany({ where: { runId: id }, data: { state: 'applied' } });
    await prisma.levellingRun.update({ where: { id }, data: { status: 'applied', ...failureOf(error) } });
    requestScheduleRecalc();
    forgetShared();
    throw EpmError.conflict(message('The undo did not complete, and the levelled dates stand: {reason}', { reason: reasonOf(error) }));
  }

  await withAudit(
    (tx) => tx.levellingRun.update({ where: { id }, data: { status: 'undone', undoneAt: new Date(), undoneBy: actorId, error: null, errorMessage: Prisma.DbNull } }),
    () => ({
      actorId,
      entityType: 'levelling-run',
      entityId: id,
      action: 'resources.levelling.undone',
      summary: message('Levelling undone: {count, plural, one {# work package} other {# work packages}} back to the dates before.', {
        count: items.length,
      }),
      after: { moves: items.length },
    }),
  );
  requestScheduleRecalc();
  forgetShared();
  return getLevellingRun(id);
}
