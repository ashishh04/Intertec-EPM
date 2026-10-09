import assert from 'node:assert/strict';

import {
  computeCriticalPath,
  dayOf,
  DayCounter,
  isoOf,
  type NetworkItem,
  type NetworkRelation,
  type WorkingCalendar,
} from '../critical-path.js';

/**
 * Worked examples for critical path and float (BR-101): working-day
 * arithmetic, a reference network of 200 work packages checked item by item
 * against a control set worked by hand and against an independent solver, the
 * rules for lag, milestones, manual dates, parents, cycles and missing dates,
 * and the time a 2,000-item network takes (BR-104).
 *
 *   npx tsx src/domain/__checks__/schedule.check.ts
 */

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

/** Monday to Friday, with two holidays: Wednesday 14 and Tuesday 27 October 2026. */
const calendar: WorkingCalendar = { weekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-10-14', '2026-10-27']) };
const working = new DayCounter(calendar, false);
const d = dayOf;

const item = (id: number, projectId: number, start: string, finish: string, extra: Partial<NetworkItem> = {}): NetworkItem => ({
  id,
  projectId,
  parentId: null,
  subject: `Item ${id}`,
  startDate: start,
  dueDate: finish,
  duration: null,
  scheduleManually: false,
  ignoreNonWorkingDays: false,
  isMilestone: false,
  ...extra,
});
const follows = (successorId: number, predecessorId: number, lag = 0): NetworkRelation => ({ successorId, predecessorId, lag });

console.log('Working days');

await check('a working day is Monday to Friday, less the holidays', () => {
  assert.equal(working.isWorking(d('2026-10-12')), true, 'Monday');
  assert.equal(working.isWorking(d('2026-10-14')), false, 'the holiday');
  assert.equal(working.isWorking(d('2026-10-17')), false, 'Saturday');
});

await check('counting on and back skips weekends and holidays', () => {
  assert.equal(isoOf(working.add(d('2026-10-13'), 1)), '2026-10-15', 'Tuesday plus one is Thursday: Wednesday is a holiday');
  assert.equal(isoOf(working.add(d('2026-10-16'), 1)), '2026-10-19', 'Friday plus one is Monday');
  assert.equal(isoOf(working.add(d('2026-10-19'), -1)), '2026-10-16', 'and back');
  assert.equal(working.between(d('2026-10-12'), d('2026-10-19')), 4, 'a week with a holiday is four working days');
  assert.equal(working.span(d('2026-10-12'), d('2026-10-16')), 4, 'Monday to Friday that week: four, both counted');
});

console.log('A reference network of 200 work packages (BR-101)');

/**
 * The control set, worked by hand in working days from A's start (day 0):
 *
 *   item  dur  follows                  ES EF LS LF  TF FF
 *   A      3   —                         0  2  0  2   0  0   critical
 *   B      2   A                         3  4  6  7   3  3
 *   C      4   A, lag 1                  4  7  4  7   0  0   critical
 *   D      1   B, C                      8  8  8  8   0  0   critical
 *   E      ◆   D, G, I, K                9  9  9  9   0  0   critical (milestone)
 *   F      2   A                         3  4  6  7   3  0
 *   G      1   F                         5  5  8  8   3  3
 *   H      2   — (starts on day 2)       2  3  4  5   2  0
 *   I      3   H                         4  6  6  8   2  2
 *   K      1   A, scheduled by hand      6  6  8  8   2  2   (its own date, day 6, is later than A allows)
 *
 * The project finishes on day 9. Day numbers are working days, so the dates
 * depend on the weekday each copy starts on and the holidays it crosses.
 */
const MOTIF = [
  { key: 'A', duration: 3, es: 0, ef: 2, ls: 0, lf: 2, tf: 0, ff: 0 },
  { key: 'B', duration: 2, es: 3, ef: 4, ls: 6, lf: 7, tf: 3, ff: 3 },
  { key: 'C', duration: 4, es: 4, ef: 7, ls: 4, lf: 7, tf: 0, ff: 0 },
  { key: 'D', duration: 1, es: 8, ef: 8, ls: 8, lf: 8, tf: 0, ff: 0 },
  { key: 'E', duration: 1, es: 9, ef: 9, ls: 9, lf: 9, tf: 0, ff: 0, milestone: true },
  { key: 'F', duration: 2, es: 3, ef: 4, ls: 6, lf: 7, tf: 3, ff: 0 },
  { key: 'G', duration: 1, es: 5, ef: 5, ls: 8, lf: 8, tf: 3, ff: 3 },
  { key: 'H', duration: 2, es: 2, ef: 3, ls: 4, lf: 5, tf: 2, ff: 0, startsOn: 2 },
  { key: 'I', duration: 3, es: 4, ef: 6, ls: 6, lf: 8, tf: 2, ff: 2 },
  { key: 'K', duration: 1, es: 6, ef: 6, ls: 8, lf: 8, tf: 2, ff: 2, startsOn: 6, manual: true },
] as const;
const MOTIF_RELATIONS: [string, string, number][] = [
  ['B', 'A', 0],
  ['C', 'A', 1],
  ['D', 'B', 0],
  ['D', 'C', 0],
  ['E', 'D', 0],
  ['E', 'G', 0],
  ['E', 'I', 0],
  ['E', 'K', 0],
  ['F', 'A', 0],
  ['G', 'F', 0],
  ['I', 'H', 0],
  ['K', 'A', 0],
];

/** Twenty copies, one per project, each starting on the next calendar day from 1 October 2026. */
const reference = (() => {
  const items: NetworkItem[] = [];
  const relations: NetworkRelation[] = [];
  const expected = new Map<number, (typeof MOTIF)[number] & { day0: number }>();
  for (let copy = 0; copy < 20; copy += 1) {
    const projectId = 100 + copy;
    const day0 = working.onOrAfter(d('2026-10-01') + copy);
    const idOf = (key: string) => projectId * 100 + MOTIF.findIndex((entry) => entry.key === key);
    for (const entry of MOTIF) {
      // Each item's own dates: where the hand schedule puts it, or its own start where it has one.
      const start = working.add(day0, 'startsOn' in entry ? entry.startsOn : entry.es);
      const finish = working.add(start, entry.duration - 1);
      items.push(
        item(idOf(entry.key), projectId, isoOf(start), isoOf(finish), {
          duration: 'milestone' in entry ? null : entry.duration,
          isMilestone: 'milestone' in entry,
          scheduleManually: 'manual' in entry,
        }),
      );
      expected.set(idOf(entry.key), { ...entry, day0 });
    }
    for (const [successor, predecessor, lag] of MOTIF_RELATIONS) relations.push(follows(idOf(successor), idOf(predecessor), lag));
  }
  return { items, relations, expected };
})();

/**
 * The same network solved another way, sharing nothing with the engine but
 * the calendar: working days numbered from each copy's start, and the passes
 * repeated until nothing changes rather than taken in order.
 */
function independentSolve(items: NetworkItem[], relations: NetworkRelation[]) {
  const ordinalDates: number[] = [];
  for (let day = d('2026-09-01'); ordinalDates.length < 400; day += 1) if (working.isWorking(day)) ordinalDates.push(day);
  const ordinal = new Map(ordinalDates.map((day, index) => [day, index]));
  const dur = new Map(items.map((entry) => [entry.id, entry.isMilestone ? 1 : entry.duration!]));
  const own = new Map(items.map((entry) => [entry.id, ordinal.get(d(entry.startDate!))!]));
  const preds = new Map<number, NetworkRelation[]>();
  const succs = new Map<number, NetworkRelation[]>();
  for (const relation of relations) {
    preds.set(relation.successorId, [...(preds.get(relation.successorId) ?? []), relation]);
    succs.set(relation.predecessorId, [...(succs.get(relation.predecessorId) ?? []), relation]);
  }
  const es = new Map<number, number>();
  const ef = new Map<number, number>();
  for (const entry of items) {
    es.set(entry.id, own.get(entry.id)!);
    ef.set(entry.id, own.get(entry.id)! + dur.get(entry.id)! - 1);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of items) {
      const incoming = preds.get(entry.id) ?? [];
      const anchor = incoming.length === 0 || entry.scheduleManually ? own.get(entry.id)! : -Infinity;
      const value = Math.max(anchor, ...incoming.map((relation) => ef.get(relation.predecessorId)! + 1 + relation.lag));
      if (value !== es.get(entry.id)) {
        es.set(entry.id, value);
        ef.set(entry.id, value + dur.get(entry.id)! - 1);
        changed = true;
      }
    }
  }
  const end = new Map<number, number>();
  for (const entry of items) end.set(entry.projectId, Math.max(end.get(entry.projectId) ?? -Infinity, ef.get(entry.id)!));
  const lf = new Map(items.map((entry) => [entry.id, end.get(entry.projectId)!]));
  const ls = new Map(items.map((entry) => [entry.id, end.get(entry.projectId)! - dur.get(entry.id)! + 1]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of items) {
      const outgoing = succs.get(entry.id) ?? [];
      const value = outgoing.length === 0 ? end.get(entry.projectId)! : Math.min(...outgoing.map((relation) => ls.get(relation.successorId)! - 1 - relation.lag));
      if (value !== lf.get(entry.id)) {
        lf.set(entry.id, value);
        ls.set(entry.id, value - dur.get(entry.id)! + 1);
        changed = true;
      }
    }
  }
  return new Map(
    items.map((entry) => {
      const outgoing = succs.get(entry.id) ?? [];
      const bound = outgoing.length === 0 ? end.get(entry.projectId)! : Math.min(...outgoing.map((relation) => es.get(relation.successorId)! - 1 - relation.lag));
      return [
        entry.id,
        {
          earlyStart: isoOf(ordinalDates[es.get(entry.id)!]!),
          earlyFinish: isoOf(ordinalDates[ef.get(entry.id)!]!),
          lateStart: isoOf(ordinalDates[ls.get(entry.id)!]!),
          lateFinish: isoOf(ordinalDates[lf.get(entry.id)!]!),
          totalFloat: ls.get(entry.id)! - es.get(entry.id)!,
          freeFloat: bound - ef.get(entry.id)!,
        },
      ];
    }),
  );
}

const solved = computeCriticalPath(reference.items, reference.relations, calendar);

await check('the reference network has 200 work packages, every one scheduled', () => {
  assert.equal(reference.items.length, 200);
  assert.equal(solved.results.size, 200);
  assert.deepEqual(solved.cycles, []);
  assert.deepEqual(solved.unscheduled, []);
});

await check('every item’s total float matches the control set worked by hand', () => {
  for (const entry of reference.items) {
    assert.equal(solved.results.get(entry.id)!.totalFloat, reference.expected.get(entry.id)!.tf, `item ${entry.id}`);
  }
});

await check('so do free float and which items are critical', () => {
  for (const entry of reference.items) {
    const want = reference.expected.get(entry.id)!;
    assert.equal(solved.results.get(entry.id)!.freeFloat, want.ff, `item ${entry.id} free float`);
    assert.equal(solved.results.get(entry.id)!.critical, want.tf === 0, `item ${entry.id} critical`);
  }
});

await check('and the four dates, on the calendar each copy actually runs across', () => {
  for (const entry of reference.items) {
    const want = reference.expected.get(entry.id)!;
    const got = solved.results.get(entry.id)!;
    assert.equal(got.earlyStart, isoOf(working.add(want.day0, want.es)), `item ${entry.id} early start`);
    assert.equal(got.earlyFinish, isoOf(working.add(want.day0, want.ef)), `item ${entry.id} early finish`);
    assert.equal(got.lateStart, isoOf(working.add(want.day0, want.ls)), `item ${entry.id} late start`);
    assert.equal(got.lateFinish, isoOf(working.add(want.day0, want.lf)), `item ${entry.id} late finish`);
  }
});

await check('the relations that drive are the ones the hand schedule says, and the critical chain is A, C, D, E', () => {
  // Driving: the successor starts exactly when that predecessor lets it.
  // B–D, G–E, I–E and K–E leave slack; A–K does not hold K, which keeps its own later date.
  const want = new Set(['A>B', 'A>C', 'C>D', 'D>E', 'A>F', 'F>G', 'H>I']);
  const keyOf = (id: number) => MOTIF[id % 100]!.key;
  for (const [index, link] of solved.links.entries()) {
    const relation = reference.relations[index]!;
    assert.equal(link.predecessorId, relation.predecessorId);
    const name = `${keyOf(link.predecessorId)}>${keyOf(link.successorId)}`;
    assert.equal(link.driving, want.has(name), `${name} in project ${Math.floor(link.successorId / 100)}`);
  }
  const chain = solved.links
    .filter((link) => link.driving && solved.results.get(link.predecessorId)!.critical && solved.results.get(link.successorId)!.critical)
    .filter((link) => Math.floor(link.successorId / 100) === 100)
    .map((link) => `${keyOf(link.predecessorId)}>${keyOf(link.successorId)}`);
  assert.deepEqual(chain.sort(), ['A>C', 'C>D', 'D>E']);
});

await check('an independent solver agrees on every item, date for date', () => {
  const other = independentSolve(reference.items, reference.relations);
  for (const entry of reference.items) {
    const got = solved.results.get(entry.id)!;
    const want = other.get(entry.id)!;
    for (const field of ['earlyStart', 'earlyFinish', 'lateStart', 'lateFinish', 'totalFloat', 'freeFloat'] as const) {
      assert.equal(got[field], want[field], `item ${entry.id} ${field}`);
    }
  }
});

console.log('The rules');

await check('lag is counted in working days after the predecessor finishes', () => {
  // A finishes Tuesday 13 October; lag 1 skips Thursday 15 (Wednesday is a holiday): B starts Friday 16.
  const result = computeCriticalPath(
    [item(1, 1, '2026-10-12', '2026-10-13', { duration: 2 }), item(2, 1, '2026-10-20', '2026-10-20', { duration: 1 })],
    [follows(2, 1, 1)],
    calendar,
  );
  assert.equal(result.results.get(2)!.earlyStart, '2026-10-16');
});

await check('lag is counted in working days even for a successor that counts every day, as OpenProject counts it', () => {
  // A finishes Friday 16 October. Lag 1 is Monday 19, a working day, so B —
  // which ignores non-working days — starts Tuesday 20, not Sunday 18.
  const result = computeCriticalPath(
    [
      item(1, 1, '2026-10-15', '2026-10-16', { duration: 2 }),
      item(2, 1, '2026-10-25', '2026-10-25', { duration: 1, ignoreNonWorkingDays: true }),
      item(3, 1, '2026-10-25', '2026-10-25', { duration: 1, ignoreNonWorkingDays: true }),
    ],
    [follows(2, 1, 1), follows(3, 1)],
    calendar,
  );
  assert.equal(result.results.get(2)!.earlyStart, '2026-10-20');
  assert.equal(result.results.get(3)!.earlyStart, '2026-10-17', 'with no lag it may start on the Saturday');
  // Backwards the same way: A may finish no later than Friday 16 for B to start on Tuesday 20.
  assert.equal(result.results.get(2)!.critical, true);
  assert.equal(result.results.get(1)!.lateFinish, '2026-10-16');
});

await check('a milestone takes its one day, and its successor starts the next working day', () => {
  const result = computeCriticalPath(
    [item(1, 1, '2026-10-16', '2026-10-16', { isMilestone: true }), item(2, 1, '2026-10-30', '2026-10-30', { duration: 1 })],
    [follows(2, 1)],
    calendar,
  );
  assert.equal(result.results.get(1)!.earlyFinish, '2026-10-16');
  assert.equal(result.results.get(2)!.earlyStart, '2026-10-19', 'Friday’s milestone: Monday');
});

await check('a relation on a parent holds every child back; the parent is its children rolled up', () => {
  const result = computeCriticalPath(
    [
      item(1, 1, '2026-10-05', '2026-10-06', { duration: 2 }),
      item(2, 1, '2026-10-01', '2026-10-09', {}),
      item(3, 1, '2026-10-01', '2026-10-01', { parentId: 2, duration: 1 }),
      item(4, 1, '2026-10-01', '2026-10-02', { parentId: 2, duration: 2 }),
    ],
    [follows(2, 1)],
    calendar,
  );
  assert.equal(result.results.get(3)!.earlyStart, '2026-10-07', 'the first child waits for the predecessor');
  assert.equal(result.results.get(4)!.earlyStart, '2026-10-07', 'and so does the second');
  const parent = result.results.get(2)!;
  assert.equal(parent.summary, true);
  assert.equal(parent.earlyStart, '2026-10-07');
  assert.equal(parent.earlyFinish, '2026-10-08');
  assert.equal(parent.totalFloat, Math.min(result.results.get(3)!.totalFloat, result.results.get(4)!.totalFloat));
});

await check('an item that counts every day keeps its weekend', () => {
  const result = computeCriticalPath(
    [item(1, 1, '2026-10-16', '2026-10-18', { ignoreNonWorkingDays: true, duration: 3 })],
    [],
    calendar,
  );
  assert.equal(result.results.get(1)!.earlyFinish, '2026-10-18', 'Friday to Sunday, three days');
});

await check('a cycle is reported, and everything outside it is still scheduled', () => {
  const result = computeCriticalPath(
    [
      item(1, 1, '2026-10-05', '2026-10-05', { duration: 1 }),
      item(2, 1, '2026-10-06', '2026-10-06', { duration: 1 }),
      item(3, 1, '2026-10-07', '2026-10-07', { duration: 1 }),
      item(4, 1, '2026-10-08', '2026-10-08', { duration: 1 }),
    ],
    [follows(2, 1), follows(3, 2), follows(2, 3), follows(4, 1)],
    calendar,
  );
  assert.deepEqual(result.cycles, [[2, 3]]);
  assert.equal(result.results.get(2)!.inCycle, true);
  assert.equal(result.results.get(4)!.inCycle, false);
  assert.equal(result.results.get(4)!.earlyStart, '2026-10-06');
});

await check('an item without dates is left out and listed', () => {
  const result = computeCriticalPath(
    [item(1, 1, '2026-10-05', '2026-10-05', { duration: 1 }), item(2, 1, '', '', {}), { ...item(3, 1, '', ''), startDate: null, dueDate: null }],
    [follows(3, 1)],
    calendar,
  );
  assert.deepEqual(result.unscheduled.sort(), [2, 3]);
  assert.equal(result.results.has(3), false);
});

await check('a standalone item has the project’s slack, not none', () => {
  const result = computeCriticalPath(
    [item(1, 1, '2026-10-05', '2026-10-09', { duration: 5 }), item(2, 1, '2026-10-05', '2026-10-05', { duration: 1 })],
    [],
    calendar,
  );
  assert.equal(result.results.get(1)!.critical, true, 'the longest work sets the finish');
  assert.equal(result.results.get(2)!.totalFloat, 4, 'the one-day item can slip four days');
});

console.log('Recalculating within the performance budget (BR-104)');

await check('a 2,000-item network is solved well within five seconds', () => {
  const items: NetworkItem[] = [];
  const relations: NetworkRelation[] = [];
  for (let chain = 0; chain < 200; chain += 1) {
    for (let step = 0; step < 10; step += 1) {
      const id = chain * 10 + step + 1;
      const start = isoOf(working.add(working.onOrAfter(d('2026-10-01')), step * 3));
      items.push(item(id, 1 + (chain % 5), start, isoOf(working.add(dayOf(start), 2)), { duration: 1 + ((chain + step) % 4) }));
      if (step > 0) relations.push(follows(id, id - 1, step % 3));
      if (chain > 0 && step % 4 === 0) relations.push(follows(id, id - 10));
    }
  }
  const started = performance.now();
  const result = computeCriticalPath(items, relations, calendar);
  const took = performance.now() - started;
  assert.equal(result.results.size, 2000);
  assert.ok(took < 5000, `took ${Math.round(took)} ms`);
  console.log(`        (${items.length} items, ${relations.length} relations: ${Math.round(took)} ms)`);
});

console.log(`\n${passed} passed`);
