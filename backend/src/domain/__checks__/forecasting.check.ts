import assert from 'node:assert/strict';

import { dayOf } from '../critical-path.js';
import { addWorkingDays, calibrate, forecastProject, groupOf, trainModel, workingDaysBetween, type Calendar, type HistoryItem, type ProjectInput } from '../forecasting.js';

/**
 * Delivery forecasting (BR-509, BR-510) on hand-made histories, each answer
 * worked out apart from the engine.
 *
 *   npx tsx src/domain/__checks__/forecasting.check.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const calendar: Calendar = { nonWorking: new Set<number>(), workingWeekdays: new Set([0, 1, 2, 3, 4]) };
const monday = dayOf('2026-11-02');

check('working days skip weekends both ways', () => {
  assert.equal(workingDaysBetween(calendar, monday, dayOf('2026-11-09')), 5);
  assert.equal(workingDaysBetween(calendar, dayOf('2026-11-09'), monday), -5);
  assert.equal(addWorkingDays(calendar, dayOf('2026-11-06'), 1), dayOf('2026-11-09'));
  assert.equal(addWorkingDays(calendar, dayOf('2026-11-09'), -1), dayOf('2026-11-06'));
});

/** A history where every task finishes exactly `slip` working days after its due date. */
const history = (slip: number, count: number, group = groupOf('task', 16)): HistoryItem[] =>
  Array.from({ length: count }, (_, i) => {
    const due = monday - 200 + i;
    return { id: i + 1, group, due, finished: addWorkingDays(calendar, due, slip), estimatedHours: 16, spentHours: 24 };
  });

const project = (overrides: Partial<ProjectInput> = {}): ProjectInput => ({
  projectId: 1,
  name: 'Control',
  today: monday,
  plannedFinish: dayOf('2026-11-30'),
  budget: 10_000,
  spentCost: 4_000,
  spentHours: 40,
  costPerHour: 100,
  open: [
    { id: 11, subject: 'A', group: groupOf('task', 16), due: dayOf('2026-11-20'), estimatedHours: 16, spentHours: 0 },
    { id: 12, subject: 'B', group: groupOf('task', 16), due: dayOf('2026-11-25'), estimatedHours: 16, spentHours: 8 },
  ],
  ...overrides,
});

check('a history that always finishes 5 working days late puts the finish 5 working days past the last due date', () => {
  const model = trainModel(history(5, 30), calendar);
  const forecast = forecastProject(project(), model, calendar);
  const expected = addWorkingDays(calendar, dayOf('2026-11-25'), 5); // 2 Dec
  assert.deepEqual(forecast.finish, { p10: expected, p50: expected, p90: expected });
  assert.equal(forecast.probabilityOnTime, 0, 'planned 30 Nov, always 2 Dec');
  assert.equal(forecast.factors[0]?.workPackageId, 12, 'B, due last, decides the finish');
});

check('one that always finishes on time gives probability 1 against a planned finish after the last due date', () => {
  const forecast = forecastProject(project(), trainModel(history(0, 30), calendar), calendar);
  assert.equal(forecast.probabilityOnTime, 1);
});

check('effort and cost at completion follow the estimate multiplier: 24 spent for every 16 estimated', () => {
  const forecast = forecastProject(project(), trainModel(history(0, 30), calendar), calendar);
  // A: 16 × 1.5 − 0 = 24; B: 16 × 1.5 − 8 = 16; 40 remaining.
  assert.equal(forecast.effort.remainingP50, 40);
  assert.equal(forecast.effort.atCompletionP50, 80);
  assert.equal(forecast.cost.atCompletionP50, 4_000 + 40 * 100);
  assert.equal(forecast.cost.overrunP50, -2_000);
  assert.equal(forecast.cost.probabilityOverBudget, 0);
});

check('work already late finishes no earlier than today', () => {
  const late = project({ open: [{ id: 21, subject: 'Late', group: groupOf('task', 16), due: monday - 7, estimatedHours: 16, spentHours: 0 }] });
  const forecast = forecastProject(late, trainModel(history(0, 30), calendar), calendar);
  assert.ok(forecast.finish!.p10 >= monday);
});

check('a small group falls back to the whole history', () => {
  const mixed = [...history(10, 30, groupOf('task', 16)), ...history(0, 3, groupOf('bug', 2))];
  const model = trainModel(mixed, calendar);
  const bugOnly = project({ open: [{ id: 31, subject: 'Bug', group: groupOf('bug', 2), due: dayOf('2026-11-20'), estimatedHours: 2, spentHours: 0 }] });
  const forecast = forecastProject(bugOnly, model, calendar);
  // Three bugs are too few: the whole history (mostly 10 late) decides.
  assert.ok(forecast.finish!.p90 > dayOf('2026-11-20'));
});

check('BR-510: the same stored inputs reproduce the same forecast exactly', () => {
  const model = trainModel([...history(2, 15), ...history(8, 15)], calendar);
  const a = forecastProject(project(), model, calendar);
  const b = forecastProject(JSON.parse(JSON.stringify(project())), JSON.parse(JSON.stringify(model)), calendar);
  assert.deepEqual(a, b);
});

check('calibration: perfect predictions score 0; always 50 % against a fair coin scores 0.25', () => {
  const perfect = calibrate([{ probability: 1, onTime: true }, { probability: 0, onTime: false }]);
  assert.equal(perfect.brier, 0);
  assert.equal(perfect.calibrationError, 0);
  const coin = calibrate([{ probability: 0.5, onTime: true }, { probability: 0.5, onTime: false }]);
  assert.equal(coin.brier, 0.25);
  assert.equal(coin.calibrationError, 0);
});

check('BR-509: back-tested against outcomes drawn as history was, the forecasts are calibrated within the default tolerance', () => {
  // A seeded spread of lateness: -3 to +10 working days, most a little late.
  let seed = 7;
  const draw = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const slip = () => Math.round(-3 + 13 * draw() ** 1.6);
  const finished: HistoryItem[] = Array.from({ length: 400 }, (_, i) => {
    const due = monday - 400 + i;
    return { id: i + 1, group: groupOf('task', 16), due, finished: addWorkingDays(calendar, due, slip()), estimatedHours: 16, spentHours: 16 };
  });
  const model = trainModel(finished, calendar);
  const cases = Array.from({ length: 600 }, (_, i) => {
    const due = addWorkingDays(calendar, monday, Math.floor(draw() * 10));
    const planned = addWorkingDays(calendar, due, Math.floor(draw() * 11) - 2);
    const input = project({ projectId: i, plannedFinish: planned, open: [{ id: 1, subject: 'X', group: groupOf('task', 16), due, estimatedHours: null, spentHours: 0 }] });
    const forecast = forecastProject(input, model, calendar, 400);
    return { probability: forecast.probabilityOnTime ?? 0, onTime: addWorkingDays(calendar, due, slip()) <= planned };
  });
  const result = calibrate(cases);
  assert.ok(result.brier! <= 0.25, `Brier ${result.brier}`);
  assert.ok(result.calibrationError! <= 0.15, `calibration error ${result.calibrationError}`);
  console.log(`        (600 cases: Brier ${result.brier}, calibration error ${result.calibrationError})`);
});

console.log(`\n${passed} passed`);
