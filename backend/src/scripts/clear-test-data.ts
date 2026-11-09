import type { Prisma } from '@prisma/client';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { auditRow } from '../domain/audit.js';
import { EpmError } from '../lib/errors.js';
import { message, type Message } from '../lib/i18n.js';
import { openProject } from '../openproject/client.js';

/**
 * Clears what testing left on a server before it goes live.
 *
 * The kinds below are removed whole: every record of each kind, with what hangs
 * off it. Several cannot be removed from the screens at all (a submitted expense
 * claim, everybody's notifications) and the rest only one at a time.
 *
 *   node dist/scripts/clear-test-data.js                        lists what would go; changes nothing
 *   node dist/scripts/clear-test-data.js --apply                removes it
 *   node dist/scripts/clear-test-data.js --only=teams,rules     only those kinds (add --apply to remove)
 *   node dist/scripts/clear-test-data.js --rehearse             every database step, rolled back
 *   npx tsx --env-file-if-exists=.env src/scripts/clear-test-data.ts …     (development)
 *
 * Kinds: expenses, scenarios, scheduled-reports, approval-chains, rules, teams,
 * departments, resource-roles, custom-fields, notifications.
 *
 * Back up first (deploy/backup/epm-backup.sh): nothing here can be undone.
 * What stays: projects, people, timesheets, the journal, the three approval
 * chains EPM ships (put back to their shipped steps) and the four custom fields
 * EPM's own features write into. Each kind cleared is journalled once, with no
 * person as the actor.
 */

const KINDS = [
  'expenses',
  'scenarios',
  'scheduled-reports',
  'approval-chains',
  'rules',
  'teams',
  'departments',
  'resource-roles',
  'custom-fields',
  'notifications',
] as const;
type Kind = (typeof KINDS)[number];

const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rehearse = args.includes('--rehearse');
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const requested = onlyArg ? onlyArg.slice('--only='.length).split(',').map((kind) => kind.trim()).filter(Boolean) : [...KINDS];
const strayArgs = args.filter((arg) => arg !== '--apply' && arg !== '--rehearse' && !arg.startsWith('--only='));
const strayKinds = requested.filter((kind) => !isKind(kind));

if (strayArgs.length > 0 || strayKinds.length > 0 || (apply && rehearse) || requested.length === 0) {
  console.error('Usage: clear-test-data [--only=kind,kind] [--apply | --rehearse]');
  console.error(`Kinds: ${KINDS.join(', ')}`);
  if (strayKinds.length > 0) console.error(`Not a kind: ${strayKinds.join(', ')}`);
  process.exit(2);
}

// In the order they are removed: claims and scenarios release their approval
// requests before the chains go, and teams leave their departments first.
const chosen = KINDS.filter((kind) => requested.includes(kind));

/** The chains EPM ships, as the migrations that created them wrote them. */
const SHIPPED_CHAINS = [
  {
    id: 'chain-timesheets-default',
    name: 'Timesheets',
    description: 'The line manager, then the owners of the projects the time is on.',
    subjectType: 'timesheet',
    steps: [
      { id: 'line', name: 'Line manager', approvers: [{ kind: 'requester_manager' }], mode: 'any' },
      { id: 'projects', name: 'Project owners', approvers: [{ kind: 'project_owner' }], mode: 'all', skipIfNobody: true },
    ],
  },
  {
    id: 'chain-expenses-default',
    name: 'Expense claims',
    description: "The line manager; above 1,000, the project's owner as well.",
    subjectType: 'expense_claim',
    steps: [
      { id: 'line', name: 'Line manager', approvers: [{ kind: 'requester_manager' }], mode: 'any' },
      {
        id: 'additional',
        name: 'Additional approval',
        approvers: [{ kind: 'project_owner' }],
        mode: 'any',
        condition: { field: 'value', operator: 'gt', value: 1000 },
      },
    ],
  },
  {
    id: 'chain-scenarios-default',
    name: 'Scenarios',
    description: 'Every owner of a project the scenario changes.',
    subjectType: 'scenario',
    steps: [{ id: 'owners', name: 'Project owners', approvers: [{ kind: 'project_owner' }], mode: 'all' }],
  },
] as const;

/** The fields a shipped chain is put back to, besides its steps. */
const shippedRow = (chain: (typeof SHIPPED_CHAINS)[number]) => ({
  name: chain.name,
  description: chain.description,
  subjectType: chain.subjectType,
  typeIds: [] as string[],
  projectIds: [] as string[],
  valueField: null,
  steps: chain.steps as unknown as Prisma.InputJsonValue,
  onSubmitStatusId: null,
  onApproveStatusId: null,
  onRejectStatusId: null,
  allowSelfApproval: false,
  active: true,
});

/** JSON with its keys sorted, so two values compare equal whatever order the database keeps them in. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

/** As the Expenses page shows a claim. */
const claimKey = (id: string) => `EX-${id.slice(-6).toUpperCase()}`;

const clip = (text: string | null | undefined, length = 48) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

class Rollback extends Error {}

/**
 * One kind's database work, in one transaction with its journal entry. In a
 * rehearsal the transaction is rolled back once every step has run.
 */
async function inTransaction(work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await work(tx);
        if (rehearse) throw new Rollback();
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/**
 * Removes a record in the delivery system through EPM's add-on, as the service
 * account. Already gone counts as removed, so a second run picks up where a
 * first one stopped.
 */
async function removeUpstream(path: string): Promise<void> {
  try {
    await runAsSystem(() => openProject.request<void>(path, { root: true, method: 'DELETE' }));
  } catch (error) {
    if (error instanceof EpmError && error.status === 404) return;
    throw error;
  }
}

/** Approval requests with their tasks, the links emailed for those tasks and their escalations. */
async function removeRequests(tx: Prisma.TransactionClient, requestIds: string[]): Promise<void> {
  if (requestIds.length === 0) return;
  const taskIds = (await tx.approvalTask.findMany({ where: { requestId: { in: requestIds } }, select: { id: true } })).map((task) => task.id);
  if (taskIds.length > 0) await tx.approvalLinkToken.deleteMany({ where: { taskId: { in: taskIds } } });
  await tx.escalationEvent.deleteMany({ where: { subjectType: 'approval-request', subjectId: { in: requestIds } } });
  // The tasks go with their request (ON DELETE CASCADE).
  await tx.approvalRequest.deleteMany({ where: { id: { in: requestIds } } });
}

async function journal(
  tx: Prisma.TransactionClient,
  entityType: string,
  summary: Message,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.auditEvent.create({
    data: auditRow({ actorId: null, entityType, entityId: 'test-data', action: 'test-data.cleared', summary, metadata }),
  });
}

interface Plan {
  title: string;
  count: number;
  lines: string[];
  notes: string[];
  /** Removes what was listed. Absent when there is nothing to remove. */
  run?: () => Promise<void>;
}

async function planExpenses(): Promise<Plan> {
  const claims = await prisma.expenseClaim.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, amount: true, currency: true, description: true, projectId: true, costEntryId: true, _count: { select: { receipts: true } } },
  });
  const requestIds = (await prisma.approvalRequest.findMany({ where: { subjectType: 'expense_claim' }, select: { id: true } })).map((row) => row.id);
  const costEntryIds = claims.flatMap((claim) => (claim.costEntryId === null ? [] : [claim.costEntryId]));
  const receipts = claims.reduce((sum, claim) => sum + claim._count.receipts, 0);
  const ids = claims.map((claim) => claim.id);
  return {
    title: 'Expense claims',
    count: claims.length,
    lines: claims.map(
      (claim) => `${claimKey(claim.id)}  ${claim.status.padEnd(9)} ${String(claim.amount)} ${claim.currency}  "${clip(claim.description)}"  (project ${claim.projectId})`,
    ),
    notes: [
      `with ${receipts} receipts and ${requestIds.length} approval requests`,
      `${costEntryIds.length} of them posted: their cost entries are removed from the delivery system too, so no budget still counts them`,
    ],
    run: claims.length === 0 && requestIds.length === 0 ? undefined : async () => {
      if (!rehearse) for (const id of costEntryIds) await removeUpstream(`/epm_admin/costs/entries/${id}`);
      await inTransaction(async (tx) => {
        await removeRequests(tx, requestIds);
        await tx.expenseClaim.deleteMany({ where: { id: { in: ids } } });
        await journal(
          tx,
          'expense-claim',
          message('Test data cleared from the server: expense claims ({count}), with their receipts, approvals and cost entries.', { count: ids.length }),
          { claimIds: ids, costEntryIds },
        );
      });
    },
  };
}

async function planScenarios(): Promise<Plan> {
  const scenarios = await prisma.scenario.findMany({
    orderBy: { capturedAt: 'asc' },
    select: { id: true, name: true, status: true, _count: { select: { projects: true } } },
  });
  const requestIds = (await prisma.approvalRequest.findMany({ where: { subjectType: 'scenario' }, select: { id: true } })).map((row) => row.id);
  const ids = scenarios.map((scenario) => scenario.id);
  return {
    title: 'Scenarios',
    count: scenarios.length,
    lines: scenarios.map((scenario) => `${clip(scenario.name)}  ${scenario.status}, ${scenario._count.projects} projects`),
    notes: [`with ${requestIds.length} approval requests`],
    run: scenarios.length === 0 && requestIds.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await removeRequests(tx, requestIds);
        // Its projects and work go with it (ON DELETE CASCADE).
        await tx.scenario.deleteMany({ where: { id: { in: ids } } });
        await journal(tx, 'scenario', message('Test data cleared from the server: scenarios ({count}), with their approvals.', { count: ids.length }), {
          scenarioIds: ids,
        });
      });
    },
  };
}

async function planScheduledReports(): Promise<Plan> {
  const schedules = await prisma.reportSchedule.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, frequency: true, active: true, _count: { select: { runs: true } } },
  });
  const ids = schedules.map((schedule) => schedule.id);
  const outboxIds = (
    await prisma.reportDelivery.findMany({ where: { run: { scheduleId: { in: ids } }, outboxId: { not: null } }, select: { outboxId: true } })
  ).flatMap((delivery) => (delivery.outboxId ? [delivery.outboxId] : []));
  const queued = outboxIds.length === 0 ? 0 : await prisma.emailOutbox.count({ where: { id: { in: outboxIds }, status: 'queued' } });
  const runs = schedules.reduce((sum, schedule) => sum + schedule._count.runs, 0);
  return {
    title: 'Scheduled reports',
    count: schedules.length,
    lines: schedules.map((schedule) => `${clip(schedule.name)}  ${schedule.frequency}${schedule.active ? '' : ', switched off'}, ${schedule._count.runs} runs`),
    notes: [`with ${runs} runs and their files; ${queued} report emails not yet sent are cancelled`],
    run: schedules.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        if (outboxIds.length > 0) {
          await tx.emailOutbox.updateMany({ where: { id: { in: outboxIds }, status: 'queued' }, data: { status: 'cancelled' } });
        }
        // Runs, deliveries and files go with the schedule (ON DELETE CASCADE).
        await tx.reportSchedule.deleteMany({ where: { id: { in: ids } } });
        await journal(
          tx,
          'report_schedule',
          message('Test data cleared from the server: scheduled reports ({count}), with their runs.', { count: ids.length }),
          { scheduleIds: ids },
        );
      });
    },
  };
}

async function planApprovalChains(): Promise<Plan> {
  const chains = await prisma.approvalChain.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { requests: true } } } });
  const shippedIds = new Set<string>(SHIPPED_CHAINS.map((chain) => chain.id));
  const extra = chains.filter((chain) => !shippedIds.has(chain.id));
  const extraIds = extra.map((chain) => chain.id);
  const requests = extraIds.length === 0 ? [] : await prisma.approvalRequest.findMany({ where: { chainId: { in: extraIds } }, select: { id: true, subjectType: true } });
  const bySubject = new Map<string, number>();
  for (const request of requests) bySubject.set(request.subjectType, (bySubject.get(request.subjectType) ?? 0) + 1);

  const resets = SHIPPED_CHAINS.filter((shipped) => {
    const row = chains.find((chain) => chain.id === shipped.id);
    if (!row) return true;
    const want = shippedRow(shipped);
    return (
      row.name !== want.name ||
      row.description !== want.description ||
      row.subjectType !== want.subjectType ||
      row.typeIds.length > 0 ||
      row.projectIds.length > 0 ||
      row.valueField !== null ||
      row.onSubmitStatusId !== null ||
      row.onApproveStatusId !== null ||
      row.onRejectStatusId !== null ||
      row.allowSelfApproval !== false ||
      row.active !== true ||
      stable(row.steps) !== stable(shipped.steps)
    );
  });

  return {
    title: 'Approval chains',
    count: extra.length,
    lines: [
      ...extra.map((chain) => `${clip(chain.name)}  (${chain.subjectType}, ${chain._count.requests} requests)`),
      ...SHIPPED_CHAINS.map((shipped) =>
        resets.includes(shipped) ? `kept, put back to its shipped steps: ${shipped.name}` : `kept, unchanged: ${shipped.name}`,
      ),
    ],
    notes: [
      requests.length === 0
        ? 'no approval requests use them'
        : `with ${requests.length} approval requests (${[...bySubject].map(([subject, count]) => `${count} ${subject}`).join(', ')}); a timesheet among them keeps its status but loses its approval history`,
    ],
    run: extra.length === 0 && resets.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await removeRequests(tx, requests.map((request) => request.id));
        await tx.approvalChain.deleteMany({ where: { id: { in: extraIds } } });
        for (const shipped of resets) {
          const row = shippedRow(shipped);
          await tx.approvalChain.upsert({ where: { id: shipped.id }, create: { id: shipped.id, ...row, createdBy: 'system' }, update: row });
        }
        await journal(
          tx,
          'approval-chain',
          message('Test data cleared from the server: approval chains ({count}). The chains EPM ships were put back to their shipped steps.', {
            count: extraIds.length,
          }),
          { chainIds: extraIds, reset: resets.map((chain) => chain.id) },
        );
      });
    },
  };
}

async function planRules(): Promise<Plan> {
  const rules = await prisma.automationRule.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, active: true, _count: { select: { firings: true } } },
  });
  const ids = rules.map((rule) => rule.id);
  const firings = rules.reduce((sum, rule) => sum + rule._count.firings, 0);
  return {
    title: 'Automation rules',
    count: rules.length,
    lines: rules.map((rule) => `${clip(rule.name)}  ${rule.active ? 'on' : 'off'}, fired ${rule._count.firings} times`),
    notes: [`with ${firings} firings in their history. Escalation, time logging, health and resource rules are not touched`],
    run: rules.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await tx.ruleFiring.deleteMany({ where: { ruleId: { in: ids } } });
        await tx.ruleItemState.deleteMany({ where: { ruleId: { in: ids } } });
        await tx.automationRule.deleteMany({ where: { id: { in: ids } } });
        await journal(tx, 'automation-rule', message('Test data cleared from the server: automation rules ({count}), with their history.', { count: ids.length }), {
          ruleIds: ids,
        });
      });
    },
  };
}

async function planTeams(): Promise<Plan> {
  const teams = await prisma.team.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, code: true, _count: { select: { members: true, placeholders: true } } },
  });
  const ids = teams.map((team) => team.id);
  const people = teams.reduce((sum, team) => sum + team._count.members + team._count.placeholders, 0);
  return {
    title: 'Teams',
    count: teams.length,
    lines: teams.map((team) => `${clip(team.name)}  ${team.code}, ${team._count.members} people`),
    notes: [`${people} people and placeholders are left in no team`],
    run: teams.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await tx.userProfile.updateMany({ where: { teamId: { in: ids } }, data: { teamId: null } });
        await tx.placeholderPerson.updateMany({ where: { teamId: { in: ids } }, data: { teamId: null } });
        await tx.team.deleteMany({ where: { id: { in: ids } } });
        await journal(tx, 'team', message('Test data cleared from the server: teams ({count}).', { count: ids.length }), { teamIds: ids });
      });
    },
  };
}

async function planDepartments(): Promise<Plan> {
  const departments = await prisma.department.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, code: true, _count: { select: { members: true, placeholders: true, teams: true } } },
  });
  const ids = departments.map((department) => department.id);
  const people = departments.reduce((sum, department) => sum + department._count.members + department._count.placeholders, 0);
  return {
    title: 'Departments',
    count: departments.length,
    lines: departments.map((department) => `${clip(department.name)}  ${department.code}, ${department._count.members} people`),
    notes: [`${people} people and placeholders are left in no department; a team that stays keeps no department`],
    run: departments.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await tx.userProfile.updateMany({ where: { departmentId: { in: ids } }, data: { departmentId: null } });
        await tx.placeholderPerson.updateMany({ where: { departmentId: { in: ids } }, data: { departmentId: null } });
        await tx.team.updateMany({ where: { departmentId: { in: ids } }, data: { departmentId: null } });
        await tx.department.deleteMany({ where: { id: { in: ids } } });
        await journal(tx, 'department', message('Test data cleared from the server: departments ({count}).', { count: ids.length }), {
          departmentIds: ids,
        });
      });
    },
  };
}

async function planResourceRoles(): Promise<Plan> {
  const roles = await prisma.resourceRole.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, archivedAt: true, _count: { select: { people: true, placeholders: true, allocations: true } } },
  });
  const ids = roles.map((role) => role.id);
  const allocations = roles.reduce((sum, role) => sum + role._count.allocations, 0);
  return {
    title: 'Resource roles',
    count: roles.length,
    lines: roles.map((role) => `${clip(role.name)}${role.archivedAt ? ', archived' : ''}, ${role._count.people + role._count.placeholders} people`),
    notes: [`people keep their place; ${allocations} planned allocations stay, without a role`],
    run: roles.length === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await tx.resourceAllocation.updateMany({ where: { roleId: { in: ids } }, data: { roleId: null } });
        // People and placeholders let go of the role themselves (ON DELETE SET NULL).
        await tx.resourceRole.deleteMany({ where: { id: { in: ids } } });
        await journal(tx, 'resource-role', message('Test data cleared from the server: resource roles ({count}).', { count: ids.length }), {
          roleIds: ids,
        });
      });
    },
  };
}

/**
 * Work package fields EPM itself relies on, made by its setup scripts and found
 * by name: the critical path writes its figures into the three float fields
 * (setup/schedule-fields.rb, zzz_epm_schedule.rb), and change requests are
 * valued in "Change value" (setup/governance-types.rb). Never removed.
 */
const EPM_FIELDS = new Set(['Change value', 'Total float (days)', 'Free float (days)', 'On critical path']);

async function planCustomFields(): Promise<Plan> {
  const calculated = await prisma.calculatedField.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, key: true, name: true, customFieldId: true, _count: { select: { values: true } } },
  });
  // Every work package custom field, through the same add-on calculated fields keep theirs with.
  const catalogue = await runAsSystem(() =>
    openProject.request<{ rows?: { id: number | string; name?: string | null }[] }>('/epm_admin/catalog/custom-fields', { root: true }),
  );
  const mirrored = new Set(calculated.flatMap((field) => (field.customFieldId === null ? [] : [String(field.customFieldId)])));
  const rows = catalogue.rows ?? [];
  const kept = rows.filter((row) => EPM_FIELDS.has(row.name ?? ''));
  const others = rows.filter((row) => !mirrored.has(String(row.id)) && !EPM_FIELDS.has(row.name ?? ''));
  const ids = calculated.map((field) => field.id);
  const total = calculated.length + others.length;
  return {
    title: 'Custom fields',
    count: total,
    lines: [
      ...calculated.map((field) => `${clip(field.name)} (${field.key})  calculated, ${field._count.values} values`),
      ...others.map((row) => `${clip(row.name ?? '')}  #${row.id}`),
      ...kept.map((row) => `kept, EPM's own: ${row.name ?? ''}  #${row.id}`),
    ],
    notes: [`${calculated.length} calculated and ${others.length} others, each with every value it holds`],
    run: total === 0 ? undefined : async () => {
      if (!rehearse) {
        for (const field of calculated) if (field.customFieldId !== null) await removeUpstream(`/epm_admin/catalog/custom-fields/${field.customFieldId}`);
        for (const row of others) await removeUpstream(`/epm_admin/catalog/custom-fields/${row.id}`);
      }
      await inTransaction(async (tx) => {
        // Values go with their field (ON DELETE CASCADE); the passes' history goes with the last field.
        await tx.calculatedField.deleteMany({ where: { id: { in: ids } } });
        await tx.calculatedRun.deleteMany({});
        await journal(tx, 'calculated-field', message('Test data cleared from the server: custom fields ({count}), calculated ones included.', { count: total }), {
          calculatedFieldIds: ids,
          customFieldIds: others.map((row) => String(row.id)),
        });
      });
    },
  };
}

async function planNotifications(): Promise<Plan> {
  const count = await prisma.notification.count();
  return {
    title: 'Notifications',
    count,
    lines: [],
    notes: [
      "EPM's own, for everyone. The delivery system keeps its own (mentions, assignments, date alerts); clear those with:",
      `  docker exec openproject-db psql -U openproject -d openproject -c "DELETE FROM notifications;"`,
    ],
    run: count === 0 ? undefined : async () => {
      await inTransaction(async (tx) => {
        await tx.notification.deleteMany({});
        await journal(tx, 'notification', message('Test data cleared from the server: notifications ({count}).', { count }), {});
      });
    },
  };
}

const PLANNERS: Record<Kind, () => Promise<Plan>> = {
  expenses: planExpenses,
  scenarios: planScenarios,
  'scheduled-reports': planScheduledReports,
  'approval-chains': planApprovalChains,
  rules: planRules,
  teams: planTeams,
  departments: planDepartments,
  'resource-roles': planResourceRoles,
  'custom-fields': planCustomFields,
  notifications: planNotifications,
};

const MAX_LINES = 40;
let failed = 0;

console.log(
  apply
    ? 'Removing test data. This cannot be undone.\n'
    : rehearse
      ? 'Rehearsal: every database step runs and is rolled back. Nothing changes, here or in the delivery system.\n'
      : 'Dry run: nothing is changed. Add --apply to remove what is listed.\n',
);

for (const kind of chosen) {
  let plan: Plan;
  try {
    plan = await PLANNERS[kind]();
  } catch (error) {
    failed += 1;
    console.log(`${kind}: could not be read — ${error instanceof Error ? error.message : String(error)}\n`);
    continue;
  }

  console.log(`${plan.title} [${kind}]: ${plan.count} to remove`);
  for (const line of plan.lines.slice(0, MAX_LINES)) console.log(`  ${line}`);
  if (plan.lines.length > MAX_LINES) console.log(`  … and ${plan.lines.length - MAX_LINES} more`);
  for (const note of plan.notes) console.log(`  ${note}`);

  if ((apply || rehearse) && plan.run) {
    try {
      await plan.run();
      console.log(rehearse ? '  rehearsed: every step ran, then rolled back' : '  removed');
    } catch (error) {
      failed += 1;
      console.log(`  NOT removed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log('');
}

if (apply) {
  console.log(failed === 0 ? 'Done.' : `Done, with ${failed} kind(s) not removed (above). Run again to retry them.`);
  console.log('Restart the backend so nothing it has cached still shows them:');
  console.log('  docker compose -f docker-compose.prod.yml --env-file .env.prod restart backend');
} else if (rehearse) {
  console.log(failed === 0 ? 'Rehearsal finished: every step works, and nothing was changed.' : `Rehearsal finished with ${failed} failure(s) (above). Nothing was changed.`);
} else {
  console.log('Nothing has been changed. Back up first, then run again with --apply:');
  console.log('  COMPOSE_FILE=docker-compose.prod.yml BACKUP_ROOT=$HOME/epm-backups sh deploy/backup/epm-backup.sh');
}

await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
