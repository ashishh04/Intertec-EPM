import assert from 'node:assert/strict';

import { daysBetween, figuresOf, remainingOf, sprintStateOf } from '../burndown.js';

/**
 * The figures behind a sprint's burndown (`domain/burndown.ts`): what a day's
 * remaining and completed points are, which sprints are running, and which days
 * a sprint spans.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/burndown.check.ts
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

await check('points in the sprint and points done are summed', () => {
  const figures = figuresOf([
    { points: 5, done: true },
    { points: 3, done: false },
    { points: 8, done: true },
  ]);
  assert.deepEqual(figures, { committed: 16, completed: 13 });
});

await check('work without points counts as nothing, done or not', () => {
  const figures = figuresOf([
    { points: null, done: true },
    { points: undefined, done: false },
    { points: 2, done: false },
  ]);
  assert.deepEqual(figures, { committed: 2, completed: 0 });
});

await check('remaining is the points committed at the start less those done, when the start was recorded', () => {
  // Scope added mid-sprint does not flatten the line: committed stays at 20.
  assert.equal(remainingOf({ committed: 26, completed: 9 }, 20), 11);
});

await check("without a recorded start, remaining is that day's points less those done", () => {
  assert.equal(remainingOf({ committed: 26, completed: 9 }, null), 17);
});

await check('fractions of a point are kept to two places', () => {
  const figures = figuresOf([
    { points: 0.1, done: true },
    { points: 0.2, done: true },
  ]);
  assert.equal(figures.completed, 0.3);
  assert.equal(remainingOf(figures, 1), 0.7);
});

await check('a sprint runs from its start date to its end date', () => {
  const sprint = { status: 'open' as const, startDate: '2026-10-05', endDate: '2026-10-16' };
  assert.equal(sprintStateOf(sprint, '2026-10-04'), 'planned');
  assert.equal(sprintStateOf(sprint, '2026-10-05'), 'active');
  assert.equal(sprintStateOf(sprint, '2026-10-16'), 'active');
  assert.equal(sprintStateOf(sprint, '2026-10-17'), 'completed');
});

await check('a closed version is completed and an undated one is a backlog', () => {
  assert.equal(sprintStateOf({ status: 'closed', startDate: '2026-10-05', endDate: '2026-10-30' }, '2026-10-10'), 'completed');
  assert.equal(sprintStateOf({ status: 'open', startDate: null, endDate: null }, '2026-10-10'), 'planned');
});

await check("a sprint's days include both ends, across a month's end", () => {
  assert.deepEqual(daysBetween('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(daysBetween('2026-10-02', '2026-10-01'), []);
});

await check('a sprint is never drawn over more than 90 days', () => {
  assert.equal(daysBetween('2026-01-01', '2026-12-31').length, 90);
});

console.log(`\n${passed} passed`);
