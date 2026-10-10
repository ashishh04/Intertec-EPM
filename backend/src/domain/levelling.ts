import { DayCounter, isoOf, type WorkingCalendar } from './critical-path.js';
import {
  EPSILON,
  isOverAllocated,
  spread,
  weekOf,
  weeklyLoads,
  type AvailabilityModel,
  type CarrierWeek,
  type DemandItem,
} from './resource-model.js';

/**
 * Resource levelling (BR-111): new dates for work that resolve
 * over-allocation, honouring dependencies, and never moving what must stay.
 *
 * A serial pass. Work that may move is taken in order — earliest start first,
 * never before its predecessors — and placed at the first start, on or after
 * its own start and as soon as its predecessors allow, at which its hours fit
 * its assignee's free hours in every week it touches. Everything that may not
 * move is booked first, with every other demand on the same people: planned
 * allocations, work outside the scope. It only ever delays, it keeps each
 * item's length in working days — unless its hours cannot fit that length at
 * any start, when it is stretched — and it never moves an item past the
 * latest start that keeps a successor that may not move where it is. That
 * limit is what keeps pinned milestones still: where work cannot fit before
 * one, it stays where its predecessors allow and the clash is reported.
 *
 * Pure: the dates in, the dates out. Writing them is `levelling-store.ts`.
 */

/** Why an item may not move. */
export type FixedReason =
  /** Pinned: a contractual date levelling never moves. */
  | 'pinned'
  /** Started already: its dates are history. */
  | 'started'
  /** Manually scheduled, where the run was asked to keep such work. */
  | 'manual'
  /** A parent: its dates follow its children's. */
  | 'parent'
  /** The person running it may not edit it. */
  | 'not-editable';

export interface LevelItem {
  id: number;
  projectId: number;
  subject: string;
  /** Whoever its hours fall on, or null. */
  carrier: string | null;
  /** Hours still to do. */
  hours: number;
  start: number;
  due: number;
  scheduleManually: boolean;
  ignoreNonWorkingDays: boolean;
  /** Why it may not move; null when it may. */
  fixed: FixedReason | null;
}

export interface LevelRelation {
  predecessorId: number;
  successorId: number;
  lag: number;
}

export interface LevelInput {
  items: LevelItem[];
  relations: LevelRelation[];
  /** The instance's working calendar, as the schedule uses it. */
  calendar: WorkingCalendar;
  availability: AvailabilityModel;
  /** Demand that is not in `items` and cannot move: allocations, work outside the scope. */
  otherDemand: DemandItem[];
  /** The carriers whose over-allocation is to be resolved. */
  carriers: ReadonlySet<string>;
  today: number;
  /** How far past its earliest start an item may be pushed, in days. */
  horizonDays: number;
}

export type MoveReason = 'capacity' | 'dependency' | 'stretched';

export interface LevelMove {
  id: number;
  start: number;
  due: number;
  newStart: number;
  newDue: number;
  reason: MoveReason;
}

export interface LevelConflict {
  id: number;
  /** `pinned`: it cannot fit before work that may not move. `horizon`: no room within the horizon. */
  reason: 'pinned' | 'horizon';
}

export interface LevelOutcome {
  /** The items that move, predecessors first: the order to write them in. */
  moves: LevelMove[];
  conflicts: LevelConflict[];
  /** Over-allocated weeks of the carriers in scope, before and after. */
  before: CarrierWeek[];
  after: CarrierWeek[];
}

const workItem = (item: LevelItem, start: number, due: number): DemandItem => ({
  id: `wp:${item.id}`,
  kind: 'work',
  carrier: item.carrier,
  roleId: null,
  projectId: item.projectId,
  hours: item.hours,
  start,
  due,
});

export function level(input: LevelInput): LevelOutcome {
  const { items, relations, availability, today } = input;
  const byId = new Map(items.map((item) => [item.id, item]));
  const working = new DayCounter(input.calendar, false);
  const counters = new Map<number, DayCounter>();
  const counterOf = (item: LevelItem) => {
    let counter = counters.get(item.id);
    if (!counter) {
      counter = item.ignoreNonWorkingDays ? new DayCounter(input.calendar, true) : working;
      counters.set(item.id, counter);
    }
    return counter;
  };

  // OpenProject's lag rule, as `critical-path.ts` applies it: from the day after
  // the predecessor finishes, the lag in working days, then the successor's
  // next working day.
  const afterLag = (finish: number, lag: number) => {
    let at = finish + 1;
    for (let left = lag; left > 0; at += 1) if (working.isWorking(at)) left -= 1;
    return at;
  };
  const soonest = (finish: number, lag: number, successor: LevelItem) => counterOf(successor).onOrAfter(afterLag(finish, lag));
  const latestFinish = (start: number, lag: number, predecessor: LevelItem) => {
    const bound = lag > 0 ? working.add(working.onOrBefore(start - 1), -(lag - 1)) - 1 : start - 1;
    return counterOf(predecessor).onOrBefore(bound);
  };
  const lengthOf = (item: LevelItem, start = item.start, due = item.due) => counterOf(item).span(start, due);
  const dueFor = (item: LevelItem, start: number, length: number) => counterOf(item).add(start, length - 1);

  const preds = new Map<number, LevelRelation[]>();
  const succs = new Map<number, LevelRelation[]>();
  for (const relation of relations) {
    if (!byId.has(relation.predecessorId) || !byId.has(relation.successorId)) continue;
    preds.set(relation.successorId, [...(preds.get(relation.successorId) ?? []), relation]);
    succs.set(relation.predecessorId, [...(succs.get(relation.predecessorId) ?? []), relation]);
  }

  // A topological order (Kahn), earliest start first among those ready. A loop
  // — which OpenProject refuses but data can hold — leaves its items out of the
  // order: they keep their dates.
  const indegree = new Map(items.map((item) => [item.id, (preds.get(item.id) ?? []).length]));
  const ready = items.filter((item) => indegree.get(item.id) === 0);
  const order: LevelItem[] = [];
  const byStart = (a: LevelItem, b: LevelItem) => a.start - b.start || a.due - b.due || a.id - b.id;
  while (ready.length > 0) {
    ready.sort(byStart);
    const next = ready.shift()!;
    order.push(next);
    for (const relation of succs.get(next.id) ?? []) {
      const left = indegree.get(relation.successorId)! - 1;
      indegree.set(relation.successorId, left);
      if (left === 0) ready.push(byId.get(relation.successorId)!);
    }
  }
  const ordered = new Set(order.map((item) => item.id));
  const movable = (item: LevelItem) => item.fixed === null && ordered.has(item.id);

  // The latest each item may finish so every successor that may not move stays
  // where it is: a backward pass from those, through work that may move at its
  // own length. Unbounded where nothing fixed follows.
  const latestEnd = new Map<number, number>();
  for (const item of [...order].reverse()) {
    let bound = Number.POSITIVE_INFINITY;
    for (const relation of succs.get(item.id) ?? []) {
      const successor = byId.get(relation.successorId)!;
      if (!movable(successor)) {
        // Where the plan already has it finishing too late for that successor
        // — manual scheduling lets a plan hold that — it may stay, but not
        // move later still.
        bound = Math.min(bound, Math.max(latestFinish(successor.start, relation.lag, item), item.due));
      } else {
        const successorEnd = latestEnd.get(successor.id) ?? Number.POSITIVE_INFINITY;
        if (successorEnd !== Number.POSITIVE_INFINITY) {
          const successorStart = counterOf(successor).add(successorEnd, -(lengthOf(successor) - 1));
          bound = Math.min(bound, latestFinish(successorStart, relation.lag, item));
        }
      }
    }
    latestEnd.set(item.id, bound);
  }

  // The weeks that matter: from this one to well past the last date anything could reach.
  const lastDate = Math.max(today, ...items.map((item) => item.due), ...input.otherDemand.map((item) => item.due ?? today));
  const fromWeek = weekOf(today);
  const toWeek = weekOf(lastDate + input.horizonDays + 7 * 8);
  const scopeCarriers = new Set<string>(input.carriers);

  const fixedDemand: DemandItem[] = [...input.otherDemand];
  for (const item of items) if (!movable(item)) fixedDemand.push(workItem(item, item.start, item.due));
  const beforeDemand = [...input.otherDemand, ...items.map((item) => workItem(item, item.start, item.due))];
  const before = overWeeks(weeklyLoads(beforeDemand, availability, scopeCarriers, fromWeek, toWeek, today));

  // The ledger: what is booked on each carrier in scope, week by week.
  const ledger = weeklyLoads(fixedDemand, availability, scopeCarriers, fromWeek, toWeek, today);
  const fits = (item: LevelItem, start: number, due: number) => {
    if (!item.carrier || !scopeCarriers.has(item.carrier)) return true;
    const weeks = ledger.get(item.carrier)!;
    const days = spread(workItem(item, start, due), availability, today);
    if (!days) return true;
    const byWeek = new Map<number, number>();
    for (const [day, hours] of days) byWeek.set(weekOf(day), (byWeek.get(weekOf(day)) ?? 0) + hours);
    for (const [week, hours] of byWeek) {
      const cell = weeks.get(week);
      if (!cell) return false;
      if (cell.committed + cell.planned + hours > cell.available + EPSILON) return false;
    }
    return true;
  };
  const book = (item: LevelItem, start: number, due: number) => {
    if (!item.carrier || !scopeCarriers.has(item.carrier)) return;
    const weeks = ledger.get(item.carrier)!;
    const days = spread(workItem(item, start, due), availability, today);
    if (!days) return;
    for (const [day, hours] of days) {
      const cell = weeks.get(weekOf(day));
      if (cell) cell.committed += hours;
    }
  };

  const placed = new Map<number, { start: number; due: number }>();
  for (const item of items) if (!movable(item)) placed.set(item.id, { start: item.start, due: item.due });

  const moves: LevelMove[] = [];
  const conflicts: LevelConflict[] = [];
  for (const item of order) {
    if (!movable(item)) continue;
    const counter = counterOf(item);
    const length = lengthOf(item);
    let earliest = counter.onOrAfter(Math.max(item.start, today));
    for (const relation of preds.get(item.id) ?? []) {
      const predecessor = placed.get(relation.predecessorId);
      if (!predecessor) continue;
      const after = soonest(predecessor.due, relation.lag, item);
      // A predecessor that did not move holds it back only as the plan
      // already has it: a clash the plan holds — manual scheduling allows one
      // — is not this run's to repair.
      const moved = predecessor.due !== byId.get(relation.predecessorId)!.due;
      if (!moved && after > item.start) continue;
      earliest = Math.max(earliest, after);
    }
    const endBound = latestEnd.get(item.id) ?? Number.POSITIVE_INFINITY;
    const startBound = endBound === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : counter.add(endBound, -(length - 1));
    const limit = Math.min(startBound, earliest + input.horizonDays);

    let chosen: { start: number; due: number; length: number } | null = null;
    // Work that should have started already, and has not, keeps its dates if
    // they still fit: levelling moves it for capacity, never for being late.
    if (item.start < earliest && earliest === counter.onOrAfter(Math.max(item.start, today)) && item.due <= endBound && fits(item, item.start, item.due)) {
      chosen = { start: item.start, due: item.due, length };
    }
    for (let start = earliest; start <= limit && !chosen; start = counter.onOrAfter(start + 1)) {
      const due = dueFor(item, start, length);
      if (due <= endBound && fits(item, start, due)) chosen = { start, due, length };
    }
    // Hours that fit no start at this length: longer, a working day at a time.
    for (let longer = length + 1; !chosen && item.carrier && longer <= length * 4 + 5; longer += 1) {
      for (let start = earliest; start <= limit && !chosen; start = counter.onOrAfter(start + 1)) {
        const due = dueFor(item, start, longer);
        if (due <= endBound && fits(item, start, due)) chosen = { start, due, length: longer };
      }
    }
    if (!chosen) {
      // No room: it stays where its predecessors allow, and the clash is reported.
      chosen = { start: earliest, due: dueFor(item, earliest, length), length };
      conflicts.push({ id: item.id, reason: startBound < earliest + input.horizonDays ? 'pinned' : 'horizon' });
    }
    book(item, chosen.start, chosen.due);
    placed.set(item.id, { start: chosen.start, due: chosen.due });
    if (chosen.start !== item.start || chosen.due !== item.due) {
      // Moved by a predecessor only when one pushed its earliest start and it
      // starts there; otherwise it moved to fit its assignee.
      const pushed = earliest > counter.onOrAfter(Math.max(item.start, today));
      moves.push({
        id: item.id,
        start: item.start,
        due: item.due,
        newStart: chosen.start,
        newDue: chosen.due,
        reason: chosen.length !== length ? 'stretched' : pushed && chosen.start === earliest ? 'dependency' : 'capacity',
      });
    }
  }

  const afterDemand = [
    ...input.otherDemand,
    ...items.map((item) => {
      const at = placed.get(item.id) ?? { start: item.start, due: item.due };
      return workItem(item, at.start, at.due);
    }),
  ];
  const after = overWeeks(weeklyLoads(afterDemand, availability, scopeCarriers, fromWeek, toWeek, today));
  return { moves, conflicts, before, after };
}

const overWeeks = (loads: Map<string, Map<number, CarrierWeek>>): CarrierWeek[] => {
  const out: CarrierWeek[] = [];
  for (const weeks of loads.values()) for (const week of weeks.values()) if (isOverAllocated(week)) out.push(week);
  return out.sort((a, b) => a.week - b.week || a.carrier.localeCompare(b.carrier));
};

/** A move, as dates. */
export const moveDates = (move: LevelMove) => ({
  start: isoOf(move.start),
  due: isoOf(move.due),
  newStart: isoOf(move.newStart),
  newDue: isoOf(move.newDue),
});
