import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { durationToHours, hoursToDuration } from '../../lib/duration.js';
import { allowedDifference } from '../analytics-model.js';
import { buildDashboard } from '../dashboards.js';
import { workingDaysOf } from '../earned-value-store.js';
import { budgetVariancePct, plannedBudgetToDate } from '../health.js';
import type { ModelFacts, PersonFact, ProjectFact, TimeFact, WorkFact } from '../measure-facts.js';
import {
  bucketsOf,
  contextFor,
  evaluateInContext,
  milestoneOutcome,
  weeksIn,
  type HealthFact,
  type Shared,
} from '../measures.js';
import { OVERDUE_DUE_FILTER, isDelivered, isDueSoon, isOpen, isOverdue } from '../work-definitions.js';

/**
 * Worked examples for the semantic layer and the analytics model (BR-401 to
 * BR-405): what each definition counts, at its edges; that a scope and a
 * viewer narrow the facts as they should; that the same measure read from two
 * dashboards is the same number; and that the deploy file's inline copies of
 * the replica's scripts match their sources. Reads no instance and no model.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/analytics.check.ts
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

const TODAY = '2026-10-06';

/* -------------------------------------------------------------------------- */
/* A small instance                                                           */
/* -------------------------------------------------------------------------- */

const work = (id: number, values: Partial<WorkFact>): WorkFact => ({
  id,
  projectId: 1,
  typeId: 1,
  statusId: 1,
  priorityId: 2,
  assigneeId: 10,
  accountableId: null,
  parentId: null,
  versionId: null,
  subject: `Work ${id}`,
  startDate: null,
  dueDate: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  closedAt: null,
  isClosed: false,
  isMilestone: false,
  statusCategory: 'in_progress',
  typeCategory: 'task',
  priorityCategory: 'medium',
  estimatedHours: null,
  spentHours: 0,
  doneRatio: null,
  storyPoints: null,
  ...values,
});

const DONE = { isClosed: true, statusCategory: 'done', statusId: 3 };
const REJECTED = { isClosed: true, statusCategory: 'blocked', statusId: 4 };

const project = (id: number, values: Partial<ProjectFact> = {}): ProjectFact => ({
  id,
  name: `Project ${id}`,
  identifier: `p${id}`,
  parentId: null,
  active: true,
  portfolioId: null,
  ownerId: null,
  plannedStart: null,
  plannedFinish: null,
  budget: null,
  ...values,
});

const person = (id: number, values: Partial<PersonFact> = {}): PersonFact => ({
  id,
  name: `Person ${id}`,
  status: 'active',
  departmentId: 'd1',
  teamId: 't1',
  weeklyCapacityHours: 40,
  capacitySet: true,
  ...values,
});

const entry = (id: number, values: Partial<TimeFact>): TimeFact => ({
  id,
  spentOn: '2026-10-01',
  userId: 10,
  projectId: 1,
  workPackageId: null,
  hours: 1,
  cost: 100,
  ...values,
});

const WORK: WorkFact[] = [
  // Project 1, portfolio A
  work(1, { dueDate: '2026-10-05' }), // overdue
  work(2, { dueDate: TODAY }), // due today: due, not overdue
  work(3, { dueDate: '2026-10-12' }), // due in six days: due soon
  work(4, { dueDate: '2026-10-13' }), // seven days out: not due soon
  work(5, { ...DONE, dueDate: '2026-10-01', closedAt: '2026-09-30T10:00:00.000Z', storyPoints: 5, versionId: 70 }),
  work(6, { ...REJECTED, dueDate: '2026-09-20', closedAt: '2026-09-25T10:00:00.000Z' }),
  work(7, { isMilestone: true, ...DONE, dueDate: '2026-09-30', closedAt: '2026-09-29T10:00:00.000Z' }), // met
  work(8, { isMilestone: true, ...DONE, dueDate: '2026-09-20', closedAt: '2026-09-22T10:00:00.000Z' }), // missed: late
  work(9, { isMilestone: true, dueDate: '2026-10-02' }), // missed: open past its date
  work(10, { isMilestone: true, dueDate: '2026-10-20' }), // not yet due
  work(11, { typeId: 9, priorityId: 8, dueDate: '2026-10-03' }), // a high risk, past its date
  work(12, { typeId: 9, priorityId: 2 }), // a risk, normal priority
  work(13, { typeId: 9, ...DONE, closedAt: '2026-09-28T10:00:00.000Z' }), // a closed risk
  // Project 2, portfolio A, person 11
  work(20, { projectId: 2, assigneeId: 11, dueDate: '2026-09-01' }),
  work(21, { projectId: 2, assigneeId: 11, ...DONE, closedAt: '2026-10-02T08:00:00.000Z', storyPoints: 3, versionId: 70 }),
  // Project 3, archived
  work(30, { projectId: 3, dueDate: '2026-09-01' }),
  // Project 4, the viewer cannot see it
  work(40, { projectId: 4, dueDate: '2026-09-01' }),
];

const facts: ModelFacts = {
  runId: '1',
  asOf: '2026-10-06T08:00:00.000Z',
  calendar: { nonWorking: new Set(), from: 0, to: -1 },
  projects: new Map(
    [
      project(1, { portfolioId: 'A', budget: 10_000, plannedStart: '2026-09-01', plannedFinish: '2026-10-30' }),
      project(2, { portfolioId: 'A', budget: 5_000 }),
      project(3, { portfolioId: 'A', active: false }),
      project(4, { portfolioId: 'B' }),
    ].map((item) => [item.id, item]),
  ),
  workPackages: WORK,
  time: [
    entry(1, { hours: 8, cost: 800, spentOn: '2026-10-01' }),
    entry(2, { hours: 4, cost: null, spentOn: '2026-10-02', userId: 11, projectId: 2 }),
    entry(3, { hours: 6, cost: 600, spentOn: '2026-08-01' }), // before the period
    entry(4, { hours: 5, cost: 500, spentOn: '2026-10-01', projectId: 4 }), // a project the viewer cannot see
  ],
  people: new Map(
    [person(10), person(11, { teamId: 't2', weeklyCapacityHours: 20 }), person(12, { teamId: 't2', departmentId: 'd2' })].map(
      (item) => [item.id, item],
    ),
  ),
  members: new Map([
    [1, new Set([10])],
    [2, new Set([11])],
  ]),
  versions: new Map([
    [70, { id: 70, projectId: 1, name: 'Sprint 7', startDate: '2026-09-21', endDate: '2026-10-04', status: 'closed', committedPoints: 10 }],
    [71, { id: 71, projectId: 1, name: 'Sprint 8', startDate: '2026-10-05', endDate: '2026-10-18', status: 'open', committedPoints: null }],
  ]),
  portfolios: new Map([
    ['A', { id: 'A', name: 'Alpha', code: 'A', active: true }],
    ['B', { id: 'B', name: 'Beta', code: 'B', active: true }],
  ]),
  departments: new Map([['d1', { id: 'd1', name: 'Delivery', code: 'D1', active: true }]]),
  teams: new Map([
    ['t1', { id: 't1', name: 'Team one', code: 'T1', active: true, departmentId: 'd1' }],
    ['t2', { id: 't2', name: 'Team two', code: 'T2', active: true, departmentId: 'd1' }],
  ]),
  statuses: new Map([
    [1, { name: 'In progress', isClosed: false, category: 'in_progress' }],
    [3, { name: 'Closed', isClosed: true, category: 'done' }],
    [4, { name: 'Rejected', isClosed: true, category: 'blocked' }],
  ]),
  types: new Map([
    [1, { name: 'Task', isMilestone: false, category: 'task' }],
    [9, { name: 'Risk', isMilestone: false, category: 'task' }],
  ]),
  priorities: new Map([
    [2, { name: 'Normal', category: 'medium', position: 2 }],
    [8, { name: 'High', category: 'high', position: 3 }],
  ]),
  users: new Map([
    [10, { name: 'Person 10', kind: 'person' }],
    [11, { name: 'Person 11', kind: 'person' }],
  ]),
};

const health = new Map<number, HealthFact>([
  [1, { overall: 'warning', assessed: true, scheduleVarianceDays: 6, budgetVariancePct: 2 }],
  [2, { overall: 'healthy', assessed: true, scheduleVarianceDays: -3, budgetVariancePct: null }],
]);

const shared: Shared = {
  facts,
  viewer: { visibleProjectIds: new Set([1, 2, 3]) },
  health,
  risk: { typeIds: new Set([9]), highPriorityIds: new Set([8]), configured: true },
  // No baselines or rates: earned value reads each project's plan, unpriced.
  evm: { settings: [], baselines: new Map(), rates: new Map(), days: workingDaysOf(facts.calendar) },
};

const PERIOD = { from: '2026-09-07', to: TODAY }; // four weeks and two days
const value = async (ids: string[], scope = { kind: 'instance' as const } as Parameters<typeof contextFor>[1]) => {
  const result = await evaluateInContext(ids, contextFor(shared, scope, PERIOD, TODAY));
  return Object.fromEntries(Object.entries(result).map(([id, measure]) => [id, measure.value]));
};

/* -------------------------------------------------------------------------- */

console.log('Definitions');

await check('overdue is open and due before today; due today is not overdue', () => {
  assert.equal(isOverdue({ isClosed: false, dueDate: '2026-10-05' }, TODAY), true);
  assert.equal(isOverdue({ isClosed: false, dueDate: TODAY }, TODAY), false);
  assert.equal(isOverdue({ isClosed: true, dueDate: '2026-10-05' }, TODAY), false);
  assert.equal(isOverdue({ isClosed: false, dueDate: null }, TODAY), false);
});

await check('OpenProject is asked for "due on or before yesterday" (<t- 1), not <t- 0, which includes today', () => {
  assert.deepEqual(OVERDUE_DUE_FILTER, { field: 'dueDate', operator: '<t-', values: ['1'] });
});

await check('due soon is today and the next six days', () => {
  assert.equal(isDueSoon({ isClosed: false, dueDate: TODAY }, TODAY), true);
  assert.equal(isDueSoon({ isClosed: false, dueDate: '2026-10-12' }, TODAY), true);
  assert.equal(isDueSoon({ isClosed: false, dueDate: '2026-10-13' }, TODAY), false);
  assert.equal(isDueSoon({ isClosed: false, dueDate: '2026-10-05' }, TODAY), false);
});

await check('rejected work is closed but not delivered', () => {
  assert.equal(isOpen({ isClosed: true, dueDate: null }), false);
  assert.equal(isDelivered({ isClosed: true, dueDate: null, statusCategory: 'done' }), true);
  assert.equal(isDelivered({ isClosed: true, dueDate: null, statusCategory: 'blocked' }), false);
});

await check('milestones: met, late, open past their date, not yet due, rejected', () => {
  assert.equal(milestoneOutcome(WORK[6]!, TODAY), 'met');
  assert.equal(milestoneOutcome(WORK[7]!, TODAY), 'missed');
  assert.equal(milestoneOutcome(WORK[8]!, TODAY), 'missed');
  assert.equal(milestoneOutcome(WORK[9]!, TODAY), 'pending');
  assert.equal(milestoneOutcome(work(99, { isMilestone: true, ...REJECTED, dueDate: '2026-09-01' }), TODAY), 'excluded');
});

await check('durations: a day of effort in the API is 24 hours (40h is P1DT16H, 120h is P5D)', () => {
  for (const [iso, hours] of [
    ['PT7H30M', 7.5],
    ['P1D', 24],
    ['P1DT16H', 40],
    ['P5D', 120],
    ['P8DT8H', 200],
    ['P375D', 9000],
  ] as const) {
    assert.equal(durationToHours(iso), hours, iso);
  }
  assert.equal(hoursToDuration(120), 'PT120H');
  assert.equal(durationToHours(hoursToDuration(37.5)), 37.5);
});

await check('the budget planned to date is phased evenly from planned start to finish', () => {
  assert.deepEqual(plannedBudgetToDate(1000, '2026-10-10', '2026-10-19', TODAY), { planned: 0, share: 0 });
  assert.deepEqual(plannedBudgetToDate(1000, '2026-10-01', '2026-10-10', TODAY), { planned: 600, share: 0.6 });
  assert.deepEqual(plannedBudgetToDate(1000, '2026-09-01', '2026-09-30', TODAY), { planned: 1000, share: 1 });
  assert.deepEqual(plannedBudgetToDate(1000, null, '2026-09-30', TODAY), { planned: 1000, share: null });
  assert.equal(budgetVariancePct(700, 600, 1000), 10);
});

await check('reconciliation allows a share of the source, rounded up to whole rows', () => {
  assert.equal(allowedDifference(79, 0.5), 1);
  assert.equal(allowedDifference(1000, 0.5), 5);
  assert.equal(allowedDifference(0, 0.5), 0);
});

await check('buckets are ISO weeks or calendar months, clipped to the period', () => {
  assert.deepEqual(bucketsOf({ from: '2026-09-30', to: '2026-10-08' }, 'week'), [
    { from: '2026-09-30', to: '2026-10-04' },
    { from: '2026-10-05', to: '2026-10-08' },
  ]);
  assert.deepEqual(bucketsOf({ from: '2026-08-15', to: '2026-10-06' }, 'month'), [
    { from: '2026-08-15', to: '2026-08-31' },
    { from: '2026-09-01', to: '2026-09-30' },
    { from: '2026-10-01', to: '2026-10-06' },
  ]);
  assert.equal(Math.round(weeksIn(PERIOD) * 100) / 100, 4.29);
});

console.log('Scopes and visibility');

await check('the instance is the active projects the viewer can see: archived and hidden work are left out', async () => {
  const context = contextFor(shared, { kind: 'instance' }, PERIOD, TODAY);
  assert.deepEqual(context.projects.map((item) => item.id).sort(), [1, 2]);
  assert.equal(context.work.some((item) => item.projectId === 3 || item.projectId === 4), false);
});

await check('an archived project asked for by itself is measured', async () => {
  assert.deepEqual(await value(['work.open'], { kind: 'project', id: '3' }), { 'work.open': 1 });
});

await check('a team is its people’s work in visible projects', async () => {
  const context = contextFor(shared, { kind: 'team', id: 't2' }, PERIOD, TODAY);
  assert.deepEqual(context.work.map((item) => item.id).sort(), [20, 21]);
  assert.deepEqual(context.people.map((item) => item.id).sort(), [11, 12]);
});

console.log('Measures');

await check('work: open, overdue, due soon, progress', async () => {
  assert.deepEqual(await value(['work.open', 'work.overdue', 'work.dueSoon', 'work.progress']), {
    'work.open': 9, // 1-4, 9-12 and 20
    'work.overdue': 4, // 1, 9, 11 and 20 — not 2, which is due today
    'work.dueSoon': 2, // 2 (today) and 3 (in six days); 4 is seven days out
    'work.progress': 40, // 6 closed, the rejected one included, of 15
  });
});

await check('delivered in the period counts done work on its closing day, never rejected work', async () => {
  // 5 (30 Sep), 7 (29 Sep), 8 (22 Sep), 13 (28 Sep), 21 (2 Oct); 6 was rejected.
  assert.deepEqual(await value(['work.completed', 'work.throughput']), { 'work.completed': 5, 'work.throughput': 1.2 });
});

await check('milestones on time: met over decided; not-yet-due ones are left out', async () => {
  assert.deepEqual(await value(['milestones.onTime', 'milestones.missed']), {
    'milestones.onTime': 33.3, // 7 met; 8 and 9 missed; 10 pending
    'milestones.missed': 2,
  });
});

await check('risks: open, high and past their date, by the health rules’ selection', async () => {
  assert.deepEqual(await value(['risk.open', 'risk.high', 'risk.overdue']), { 'risk.open': 2, 'risk.high': 1, 'risk.overdue': 1 });
});

await check('health: counts by effective level, and the share green', async () => {
  assert.deepEqual(await value(['projects.active', 'health.green', 'health.amber', 'health.greenPct', 'projects.atRisk', 'schedule.slipping']), {
    'projects.active': 2,
    'health.green': 1,
    'health.amber': 1,
    'health.greenPct': 50,
    'projects.atRisk': 1,
    'schedule.slipping': 1,
  });
});

await check('cost and budget: actual at the rate, phased plan, variance and consumption', async () => {
  // Visible project time: 800 + uncosted 4h + 600 (August) = 1,400 actual.
  // Planned: project 1, 36 of 60 days of 10,000 = 6,000; project 2 has no plan, so all 5,000.
  assert.deepEqual(await value(['budget.total', 'cost.actual', 'cost.plannedToDate', 'cost.variance', 'budget.consumed', 'budget.variancePct']), {
    'budget.total': 15_000,
    'cost.actual': 1_400,
    'cost.plannedToDate': 11_000,
    'cost.variance': 9_600,
    'budget.consumed': 9.3,
    'budget.variancePct': -64,
  });
});

await check('utilisation: hours logged in the period over capacity for the period', async () => {
  // Team two: person 11 (20h a week) and 12 (40h): 60h × 30/7 weeks; 4h logged.
  assert.deepEqual(await value(['utilisation', 'capacity.weeklyHours', 'time.logged'], { kind: 'team', id: 't2' }), {
    utilisation: 1.6,
    'capacity.weeklyHours': 60,
    'time.logged': 4,
  });
});

await check('velocity over sprints ended in the period; progress of the sprint under way', async () => {
  // Sprint 7 ended on 4 Oct: 5 + 3 points delivered. Sprint 8 is under way and has no points.
  assert.deepEqual(await value(['sprint.velocity', 'sprint.progress']), { 'sprint.velocity': 8, 'sprint.progress': null });
});

await check('a measure has no value for a scope it means nothing for, and says so', async () => {
  const result = await evaluateInContext(['budget.total'], contextFor(shared, { kind: 'team', id: 't1' }, PERIOD, TODAY));
  assert.equal(result['budget.total']?.applicable, false);
  assert.equal(result['budget.total']?.value, null);
});

console.log('One number, wherever it is read (BR-404)');

await check('a portfolio’s figures on the portfolio-health dashboard equal the measures asked directly', async () => {
  const today = { from: TODAY, to: TODAY };
  const dashboard = await buildDashboard('portfolio-health', { kind: 'instance' }, today, shared.viewer, TODAY, shared);
  const row = dashboard.tables.find((table) => table.id === 'portfolios')!.rows.find((item) => item.key === 'portfolio:A')!;
  const direct = await evaluateInContext(
    ['projects.active', 'work.overdue', 'risk.high', 'budget.consumed'],
    contextFor(shared, { kind: 'portfolio', id: 'A' }, today, TODAY),
  );
  for (const id of ['projects.active', 'work.overdue', 'risk.high', 'budget.consumed']) {
    assert.equal(row.cells[id], direct[id]?.value, id);
  }
  // And the dashboard's own tile equals the instance measure.
  const instance = await evaluateInContext(['work.overdue'], contextFor(shared, { kind: 'instance' }, today, TODAY));
  assert.equal(dashboard.measures['work.overdue']?.value, instance['work.overdue']?.value);
  assert.equal(dashboard.timing.withinTarget, true);
});

await check('the risk dashboard and the portfolio-health dashboard agree on high risks', async () => {
  const today = { from: TODAY, to: TODAY };
  const [risk, portfolio] = await Promise.all([
    buildDashboard('risk', { kind: 'instance' }, today, shared.viewer, TODAY, shared),
    buildDashboard('portfolio-health', { kind: 'instance' }, today, shared.viewer, TODAY, shared),
  ]);
  assert.equal(risk.measures['risk.high']?.value, portfolio.measures['risk.high']?.value);
});

console.log('The replica’s files (BR-401)');

await check('the deploy file’s inline copies equal deploy/analytics', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const compose = readFileSync(`${root}docker-compose.deploy.yml`, 'utf8').replace(/\r\n/g, '\n');
  const inline = (name: string) => {
    const start = compose.indexOf(`  ${name}:\n    content: |\n`);
    assert.ok(start >= 0, `${name} is in docker-compose.deploy.yml`);
    const lines = compose.slice(start).split('\n').slice(2);
    const body: string[] = [];
    for (const line of lines) {
      if (line !== '' && !line.startsWith('      ')) break;
      body.push(line.slice(6));
    }
    return body.join('\n').replace(/\n*$/, '\n').replaceAll('$$', '$');
  };
  const file = (path: string) => readFileSync(`${root}${path}`, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(inline('epm_primary_hba'), file('deploy/analytics/primary-pg_hba.conf'));
  assert.equal(inline('epm_replica_entrypoint'), file('deploy/analytics/replica-entrypoint.sh'));
});

console.log(`\n${passed} passed`);
process.exit(0);
