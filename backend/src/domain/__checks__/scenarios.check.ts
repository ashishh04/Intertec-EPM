import assert from 'node:assert/strict';

import { scenarioProfile, shiftDate, type ScenarioProjectInput, type ScenarioWorkInput } from '../scenarios.js';

/**
 * A control example for portfolio scenarios (BR-221): one project deferred by a
 * quarter, worked out by hand.
 *
 *   npx tsx src/domain/__checks__/scenarios.check.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

// P: 2027-01-04 to 2027-03-31, budget 6,300. Work: 100 h over 4–29 January (20 working days),
// 20 h on 1–5 March (5 working days), and a milestone on 31 March.
const project = (shiftMonths: number): ScenarioProjectInput => ({
  projectId: 1, included: true, priority: 4, shiftMonths, shiftDays: 0, budget: 6300, start: '2027-01-04', finish: '2027-03-31',
});
const work: ScenarioWorkInput[] = [
  { workPackageId: 10, projectId: 1, subject: 'Build', remainingHours: 100, start: '2027-01-04', due: '2027-01-29', isMilestone: false },
  { workPackageId: 11, projectId: 1, subject: 'Test', remainingHours: 20, start: '2027-03-01', due: '2027-03-05', isMilestone: false },
  { workPackageId: 12, projectId: 1, subject: 'Release', remainingHours: 0, start: '2027-03-31', due: '2027-03-31', isMilestone: true },
];

check('a quarter moves a day three months on, keeping the day of the month where it exists', () => {
  assert.equal(shiftDate('2027-01-04', 3, 0), '2027-04-04');
  assert.equal(shiftDate('2027-03-31', 3, 0), '2027-06-30');
  assert.equal(shiftDate('2027-01-29', 0, 7), '2027-02-05');
});

const now = scenarioProfile([project(0)], work, 40);
const deferred = scenarioProfile([project(3)], work, 40);

check('as planned: demand and spend by month, worked by hand', () => {
  // Spend: 6,300 over the working days 4 Jan–31 Mar: 20 in January, 20 in February, 23 in March (63).
  assert.deepEqual(
    now.months.map((row) => [row.month, row.demand, row.spend]),
    [
      ['2027-01-01', 100, 2000],
      ['2027-02-01', 0, 2000],
      ['2027-03-01', 20, 2300],
    ],
  );
  assert.equal(now.milestones[0]?.date, '2027-03-31');
  assert.equal(now.strategicScore, 4);
});

check('BR-221: deferred a quarter, capacity demand and spend move together, their totals unchanged', () => {
  assert.equal(deferred.totals.demand, now.totals.demand);
  assert.equal(deferred.totals.spend, now.totals.spend);
  const by = (profile: typeof now, month: string) => profile.months.find((row) => row.month === month);
  // Demand: January's 100 h fall in 4–29 April (20 working days), March's 20 h in 1–5 June.
  assert.equal(by(deferred, '2027-04-01')?.demand, 100);
  assert.equal(by(deferred, '2027-06-01')?.demand, 20);
  assert.equal(by(deferred, '2027-01-01'), undefined, 'nothing is left in January');
  // Spend: 6,300 over 4 Apr–30 Jun: 20 working days in April, 21 in May, 22 in June (63).
  assert.deepEqual(
    ['2027-04-01', '2027-05-01', '2027-06-01'].map((month) => by(deferred, month)?.spend),
    [2000, 2100, 2200],
  );
  assert.equal(deferred.milestones[0]?.date, '2027-06-30', 'the milestone moves with it');
});

check('left out, a project adds nothing; capacity is the same either way', () => {
  const out = scenarioProfile([{ ...project(0), included: false }], work, 40);
  assert.equal(out.totals.demand, 0);
  assert.equal(out.strategicScore, 0);
  assert.equal(now.months[0]?.capacity, 168, '40 h a week over January’s 21 working days, the 1st a Friday');
});

console.log(`\n${passed} passed`);
