import assert from 'node:assert/strict';

import { dayOf } from '../critical-path.js';
import {
  combineTotals,
  earnedShare,
  evaluateEarnedValue,
  plannedShare,
  WorkingDayCounter,
  type EarningMethod,
  type LabourEntry,
  type PlannedItem,
  type ProgressState,
} from '../earned-value.js';

/**
 * A worked control example for earned value (BR-301, BR-302): two projects and
 * their portfolio, every figure worked out beforehand — by hand and again by
 * a separate script — and checked item by item, then the same plan solved by
 * an independent calculation that shares nothing with the engine but the
 * inputs.
 *
 *   npx tsx src/domain/__checks__/evm.check.ts
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

/** Monday to Friday, with Wednesday 14 October 2026 a holiday. */
const holiday = dayOf('2026-10-14');
const isWorking = (day: number) => {
  const weekday = ((((day + 3) % 7) + 7) % 7) + 1;
  return weekday <= 5 && day !== holiday;
};
const days = new WorkingDayCounter({ isWorking });

console.log('Working days and the planned spread');

await check('a fortnight with a holiday has nine working days', () => {
  assert.equal(days.between(dayOf('2026-10-12'), dayOf('2026-10-23')), 9);
  assert.equal(days.between(dayOf('2026-10-05'), dayOf('2026-10-30')), 19);
  assert.equal(days.between(dayOf('2026-10-17'), dayOf('2026-10-18')), 0, 'a weekend');
});

await check('a budget is spread over the working days of its planned span', () => {
  assert.equal(plannedShare('2026-10-12', '2026-10-23', '2026-10-16', days), 4 / 9, 'Mon, Tue, Thu, Fri of nine');
  assert.equal(plannedShare('2026-10-12', '2026-10-23', '2026-10-11', days), 0, 'before it starts');
  assert.equal(plannedShare('2026-10-12', '2026-10-23', '2026-10-23', days), 1, 'on its finish');
  assert.equal(plannedShare('2026-10-23', '2026-10-23', '2026-10-22', days), 0, 'a milestone the day before');
  assert.equal(plannedShare('2026-10-23', '2026-10-23', '2026-10-23', days), 1, 'and on the day');
  assert.equal(plannedShare(null, '2026-10-23', '2026-10-23', days), null, 'no planned start: nothing planned');
});

const state = (workPackageId: number, extra: Partial<ProgressState> = {}): ProgressState => ({
  workPackageId,
  parentId: null,
  isMilestone: false,
  doneRatio: 0,
  delivered: false,
  started: false,
  estimatedHours: null,
  ...extra,
});

await check('each earning rule earns what it says', () => {
  const half = state(1, { doneRatio: 50, started: true });
  assert.equal(earnedShare('percent_complete', half, [], 0.2), 0.5);
  assert.equal(earnedShare('zero_hundred', half, [], 0.2), 0);
  assert.equal(earnedShare('fifty_fifty', half, [], 0.2), 0.5);
  assert.equal(earnedShare('fifty_fifty', state(1), [], 0.2), 0, 'not started');
  assert.equal(earnedShare('level_of_effort', half, [], 0.2), 0.2, 'as planned, whatever its progress');
  const milestones = [
    state(11, { isMilestone: true, delivered: true }),
    state(12, { isMilestone: true }),
    state(13, { isMilestone: true, estimatedHours: 2 }),
  ];
  assert.equal(earnedShare('milestone_weighted', half, milestones, 0.2), 0.25, 'one of weights 1 + 1 + 2');
  assert.equal(earnedShare('milestone_weighted', half, [], 0.2), 0, 'no milestones: all when delivered');
  for (const method of ['percent_complete', 'zero_hundred', 'fifty_fifty', 'milestone_weighted', 'level_of_effort'] as const) {
    assert.equal(earnedShare(method, state(1, { delivered: true }), [], 0), 1, `${method}: delivered work has earned it all`);
  }
  assert.equal(earnedShare('percent_complete', undefined, [], 1), 0, 'work that did not exist yet');
});

/*
 * The control example, as at Friday 16 October 2026. Budgets are estimated
 * hours at an hourly rate; planned spans in working days.
 *
 *   item  type       rule        hours×rate   BAC     planned           share   PV        progress           EV       AC
 *   W1    Task       % complete  40×100       4000    5–9 Oct           1       4000.00   delivered          4000.00  4500
 *   W2    Task       % complete  80×100       8000    12–23 Oct         4/9     3555.56   50%                4000.00  3000
 *   W3    Feature    0/100       24×150       3600    12–15 Oct         1       3600.00   80%, open          0        3000
 *   W4    Bug        50/50       16×100       1600    15–20 Oct         1/2     800.00    started            800.00   600
 *   W5    Epic       milestones  40×100       4000    5–30 Oct          9/19    1894.74   M1 of M1,M2,M3(2h) 1000.00  1000
 *   M1–3  Milestone  % complete  —, —, 2×100  0,0,200 9, 16, 23 Oct     —       0         M1 delivered       0        —
 *   W6    Support    level of effort 50×80    4000    5–30 Oct          9/19    1894.74   (as planned)       1894.74  1440
 *   W7    Task       % complete  10×none      —       12–16 Oct         —       —         unpriced           —        4 h uncosted
 *   W8    Task       % complete  12×100       1200    no dates          —       0         25%                300.00   0
 *   (no work package)                                                                                                 500
 *
 * Project 1: BAC 26600, PV 15745.04, EV 11994.74, AC 14040 → SV −3750.30,
 * CV −2045.26, SPI 0.762, CPI 0.854, EAC 31135.65, ETC 17095.65,
 * VAC −4535.65, TCPI 1.163. A further 3 hours logged on 20 October are after
 * the reporting date and in no figure.
 *
 * Project 2, one task W9: BAC 2000, 12–16 Oct, 100% but not closed, 18 h at
 * 100 → PV 2000, EV 2000, AC 1800, CPI 1.111, EAC 1800, VAC 200, TCPI 0.
 */
const TYPE = { task: 1, milestone: 2, feature: 4, epic: 5, bug: 7, support: 99 };
const METHOD_OF: Record<number, EarningMethod> = {
  [TYPE.task]: 'percent_complete',
  [TYPE.milestone]: 'percent_complete',
  [TYPE.feature]: 'zero_hundred',
  [TYPE.epic]: 'milestone_weighted',
  [TYPE.bug]: 'fifty_fifty',
  [TYPE.support]: 'level_of_effort',
};

const plan = (
  workPackageId: number,
  projectId: number,
  typeId: number,
  hours: number | null,
  rate: number | null,
  start: string | null,
  finish: string | null,
  extra: Partial<PlannedItem> = {},
): PlannedItem => ({
  workPackageId,
  projectId,
  parentId: null,
  typeId,
  isMilestone: typeId === TYPE.milestone,
  estimatedHours: hours,
  rate,
  bac: hours === null ? 0 : rate === null ? null : hours * rate,
  plannedStart: start,
  plannedFinish: finish,
  ...extra,
});

const ID = { W1: 1, W2: 2, W3: 3, W4: 4, W5: 5, M1: 51, M2: 52, M3: 53, W6: 6, W7: 7, W8: 8, W9: 9 };
const items1: PlannedItem[] = [
  plan(ID.W1, 1, TYPE.task, 40, 100, '2026-10-05', '2026-10-09'),
  plan(ID.W2, 1, TYPE.task, 80, 100, '2026-10-12', '2026-10-23'),
  plan(ID.W3, 1, TYPE.feature, 24, 150, '2026-10-12', '2026-10-15'),
  plan(ID.W4, 1, TYPE.bug, 16, 100, '2026-10-15', '2026-10-20'),
  plan(ID.W5, 1, TYPE.epic, 40, 100, '2026-10-05', '2026-10-30'),
  plan(ID.M1, 1, TYPE.milestone, null, 100, '2026-10-09', '2026-10-09', { parentId: ID.W5 }),
  plan(ID.M2, 1, TYPE.milestone, null, 100, '2026-10-16', '2026-10-16', { parentId: ID.W5 }),
  plan(ID.M3, 1, TYPE.milestone, 2, 100, '2026-10-23', '2026-10-23', { parentId: ID.W5 }),
  plan(ID.W6, 1, TYPE.support, 50, 80, '2026-10-05', '2026-10-30'),
  plan(ID.W7, 1, TYPE.task, 10, null, '2026-10-12', '2026-10-16'),
  plan(ID.W8, 1, TYPE.task, 12, 100, null, null),
];
const items2: PlannedItem[] = [plan(ID.W9, 2, TYPE.task, 20, 100, '2026-10-12', '2026-10-16')];

const progress = new Map<number, ProgressState>(
  [
    state(ID.W1, { doneRatio: 100, delivered: true, started: true }),
    state(ID.W2, { doneRatio: 50, started: true }),
    state(ID.W3, { doneRatio: 80, started: true }),
    state(ID.W4, { doneRatio: 10, started: true }),
    state(ID.W5, { doneRatio: 30, started: true }),
    state(ID.M1, { parentId: ID.W5, isMilestone: true, doneRatio: 100, delivered: true, started: true }),
    state(ID.M2, { parentId: ID.W5, isMilestone: true }),
    state(ID.M3, { parentId: ID.W5, isMilestone: true, estimatedHours: 2 }),
    state(ID.W6),
    state(ID.W7),
    state(ID.W8, { doneRatio: 25, started: true }),
    state(ID.W9, { doneRatio: 100, started: true }),
  ].map((entry) => [entry.workPackageId, entry]),
);

const entry = (projectId: number, workPackageId: number | null, spentOn: string, hours: number, rate: number | null): LabourEntry => ({
  projectId,
  workPackageId,
  spentOn,
  hours,
  cost: rate === null ? null : hours * rate,
});
const labour1: LabourEntry[] = [
  entry(1, ID.W1, '2026-10-07', 45, 100),
  entry(1, ID.W2, '2026-10-13', 30, 100),
  entry(1, ID.W3, '2026-10-13', 20, 150),
  entry(1, ID.W4, '2026-10-15', 6, 100),
  entry(1, ID.W5, '2026-10-08', 10, 100),
  entry(1, ID.W6, '2026-10-16', 18, 80),
  entry(1, ID.W7, '2026-10-12', 4, null),
  entry(1, null, '2026-10-12', 5, 100),
  entry(1, ID.W2, '2026-10-20', 3, 100),
];
const labour2: LabourEntry[] = [entry(2, ID.W9, '2026-10-14', 18, 100)];

const AT = '2026-10-16';
const methodOf = (typeId: number) => METHOD_OF[typeId] ?? 'percent_complete';
const project1 = evaluateEarnedValue({ at: AT, items: items1, progress, methodOf, days, labour: labour1 });
const project2 = evaluateEarnedValue({ at: AT, items: items2, progress, methodOf, days, labour: labour2 });

console.log('The control example (BR-301): work packages');

const HAND: Record<keyof typeof ID, { bac: number | null; pv: number | null; ev: number | null; ac: number }> = {
  W1: { bac: 4000, pv: 4000, ev: 4000, ac: 4500 },
  W2: { bac: 8000, pv: 3555.56, ev: 4000, ac: 3000 },
  W3: { bac: 3600, pv: 3600, ev: 0, ac: 3000 },
  W4: { bac: 1600, pv: 800, ev: 800, ac: 600 },
  W5: { bac: 4000, pv: 1894.74, ev: 1000, ac: 1000 },
  M1: { bac: 0, pv: 0, ev: 0, ac: 0 },
  M2: { bac: 0, pv: 0, ev: 0, ac: 0 },
  M3: { bac: 200, pv: 0, ev: 0, ac: 0 },
  W6: { bac: 4000, pv: 1894.74, ev: 1894.74, ac: 1440 },
  W7: { bac: null, pv: null, ev: null, ac: 0 },
  W8: { bac: 1200, pv: 0, ev: 300, ac: 0 },
  W9: { bac: 2000, pv: 2000, ev: 2000, ac: 1800 },
};

await check('every work package’s budget, planned value, earned value and actual cost match the hand table', () => {
  const figures = new Map([...project1.items, ...project2.items].map((item) => [item.workPackageId, item]));
  for (const [key, want] of Object.entries(HAND) as [keyof typeof ID, (typeof HAND)[keyof typeof ID]][]) {
    const got = figures.get(ID[key])!;
    assert.deepEqual({ bac: got.bac, pv: got.pv, ev: got.ev, ac: got.ac }, want, key);
  }
});

await check('and their indices: W2 is ahead of schedule and under cost, W3 has spent without earning', () => {
  const w2 = project1.items.find((item) => item.workPackageId === ID.W2)!;
  assert.deepEqual({ sv: w2.sv, cv: w2.cv, spi: w2.spi, cpi: w2.cpi }, { sv: 444.44, cv: 1000, spi: 1.125, cpi: 1.333 });
  const w3 = project1.items.find((item) => item.workPackageId === ID.W3)!;
  assert.deepEqual({ sv: w3.sv, cv: w3.cv, spi: w3.spi, cpi: w3.cpi }, { sv: -3600, cv: -3000, spi: 0, cpi: 0 });
});

console.log('The control example: projects and the portfolio');

await check('project 1’s figures match the control set', () => {
  const t = project1.totals;
  assert.deepEqual(
    { bac: t.bac, pv: t.pv, ev: t.ev, ac: t.ac, sv: t.sv, cv: t.cv, spi: t.spi, cpi: t.cpi },
    { bac: 26600, pv: 15745.04, ev: 11994.74, ac: 14040, sv: -3750.3, cv: -2045.26, spi: 0.762, cpi: 0.854 },
  );
  assert.deepEqual({ eac: t.eac, etc: t.etc, vac: t.vac, tcpi: t.tcpi }, { eac: 31135.65, etc: 17095.65, vac: -4535.65, tcpi: 1.163 });
});

await check('with what it leaves out said: an unpriced item, an undated one, time off the plan and uncosted hours', () => {
  const t = project1.totals;
  assert.deepEqual(t.counts, { planned: 11, unpriced: 1, undated: 1 });
  assert.equal(t.acOutsidePlan, 500);
  assert.equal(t.uncostedHours, 4);
});

await check('project 2’s figures match the control set', () => {
  const t = project2.totals;
  assert.deepEqual(
    { bac: t.bac, pv: t.pv, ev: t.ev, ac: t.ac, sv: t.sv, cv: t.cv, spi: t.spi, cpi: t.cpi, eac: t.eac, vac: t.vac, tcpi: t.tcpi },
    { bac: 2000, pv: 2000, ev: 2000, ac: 1800, sv: 0, cv: 200, spi: 1, cpi: 1.111, eac: 1800, vac: 200, tcpi: 0 },
  );
});

await check('the portfolio adds the projects up and takes its indices from the sums, never their average', () => {
  const t = combineTotals([project1.totals, project2.totals]);
  assert.deepEqual(
    { bac: t.bac, pv: t.pv, ev: t.ev, ac: t.ac, sv: t.sv, cv: t.cv, spi: t.spi, cpi: t.cpi },
    { bac: 28600, pv: 17745.04, ev: 13994.74, ac: 15840, sv: -3750.3, cv: -1845.26, spi: 0.789, cpi: 0.884 },
  );
  assert.deepEqual({ eac: t.eac, etc: t.etc, vac: t.vac, tcpi: t.tcpi }, { eac: 32371.02, etc: 16531.02, vac: -3771.02, tcpi: 1.145 });
  assert.notEqual(t.cpi, Math.round(((project1.totals.cpi! + project2.totals.cpi!) / 2) * 1000) / 1000, 'not the average of the CPIs');
});

/**
 * The same plan solved another way: calendar days walked one at a time, each
 * rule written out afresh, totals added from unrounded figures and rounded
 * once. Shares nothing with the engine but the inputs.
 */
function independent(items: PlannedItem[], labour: LabourEntry[], at: string) {
  const walk = (from: string, to: string) => {
    let count = 0;
    for (let day = dayOf(from); day <= dayOf(to); day += 1) if (isWorking(day)) count += 1;
    return count;
  };
  const out = new Map<number, { pv: number; ev: number }>();
  let bac = 0;
  let pv = 0;
  let ev = 0;
  for (const item of items) {
    if (item.bac === null) continue;
    let share = 0;
    if (item.plannedStart && item.plannedFinish) {
      if (at >= item.plannedFinish) share = 1;
      else if (at >= item.plannedStart) share = walk(item.plannedStart, at) / walk(item.plannedStart, item.plannedFinish);
    }
    const now = progress.get(item.workPackageId)!;
    let earned: number;
    const method = methodOf(item.typeId);
    if (now.delivered) earned = 1;
    else if (method === 'percent_complete') earned = (now.doneRatio ?? 0) / 100;
    else if (method === 'zero_hundred') earned = 0;
    else if (method === 'fifty_fifty') earned = now.started ? 0.5 : 0;
    else if (method === 'level_of_effort') earned = share;
    else {
      const under = [...progress.values()].filter((other) => other.parentId === item.workPackageId && other.isMilestone);
      const weight = (other: ProgressState) => other.estimatedHours || 1;
      const total = under.reduce((sum, other) => sum + weight(other), 0);
      earned = total === 0 ? 0 : under.filter((other) => other.delivered).reduce((sum, other) => sum + weight(other), 0) / total;
    }
    out.set(item.workPackageId, { pv: Math.round(item.bac * share * 100) / 100, ev: Math.round(item.bac * earned * 100) / 100 });
    bac += item.bac;
    pv += out.get(item.workPackageId)!.pv;
    ev += out.get(item.workPackageId)!.ev;
  }
  const ac = labour.filter((entryNow) => entryNow.spentOn <= at && entryNow.cost !== null).reduce((sum, entryNow) => sum + entryNow.cost!, 0);
  const r = (value: number) => Math.round(value * 100) / 100;
  const cpi = ev / ac;
  return {
    items: out,
    totals: {
      bac: r(bac),
      pv: r(pv),
      ev: r(ev),
      ac: r(ac),
      spi: Math.round((ev / pv) * 1000) / 1000,
      cpi: Math.round(cpi * 1000) / 1000,
      eac: r(bac / cpi),
      tcpi: Math.round(((bac - ev) / (bac - ac)) * 1000) / 1000,
    },
  };
}

await check('an independent calculation agrees on every item and every total', () => {
  for (const [items, labour, result] of [
    [items1, labour1, project1],
    [items2, labour2, project2],
  ] as const) {
    const other = independent(items, labour, AT);
    for (const item of result.items) {
      if (item.bac === null) continue;
      assert.deepEqual({ pv: item.pv, ev: item.ev }, other.items.get(item.workPackageId), `item ${item.workPackageId}`);
    }
    const t = result.totals;
    assert.deepEqual({ bac: t.bac, pv: t.pv, ev: t.ev, ac: t.ac, spi: t.spi, cpi: t.cpi, eac: t.eac, tcpi: t.tcpi }, other.totals);
  }
});

console.log('Earning rules per type (BR-302)');

await check('changing one type’s rule changes the earned value of that type’s work and nobody else’s', () => {
  const changed = evaluateEarnedValue({
    at: AT,
    items: items1,
    progress,
    methodOf: (typeId) => (typeId === TYPE.feature ? 'percent_complete' : methodOf(typeId)),
    days,
    labour: labour1,
  });
  const before = new Map(project1.items.map((item) => [item.workPackageId, item.ev]));
  for (const item of changed.items) {
    if (item.workPackageId === ID.W3) assert.equal(item.ev, 2880, 'W3, a Feature, now earns its 80%');
    else assert.equal(item.ev, before.get(item.workPackageId), `item ${item.workPackageId} unchanged`);
  }
  assert.equal(changed.totals.ev, 14874.74);
});

console.log('Another reporting date');

await check('a week earlier, less is planned and only what was logged by then is cost', () => {
  const earlier = evaluateEarnedValue({ at: '2026-10-09', items: items1, progress, methodOf, days, labour: labour1 });
  // W1 all; W5 and W6 five of nineteen days; M1 on its day; nothing else had started.
  assert.equal(earlier.totals.pv, 4000 + 1052.63 + 1052.63);
  assert.equal(earlier.totals.ac, 4500 + 1000, 'W1 and W5’s hours; the rest came later');
});

console.log(`\n${passed} passed`);
