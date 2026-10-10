import assert from 'node:assert/strict';

import { dayOf, isoOf } from '../critical-path.js';
import { level, type LevelItem } from '../levelling.js';
import {
  AvailabilityModel,
  bandOf,
  DEFAULT_THRESHOLDS,
  overAllocated,
  placeholderKey,
  spread,
  weekOf,
  weeklyLoads,
  type CarrierInput,
  type DemandItem,
} from '../resource-model.js';

/**
 * Worked examples for resources and capacity (Module 6), every figure worked
 * out by hand beforehand: availability from a schedule, a fraction, a holiday
 * and time off (BR-312); demand spread over the days someone can work and the
 * weeks it overloads (BR-110, BR-313); heatmap bands (BR-314); and levelling a
 * knowingly over-allocated plan (BR-111).
 *
 *   npx tsx src/domain/__checks__/resources.check.ts
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

const d = dayOf;
const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} is not ${expected}`);

/** Monday to Friday, with Wednesday 14 October 2026 a public holiday. */
const calendar = { workingWeekdays: new Set([0, 1, 2, 3, 4]), holidays: new Set([d('2026-10-14')]) };

/*
 * Person 1: 40 hours a week until Sunday 18 October; from Monday 19 October a
 * schedule of 9, 9, 9, 9 and 4 hours at half time — 20 hours a week. Off all
 * of Thursday 15 October, and two hours on Monday 19 and Tuesday 20.
 * Placeholder ph1: 40 hours a week, no schedule.
 */
const carriers = new Map<string, CarrierInput>([
  [
    '1',
    {
      weeklyHours: 40,
      schedules: [{ effectiveFrom: d('2026-10-19'), hours: [9, 9, 9, 9, 4, 0, 0], fraction: 0.5 }],
      timeOff: [
        { from: d('2026-10-15'), to: d('2026-10-15'), hoursPerDay: null },
        { from: d('2026-10-19'), to: d('2026-10-20'), hoursPerDay: 2 },
      ],
    },
  ],
  [placeholderKey('ph1'), { weeklyHours: 40, schedules: [], timeOff: [] }],
]);
const availability = new AvailabilityModel(calendar, carriers);

console.log('Availability (BR-312)');

await check('the default spreads weekly hours over the working days; the holiday and the day off have none', () => {
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  assert.deepEqual(week.map((day) => availability.available('1', d(day))), [8, 8, 0, 0, 8, 0, 0]);
  close(availability.sum('1', d('2026-10-12'), d('2026-10-18')), 24, 'week of 12 October');
});

await check('from the schedule on: its hours times the fraction, less the hours off', () => {
  const week = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
  assert.deepEqual(week.map((day) => availability.available('1', d(day))), [2.5, 2.5, 4.5, 4.5, 2, 0, 0]);
  close(availability.sum('1', d('2026-10-19'), d('2026-10-25')), 16, 'week of 19 October');
  close(availability.sum('1', d('2026-10-26'), d('2026-11-01')), 20, 'week of 26 October');
});

console.log('\nDemand and over-allocation (BR-110, BR-313)');

const today = d('2026-10-12');
const w1: DemandItem = { id: 'wp:1', kind: 'work', carrier: '1', roleId: null, projectId: 7, hours: 18, start: d('2026-10-14'), due: d('2026-10-20') };
const w2: DemandItem = { id: 'wp:2', kind: 'work', carrier: '1', roleId: null, projectId: 7, hours: 16, start: d('2026-10-12'), due: d('2026-10-13') };
const a1: DemandItem = {
  id: 'allocation:a1',
  kind: 'allocation',
  carrier: placeholderKey('ph1'),
  roleId: 'r1',
  projectId: 8,
  hours: 10,
  start: d('2026-10-12'),
  due: d('2026-10-25'),
};

await check('work spreads over the days its assignee can work, in proportion to their hours', () => {
  const days = spread(w1, availability, today)!;
  // Available in its dates: Fri 16 → 8, Mon 19 → 2.5, Tue 20 → 2.5; 13 in all.
  close(days.get(d('2026-10-16'))!, (18 * 8) / 13, 'Friday');
  close(days.get(d('2026-10-19'))!, (18 * 2.5) / 13, 'Monday');
  close(days.get(d('2026-10-20'))!, (18 * 2.5) / 13, 'Tuesday');
  assert.equal(days.has(d('2026-10-14')), false, 'nothing on the holiday');
  assert.equal(days.has(d('2026-10-15')), false, 'nothing on the day off');
});

await check('overdue work falls on the next working day, not on a weekend', () => {
  // Due Wednesday 14; it is Saturday 17: all of it on Monday 19.
  const days = spread({ ...w1, hours: 6, start: d('2026-10-12'), due: d('2026-10-14') }, availability, d('2026-10-17'))!;
  assert.deepEqual([...days.entries()], [[d('2026-10-19'), 6]]);
});

await check('a booking spreads its weekly hours over the scheduled days of each week', () => {
  const days = spread(a1, availability, today)!;
  // Week of 12 October: Mon, Tue, Thu, Fri scheduled (8 each, the holiday not) → 2.5 a day.
  assert.deepEqual(
    ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map((day) => days.get(d(day)) ?? 0),
    [2.5, 2.5, 0, 2.5, 2.5],
  );
  close(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].reduce((sum, day) => sum + (days.get(d(day)) ?? 0), 0), 10, 'second week');
});

await check('a week asked for more than is available is over-allocated, with what makes it up', () => {
  const loads = weeklyLoads([w1, w2, a1], availability, ['1', placeholderKey('ph1')], weekOf(today), weekOf(d('2026-10-26')), today);
  const week = loads.get('1')!.get(d('2026-10-12'))!;
  close(week.available, 24, 'available');
  close(week.committed, 16 + (18 * 8) / 13, 'committed');
  const over = overAllocated(loads);
  assert.deepEqual(over.map((entry) => `${entry.carrier} ${isoOf(entry.week)}`), ['1 2026-10-12']);
  assert.deepEqual(over[0]!.contributions.map((part) => part.itemId), ['wp:2', 'wp:1']);
  close(loads.get('1')!.get(d('2026-10-19'))!.committed, (18 * 5) / 13, 'second week, within 16');
  close(loads.get(placeholderKey('ph1'))!.get(d('2026-10-12'))!.planned, 10, 'the placeholder’s booking');
});

console.log('\nHeatmap bands (BR-314)');

await check('the colour follows the thresholds', () => {
  const band = (ratio: number | null) => bandOf(ratio, DEFAULT_THRESHOLDS);
  assert.deepEqual([band(null), band(59.9), band(60), band(90), band(90.1), band(100), band(100.1)], [
    'none',
    'under',
    'healthy',
    'healthy',
    'full',
    'full',
    'over',
  ]);
});

console.log('\nLevelling (BR-111)');

/*
 * Two people, 40 hours a week, Monday to Friday, no holidays. Today Monday 12
 * October.
 *   A  P  40 h  12–16 Oct
 *   B  P  40 h  12–16 Oct            — with A, 80 hours in a 40-hour week
 *   C  P  16 h  19–20 Oct  follows B
 *   M  milestone, pinned, 30 Oct, follows C
 *   D  Q   8 h  12 Oct
 * By hand: A stays; B goes to the next week it fits, 19–23 Oct; C follows it
 * to 26–27 Oct, still before M; D and M stay. Nothing over-allocated after.
 */
const plain = { workingWeekdays: new Set([0, 1, 2, 3, 4]), holidays: new Set<number>() };
const people = new AvailabilityModel(
  plain,
  new Map<string, CarrierInput>([
    ['P', { weeklyHours: 40, schedules: [], timeOff: [] }],
    ['Q', { weeklyHours: 40, schedules: [], timeOff: [] }],
    ['P2', { weeklyHours: 40, schedules: [], timeOff: [] }],
    ['P3', { weeklyHours: 40, schedules: [], timeOff: [] }],
  ]),
);
const scheduleCalendar = { weekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() };
const item = (id: number, carrier: string | null, hours: number, start: string, due: string, extra: Partial<LevelItem> = {}): LevelItem => ({
  id,
  projectId: 1,
  subject: `#${id}`,
  carrier,
  hours,
  start: d(start),
  due: d(due),
  scheduleManually: true,
  ignoreNonWorkingDays: false,
  fixed: null,
  ...extra,
});

await check('a knowingly over-allocated plan levels to no over-allocation, the pinned milestone unmoved', () => {
  const outcome = level({
    items: [
      item(1, 'P', 40, '2026-10-12', '2026-10-16'),
      item(2, 'P', 40, '2026-10-12', '2026-10-16'),
      item(3, 'P', 16, '2026-10-19', '2026-10-20', { scheduleManually: false }),
      item(4, null, 0, '2026-10-30', '2026-10-30', { fixed: 'pinned' }),
      item(5, 'Q', 8, '2026-10-12', '2026-10-12'),
    ],
    relations: [
      { predecessorId: 2, successorId: 3, lag: 0 },
      { predecessorId: 3, successorId: 4, lag: 0 },
    ],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P', 'Q']),
    today: d('2026-10-12'),
    horizonDays: 365,
  });
  assert.deepEqual(outcome.before.map((week) => `${week.carrier} ${isoOf(week.week)}`), ['P 2026-10-12']);
  assert.deepEqual(
    outcome.moves.map((move) => `#${move.id} ${isoOf(move.newStart)}..${isoOf(move.newDue)} ${move.reason}`),
    ['#2 2026-10-19..2026-10-23 capacity', '#3 2026-10-26..2026-10-27 dependency'],
  );
  assert.equal(outcome.after.length, 0, 'no over-allocation remains');
  assert.equal(outcome.moves.some((move) => move.id === 4), false, 'the milestone does not move');
  assert.equal(outcome.conflicts.length, 0);
});

await check('an independent sum of the levelled plan finds no week over 40 hours', () => {
  // Spread each item evenly over its working days — no holidays, no time off,
  // so the same as the model — and add the weeks up, from the dates alone.
  const plan = [
    { carrier: 'P', hours: 40, start: '2026-10-12', due: '2026-10-16' },
    { carrier: 'P', hours: 40, start: '2026-10-19', due: '2026-10-23' },
    { carrier: 'P', hours: 16, start: '2026-10-26', due: '2026-10-27' },
    { carrier: 'Q', hours: 8, start: '2026-10-12', due: '2026-10-12' },
  ];
  const weeks = new Map<string, number>();
  for (const entry of plan) {
    const days: number[] = [];
    for (let at = d(entry.start); at <= d(entry.due); at += 1) if ((((at + 3) % 7) + 7) % 7 < 5) days.push(at);
    for (const at of days) {
      const key = `${entry.carrier} ${isoOf(at - ((((at + 3) % 7) + 7) % 7))}`;
      weeks.set(key, (weeks.get(key) ?? 0) + entry.hours / days.length);
    }
  }
  assert.ok([...weeks.values()].every((hours) => hours <= 40 + 1e-9), JSON.stringify([...weeks]));
});

await check('work that cannot fit before a pinned milestone stays, and the clash is reported', () => {
  const outcome = level({
    items: [
      item(11, 'P2', 40, '2026-10-12', '2026-10-16'),
      item(12, 'P2', 40, '2026-10-12', '2026-10-16'),
      item(13, null, 0, '2026-10-19', '2026-10-19', { fixed: 'pinned' }),
    ],
    relations: [{ predecessorId: 12, successorId: 13, lag: 0 }],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P2']),
    today: d('2026-10-12'),
    horizonDays: 365,
  });
  assert.deepEqual(outcome.moves, [], 'nothing moves');
  assert.deepEqual(outcome.conflicts, [{ id: 12, reason: 'pinned' }]);
  assert.equal(outcome.after.length, 1, 'the over-allocation it could not resolve is still reported');
});

await check('over-allocation is weekly: dense work fits where it straddles two weeks', () => {
  // 60 hours in five working days is 12 a day. From Wednesday 14 that is 36 in
  // one week and 24 in the next: no week over its 40, at its own length.
  const outcome = level({
    items: [item(21, 'P3', 60, '2026-10-12', '2026-10-16')],
    relations: [],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P3']),
    today: d('2026-10-12'),
    horizonDays: 365,
  });
  assert.deepEqual(
    outcome.moves.map((move) => `#${move.id} ${isoOf(move.newStart)}..${isoOf(move.newDue)} ${move.reason}`),
    ['#21 2026-10-14..2026-10-20 capacity'],
  );
  assert.equal(outcome.after.length, 0);
});

await check('work that fits no start at its length is stretched, as little as fits', () => {
  // 100 hours over five days fits no two weeks; any span with a whole week in
  // it puts five days there, so it needs at most 8 a day: thirteen working
  // days, from Monday 12 to Wednesday 28 — 38.46, 38.46 and 23.08.
  const outcome = level({
    items: [item(22, 'P3', 100, '2026-10-12', '2026-10-16')],
    relations: [],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P3']),
    today: d('2026-10-12'),
    horizonDays: 365,
  });
  assert.deepEqual(
    outcome.moves.map((move) => `#${move.id} ${isoOf(move.newStart)}..${isoOf(move.newDue)} ${move.reason}`),
    ['#22 2026-10-12..2026-10-28 stretched'],
  );
  assert.equal(outcome.after.length, 0);
});

await check('work late to start keeps its dates when they still fit, and moves only to fit', () => {
  // Wednesday 14 October. L1: 8 hours, Monday 12 to Friday 16, not started —
  // from today 8 hours in the 24 left this week: it fits, so it stays. L2: 40
  // hours in the same dates cannot fit the 24; it starts today instead, five
  // working days to Tuesday 20: 24 this week, 16 the next.
  const outcome = level({
    items: [item(41, 'P', 8, '2026-10-12', '2026-10-16'), item(42, 'Q', 40, '2026-10-12', '2026-10-16')],
    relations: [],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P', 'Q']),
    today: d('2026-10-14'),
    horizonDays: 365,
  });
  assert.deepEqual(
    outcome.moves.map((move) => `#${move.id} ${isoOf(move.newStart)}..${isoOf(move.newDue)} ${move.reason}`),
    ['#42 2026-10-14..2026-10-20 capacity'],
  );
  assert.equal(outcome.after.length, 0);
});

await check('a milestone its predecessor pushes stays one day: its start is its finish', () => {
  const outcome = level({
    items: [
      item(51, 'P', 40, '2026-10-12', '2026-10-16'),
      item(52, 'P', 40, '2026-10-12', '2026-10-16'),
      item(53, null, 0, '2026-10-19', '2026-10-19', { scheduleManually: false }),
    ],
    relations: [{ predecessorId: 52, successorId: 53, lag: 0 }],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P']),
    today: d('2026-10-12'),
    horizonDays: 365,
  });
  assert.deepEqual(
    outcome.moves.map((move) => `#${move.id} ${isoOf(move.newStart)}..${isoOf(move.newDue)} ${move.reason}`),
    ['#52 2026-10-19..2026-10-23 capacity', '#53 2026-10-26..2026-10-26 dependency'],
  );
  assert.equal(outcome.after.length, 0);
});

await check('work that has started, or may not be edited, is not moved', () => {
  const outcome = level({
    items: [
      item(31, 'P', 40, '2026-10-12', '2026-10-16', { fixed: 'started' }),
      item(32, 'P', 40, '2026-10-12', '2026-10-16', { fixed: 'not-editable' }),
    ],
    relations: [],
    calendar: scheduleCalendar,
    availability: people,
    otherDemand: [],
    carriers: new Set(['P']),
    today: d('2026-10-12'),
    horizonDays: 365,
  });
  assert.deepEqual(outcome.moves, []);
  assert.equal(outcome.after.length, 1, 'still over: nothing that may move');
});

console.log(`\n${passed} passed`);
