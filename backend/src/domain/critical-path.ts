/**
 * Critical path and float (BR-101): a forward and a backward pass over the
 * work package network, in working days.
 *
 * The network is OpenProject's: work packages with dates, and the `follows`
 * relations between them. A successor starts no sooner than OpenProject
 * itself would put it (`Relation#successor_soonest_start`): the lag is counted
 * in working days from the day after the predecessor finishes, and the
 * successor then starts on its own next working day. Other relation types do
 * not constrain dates upstream and are not used. A relation on a parent holds
 * back every child under it — a dependency between two phases is one between
 * their contents — and a parent's own figures are rolled up from its children.
 *
 * - Early start: the item's own start when nothing precedes it, or when it is
 *   scheduled manually (its date is then a "not earlier than"); otherwise as
 *   soon as every predecessor allows. Early finish: early start plus its
 *   duration in working days.
 * - Late finish: as late as every successor allows, or — with no successor —
 *   the finish of its project's network (the latest early finish in it). Late
 *   start: late finish less its duration.
 * - Total float: late start less early start, in working days. Free float: how
 *   far it can slip without delaying any successor's early start, or the
 *   project's finish when it has none.
 * - A cycle of `follows` cannot be scheduled; its members are reported, and the
 *   relations inside it are left out so everything else still is.
 *
 * Pure: no database and no OpenProject. `schedule-network.ts` reads the
 * network and stores what this returns.
 */

export interface NetworkItem {
  id: number;
  projectId: number;
  parentId: number | null;
  subject: string;
  /** ISO dates. A milestone has one date: both the same. */
  startDate: string | null;
  dueDate: string | null;
  /** Working days, as OpenProject stores it; derived from the dates where absent. */
  duration: number | null;
  scheduleManually: boolean;
  /** Counts every calendar day, as OpenProject does when this is set. */
  ignoreNonWorkingDays: boolean;
  isMilestone: boolean;
}

/** `successor` follows `predecessor`, `lag` working days after it finishes. */
export interface NetworkRelation {
  predecessorId: number;
  successorId: number;
  lag: number;
}

export interface WorkingCalendar {
  /** ISO weekdays that are worked: 1 Monday … 7 Sunday. */
  weekdays: ReadonlySet<number>;
  /** ISO dates that are not worked, whatever their weekday. */
  holidays: ReadonlySet<string>;
}

export interface FloatResult {
  id: number;
  projectId: number;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  /** Working days the item can slip without delaying its project's finish. */
  totalFloat: number;
  /** Working days it can slip without delaying any successor. */
  freeFloat: number;
  /** Total float of nought or less. */
  critical: boolean;
  /** A parent: its figures are its children's, rolled up. */
  summary: boolean;
  /** Part of a cycle of relations, scheduled as if the cycle's relations were not there. */
  inCycle: boolean;
}

/** A relation as given, and whether it sets its successor's early start. */
export interface LinkResult {
  predecessorId: number;
  successorId: number;
  lag: number;
  /**
   * The predecessor is what holds the successor back: it could start no
   * sooner. A chain of driving links between critical items is the critical
   * path drawn.
   */
  driving: boolean;
}

export interface CriticalPathOutcome {
  results: Map<number, FloatResult>;
  /** One per relation given, in the same order. */
  links: LinkResult[];
  /** Each cycle's members. */
  cycles: number[][];
  /** Items left out for want of dates. */
  unscheduled: number[];
  /** The finish of each project's network: its latest early finish. */
  projectFinish: Map<number, string>;
}

/* -------------------------------------------------------------------------- */
/* Days                                                                       */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;
export const dayOf = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
export const isoOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** 1 Monday … 7 Sunday. 1970-01-01 was a Thursday. */
const weekdayOf = (day: number): number => ((((day + 3) % 7) + 7) % 7) + 1;

/**
 * Working-day arithmetic for one calendar. `continuous` counts every day: an
 * item that ignores non-working days.
 */
export class DayCounter {
  private readonly holidays: Set<number>;

  constructor(
    private readonly calendar: WorkingCalendar,
    private readonly continuous: boolean,
  ) {
    this.holidays = new Set([...calendar.holidays].map(dayOf));
  }

  isWorking(day: number): boolean {
    if (this.continuous) return true;
    return this.calendar.weekdays.has(weekdayOf(day)) && !this.holidays.has(day);
  }

  /** The day itself if worked, else the next that is. */
  onOrAfter(day: number): number {
    let at = day;
    for (let guard = 0; !this.isWorking(at); guard += 1) {
      if (guard > 3660) throw new Error('No working day within ten years: the working calendar has none.');
      at += 1;
    }
    return at;
  }

  /** The day itself if worked, else the last before it that was. */
  onOrBefore(day: number): number {
    let at = day;
    for (let guard = 0; !this.isWorking(at); guard += 1) {
      if (guard > 3660) throw new Error('No working day within ten years: the working calendar has none.');
      at -= 1;
    }
    return at;
  }

  /** `count` working days on from a working day; backwards when negative. */
  add(day: number, count: number): number {
    let at = day;
    let left = Math.abs(count);
    const step = count < 0 ? -1 : 1;
    while (left > 0) {
      at += step;
      if (this.isWorking(at)) left -= 1;
    }
    return at;
  }

  /** Working days from `from` to `to`: positive when `to` is later, nought when the same. */
  between(from: number, to: number): number {
    if (from === to) return 0;
    const [low, high, sign] = from < to ? [from, to, 1] : [to, from, -1];
    let count = 0;
    for (let at = low; at < high; at += 1) if (this.isWorking(at)) count += 1;
    // `low` is counted, `high` is not: from Monday to Wednesday is two working days.
    return sign * count;
  }

  /** Working days from `start` to `finish`, both counted. */
  span(start: number, finish: number): number {
    return Math.max(1, this.between(start, finish) + (this.isWorking(finish) ? 1 : 0));
  }
}

/* -------------------------------------------------------------------------- */
/* The passes                                                                 */
/* -------------------------------------------------------------------------- */

interface Node {
  item: NetworkItem;
  days: DayCounter;
  /** Working days it takes; a milestone takes its one day. */
  duration: number;
  /** Its own start, as a working day, where it constrains the early start. */
  anchor: number | null;
  preds: { from: number; lag: number }[];
  succs: { to: number; lag: number }[];
  es: number;
  ef: number;
  ls: number;
  lf: number;
  inCycle: boolean;
}

/** Strongly connected components (Tarjan), iteratively: a deep chain does not overflow the stack. */
function cyclesOf(ids: number[], next: (id: number) => number[]): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const cycles: number[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: number; edge: number }[] = [{ id: root, edge: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const edges = next(frame.id);
      if (frame.edge < edges.length) {
        const to = edges[frame.edge]!;
        frame.edge += 1;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, edge: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: number[] = [];
        let member: number;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        const selfLoop = component.length === 1 && next(frame.id).includes(frame.id);
        if (component.length > 1 || selfLoop) cycles.push(component.sort((a, b) => a - b));
      }
    }
  }
  return cycles;
}

export function computeCriticalPath(
  items: NetworkItem[],
  relations: NetworkRelation[],
  calendar: WorkingCalendar,
): CriticalPathOutcome {
  const working = new DayCounter(calendar, false);
  const continuous = new DayCounter(calendar, true);
  const byId = new Map(items.map((item) => [item.id, item]));

  // Hierarchy: a parent with scheduled descendants is a summary of them.
  const children = new Map<number, number[]>();
  for (const item of items) {
    if (item.parentId !== null && byId.has(item.parentId)) {
      const list = children.get(item.parentId) ?? [];
      list.push(item.id);
      children.set(item.parentId, list);
    }
  }
  const scheduled = (item: NetworkItem) => Boolean(item.startDate && item.dueDate);
  const leavesCache = new Map<number, number[]>();
  const leavesOf = (id: number, seen = new Set<number>()): number[] => {
    const cached = leavesCache.get(id);
    if (cached) return cached;
    if (seen.has(id)) return [];
    seen.add(id);
    const kids = children.get(id) ?? [];
    const below = kids.flatMap((kid) => leavesOf(kid, seen));
    const item = byId.get(id)!;
    const result = below.length > 0 ? below : scheduled(item) ? [id] : [];
    leavesCache.set(id, result);
    return result;
  };
  const summaries = new Set(items.filter((item) => leavesOf(item.id).some((leaf) => leaf !== item.id)).map((item) => item.id));
  const unscheduled = items.filter((item) => !scheduled(item) && !summaries.has(item.id)).map((item) => item.id);

  // The nodes: scheduled items that are not summaries.
  const nodes = new Map<number, Node>();
  for (const item of items) {
    if (!scheduled(item) || summaries.has(item.id)) continue;
    const days = item.ignoreNonWorkingDays ? continuous : working;
    const start = days.onOrAfter(dayOf(item.startDate!));
    const finish = Math.max(start, days.onOrBefore(dayOf(item.dueDate!)));
    const duration = item.isMilestone ? 1 : Math.max(1, item.duration && item.duration > 0 ? item.duration : days.span(start, finish));
    nodes.set(item.id, {
      item,
      days,
      duration,
      anchor: start,
      preds: [],
      succs: [],
      es: start,
      ef: finish,
      ls: start,
      lf: finish,
      inCycle: false,
    });
  }

  // Edges, with a parent's relations applied to its children; the longest lag wins a duplicate.
  const edges = new Map<string, { from: number; to: number; lag: number }>();
  const pairsOf = relations.map((relation) => {
    const froms = byId.has(relation.predecessorId) ? leavesOf(relation.predecessorId) : [];
    const tos = byId.has(relation.successorId) ? leavesOf(relation.successorId) : [];
    const lag = Math.max(0, Math.round(relation.lag || 0));
    const pairs: [number, number][] = [];
    for (const from of froms) {
      for (const to of tos) {
        if (from === to || !nodes.has(from) || !nodes.has(to)) continue;
        pairs.push([from, to]);
        const key = `${from}>${to}`;
        const existing = edges.get(key);
        if (!existing || existing.lag < lag) edges.set(key, { from, to, lag });
      }
    }
    return { lag, pairs };
  });

  // Cycles: reported, and their inner relations left out.
  const out = new Map<number, number[]>();
  for (const edge of edges.values()) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  const cycles = cyclesOf([...nodes.keys()], (id) => out.get(id) ?? []);
  const cycleOf = new Map<number, number>();
  cycles.forEach((members, index) => members.forEach((id) => cycleOf.set(id, index)));
  for (const edge of edges.values()) {
    const a = cycleOf.get(edge.from);
    if (a !== undefined && a === cycleOf.get(edge.to)) continue;
    nodes.get(edge.from)!.succs.push({ to: edge.to, lag: edge.lag });
    nodes.get(edge.to)!.preds.push({ from: edge.from, lag: edge.lag });
  }
  for (const id of cycleOf.keys()) nodes.get(id)!.inCycle = true;

  // An item with predecessors is anchored at its own start only when scheduled by hand.
  for (const node of nodes.values()) if (node.preds.length > 0 && !node.item.scheduleManually) node.anchor = null;

  // Topological order (Kahn), now that no cycle is left.
  const indegree = new Map([...nodes.keys()].map((id) => [id, nodes.get(id)!.preds.length]));
  const order: number[] = [];
  const ready = [...nodes.keys()].filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const { to } of nodes.get(id)!.succs) {
      const left = indegree.get(to)! - 1;
      indegree.set(to, left);
      if (left === 0) ready.push(to);
    }
  }

  // OpenProject's rule: from the day after the predecessor finishes, count the
  // lag in working days — whatever either side's own calendar — and start on
  // the successor's next working day from there.
  const afterLag = (finish: number, lag: number) => {
    let at = finish + 1;
    for (let left = lag; left > 0; at += 1) if (working.isWorking(at)) left -= 1;
    return at;
  };
  const soonest = (finish: number, lag: number, successorDays: DayCounter) => successorDays.onOrAfter(afterLag(finish, lag));
  // Its inverse: the latest a predecessor may finish and its successor still
  // start on `start`. With a lag, that many working days must lie between
  // the two, so the finish is the day before the lag-th working day back.
  const latest = (start: number, lag: number, predecessorDays: DayCounter) => {
    const bound = lag > 0 ? working.add(working.onOrBefore(start - 1), -(lag - 1)) - 1 : start - 1;
    return predecessorDays.onOrBefore(bound);
  };

  // Forward.
  for (const id of order) {
    const node = nodes.get(id)!;
    let es = node.anchor ?? Number.NEGATIVE_INFINITY;
    for (const { from, lag } of node.preds) es = Math.max(es, soonest(nodes.get(from)!.ef, lag, node.days));
    if (!Number.isFinite(es)) es = node.anchor!;
    node.es = node.days.onOrAfter(es);
    node.ef = node.days.add(node.es, node.duration - 1);
  }

  // Each project's finish: its latest early finish.
  const finishOf = new Map<number, number>();
  for (const node of nodes.values()) {
    const project = node.item.projectId;
    finishOf.set(project, Math.max(finishOf.get(project) ?? Number.NEGATIVE_INFINITY, node.ef));
  }

  // Backward.
  for (let at = order.length - 1; at >= 0; at -= 1) {
    const node = nodes.get(order[at]!)!;
    let lf = Number.POSITIVE_INFINITY;
    for (const { to, lag } of node.succs) lf = Math.min(lf, latest(nodes.get(to)!.ls, lag, node.days));
    if (!Number.isFinite(lf)) lf = finishOf.get(node.item.projectId)!;
    node.lf = node.days.onOrBefore(Math.max(lf, node.ef));
    node.ls = node.days.add(node.lf, -(node.duration - 1));
  }

  const results = new Map<number, FloatResult>();
  for (const node of nodes.values()) {
    const totalFloat = node.days.between(node.es, node.ls);
    let bound = Number.POSITIVE_INFINITY;
    for (const { to, lag } of node.succs) bound = Math.min(bound, latest(nodes.get(to)!.es, lag, node.days));
    if (!Number.isFinite(bound)) bound = finishOf.get(node.item.projectId)!;
    const freeFloat = Math.max(0, node.days.between(node.ef, Math.max(bound, node.ef)));
    results.set(node.item.id, {
      id: node.item.id,
      projectId: node.item.projectId,
      earlyStart: isoOf(node.es),
      earlyFinish: isoOf(node.ef),
      lateStart: isoOf(node.ls),
      lateFinish: isoOf(node.lf),
      totalFloat,
      freeFloat,
      critical: totalFloat <= 0,
      summary: false,
      inCycle: node.inCycle,
    });
  }

  // Summaries: their children's figures rolled up.
  for (const id of summaries) {
    const leaves = leavesOf(id).map((leaf) => results.get(leaf)).filter((result): result is FloatResult => Boolean(result));
    if (leaves.length === 0) continue;
    const item = byId.get(id)!;
    const min = (pick: (result: FloatResult) => string) => leaves.map(pick).sort()[0]!;
    const max = (pick: (result: FloatResult) => string) => leaves.map(pick).sort().at(-1)!;
    const totalFloat = Math.min(...leaves.map((leaf) => leaf.totalFloat));
    results.set(id, {
      id,
      projectId: item.projectId,
      earlyStart: min((leaf) => leaf.earlyStart),
      earlyFinish: max((leaf) => leaf.earlyFinish),
      lateStart: min((leaf) => leaf.lateStart),
      lateFinish: max((leaf) => leaf.lateFinish),
      totalFloat,
      freeFloat: Math.min(...leaves.map((leaf) => leaf.freeFloat)),
      critical: totalFloat <= 0,
      summary: true,
      inCycle: leaves.some((leaf) => leaf.inCycle),
    });
  }

  // A relation drives when one of the leaf pairs it stands for does: the
  // successor starts exactly when that predecessor lets it. Not inside a
  // cycle, whose relations were left out.
  const links: LinkResult[] = relations.map((relation, index) => {
    const { lag, pairs } = pairsOf[index]!;
    const driving = pairs.some(([from, to]) => {
      const a = cycleOf.get(from);
      if (a !== undefined && a === cycleOf.get(to)) return false;
      const successor = nodes.get(to)!;
      return soonest(nodes.get(from)!.ef, lag, successor.days) === successor.es;
    });
    return { predecessorId: relation.predecessorId, successorId: relation.successorId, lag, driving };
  });

  return {
    results,
    links,
    cycles,
    unscheduled,
    projectFinish: new Map([...finishOf].map(([project, day]) => [project, isoOf(day)])),
  };
}
