import assert from 'node:assert/strict';

import {
  conditionHolds,
  describeCondition,
  parseChain,
  pickChain,
  type SubjectFacts,
} from '../approval-chains.js';
import type { ApprovalChain } from '../../types/epm.js';

/**
 * Worked examples for approval chains (BR-211): conditions, matching a subject
 * to its chain, and what a chain may not be. Needs no instance.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/approvals.check.ts
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

const facts = (overrides: Partial<SubjectFacts> = {}): SubjectFacts => ({
  projectId: '7',
  typeId: '41',
  priorityId: '9',
  portfolioId: 'pf1',
  value: 75_000,
  customFields: {
    customField3: { number: 75_000, texts: ['75000'] },
    customField5: { texts: ['Infrastructure'] },
    customField6: { texts: ['Alpha', 'Beta'] },
  },
  ...overrides,
});

console.log('Value thresholds');
check('above the threshold passes', () => assert.equal(conditionHolds({ field: 'value', operator: 'gt', value: 50_000 }, facts()), true));
check('below it does not', () => assert.equal(conditionHolds({ field: 'value', operator: 'gt', value: 50_000 }, facts({ value: 20_000 })), false));
check('exactly on it is not above it', () => assert.equal(conditionHolds({ field: 'value', operator: 'gt', value: 75_000 }, facts()), false));
check('but is at least it', () => assert.equal(conditionHolds({ field: 'value', operator: 'gte', value: 75_000 }, facts()), true));
check('below and at most work the other way', () => {
  assert.equal(conditionHolds({ field: 'value', operator: 'lt', value: 80_000 }, facts()), true);
  assert.equal(conditionHolds({ field: 'value', operator: 'lte', value: 74_999 }, facts()), false);
});
check('an unset value passes no threshold either way', () => {
  assert.equal(conditionHolds({ field: 'value', operator: 'gt', value: 0 }, facts({ value: null })), false);
  assert.equal(conditionHolds({ field: 'value', operator: 'lt', value: 1e9 }, facts({ value: null })), false);
});
check('no condition always applies', () => assert.equal(conditionHolds(undefined, facts()), true));

console.log('\nType, priority, project, portfolio');
check('type is', () => assert.equal(conditionHolds({ field: 'type', operator: 'eq', value: '41' }, facts()), true));
check('type is not', () => assert.equal(conditionHolds({ field: 'type', operator: 'neq', value: '41' }, facts()), false));
check('priority is one of', () => assert.equal(conditionHolds({ field: 'priority', operator: 'in', value: ['9', '10'] }, facts()), true));
check('priority is none of', () => assert.equal(conditionHolds({ field: 'priority', operator: 'not_in', value: ['9', '10'] }, facts()), false));
check('project is one of', () => assert.equal(conditionHolds({ field: 'project', operator: 'in', value: ['7'] }, facts()), true));
check('portfolio is', () => assert.equal(conditionHolds({ field: 'portfolio', operator: 'eq', value: 'pf1' }, facts()), true));
check('no portfolio is not in any list', () =>
  assert.equal(conditionHolds({ field: 'portfolio', operator: 'in', value: ['pf1'] }, facts({ portfolioId: undefined })), false));

console.log('\nCustom fields');
check('a numeric field compares as a number', () =>
  assert.equal(conditionHolds({ field: 'customField3', operator: 'gte', value: 75_000 }, facts()), true));
check('and equals across representations', () =>
  assert.equal(conditionHolds({ field: 'customField3', operator: 'eq', value: '75000.0' }, facts()), true));
check('a text field compares without regard to case', () =>
  assert.equal(conditionHolds({ field: 'customField5', operator: 'eq', value: 'infrastructure' }, facts()), true));
check('a multi-value field matches any of its values', () =>
  assert.equal(conditionHolds({ field: 'customField6', operator: 'in', value: ['beta', 'gamma'] }, facts()), true));
check('a field that is not set matches nothing, and "is not" holds', () => {
  assert.equal(conditionHolds({ field: 'customField9', operator: 'eq', value: 'x' }, facts()), false);
  assert.equal(conditionHolds({ field: 'customField9', operator: 'neq', value: 'x' }, facts()), true);
});

console.log('\nDescribing a condition');
check('reads as a sentence with the value label', () =>
  assert.equal(describeCondition({ field: 'value', operator: 'gt', value: 50_000 }, { valueLabel: 'Change value' }), 'Change value is above 50,000'));
check('names ids where it can', () =>
  assert.equal(
    describeCondition({ field: 'type', operator: 'in', value: ['41', '7'] }, { value: (_f, v) => ({ '41': 'Change Request', '7': 'Bug' })[v] }),
    'Type is one of Change Request, Bug',
  ));

console.log('\nWhich chain governs a subject');
const chain = (id: string, typeIds: string[], projectIds: string[], updatedAt = '2026-10-01T00:00:00Z', active = true): ApprovalChain => ({
  id,
  name: id,
  subjectType: 'work_package',
  typeIds,
  projectIds,
  steps: [],
  allowSelfApproval: false,
  active,
  createdBy: '4',
  createdAt: updatedAt,
  updatedAt,
  requestCount: 0,
});
const chains = [
  chain('everything', [], []),
  chain('change-requests', ['41'], []),
  chain('change-requests-in-7', ['41'], ['7']),
  chain('retired', ['41'], ['7'], '2026-10-05T00:00:00Z', false),
];
check('the most specific active chain wins', () => assert.equal(pickChain(chains, { typeId: '41', projectId: '7' })?.id, 'change-requests-in-7'));
check('a retired chain never matches', () => assert.notEqual(pickChain(chains, { typeId: '41', projectId: '7' })?.id, 'retired'));
check('a type chain beats a catch-all', () => assert.equal(pickChain(chains, { typeId: '41', projectId: '8' })?.id, 'change-requests'));
check('the catch-all takes what nothing else does', () => assert.equal(pickChain(chains, { typeId: '1', projectId: '8' })?.id, 'everything'));
check('with only specific chains, an unmatched subject has none', () =>
  assert.equal(pickChain(chains.slice(1), { typeId: '1', projectId: '8' }), undefined));
check('a tie goes to the most recently changed', () =>
  assert.equal(
    pickChain([chain('older', ['41'], [], '2026-09-01T00:00:00Z'), chain('newer', ['41'], [], '2026-10-02T00:00:00Z')], {
      typeId: '41',
      projectId: '8',
    })?.id,
    'newer',
  ));

console.log('\nWhat a chain may not be');
const valid = {
  name: 'Change control',
  typeIds: ['41'],
  valueField: 'customField3',
  steps: [
    { id: 'owner', name: 'Project owner', approvers: [{ kind: 'project_owner' }], mode: 'any' },
    {
      id: 'sponsor',
      name: 'Sponsor',
      approvers: [{ kind: 'user', userId: '4' }],
      mode: 'all',
      condition: { field: 'value', operator: 'gt', value: 50_000 },
      slaHours: 48,
    },
  ],
};
const refuses = (input: unknown, pattern: RegExp) => {
  try {
    parseChain(input);
  } catch (error) {
    assert.match((error as Error).message, pattern);
    return;
  }
  assert.fail('expected the chain to be refused');
};
check('the worked example is valid', () => assert.equal(parseChain(valid).steps.length, 2));
check('a step needs an approver', () =>
  refuses({ ...valid, steps: [{ ...valid.steps[0], approvers: [] }] }, /at least one approver/));
check('a value condition needs a value field', () => refuses({ ...valid, valueField: undefined }, /needs a value field/));
check('a threshold compares with a number', () =>
  refuses({ ...valid, steps: [{ ...valid.steps[1], condition: { field: 'value', operator: 'gt', value: 'lots' } }] }, /compares with a number/));
check('"is one of" needs a list', () =>
  refuses({ ...valid, steps: [{ ...valid.steps[0], condition: { field: 'type', operator: 'in', value: '41' } }] }, /needs a list/));
check('a type condition compares ids', () =>
  refuses({ ...valid, steps: [{ ...valid.steps[0], condition: { field: 'type', operator: 'eq', value: 'Change Request' } }] }, /compares ids/));
check('an SLA is at least a quarter of an hour', () =>
  refuses({ ...valid, steps: [{ ...valid.steps[1], slaHours: 0.1 }] }, /quarter of an hour/));
check('step ids are distinct', () =>
  refuses({ ...valid, steps: [valid.steps[0], { ...valid.steps[1], id: 'owner' }] }, /different/));
check('at most ten steps', () =>
  refuses({ ...valid, steps: Array.from({ length: 11 }, (_, i) => ({ ...valid.steps[0], id: `s${i}` })) }, /at most ten/));
check('an unknown approver kind is refused', () =>
  refuses({ ...valid, steps: [{ ...valid.steps[0], approvers: [{ kind: 'everyone' }] }] }, /./));

console.log(`\n${passed} passed`);
