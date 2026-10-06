import assert from 'node:assert/strict';

import { levelFor } from '../escalation.js';
import { endpointProblem, isPrivateAddress } from '../../lib/outbound.js';
import { conditionHolds, renderTemplate, resolveDate, ruleMatches, validateRule, type RuleFacts } from '../rule-model.js';
import type { RuleCondition } from '../../types/epm.js';

/**
 * Worked examples for rules and escalation (BR-216 to BR-219): what a rule may
 * say, whether an item matches it, the text it writes, the addresses it may
 * call, and which escalation level an item has reached. Needs no instance.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/rules.check.ts
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

const NOW = new Date('2026-10-06T12:00:00Z');

const item = (values: RuleFacts['values'] = {}, customFields: RuleFacts['customFields'] = {}): RuleFacts => ({
  subjectType: 'work_package',
  id: '12',
  projectId: '7',
  values: {
    type: '7',
    status: '1',
    status_category: 'open',
    priority: '9',
    project: '7',
    assignee: '35',
    subject: 'Export fails on large reports',
    dueDate: '2026-10-03',
    updatedAt: '2026-09-30T08:00:00Z',
    createdAt: '2026-09-01T08:00:00Z',
    estimatedHours: 6,
    ...values,
  },
  customFields: { customField3: { number: 75_000, texts: ['75000'] }, ...customFields },
});

const holds = (condition: RuleCondition, facts = item()) => conditionHolds(condition, facts, NOW);

const bugAndHigh = {
  match: 'all' as const,
  conditions: [
    { field: 'type', operator: 'in' as const, value: ['7'] },
    { field: 'priority', operator: 'in' as const, value: ['9', '10'] },
  ],
};

console.log('Matching (BR-216)');
check('a bug at high priority matches a type-and-priority rule', () => assert.equal(ruleMatches(bugAndHigh, item(), NOW), true));
check('a task at high priority does not', () => assert.equal(ruleMatches(bugAndHigh, item({ type: '1' }), NOW), false));
check('a bug at normal priority does not', () => assert.equal(ruleMatches(bugAndHigh, item({ priority: '8' }), NOW), false));
check('"any" needs only one condition', () =>
  assert.equal(ruleMatches({ ...bugAndHigh, match: 'any' }, item({ priority: '8' }), NOW), true));
check('no conditions: every item in scope matches', () => assert.equal(ruleMatches({ match: 'all', conditions: [] }, item(), NOW), true));
check('not in', () => assert.equal(holds({ field: 'type', operator: 'not_in', value: ['1', '2'] }), true));
check('an unassigned item is "assignee is empty"', () =>
  assert.equal(holds({ field: 'assignee', operator: 'is_empty' }, item({ assignee: undefined })), true));
check('and not "assignee is set"', () =>
  assert.equal(holds({ field: 'assignee', operator: 'is_set' }, item({ assignee: undefined })), false));
check('"not in" holds for an empty field', () =>
  assert.equal(holds({ field: 'assignee', operator: 'not_in', value: ['35'] }, item({ assignee: undefined })), true));
check('subject contains, regardless of case', () => assert.equal(holds({ field: 'subject', operator: 'contains', value: 'EXPORT' }), true));
check('open or closed', () => assert.equal(holds({ field: 'status_category', operator: 'eq', value: 'open' }), true));
check('a number', () => assert.equal(holds({ field: 'estimatedHours', operator: 'gt', value: 4 }), true));
check('a custom field as a number', () => assert.equal(holds({ field: 'customField3', operator: 'gte', value: 50_000 }), true));
check('a custom field as text', () =>
  assert.equal(holds({ field: 'customField5', operator: 'eq', value: 'infrastructure' }, item({}, { customField5: { texts: ['Infrastructure'] } })), true));
check('a missing custom field is empty', () => assert.equal(holds({ field: 'customField9', operator: 'is_empty' }), true));

console.log('\nDates');
check('due before today is overdue', () => assert.equal(holds({ field: 'dueDate', operator: 'before_today' }), true));
check('due within the next three days', () =>
  assert.equal(holds({ field: 'dueDate', operator: 'within_next_days', value: 3 }, item({ dueDate: '2026-10-08' })), true));
check('but not four days out', () =>
  assert.equal(holds({ field: 'dueDate', operator: 'within_next_days', value: 3 }, item({ dueDate: '2026-10-10' })), false));
check('updated more than five days ago, to the hour', () =>
  assert.equal(holds({ field: 'updatedAt', operator: 'more_than_days_ago', value: 5 }), true));
check('not more than seven', () => assert.equal(holds({ field: 'updatedAt', operator: 'more_than_days_ago', value: 7 }), false));
check('on or before a fixed date', () => assert.equal(holds({ field: 'dueDate', operator: 'on_or_before', value: '2026-10-03' }), true));
check('an empty date matches no date test', () =>
  assert.equal(holds({ field: 'dueDate', operator: 'before_today' }, item({ dueDate: undefined })), false));

console.log('\nWhat a rule may say');
const valid = {
  name: 'Escalate high bugs',
  subjectType: 'work_package',
  events: ['work_package.created', 'work_package.updated'],
  conditions: bugAndHigh,
  actions: [
    { type: 'assign', to: { kind: 'user', userId: '35' } },
    { type: 'notify', recipients: [{ kind: 'assignee' }], title: 'High bug: {{key}}', message: '{{subject}}' },
    { type: 'set_status', statusId: '7' },
    { type: 'set_field', field: 'dueDate', value: { relativeDays: 2 } },
    { type: 'create_work_package', typeId: '1', subject: 'Follow up {{key}}', relation: 'relates' },
    { type: 'call_endpoint', url: 'https://hooks.example.com/epm' },
  ],
};
const refuses = (input: unknown, pattern: RegExp) => {
  const result = validateRule(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.problem, pattern);
};
check('every action type in one rule', () => assert.equal(validateRule(valid).ok, true));
check('defaults: on, every project, as items start to match', () => {
  const result = validateRule(valid);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.rule.active, true);
    assert.deepEqual(result.rule.projectIds, []);
    assert.equal(result.rule.fireMode, 'enter');
  }
});
check('a rule needs an action', () => refuses({ ...valid, actions: [] }, /at least one action/));
check('an event of the wrong kind', () => refuses({ ...valid, events: ['project.updated'] }, /not an event/));
check('a field a work package does not have', () =>
  refuses({ ...valid, conditions: { match: 'all', conditions: [{ field: 'colour', operator: 'eq', value: 'red' }] } }, /not something/));
check('an operator the field does not take', () =>
  refuses({ ...valid, conditions: { match: 'all', conditions: [{ field: 'type', operator: 'gt', value: 3 }] } }, /does not apply/));
check('type is compared by id', () =>
  refuses({ ...valid, conditions: { match: 'all', conditions: [{ field: 'type', operator: 'in', value: ['Bug'] }] } }, /by id/));
check('"in" needs values', () =>
  refuses({ ...valid, conditions: { match: 'all', conditions: [{ field: 'type', operator: 'in', value: [] }] } }, /at least one value/));
check('a field a rule cannot set', () => refuses({ ...valid, actions: [{ type: 'set_field', field: 'subject', value: 'x' }] }, /cannot set/));
check('a percentage stays in range', () =>
  refuses({ ...valid, actions: [{ type: 'set_field', field: 'percentageDone', value: 140 }] }, /0 to 100/));
check('assign to one person, not a role', () =>
  refuses({ ...valid, actions: [{ type: 'assign', to: { kind: 'project_role', roleId: '3' } }] }, /one person/));
check('"the approvers" is for approval escalation only', () =>
  refuses({ ...valid, actions: [{ type: 'notify', recipients: [{ kind: 'approvers' }], title: 't', message: 'm' }] }, /approval/));
check('a project rule cannot assign', () =>
  refuses(
    { ...valid, subjectType: 'project', events: ['project.health_changed'], conditions: { match: 'all', conditions: [] }, actions: [valid.actions[0]] },
    /cannot assign/,
  ));
check('a project has no assignee to notify', () =>
  refuses(
    { ...valid, subjectType: 'project', events: ['project.updated'], conditions: { match: 'all', conditions: [] }, actions: [valid.actions[1]] },
    /no assignee/,
  ));
check('a project rule may test health', () =>
  assert.equal(
    validateRule({
      ...valid,
      subjectType: 'project',
      events: ['project.health_changed'],
      conditions: { match: 'all', conditions: [{ field: 'health', operator: 'in', value: ['critical'] }] },
      actions: [{ type: 'notify', recipients: [{ kind: 'project_owner' }], title: '{{project}} is {{health}}', message: 'Look.' }],
    }).ok,
    true,
  ));

console.log('\nText and dates a rule writes');
check('placeholders are filled', () =>
  assert.equal(renderTemplate('High bug {{key}}: {{ subject }}', { key: 'APP-12', subject: 'Export' }), 'High bug APP-12: Export'));
check('an unknown placeholder renders empty, not as itself', () => assert.equal(renderTemplate('A{{nope}}B', {}), 'AB'));
check('two days from today', () => assert.equal(resolveDate({ relativeDays: 2 }, item(), NOW), '2026-10-08'));
check('a week after the due date', () => assert.equal(resolveDate({ relativeDays: 7, from: 'dueDate' }, item(), NOW), '2026-10-10'));
check('from an empty date: nothing to set', () =>
  assert.equal(resolveDate({ relativeDays: 1, from: 'startDate' }, item(), NOW), undefined));
check('null clears', () => assert.equal(resolveDate(null, item(), NOW), null));

console.log('\nAddresses a rule may call');
check('a public https endpoint', () => assert.equal(endpointProblem('https://hooks.example.com/epm'), undefined));
check('plain http is refused', () => assert.match(endpointProblem('http://hooks.example.com/epm') ?? '', /https/));
check('localhost is refused', () => assert.match(endpointProblem('https://localhost/x') ?? '', /inside the network/));
check('the metadata address is refused', () => assert.match(endpointProblem('https://169.254.169.254/latest') ?? '', /inside/));
check('a private address is refused', () => assert.match(endpointProblem('https://10.1.2.3/hook') ?? '', /inside/));
check('credentials in the URL are refused', () => assert.match(endpointProblem('https://user:pw@hooks.example.com/') ?? '', /credentials/i));
check('private and loopback ranges', () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.63', '169.254.0.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});
check('public addresses', () => {
  for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

console.log('\nEscalation levels (BR-218)');
const levels = [
  { after: 3, notify: [{ kind: 'assignee' as const }] },
  { after: 5, notify: [{ kind: 'team_lead' as const }] },
  { after: 8, notify: [{ kind: 'department_manager' as const }] },
];
check('before the first threshold: no level', () => assert.equal(levelFor(levels, 2.9), 0));
check('at the first threshold: level one', () => assert.equal(levelFor(levels, 3), 1));
check('between: the level reached', () => assert.equal(levelFor(levels, 6.5), 2));
check('past the last: the top level', () => assert.equal(levelFor(levels, 30), 3));

console.log(`\n${passed} passed`);
