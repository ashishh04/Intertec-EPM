import assert from 'node:assert/strict';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { runWithLanguage } from '../../lib/i18n.js';
import { withoutAmounts } from '../policy.js';
import { replayTurns, toMessage } from '../service.js';
import { GUARDRAIL, TOOLS, ToolError, chipLabel, findTool, toolAllowed, toolSchemas, type ToolAccess, type ToolContext } from '../tools.js';

/**
 * What Pragnya's settings promise, tool by tool, against a stub of EPM's API
 * that is full of money: with finance off nothing a tool returns carries any of
 * it, with finance on every amount carries its currency. Also a project named
 * rather than numbered, chips and refusals in the reader's language, stored ones
 * included, and what an earlier conversation looks like when it goes back to
 * the model.
 *
 * A new tool is run here without being asked: if it can carry money, give the
 * stub a route for it, with the sentinels below in it.
 *
 * Needs no stack: `npx tsx --env-file-if-exists=.env src/assistant/__checks__/guardrails.check.ts`.
 */

const BUDGET = 987654;
const SPENT = 123456;
const CLAIM = 543210;
const CURRENCY = 'AED';
const MONEY = /987,?654|123,?456|543,?210|AED/;

const project = {
  id: '15',
  identifier: 'falcon',
  name: 'Falcon',
  status: 'at_risk',
  health: { overall: 'warning' },
  healthCalculated: { overall: 'warning' },
  healthDetail: {
    explanation: 'Amber: budget variance is amber or red, carrying 40% of the weight assessed (amber from 40%).',
    criteria: [
      { criterion: 'schedule', level: 'healthy', value: 0, unit: 'days', reason: 'Open work is forecast to finish on the planned finish.' },
      { criterion: 'budget', level: 'warning', value: 12.5, unit: 'percent', reason: `Spent ${CURRENCY} ${SPENT.toLocaleString('en-US')} of the ${CURRENCY} ${BUDGET.toLocaleString('en-US')} budget.` },
    ],
  },
  // A person's reason is free text, so only the net can catch this one.
  healthOverride: { reason: `Client agreed ${CURRENCY} ${SPENT} extra`, setBy: '1', setAt: '2026-10-01' },
  progress: 40,
  ownerId: '1',
  startDate: '2026-01-01',
  dueDate: '2026-12-01',
  forecastFinish: '2026-12-02',
  taskCount: 3,
  completedTaskCount: 1,
  openRiskCount: 1,
  budgetUsed: SPENT,
  budgetTotal: BUDGET,
  description: 'A project.',
};

const forecast = {
  id: 'f1',
  projectId: 15,
  name: 'Falcon',
  probabilityOnTime: 0.8,
  plannedFinish: '2026-12-01',
  finish: { p10: '2026-11-20', p50: '2026-12-01', p90: '2026-12-10' },
  effort: { spentHours: 10, remainingP50: 5, remainingP80: 8, atCompletionP50: 15, atCompletionP80: 18 },
  cost: { spent: SPENT, atCompletionP50: SPENT, atCompletionP80: SPENT, budget: BUDGET, overrunP50: null, probabilityOverBudget: 0.5 },
  factors: [{ workPackageId: 81, subject: 'Install sensors', drivesFinish: 1, medianSlipDays: 0 }],
  trainedOn: { items: 7, withEstimates: 7 },
};

const recommendations = [
  {
    id: 'r1',
    title: `Set the budget of Falcon to ${BUDGET.toLocaleString('en-US')}`,
    rationale: `It is 60 % likely to pass its budget of ${BUDGET.toLocaleString('en-US')}.`,
    evidence: [{ kind: 'cost-entry', id: '9', label: 'Time on 1 Oct 2026', value: SPENT, link: '/tasks/81' }],
    expectedEffect: { summary: 'The budget reflects the cost the forecast expects.', before: 0.6, after: 0.1 },
    change: { entity: 'project-plan', id: '15', field: 'budgetTotal', from: BUDGET, to: SPENT },
  },
  {
    id: 'r2',
    title: 'Move the planned finish of Falcon to 10 Dec 2026',
    rationale: 'Its forecast gives 40 % for finishing by 1 Dec 2026.',
    evidence: [{ kind: 'forecast', id: 'f1', label: 'Forecast for Falcon', link: '/forecasts?project=15' }],
    expectedEffect: { summary: 'The plan becomes one the forecast expects to be met.', before: 0.4, after: 0.9 },
    change: { entity: 'project-plan', id: '15', field: 'plannedFinish', from: '2026-12-01', to: '2026-12-10' },
  },
];

/** What each API path answers. Paths the tools call as the person asking, nothing else. */
const API: Record<string, (query: URLSearchParams) => unknown> = {
  '/users': () => [{ id: '1', name: 'Ada', role: 'Developer', department: 'Delivery' }],
  '/projects': (query) => (!query.get('search') || 'falcon'.includes(query.get('search')!.toLowerCase()) ? [project] : []),
  '/projects/15': () => project,
  '/tasks': () => ({ total: 1, items: [{ id: '81', key: 'FALCON-81', subject: 'Install sensors', projectId: '15', status: { name: 'New' }, statusCategory: 'todo', priority: 'high', assigneeId: '1', dueDate: '2026-11-01', progress: 0, typeRef: { id: '2' } }] }),
  '/teams/workloads': () => [{ userId: '1', allocation: 50, assignedTasks: 2, hoursLogged: 3, hoursCapacity: 40 }],
  '/sprints': () => [{ id: '3', name: 'Sprint 3', goal: '', state: 'active', startDate: '2026-11-01', endDate: '2026-11-14', committedPoints: 5, completedPoints: 1, projectIds: ['15'] }],
  '/dashboard/metrics': () => {
    const flat = { direction: 'flat', changePct: 0, periodLabel: '' };
    return { myTasks: 1, myTasksDueThisWeek: 0, inProgress: 0, inProgressBlocked: 0, overdue: 0, overdueCritical: 0, activeProjects: 1, projectsAtRisk: 1, trends: { myTasks: flat, inProgress: flat, overdue: flat, activeProjects: flat } };
  },
  '/meetings': () => ({ total: 0, items: [] }),
  '/news': () => ({ total: 0, items: [] }),
  '/wiki/tree': () => [{ slug: 'rates', title: 'Rates', children: [] }],
  '/wiki/page': () => ({ body: `Day rate is ${CURRENCY} ${SPENT}.`, updatedByName: 'Ada' }),
  '/time-entries/report': (query) => ({
    from: query.get('from'),
    to: query.get('to'),
    groupBy: query.get('groupBy'),
    totalHours: 8,
    totalCost: SPENT,
    hoursWithoutRate: 1,
    currency: CURRENCY,
    truncated: false,
    rows: [{ label: 'Falcon', hours: 8, entries: 2, cost: SPENT, hoursWithoutRate: 1 }],
  }),
  '/timesheets/mine': () => ({ period: {}, status: 'draft', hours: 8, bounds: {}, problems: [], locked: false }),
  '/timesheets/overview': () => ({ period: {}, counts: {}, rows: [{ personName: 'Ada', status: 'draft', hours: 8 }] }),
  '/expenses': () => [{ id: 'c1', description: 'Taxi', amount: CLAIM, currency: CURRENCY, status: 'submitted', projectName: 'Falcon', spentOn: '2026-11-01' }],
  // An expense claim's approval carries its amount in the title.
  '/approvals/inbox': () => [{ title: `EXP-1 Travel, ${CLAIM}.00 ${CURRENCY}: Taxi`, projectName: 'Falcon', subjectType: 'expense-claim', requestedAt: '2026-11-01', link: '/expenses/c1' }],
  '/finance/cash-flow': () => ({ currency: CURRENCY, combined: { totals: { actual: SPENT }, points: [] }, reconciliation: {} }),
  '/finance/margin': () => ({ currency: CURRENCY, combined: { margin: SPENT }, projects: [] }),
  '/finance/forecast': () => ({ currency: CURRENCY, total: { revenue: SPENT }, combined: [] }),
  '/earned-value': () => ({ totals: { bac: BUDGET, ac: SPENT } }),
  '/resources/over-allocations': () => [{ name: 'Ada', week: '2026-W45', available: 40, committed: 50, excess: 10 }],
  '/scenarios': () => [{ id: 's1', name: 'Plan B', status: 'draft', capturedAt: '2026-11-01', projects: 2 }],
  '/catalog/types': () => [{ id: '9', name: 'Risk' }],
  '/forecasts': (query) => ({ run: {}, total: 1, forecasts: !query.get('projectId') || query.get('projectId') === '15' ? [forecast] : [] }),
  '/recommendations': () => ({ total: recommendations.length, items: recommendations }),
};

/** Every path a run asked for, with its query: how a check sees what a tool sent. */
const asked: string[] = [];

const app = {
  inject: async ({ url }: { url: string }) => {
    const parsed = new URL(url, 'http://stub');
    const path = parsed.pathname.replace(/^\/api/, '');
    asked.push(`${path}${parsed.search}`);
    const answer = API[path];
    if (!answer) {
      // A refusal the tool can read, as an unknown id would get.
      return { statusCode: 404, json: () => ({ message: `No route for ${path}.` }) };
    }
    return { statusCode: 200, json: () => answer(parsed.searchParams) };
  },
} as unknown as FastifyInstance;

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  app,
  request: { headers: { cookie: '' } } as unknown as FastifyRequest,
  userId: '1',
  role: 'admin',
  allowFinance: true,
  allowPeople: true,
  ...overrides,
});

const access = (overrides: Partial<ToolAccess> = {}): ToolAccess => ({ can: () => true, allowFinance: true, allowPeople: true, role: 'admin', ...overrides });

const SAMPLE: Record<string, Record<string, unknown>> = {
  get_project: { name: 'Falcon' },
  get_meeting: { id: 'm1' },
  time_summary: { from: '2026-11-01', to: '2026-11-07' },
  finance_figures: { kind: 'cash_flow' },
  search_wiki: { search: 'rates' },
};

/** A tool's result as the model reads it with finance off: through the net, as `runTool` sends it. */
async function resultWithFinanceOff(name: string, args: Record<string, unknown>) {
  const tool = findTool(name);
  assert.ok(tool, `tool ${name} exists`);
  return withoutAmounts(await tool.execute(context({ allowFinance: false }), args));
}

/* ------------------------------------------------------------- finance off */

const noFinance = access({ allowFinance: false });
const offered = new Set(toolSchemas(noFinance).map((tool) => tool.name));
for (const name of ['finance_figures', 'earned_value', 'budget_exposure']) {
  assert.ok(!offered.has(name), `finance off does not offer ${name}`);
  assert.equal(toolAllowed(findTool(name)!, noFinance), false, `finance off refuses ${name} when it runs`);
}

let ran = 0;
for (const tool of TOOLS.filter((candidate) => toolAllowed(candidate, noFinance))) {
  try {
    const result = await resultWithFinanceOff(tool.name, SAMPLE[tool.name] ?? {});
    const json = JSON.stringify(result);
    assert.ok(!MONEY.test(json), `${tool.name} carries money with finance off: ${json}`);
    assert.ok(!/"(budgetTotal|spentToDate|budget|spent|cost|totalCost|amount|currency|hoursWithoutRate)":/.test(json), `${tool.name} has a money field with finance off: ${json}`);
    ran += 1;
  } catch (error) {
    // A meeting the stub does not have. Everything else has to run, or it proves nothing.
    assert.ok(error instanceof ToolError && tool.name === 'get_meeting', `${tool.name} failed: ${String(error)}`);
  }
}
console.log(`ok  finance off: no money in the results of ${ran} tools, three not offered`);

// What is left is still an answer.
const projectOff = (await resultWithFinanceOff('get_project', { name: 'Falcon' })) as { healthCriteria: { criterion: string }[]; health: string };
assert.deepEqual(projectOff.healthCriteria.map((row) => row.criterion), ['schedule'], 'the budget criterion goes, the others stay');
assert.equal(projectOff.health, 'warning');
const forecastOff = (await resultWithFinanceOff('delivery_forecast', {})) as { forecasts: Record<string, unknown>[] };
assert.equal(forecastOff.forecasts[0]?.probabilityOnTime, 0.8, 'the forecast still answers the delivery question');
assert.ok(!('cost' in forecastOff.forecasts[0]!), 'cost at completion is gone');
const actionsOff = (await resultWithFinanceOff('recommended_actions', {})) as { waiting: number; recommendations: { id: string }[] };
assert.deepEqual(actionsOff.recommendations.map((row) => row.id), ['r2'], 'a recommendation about money goes altogether');
assert.equal(actionsOff.waiting, 1, 'and is not counted as waiting');
const claimsOff = (await resultWithFinanceOff('expense_claims', {})) as { description: string; status: string }[];
assert.equal(claimsOff[0]?.status, 'submitted', 'a claim keeps its status');
const timeOff = (await resultWithFinanceOff('time_summary', SAMPLE.time_summary!)) as { costHidden: boolean; totalHours: number };
assert.equal(timeOff.costHidden, true, 'the model is told the money was taken out');
assert.equal(timeOff.totalHours, 8, 'the hours stay');
console.log('ok  finance off: each still answers what it can');

// Budget and spend are for the roles that work with money, the switch or not.
for (const role of ['hr', 'employee'] as const) {
  const seen = JSON.stringify(await findTool('get_project')!.execute(context({ role }), { name: 'Falcon' }));
  assert.ok(!/budgetTotal|spentToDate|Spent AED/.test(seen), `${role} is not given a project's money: ${seen}`);
}
console.log('ok  a project\'s money is for the roles that work with it');

/* ------------------------------------------------------- the net for free text */

for (const [text, expected] of [
  ['Travel, 120.00 AED: Taxi', 'Travel, [amount hidden]: Taxi'],
  ['Budget: AED 12,000.', 'Budget: [amount hidden].'],
  ['It cost $12,000 in all', 'It cost [amount hidden] in all'],
  ['USD12000', '[amount hidden]'],
  ['Saved $12k this year', 'Saved [amount hidden] this year'],
  ['بلغت 12,000 درهم فقط', 'بلغت [amount hidden] فقط'],
  ['ISO 9001, Sprint 14, WP-14 on 2026-11-06', 'ISO 9001, Sprint 14, WP-14 on 2026-11-06'],
  ['TOP 10 risks and all 5 tasks in CAD 3D', 'TOP 10 risks and all 5 tasks in CAD 3D'],
] as const) {
  assert.equal(withoutAmounts(text), expected);
}
assert.deepEqual(withoutAmounts({ a: ['AED 5'], b: { c: 1, d: null } }), { a: ['[amount hidden]'], b: { c: 1, d: null } }, 'it walks a whole result');
console.log('ok  amounts in text are masked, and what only looks like one is not');

/* -------------------------------------------------------------- currency */

const withFinance = context();
const currencyOf = async (name: string, args: Record<string, unknown> = {}) => (await findTool(name)!.execute(withFinance, args)) as Record<string, unknown>;

assert.equal((await currencyOf('get_project', { name: 'Falcon' })).currency, CURRENCY, 'get_project');
assert.equal(((await currencyOf('list_projects')) as unknown as Record<string, unknown>[])[0]?.currency, CURRENCY, 'list_projects');
assert.equal(((await currencyOf('delivery_forecast')).forecasts as { cost: { currency: string } }[])[0]?.cost.currency, CURRENCY, 'delivery_forecast');
assert.equal((await currencyOf('budget_exposure')).currency, CURRENCY, 'budget_exposure');
assert.equal((await currencyOf('earned_value')).currency, CURRENCY, 'earned_value');
assert.equal((await currencyOf('recommended_actions')).currency, CURRENCY, 'recommended_actions');
assert.equal((await currencyOf('time_summary', SAMPLE.time_summary!)).currency, CURRENCY, 'time_summary');
assert.equal(((await currencyOf('expense_claims')) as unknown as Record<string, unknown>[])[0]?.currency, CURRENCY, 'expense_claims');
assert.equal((await currencyOf('finance_figures', { kind: 'margin' })).currency, CURRENCY, 'finance_figures');
console.log('ok  every amount that goes back carries its currency');

/* ----------------------------------------------------- a project by its name */

for (const [name, args] of [
  ['delivery_forecast', {}],
  ['recommended_actions', {}],
  ['risk_exposure', {}],
  ['budget_exposure', {}],
  ['earned_value', {}],
  ['finance_figures', { kind: 'cash_flow' }],
  ['time_summary', SAMPLE.time_summary!],
  ['list_tasks', {}],
  ['list_meetings', {}],
  ['list_news', {}],
  ['search_wiki', {}],
] as const) {
  for (const reference of ['Falcon', 'Project Falcon', 'the falcon project', 'falcon', '15']) {
    asked.length = 0;
    await findTool(name)!.execute(context(), { ...args, projectId: reference });
    const sent = asked.filter((path) => !path.startsWith('/projects') && !path.startsWith('/users'));
    assert.ok(sent.some((path) => /[?&]projectId=15\b/.test(path) || path.includes('scope=project%3A15')) || name === 'budget_exposure', `${name} with “${reference}” asked for the project by id: ${sent.join(' ')}`);
  }
  await assert.rejects(findTool(name)!.execute(context(), { ...args, projectId: 'Osprey' }), ToolError, `${name} with an unknown name`);
}
const budgetOf = (await findTool('budget_exposure')!.execute(context(), { projectId: 'Project Falcon' })) as { projectsWithBudget: number };
assert.equal(budgetOf.projectsWithBudget, 1, 'budget_exposure narrows to the project named');
const projectByName = (await findTool('get_project')!.execute(context(), { name: 'Project Falcon' })) as { id: string };
assert.equal(projectByName.id, '15', 'get_project takes “Project Falcon” for a project called Falcon');
const nameAsId = (await findTool('get_project')!.execute(context(), { projectId: 'Falcon' })) as { id: string };
assert.equal(nameAsId.id, '15', 'and a name sent as its id');
assert.equal(chipLabel('get_project', { projectId: 'Falcon' }), 'Checked Falcon project health');
assert.equal(chipLabel('get_project', { projectId: '15' }), 'Checked project #15 health');
console.log('ok  every tool that takes a project takes its name, and an unknown one is a failure it can read');

/* --------------------------------------------------- "me", and the workload switch */

asked.length = 0;
await findTool('time_summary')!.execute(context({ userId: '42' }), { ...SAMPLE.time_summary, userId: 'me' });
assert.ok(asked.some((path) => path.includes('userId=42')), `“me” is the person asking: ${asked.join(' ')}`);
asked.length = 0;
await findTool('list_meetings')!.execute(context({ userId: '42' }), { participantId: 'me' });
assert.ok(asked.some((path) => path.includes('participantId=42')), `“me” is the person asking: ${asked.join(' ')}`);

const noPeople = context({ allowPeople: false });
await assert.rejects(findTool('time_summary')!.execute(noPeople, { ...SAMPLE.time_summary, groupBy: 'user' }), ToolError, 'hours per person are workload');
await assert.rejects(findTool('time_summary')!.execute(noPeople, { ...SAMPLE.time_summary, userId: '9' }), ToolError, "another person's hours are workload");
await findTool('time_summary')!.execute(noPeople, SAMPLE.time_summary!);
await findTool('time_summary')!.execute(noPeople, { ...SAMPLE.time_summary, userId: 'me' });
console.log('ok  “me” means the asker, and the workload switch covers hours per person');

/* --------------------------------------------------------- chips and refusals */

for (const [name, args, english] of [
  ['list_tasks', { bucket: 'overdue', assignee: 'me' }, 'Looked up my overdue tasks'],
  ['list_tasks', { search: 'Install sensors' }, 'Looked up tasks matching “Install sensors”'],
  ['get_project', { name: 'Falcon' }, 'Checked Falcon project health'],
  ['list_projects', {}, 'Listed projects'],
  ['team_workload', {}, 'Checked everyone’s workload'],
  ['team_workload', { teamId: '1' }, 'Checked the team workload'],
  ['get_sprint', {}, 'Looked at the current sprint'],
  ['dashboard_metrics', {}, 'Read the dashboard metrics'],
  ['list_meetings', {}, 'Looked up upcoming meetings'],
  ['list_news', {}, 'Looked up announcements'],
  ['search_wiki', { search: 'onboarding' }, 'Searched the wiki for “onboarding”'],
  ['time_summary', { from: '2026-11-02', to: '2026-11-08' }, 'Summed logged time 2 Nov 2026 to 8 Nov 2026 by project'],
  ['my_timesheet', {}, 'Looked up your timesheet'],
  ['team_timesheets', {}, 'Looked up timesheets'],
  ['expense_claims', {}, 'Looked up your expense claims'],
  ['approvals_waiting', {}, 'Looked up approvals waiting for you'],
  ['finance_figures', { kind: 'cash_flow' }, 'Looked up cash flow'],
  ['earned_value', {}, 'Looked up earned value'],
  ['resource_overload', {}, 'Looked up over-allocation'],
  ['budget_exposure', {}, 'Analysed budget exposure'],
  ['risk_exposure', {}, 'Analysed risk exposure'],
  ['delivery_forecast', {}, 'Looked up the delivery forecasts'],
  ['recommended_actions', {}, 'Looked up recommended actions'],
  ['no_such_tool', {}, 'Tried no_such_tool'],
  [GUARDRAIL, {}, 'Declined by your organisation’s settings'],
] as const) {
  assert.equal(chipLabel(name, args), english, `${name} in English`);
}

// Every label is written out in Arabic: nothing in it is left to the English.
for (const tool of TOOLS) {
  const label = runWithLanguage('ar', () => chipLabel(tool.name, SAMPLE[tool.name] ?? {}));
  assert.ok(/[؀-ۿ]/.test(label), `${tool.name} chip in Arabic: ${label}`);
}

const stored = {
  id: 'm1',
  conversationId: 'c1',
  createdAt: new Date('2026-11-01T00:00:00Z'),
};
// A chip stored by an earlier version: its label in English, its call beside it.
const earlierChip = { id: 'toolu_1', name: 'list_tasks', label: 'Looked up my overdue tasks', arguments: { bucket: 'overdue', assignee: 'me' }, status: 'done' };
const answer = { ...stored, role: 'assistant', content: 'لا توجد مهام متأخرة', toolCalls: [earlierChip] };
assert.equal(toMessage(answer).toolCalls[0]?.label, 'Looked up my overdue tasks');
const inArabic = runWithLanguage('ar', () => toMessage(answer));
assert.ok(/[؀-ۿ]/.test(inArabic.toolCalls[0]!.label), `a stored chip follows the reader: ${inArabic.toolCalls[0]!.label}`);
assert.equal(inArabic.content, answer.content, 'the answer itself stays as written');

const refusal = { template: 'That is a topic your organisation has asked me not to discuss. Please speak to your manager or administrator.' };
const english = refusal.template;
const refused = { ...stored, role: 'assistant', content: english, toolCalls: [{ id: GUARDRAIL, name: GUARDRAIL, label: '', arguments: { refusal }, status: 'done' }] };
assert.equal(toMessage(refused).content, english);
assert.equal(toMessage(refused).toolCalls[0]?.label, 'Declined by your organisation’s settings');
assert.deepEqual(toMessage(refused).toolCalls[0]?.arguments, {}, 'the message behind a refusal does not leave the server');
assert.ok(/[؀-ۿ]/.test(runWithLanguage('ar', () => toMessage(refused)).content), 'a refusal follows the reader');
// Stored before refusals kept their message: a fixed phrase, so still translated.
const earlierRefusal = { ...refused, toolCalls: [{ id: GUARDRAIL, name: GUARDRAIL, label: 'Declined by your organisation’s settings', arguments: {}, status: 'done' }] };
const earlierInArabic = runWithLanguage('ar', () => toMessage(earlierRefusal));
assert.ok(/[؀-ۿ]/.test(earlierInArabic.content), 'an earlier refusal follows the reader');
assert.ok(/[؀-ۿ]/.test(earlierInArabic.toolCalls[0]!.label), 'and its chip');
console.log('ok  chips and refusals follow the reader, stored ones included');

/* ------------------------------------------------------ an earlier conversation */

const offeredNow = new Set(['list_tasks', 'my_timesheet']);
const row = (id: string, role: string, content: string, toolCalls: unknown = null) => ({ id, role, content, toolCalls: toolCalls as never });
const call = (name: string, status = 'done') => ({ id: 'toolu', name, label: '', arguments: { bucket: 'overdue' }, status });

const replayed = replayTurns(
  [
    // The window opened mid-exchange.
    row('a0', 'assistant', 'An answer with no question before it.', [call('list_tasks')]),
    row('u1', 'user', 'What is overdue?'),
    row('a1', 'assistant', 'Nothing is overdue.', [call('list_tasks'), call('finance_figures'), call('my_timesheet', 'failed')]),
    row('u2', 'user', 'And the budget?'),
    row('a2', 'assistant', 'Budget: AED 12,000.', []),
    row('u3', 'user', 'Stopped before any text.'),
    row('a3', 'assistant', '', [call('list_tasks')]),
    row('u4', 'user', 'A question nobody answered.'),
    row('a4', 'assistant', 'That is a topic your organisation has asked me not to discuss.', [{ id: GUARDRAIL, name: GUARDRAIL, label: '', arguments: {}, status: 'done' }]),
    row('a5', 'assistant', '   ', []),
  ],
  offeredNow,
  false,
);
const roles = replayed.map((message) => message.role).join(' ');
assert.equal(roles, 'user assistant user assistant user assistant user assistant user user assistant', `the shape of the replay: ${roles}`);
const uses = replayed[1]!.content as { type: string; id: string; name: string; input: unknown }[];
assert.deepEqual(uses.map((use) => use.name), ['list_tasks', 'my_timesheet'], 'only tools offered now are shown');
assert.deepEqual(uses[0]!.input, { bucket: 'overdue' }, 'with what they were asked');
assert.notEqual(uses[0]!.id, uses[1]!.id, 'each call has an id of its own');
assert.ok(uses.every((use) => /^[a-zA-Z0-9_-]+$/.test(use.id)), 'in the form the API takes');
const results = replayed[2]!.content as { type: string; tool_use_id: string; content: string; is_error: boolean }[];
assert.deepEqual(results.map((result) => result.tool_use_id), uses.map((use) => use.id), 'each result answers its call');
assert.deepEqual(results.map((result) => result.is_error), [false, true], 'a failed lookup is shown as one');
assert.ok(results.every((result) => /Look it up again/.test(result.content)), 'and no result comes back, only that it is gone');
assert.equal(replayed[3]!.content, 'Nothing is overdue.');
assert.ok(JSON.stringify(replayed).includes('Budget: [amount hidden].'), 'with finance off, an earlier amount does not come back');
assert.ok(!JSON.stringify(replayed).includes('12,000'), 'at all');
assert.ok(!JSON.stringify(replayed).includes(GUARDRAIL), 'a refusal is its words, not a lookup');
assert.ok(JSON.stringify(replayTurns([row('u', 'user', 'Q'), row('a', 'assistant', 'Budget: AED 12,000.')], offeredNow, true)).includes('AED 12,000'), 'with finance on it does');
assert.deepEqual(replayTurns([row('a', 'assistant', 'No question.')], offeredNow, true), [], 'nothing but an answer is nothing');
console.log('ok  an earlier conversation goes back with its lookups, without their results');

console.log('guardrails check passed');
process.exit(0);
