import assert from 'node:assert/strict';

import { APP_ROLES, type AppRole } from '../../auth/roles.js';
import { TOOLS, toolAllowed, toolSchemas, type ToolAccess } from '../tools.js';

/**
 * Pragnya's tools follow the EPM roles: each role is offered only what its
 * screens cover, an external user (client or vendor) is offered nothing, and
 * `toolAllowed` (which also guards every call as it runs) agrees with what is
 * offered.
 *
 * No stack needed: `npx tsx src/assistant/__checks__/roles.check.ts`.
 */

/** Someone holding every permission, with finance and people switched on: only the role narrows. */
const access = (role: AppRole): ToolAccess => ({ can: () => true, allowFinance: true, allowPeople: true, role });
const offered = (role: AppRole) => new Set(toolSchemas(access(role)).map((tool) => tool.name));

const MANAGEMENT = [
  'finance_figures',
  'earned_value',
  'resource_overload',
  'scenarios',
  'risk_exposure',
  'budget_exposure',
  'delivery_forecast',
  'recommended_actions',
];
const PEOPLE = ['team_workload', 'team_timesheets'];

const admin = offered('admin');
const manager = offered('manager');
const hr = offered('hr');
const employee = offered('employee');
const external = offered('external');

assert.equal(admin.size, TOOLS.length, 'an administrator is offered every tool');
assert.equal(external.size, 0, 'an external user is offered no tool');
for (const name of [...MANAGEMENT, ...PEOPLE, 'get_sprint']) assert.ok(manager.has(name), `manager has ${name}`);
for (const name of PEOPLE) assert.ok(hr.has(name), `HR has ${name}`);
for (const name of [...MANAGEMENT, 'get_sprint']) assert.ok(!hr.has(name), `HR lacks ${name}`);
for (const name of [...MANAGEMENT, ...PEOPLE]) assert.ok(!employee.has(name), `employee lacks ${name}`);
for (const name of ['list_tasks', 'my_timesheet', 'expense_claims', 'approvals_waiting', 'time_summary', 'get_sprint']) {
  assert.ok(employee.has(name), `employee has ${name}`);
}

// What runs is what was offered, for every role and tool.
for (const role of APP_ROLES) {
  const names = offered(role);
  for (const tool of TOOLS) assert.equal(toolAllowed(tool, access(role)), names.has(tool.name), `${role} / ${tool.name}`);
}

// The policy and permissions still narrow inside a role.
const noFinance: ToolAccess = { ...access('manager'), allowFinance: false };
assert.ok(!toolSchemas(noFinance).some((tool) => tool.name === 'finance_figures'), 'finance off hides finance from a manager');

console.log(
  'roles check passed:',
  Object.entries({ admin, manager, hr, employee, external })
    .map(([role, set]) => `${role} ${set.size}`)
    .join(', '),
  `of ${TOOLS.length} tools`,
);
