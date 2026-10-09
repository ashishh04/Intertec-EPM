import assert from 'node:assert/strict';

import { prisma } from '../../db/prisma.js';
import { today as todayIso, addDays } from '../../lib/dates.js';
import { modelFacts } from '../measure-facts.js';
import { measureById, type MeasureValue } from '../measures.js';
import { OVERVIEW_MEASURES, portfolioOverview, type ProjectSet } from '../portfolio-overview.js';
import { referenceCache } from '../../lib/cache.js';
import { forgetViewRoles, maySeeView, projectsOf } from '../portfolio-views.js';

/**
 * Worked examples for portfolio views (BR-201 to BR-203): how a set's figure is
 * rolled up from its projects' — added, the largest, or a share of summed
 * parts — checked on numbers worked by hand; which projects a saved view
 * selects; who may see one; and, on the dev instance's own model, that every
 * figure of a set equals the roll-up of its project rows, for someone who can
 * see everything and for someone who cannot.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/portfolio.check.ts
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

const rollupOf = (id: string) => {
  const rollup = measureById(id)?.rollup;
  assert.ok(rollup, `${id} has a roll-up`);
  return rollup!;
};
const values = (...items: (Partial<MeasureValue> & { value: number | null })[]): MeasureValue[] => items;

console.log('Rolling projects up into a set (BR-201)');

await check('counts and money are added; a project with nothing to count adds nothing', () => {
  assert.equal(rollupOf('risk.open').from(values({ value: 2 }, { value: 3 }, { value: null })), 5);
  assert.equal(rollupOf('cost.actual').from(values({ value: 100.1 }, { value: 0.2 })), 100.3, 'money is added to the cent');
  assert.equal(rollupOf('risk.open').from(values({ value: null }, { value: null })), null, 'nothing to count is not zero');
});

await check('schedule variance is the latest project, not a sum', () => {
  assert.equal(rollupOf('schedule.varianceDays').from(values({ value: -2 }, { value: 12 }, { value: null })), 12);
});

await check('budget consumed is the summed cost of the summed budgets, not an average of shares', () => {
  // 100 of 400 (25%) and 50 of 100 (50%): averaging the shares says 37.5%; the portfolio spent 150 of 500.
  const share = rollupOf('budget.consumed').from(
    values({ value: 25, parts: { actual: 100, budget: 400 } }, { value: 50, parts: { actual: 50, budget: 100 } }),
  );
  assert.equal(share, 30);
});

await check('budget variance is summed cost minus summed plan, of the summed budgets', () => {
  // (150 - 140) / 500 = 2%.
  const variance = rollupOf('budget.variancePct').from(
    values(
      { value: 5, parts: { actual: 100, planned: 80, budget: 400 } },
      { value: -10, parts: { actual: 50, planned: 60, budget: 100 } },
    ),
  );
  assert.equal(variance, 2);
});

await check('milestones on time are the summed met of the summed decided', () => {
  const onTime = rollupOf('milestones.onTime').from(
    values({ value: 50, parts: { met: 1, missed: 1 } }, { value: 100, parts: { met: 2, missed: 0 } }, { value: null }),
  );
  assert.equal(onTime, 75);
});

await check('every figure of the overview says how it rolls up', () => {
  for (const id of OVERVIEW_MEASURES) assert.ok(measureById(id)?.rollup, `${id} has a roll-up`);
});

console.log('Which projects a view selects, and who sees it (BR-203)');

const facts = {
  projects: new Map(
    [
      { id: 1, active: true, portfolioId: 'a' },
      { id: 2, active: true, portfolioId: 'a' },
      { id: 3, active: true, portfolioId: 'b' },
      { id: 4, active: false, portfolioId: 'a' },
      { id: 5, active: true, portfolioId: null },
    ].map((project) => [project.id, project as never]),
  ),
};

await check('no portfolio and no project named: every active project', () => {
  assert.deepEqual(projectsOf({ portfolioIds: [], projectIds: [] }, facts), [1, 2, 3, 5]);
});

await check('a portfolio and a named project: both, active only', () => {
  assert.deepEqual(projectsOf({ portfolioIds: ['a'], projectIds: ['5'] }, facts), [1, 2, 5]);
  assert.deepEqual(projectsOf({ portfolioIds: [], projectIds: ['4'] }, facts), [], 'an archived project is not delivering');
});

await check('a private view is its owner’s alone; a public one is everyone’s', () => {
  const view = { ownerId: '7', visibility: 'private', roleIds: [] };
  assert.equal(maySeeView(view, '7', new Set()), true);
  assert.equal(maySeeView(view, '8', new Set(['3'])), false);
  assert.equal(maySeeView({ ...view, visibility: 'public' }, '8', new Set()), true);
});

await check('a view shared with roles reaches whoever holds one on a project it selects, and nobody else', () => {
  const view = { ownerId: '7', visibility: 'roles', roleIds: ['3', '9'] };
  assert.equal(maySeeView(view, '8', new Set(['9'])), true);
  assert.equal(maySeeView(view, '8', new Set(['4'])), false);
  assert.equal(maySeeView(view, '8', new Set()), false);
});

await check('a membership change made in EPM forgets the roles remembered for sharing', () => {
  // Remembered per person under `portfolio-view-roles:<id>`; a stale entry would
  // keep a newly given role from reaching its view for a minute.
  referenceCache.set('portfolio-view-roles:99', new Map([[1, new Set(['5'])]]), 60_000);
  forgetViewRoles();
  assert.equal(referenceCache.peek('portfolio-view-roles:99'), undefined);
});

console.log('A set adds up to its projects, on this instance’s model (BR-201, BR-203)');

const model = await modelFacts();
const everyone = { visibleProjectIds: new Set(model.projects.keys()) };
const today = todayIso();
const period = { from: addDays(today, -83), to: today };
const allActive: ProjectSet = {
  kind: 'view',
  id: 'check',
  name: 'Every active project',
  projectIds: [...model.projects.values()].filter((project) => project.active).map((project) => project.id),
};

await check('every figure of every active project together equals the roll-up of its rows', async () => {
  const overview = await portfolioOverview(allActive, everyone, period, today);
  const wrong = overview.reconciliation.filter((line) => !line.matches);
  assert.deepEqual(wrong, [], 'no figure disagrees with its rows');
  assert.equal(overview.set.shown, allActive.projectIds.length);
  // The added figures, added again here by hand rather than by the roll-up.
  for (const id of ['work.open', 'work.overdue', 'risk.open', 'milestones.missed', 'cost.actual', 'budget.total'] as const) {
    const byHand = overview.projects.reduce((sum, project) => sum + (project.figures[id]?.value ?? 0), 0);
    const whole = overview.measures[id]?.value ?? 0;
    assert.ok(Math.abs(byHand - whole) < 0.005, `${id}: rows ${byHand} vs whole ${whole}`);
  }
});

await check('a portfolio adds up the same way', async () => {
  for (const portfolio of model.portfolios.values()) {
    const overview = await portfolioOverview(
      {
        kind: 'portfolio',
        id: portfolio.id,
        name: portfolio.name,
        projectIds: [...model.projects.values()].filter((project) => project.active && project.portfolioId === portfolio.id).map((project) => project.id),
      },
      everyone,
      period,
      today,
    );
    assert.equal(overview.reconciled, true, `${portfolio.name} reconciles`);
  }
});

await check('someone who cannot see a project gets the rest, told how many were left out — and it still adds up', async () => {
  const hiddenId = allActive.projectIds[0];
  assert.ok(hiddenId !== undefined, 'the instance has an active project');
  const partial = { visibleProjectIds: new Set([...everyone.visibleProjectIds].filter((id) => id !== hiddenId)) };
  const overview = await portfolioOverview(allActive, partial, period, today);
  assert.equal(overview.set.hidden, 1);
  assert.equal(overview.set.shown, allActive.projectIds.length - 1);
  assert.equal(overview.projects.some((project) => project.id === hiddenId), false, 'the hidden project is not a row');
  assert.equal(overview.reconciled, true);
});

await check('a health filter leaves out the others, and says how many', async () => {
  const overview = await portfolioOverview({ ...allActive, health: ['healthy'] }, everyone, period, today);
  assert.ok(overview.projects.every((project) => project.health === 'healthy'));
  assert.equal(overview.set.shown + overview.set.filtered, allActive.projectIds.length);
  assert.equal(overview.reconciled, true);
});

console.log(`\n${passed} passed`);
await prisma.$disconnect();
