import assert from 'node:assert/strict';

import { DEFAULT_HEALTH_RULES } from '../health-rules.js';
import {
  aggregateHealth,
  computeHealth,
  effectiveHealth,
  forecastFinish,
  parseOverrideLevels,
  type HealthInputs,
} from '../health.js';
import type { HealthRules } from '../../types/epm.js';

/**
 * Worked examples for the health calculation (BR-204, BR-205, BR-206).
 *
 * The calculation is a pure function of its inputs and the rules, so every
 * boundary is checked here directly — the API tests in `authz-test.ts` cover
 * the same rules end to end, but can only arrange the cases an instance lets
 * them build. Needs no instance and writes nothing.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/health.check.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

const rules = DEFAULT_HEALTH_RULES;
const TODAY = '2026-10-06';

/** A healthy, fully specified project; each example changes one thing. */
function project(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    total: 40,
    open: 20,
    overdue: 0,
    openRisks: 0,
    openHighRisks: 0,
    riskTypesConfigured: true,
    latestOpenDue: '2026-11-20',
    plannedStart: '2026-07-01',
    plannedFinish: '2026-11-30',
    budget: 100_000,
    cost: { cost: 50_000, costedHours: 500, uncostedHours: 0 },
    today: TODAY,
    ...overrides,
  };
}

const level = (inputs: HealthInputs, criterion: 'schedule' | 'budget' | 'risks' | 'overdue', with_ = rules) =>
  computeHealth(inputs, with_).levels[criterion];

console.log('Schedule variance');
check('the baseline example is on plan', () => assert.equal(level(project(), 'schedule'), 'healthy'));
check('no planned finish is not assessed, rather than green', () =>
  assert.equal(level(project({ plannedFinish: undefined }), 'schedule'), null));
check('the forecast is the latest open due date', () =>
  assert.equal(forecastFinish(project({ latestOpenDue: '2026-12-09' })), '2026-12-09'));
check('just under amber stays green (4 days late)', () =>
  assert.equal(level(project({ latestOpenDue: '2026-12-04' }), 'schedule'), 'healthy'));
check('exactly at amber is amber (5 days late)', () =>
  assert.equal(level(project({ latestOpenDue: '2026-12-05' }), 'schedule'), 'warning'));
check('just under red stays amber (14 days late)', () =>
  assert.equal(level(project({ latestOpenDue: '2026-12-14' }), 'schedule'), 'warning'));
check('exactly at red is red (15 days late)', () =>
  assert.equal(level(project({ latestOpenDue: '2026-12-15' }), 'schedule'), 'critical'));
check('overdue work cannot finish in the past: the forecast is at least today', () =>
  assert.equal(forecastFinish(project({ latestOpenDue: '2026-09-01', overdue: 3 })), TODAY));
check('so a project past its planned finish with overdue work is late by the days since', () => {
  const late = computeHealth(project({ plannedFinish: '2026-09-01', latestOpenDue: '2026-08-15', overdue: 2 }), rules);
  assert.equal(late.criteria.find((c) => c.criterion === 'schedule')?.value, 35);
  assert.equal(late.levels.schedule, 'critical');
});
check('finishing early reads as a negative variance and green', () => {
  const early = computeHealth(project({ latestOpenDue: '2026-11-10' }), rules);
  assert.equal(early.criteria.find((c) => c.criterion === 'schedule')?.value, -20);
  assert.equal(early.levels.schedule, 'healthy');
});
check('all work complete is green', () =>
  assert.equal(level(project({ open: 0, latestOpenDue: undefined }), 'schedule'), 'healthy'));
check('open work with no dates cannot be forecast', () =>
  assert.equal(level(project({ latestOpenDue: undefined }), 'schedule'), null));
check('unless the planned finish has already passed, which makes it at least today', () =>
  assert.equal(level(project({ latestOpenDue: undefined, plannedFinish: '2026-09-01' }), 'schedule'), 'critical'));

console.log('\nBudget variance');
// The plan to date phases the budget evenly from 1 Jul to 30 Nov: 153 days,
// of which 98 have elapsed by 6 Oct, so 64.05% of the budget is planned.
check('spend in line with the plan is green', () => assert.equal(level(project(), 'budget'), 'healthy'));
check('no budget is not assessed, rather than green', () =>
  assert.equal(level(project({ budget: undefined }), 'budget'), null));
check('a zero budget is no budget', () => assert.equal(level(project({ budget: 0 }), 'budget'), null));
check('unreadable spend is not assessed, rather than free', () =>
  assert.equal(level(project({ cost: undefined }), 'budget'), null));
check('the variance is the share of the whole budget spent ahead of the plan', () => {
  const ahead = computeHealth(project({ cost: { cost: 70_000, costedHours: 700, uncostedHours: 0 } }), rules);
  // 70,000 − 64,052.29 planned = 5,947.71, or 5.9% of the budget.
  assert.equal(ahead.criteria.find((c) => c.criterion === 'budget')?.value, 5.9);
  assert.equal(ahead.levels.budget, 'warning');
});
check('spend 10% of the budget ahead of plan is red', () =>
  assert.equal(level(project({ cost: { cost: 74_100, costedHours: 741, uncostedHours: 0 } }), 'budget'), 'critical'));
check('without planned dates the comparison is with the whole budget', () => {
  const noDates = { plannedStart: undefined, plannedFinish: undefined };
  assert.equal(level(project({ ...noDates, cost: { cost: 99_000, costedHours: 1, uncostedHours: 0 } }), 'budget'), 'healthy');
  assert.equal(level(project({ ...noDates, cost: { cost: 105_000, costedHours: 1, uncostedHours: 0 } }), 'budget'), 'warning');
  assert.equal(level(project({ ...noDates, cost: { cost: 110_000, costedHours: 1, uncostedHours: 0 } }), 'budget'), 'critical');
});
check('before the planned start, any spend is ahead of a plan of nothing', () =>
  assert.equal(
    level(project({ plannedStart: '2026-11-01', cost: { cost: 12_000, costedHours: 1, uncostedHours: 0 } }), 'budget'),
    'critical',
  ));
check('uncosted hours are named in the reason rather than priced at zero', () => {
  const partial = computeHealth(project({ cost: { cost: 50_000, costedHours: 500, uncostedHours: 12 } }), rules);
  assert.match(partial.criteria.find((c) => c.criterion === 'budget')!.reason, /12 hours .* no hourly rate/);
});

// BR-205's acceptance criterion: "Logging a cost entry that breaches the red
// budget threshold moves the project to red on the next recalculation."
check('BR-205: spend that crosses the red line moves the project to red', () => {
  const before = computeHealth(project(), rules);
  const after = computeHealth(project({ cost: { cost: 80_000, costedHours: 800, uncostedHours: 0 } }), rules);
  assert.equal(before.levels.overall, 'healthy');
  assert.equal(after.levels.budget, 'critical');
  assert.equal(after.levels.overall, 'critical');
});

console.log('\nOpen high risks');
check('no risk type on the instance is not assessed', () =>
  assert.equal(level(project({ riskTypesConfigured: false }), 'risks'), null));
check('no high risks is green', () => assert.equal(level(project(), 'risks'), 'healthy'));
check('one high risk is amber', () => assert.equal(level(project({ openRisks: 4, openHighRisks: 1 }), 'risks'), 'warning'));
check('two stays amber', () => assert.equal(level(project({ openRisks: 4, openHighRisks: 2 }), 'risks'), 'warning'));
check('three is red', () => assert.equal(level(project({ openRisks: 4, openHighRisks: 3 }), 'risks'), 'critical'));
check('low-priority risks do not count', () => assert.equal(level(project({ openRisks: 9, openHighRisks: 0 }), 'risks'), 'healthy'));

console.log('\nOverdue items');
check('two overdue is green', () => assert.equal(level(project({ overdue: 2 }), 'overdue'), 'healthy'));
check('three is amber', () => assert.equal(level(project({ overdue: 3 }), 'overdue'), 'warning'));
check('nine stays amber', () => assert.equal(level(project({ overdue: 9 }), 'overdue'), 'warning'));
check('ten is red', () => assert.equal(level(project({ overdue: 10 }), 'overdue'), 'critical'));
check('a project with no work packages is green on overdue', () =>
  assert.equal(level(project({ total: 0, open: 0, latestOpenDue: undefined }), 'overdue'), 'healthy'));

// BR-204's acceptance criterion: "A project breaching a configured amber
// threshold is computed amber without manual intervention." Each criterion,
// with the rules as an administrator might set them.
console.log('\nBR-204: configured thresholds');
const configured: HealthRules = structuredClone(rules);
configured.criteria.overdue.amberAt = 1;
configured.criteria.overdue.redAt = 5;
check('a lowered amber threshold, crossed, is amber overall', () => {
  const result = computeHealth(project({ overdue: 1 }), configured);
  assert.equal(result.levels.overdue, 'warning');
  assert.equal(result.levels.overall, 'warning');
});
check('and the same project under the defaults is not', () =>
  assert.equal(computeHealth(project({ overdue: 1 }), rules).levels.overall, 'healthy'));
for (const [criterion, breach] of [
  ['schedule', { latestOpenDue: '2026-12-05' }],
  ['budget', { cost: { cost: 70_000, costedHours: 700, uncostedHours: 0 } }],
  ['risks', { openRisks: 1, openHighRisks: 1 }],
  ['overdue', { overdue: 3 }],
] as const) {
  check(`breaching amber on ${criterion} alone makes the project amber`, () =>
    assert.equal(computeHealth(project(breach), rules).levels.overall, 'warning'));
}

console.log('\nOverall, by weight');
check('equal weights: any one red is red', () =>
  assert.equal(aggregateHealth({ schedule: 'critical', budget: 'healthy', risks: 'healthy', overdue: 'healthy' }, rules).overall, 'critical'));
check('two ambers and no red is amber, not red', () =>
  assert.equal(aggregateHealth({ schedule: 'warning', budget: 'warning', risks: 'healthy', overdue: 'healthy' }, rules).overall, 'warning'));
check('a criterion not assessed is left out rather than counted green', () => {
  // Three assessed, one amber: 33% of the weight, over the 25% line.
  assert.equal(aggregateHealth({ schedule: 'warning', budget: null, risks: 'healthy', overdue: 'healthy' }, rules).overall, 'warning');
});
check('nothing assessed is green, and says so', () => {
  const nothing = aggregateHealth({ schedule: null, budget: null, risks: null, overdue: null }, rules);
  assert.equal(nothing.overall, 'healthy');
  assert.match(nothing.explanation, /Nothing could be assessed/);
});
const weighted: HealthRules = structuredClone(rules);
weighted.criteria.budget.weight = 50;
weighted.criteria.schedule.weight = 30;
weighted.criteria.risks.weight = 10;
weighted.criteria.overdue.weight = 10;
check('a heavily weighted red alone is red', () =>
  assert.equal(aggregateHealth({ schedule: 'healthy', budget: 'critical', risks: 'healthy', overdue: 'healthy' }, weighted).overall, 'critical'));
check('a lightly weighted red alone is not', () => {
  const light = aggregateHealth({ schedule: 'healthy', budget: 'healthy', risks: 'healthy', overdue: 'critical' }, weighted);
  assert.equal(light.overall, 'healthy');
  assert.match(light.explanation, /only 10% of the weight/);
});
check('but two light ones together cross the line', () =>
  assert.equal(aggregateHealth({ schedule: 'healthy', budget: 'healthy', risks: 'warning', overdue: 'critical' }, { ...weighted, amberShare: 20 }).overall, 'warning'));
const informational: HealthRules = structuredClone(rules);
informational.criteria.risks.weight = 0;
check('a weight of zero is shown but never moves the overall', () => {
  const result = computeHealth(project({ openRisks: 5, openHighRisks: 5 }), informational);
  assert.equal(result.levels.risks, 'critical');
  assert.equal(result.levels.overall, 'healthy');
});
const switchedOff: HealthRules = structuredClone(rules);
switchedOff.criteria.budget.enabled = false;
check('a criterion switched off is neither measured nor shown', () => {
  const result = computeHealth(project({ cost: { cost: 99_999, costedHours: 1, uncostedHours: 0 } }), switchedOff);
  assert.equal(result.levels.budget, null);
  assert.equal(result.criteria.some((c) => c.criterion === 'budget'), false);
  assert.equal(result.levels.overall, 'healthy');
});
check('the explanation names what moved the overall', () => {
  const result = computeHealth(project({ overdue: 12 }), rules);
  assert.match(result.explanation, /^Red: overdue items is red/);
});

console.log('\nOverrides (BR-206)');
const failing = computeHealth(project({ overdue: 12, latestOpenDue: '2026-12-20' }), rules).levels;
check('no override changes nothing', () => assert.deepEqual(effectiveHealth(failing, undefined, rules), failing));
check('an empty override changes nothing', () => assert.deepEqual(effectiveHealth(failing, {}, rules), failing));
check('a pinned overall wins', () => assert.equal(effectiveHealth(failing, { overall: 'warning' }, rules).overall, 'warning'));
check('and leaves the criteria showing the truth', () =>
  assert.equal(effectiveHealth(failing, { overall: 'warning' }, rules).overdue, 'critical'));
check('pinning criteria moves the overall through the same weighting', () =>
  assert.equal(effectiveHealth(failing, { overdue: 'healthy', schedule: 'healthy' }, rules).overall, 'healthy'));
check('pinning only some leaves the rest red', () =>
  assert.equal(effectiveHealth(failing, { overdue: 'healthy' }, rules).overall, 'critical'));
check('a pin on an unassessed criterion makes it count', () => {
  const unassessed = computeHealth(project({ budget: undefined }), rules).levels;
  assert.equal(effectiveHealth(unassessed, { budget: 'critical' }, rules).overall, 'critical');
});

console.log('\nReading a stored override');
check('null is no pin', () => assert.deepEqual(parseOverrideLevels(null), {}));
check('an array is no pin', () => assert.deepEqual(parseOverrideLevels(['healthy']), {}));
check('a valid pin reads back', () => assert.deepEqual(parseOverrideLevels({ overall: 'warning' }), { overall: 'warning' }));
check('a retired dimension is dropped rather than thrown on', () =>
  assert.deepEqual(parseOverrideLevels({ scope: 'healthy', budget: 'critical' }), { budget: 'critical' }));
check('an unknown level is dropped', () => assert.deepEqual(parseOverrideLevels({ overall: 'purple' }), {}));

console.log('\nDeterminism and range');
check('the same inputs give the same result every time', () => {
  const once = JSON.stringify(computeHealth(project({ overdue: 4 }), rules));
  for (let n = 0; n < 50; n += 1) assert.equal(JSON.stringify(computeHealth(project({ overdue: 4 }), rules)), once);
});
check('no input produces a level outside the three, or a non-finite figure', () => {
  for (const overdue of [0, 1, 3, 9, 10, 500]) {
    for (const cost of [0, 1, 50_000, 1e9]) {
      for (const budget of [undefined, 0, 1, 100_000]) {
        const result = computeHealth(project({ overdue, budget, cost: { cost, costedHours: 1, uncostedHours: 0 } }), rules);
        for (const value of Object.values(result.levels)) {
          assert.ok(value === null || ['healthy', 'warning', 'critical'].includes(value));
        }
        for (const criterion of result.criteria) {
          assert.ok(criterion.value === null || Number.isFinite(criterion.value));
        }
      }
    }
  }
});

console.log(`\n${passed} passed`);
