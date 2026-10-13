import assert from 'node:assert/strict';

import {
  apportion,
  cashFlow,
  combineCashFlows,
  combineMargins,
  derivePhasing,
  estimatedRevenue,
  actualRevenue,
  forecastProject,
  margin,
  phasingDifference,
  reconcileBatch,
  reconcileBilling,
  rescalePhasing,
} from '../finance.js';

/**
 * Worked control examples for the finance engine (Module 11, part 2): every
 * figure below was worked out by hand before the engine was run.
 *
 *   npx tsx src/domain/__checks__/finance.check.ts
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

/* BR-310 ------------------------------------------------------------------ */

const linear = (start: string, finish: string, at: string) => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  if (day(at) < day(start)) return 0;
  if (day(at) >= day(finish)) return 1;
  return (day(at) - day(start) + 1) / (day(finish) - day(start) + 1);
};
const weekdays = (first: string, last: string) => {
  let count = 0;
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += 86_400_000) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
};

await check('BR-310: the budget follows priced work month by month, summing to the total', () => {
  const phased = derivePhasing({
    budget: 1000,
    items: [
      { bac: 600, start: '2026-10-01', finish: '2026-10-31' },
      { bac: 400, start: '2026-11-01', finish: '2026-11-30' },
    ],
    plannedStart: null,
    plannedFinish: null,
    today: '2026-10-13',
    share: linear,
    workingDays: weekdays,
  });
  assert.equal(phased.basis, 'schedule');
  assert.deepEqual(phased.phases, [
    { month: '2026-10-01', amount: 600 },
    { month: '2026-11-01', amount: 400 },
  ]);
});

await check('BR-310: work across a month end splits by its days; the parts still sum exactly', () => {
  // 31 days, 21 in October and 10 in November: 999.99 × 21/31 = 677.41 and × 10/31 = 322.58 (cents to the larger remainder).
  const phased = derivePhasing({
    budget: 999.99,
    items: [{ bac: 3100, start: '2026-10-11', finish: '2026-11-10' }],
    plannedStart: null,
    plannedFinish: null,
    today: '2026-10-13',
    share: linear,
    workingDays: weekdays,
  });
  assert.deepEqual(
    phased.phases.map((phase) => phase.amount),
    [677.41, 322.58],
  );
  assert.equal(phasingDifference(phased.phases, 999.99), 0);
});

await check('BR-310: without priced work, over the working days of the planned dates', () => {
  // October 2026 has 22 weekdays, November 1–13 has 10: 1000 × 22/32 and × 10/32.
  const phased = derivePhasing({ budget: 1000, items: [], plannedStart: '2026-10-01', plannedFinish: '2026-11-13', today: '2026-10-13', share: linear, workingDays: weekdays });
  assert.equal(phased.basis, 'dates');
  assert.deepEqual(
    phased.phases.map((phase) => phase.amount),
    [687.5, 312.5],
  );
});

await check('BR-310: cents left over go to the largest remainders; a changed budget rescales to the cent', () => {
  assert.deepEqual(apportion(1000, [1, 1, 1]), [333.34, 333.33, 333.33]);
  const rescaled = rescalePhasing(
    [
      { month: '2026-10-01', amount: 100 },
      { month: '2026-11-01', amount: 200 },
      { month: '2026-12-01', amount: 700 },
    ],
    1500,
  );
  assert.deepEqual(
    rescaled.map((phase) => phase.amount),
    [150, 300, 1050],
  );
  assert.equal(phasingDifference(rescaled, 1500), 0);
  assert.equal(phasingDifference(rescaled, 1500.01), 0.01);
});

/* BR-311 ------------------------------------------------------------------ */

await check('BR-311: planned against actual by month, cumulative actual equal to total actual cost', () => {
  const flow = cashFlow({
    planned: [
      { month: '2026-10-01', amount: 500 },
      { month: '2026-11-01', amount: 500 },
    ],
    labour: [
      { day: '2026-10-05', cost: 100, hours: 2 },
      { day: '2026-10-20', cost: 100, hours: 2 },
      { day: '2026-11-02', cost: 150, hours: 3 },
      { day: '2026-11-03', cost: null, hours: 3 },
    ],
    other: [{ day: '2026-10-09', amount: 50.25 }],
  });
  assert.deepEqual(
    flow.points.map((point) => [point.month, point.planned, point.actual, point.cumulativePlanned, point.cumulativeActual]),
    [
      ['2026-10-01', 500, 250.25, 500, 250.25],
      ['2026-11-01', 500, 150, 1000, 400.25],
    ],
  );
  assert.equal(flow.totals.actual, 400.25);
  assert.equal(flow.totals.uncostedHours, 3, 'unpriced hours are counted apart, in no figure');
  const portfolio = combineCashFlows([flow, cashFlow({ planned: null, labour: [{ day: '2026-12-01', cost: 99.75, hours: 1 }], other: [] })]);
  assert.equal(portfolio.points.at(-1)!.cumulativeActual, 500, 'a portfolio cumulates its projects');
  assert.equal(portfolio.totals.planned, 1000);
});

/* BR-318 ------------------------------------------------------------------ */

await check('BR-318: margin for control projects matches the hand calculation', () => {
  // Time and materials: estimates at bill rates 10,000 against a budget of 7,000; 2,500 billed, 1,800 spent.
  const tm = margin({
    estimatedRevenue: estimatedRevenue('time_and_materials', null, 10_000),
    estimatedCost: 7000,
    actualRevenue: actualRevenue('time_and_materials', null, 2500, null),
    actualCost: 1800,
  });
  assert.deepEqual(tm.estimated, { revenue: 10_000, cost: 7000, margin: 3000, percent: 30 });
  assert.deepEqual(tm.actual, { revenue: 2500, cost: 1800, margin: 700, percent: 28 });
  // Fixed price 20,000, 40% earned: 8,000 recognised against 6,000 spent.
  const fixed = margin({
    estimatedRevenue: estimatedRevenue('fixed_price', 20_000, null),
    estimatedCost: 15_000,
    actualRevenue: actualRevenue('fixed_price', 20_000, 0, 0.4),
    actualCost: 6000,
  });
  assert.deepEqual(fixed.actual, { revenue: 8000, cost: 6000, margin: 2000, percent: 25 });
  assert.deepEqual(fixed.estimated, { revenue: 20_000, cost: 15_000, margin: 5000, percent: 25 });
  const both = combineMargins([tm, fixed]);
  assert.deepEqual(both.actual, { revenue: 10_500, cost: 7800, margin: 2700, percent: 25.7 });
  assert.equal(actualRevenue('time_and_materials', 2000, 2500, null), 2000, 'no more than the contract');
  assert.equal(estimatedRevenue('non_billable', 5000, 1000), 0);
});

/* BR-319 ------------------------------------------------------------------ */

await check('BR-319: forecast revenue for a control portfolio matches the hand calculation', () => {
  const months = ['2026-10-01', '2026-11-01', '2026-12-01'];
  // P1, time and materials: 1,000 a month planned, but only 1,000 of a 5,000 contract is left; 80% confidence.
  const p1 = forecastProject({
    model: 'time_and_materials',
    contractValue: 5000,
    earned: 4000,
    months,
    planned: new Map([
      ['2026-10-01', { hours: 10, revenue: 1000 }],
      ['2026-11-01', { hours: 10, revenue: 1000 }],
    ]),
    plannedFinish: null,
    confidence: 0.8,
  });
  // P2, fixed price: 6,000 left, by planned hours 20 : 10 : 0; 50%.
  const p2 = forecastProject({
    model: 'fixed_price',
    contractValue: 9000,
    earned: 3000,
    months,
    planned: new Map([
      ['2026-10-01', { hours: 20, revenue: 0 }],
      ['2026-11-01', { hours: 10, revenue: 0 }],
    ]),
    plannedFinish: null,
    confidence: 0.5,
  });
  // P3, fixed price, no hours planned: 1,000 left, evenly to its finish in November; 100%.
  const p3 = forecastProject({ model: 'fixed_price', contractValue: 1000, earned: 0, months, planned: new Map(), plannedFinish: '2026-11-15', confidence: 1 });
  assert.deepEqual(p1.map((line) => [line.revenue, line.weighted]), [[500, 400], [500, 400], [0, 0]]);
  assert.deepEqual(p2.map((line) => [line.revenue, line.weighted]), [[4000, 2000], [2000, 1000], [0, 0]]);
  assert.deepEqual(p3.map((line) => [line.revenue, line.weighted]), [[500, 500], [500, 500], [0, 0]]);
  const weighted = months.map((_, index) => p1[index]!.weighted + p2[index]!.weighted + p3[index]!.weighted);
  assert.deepEqual(weighted, [2900, 1900, 0]);
});

/* BR-322, BR-323 ---------------------------------------------------------- */

await check('BR-322: billable items reconcile to approved time and expenses, and not when one is missing', () => {
  const items = [
    { kind: 'time', quantity: 4, amount: 400 },
    { kind: 'time', quantity: 2, amount: 200 },
    { kind: 'expense', quantity: 1, amount: 108.92 },
  ];
  assert.equal(reconcileBilling({ approvedHours: 6, approvedExpenses: 108.92, items }).reconciles, true);
  assert.equal(reconcileBilling({ approvedHours: 6, approvedExpenses: 108.92, items: items.slice(1) }).reconciles, false);
});

await check('BR-323: a batch reconciles on both sides; a replay under new references is a duplicate', () => {
  const sent = [
    { id: 'a', amount: 600, currency: 'USD', reference: null },
    { id: 'b', amount: 108.92, currency: 'USD', reference: null },
  ];
  const first = reconcileBatch(sent, { received: [{ itemId: 'a', reference: 'INV-1' }, { itemId: 'b', reference: 'INV-2' }] });
  assert.equal(first.matched, true);
  assert.deepEqual(first.epm.totals, { USD: 708.92 });
  const acknowledged = sent.map((item, index) => ({ ...item, reference: `INV-${index + 1}` }));
  assert.equal(reconcileBatch(acknowledged, { received: [{ itemId: 'a', reference: 'INV-1' }, { itemId: 'b', reference: 'INV-2' }] }).matched, true, 'a clean replay');
  const doubled = reconcileBatch(acknowledged, { received: [{ itemId: 'a', reference: 'INV-1' }, { itemId: 'b', reference: 'INV-3' }] });
  assert.deepEqual(doubled.duplicates, ['b']);
  assert.equal(doubled.matched, false);
  const short = reconcileBatch(sent, { received: [{ itemId: 'a', reference: 'INV-1' }] });
  assert.deepEqual(short.missing, ['b']);
  assert.equal(short.matched, false);
});

console.log(`\n${passed} passed`);
