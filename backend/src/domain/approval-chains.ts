import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import type {
  ApprovalApproverSpec,
  ApprovalChain,
  ApprovalChainInput,
  ApprovalCondition,
  ApprovalStep,
} from '../types/epm.js';
import { withAudit } from './audit.js';

/**
 * Approval chains (BR-211): who must approve what, in which order.
 *
 * The definitions and the pure logic over them — validation, matching a
 * subject to its chain, deciding whether a step's condition holds — live here.
 * Running a request through a chain is `domain/approvals.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const digits = z.string().regex(/^\d+$/, 'Ids are numeric.');

const approverSpec: z.ZodType<ApprovalApproverSpec> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: digits }),
  z.object({ kind: z.literal('project_owner') }),
  z.object({ kind: z.literal('project_role'), roleId: digits }),
  z.object({ kind: z.literal('requester_manager') }),
]);

const CONDITION_FIELD = /^(value|type|priority|project|portfolio|customField\d+)$/;

const condition = z
  .object({
    field: z.string().regex(CONDITION_FIELD, 'A condition is on the value, type, priority, project, portfolio or a custom field.'),
    operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in', 'not_in']),
    value: z.union([z.number().finite(), z.string().max(200), z.array(z.string().max(200)).min(1).max(100)]),
  })
  .superRefine((value, context) => {
    const comparison = ['gt', 'gte', 'lt', 'lte'].includes(value.operator);
    const list = value.operator === 'in' || value.operator === 'not_in';
    if (comparison && typeof value.value !== 'number') {
      context.addIssue({ code: 'custom', message: 'A greater-than or less-than condition compares with a number.' });
    }
    if (list && !Array.isArray(value.value)) {
      context.addIssue({ code: 'custom', message: 'An "is one of" condition needs a list of values.' });
    }
    if (!list && Array.isArray(value.value)) {
      context.addIssue({ code: 'custom', message: 'Only "is one of" takes a list of values.' });
    }
    if (['type', 'priority', 'project'].includes(value.field)) {
      const values = Array.isArray(value.value) ? value.value : [String(value.value)];
      if (values.some((entry) => !/^\d+$/.test(String(entry)))) {
        context.addIssue({ code: 'custom', message: `A ${value.field} condition compares ids.` });
      }
    }
  });

const step = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1, 'Every step needs a name.').max(80),
  approvers: z.array(approverSpec).min(1, 'Every step needs at least one approver.').max(20),
  mode: z.enum(['all', 'any']),
  condition: condition.optional(),
  // A quarter of an hour at least: anything shorter breaches before anyone could read the email.
  slaHours: z.number().min(0.25, 'An SLA is at least a quarter of an hour.').max(24 * 365).optional(),
  escalateTo: z.array(approverSpec).max(10).optional(),
});

const chainSchema = z
  .object({
    name: z.string().trim().min(1, 'A chain needs a name.').max(120),
    description: z.string().trim().max(1000).optional(),
    typeIds: z.array(digits).max(50).default([]),
    projectIds: z.array(digits).max(500).default([]),
    valueField: z
      .string()
      .regex(/^customField\d+$/, 'The value field is a custom field.')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    steps: z.array(step).min(1, 'A chain needs at least one step.').max(10, 'A chain has at most ten steps.'),
    onSubmitStatusId: digits.optional().or(z.literal('').transform(() => undefined)),
    onApproveStatusId: digits.optional().or(z.literal('').transform(() => undefined)),
    onRejectStatusId: digits.optional().or(z.literal('').transform(() => undefined)),
    allowSelfApproval: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .superRefine((chain, context) => {
    const ids = new Set<string>();
    for (const one of chain.steps) {
      if (ids.has(one.id)) context.addIssue({ code: 'custom', message: 'Step ids must be different from each other.' });
      ids.add(one.id);
      if (one.condition?.field === 'value' && !chain.valueField) {
        context.addIssue({
          code: 'custom',
          message: `Step "${one.name}" compares the value, so the chain needs a value field.`,
        });
      }
    }
  });

export function parseChain(input: unknown): ApprovalChainInput {
  const result = chainSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw EpmError.validation(issue?.message ?? 'That chain is not valid.', result.error.issues);
  }
  return result.data as ApprovalChainInput;
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

/** What a condition can be evaluated against, read from the subject. */
export interface SubjectFacts {
  projectId: string;
  typeId?: string;
  priorityId?: string;
  portfolioId?: string;
  /** The chain's value field, when it is set on the subject. */
  value?: number | null;
  /** Every custom field on the subject: a number, or the text(s) shown for it. */
  customFields: Record<string, { number?: number; texts: string[] }>;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether a condition holds for a subject.
 *
 * A value that is not set never passes a threshold either way: a change
 * request with no value is neither above nor below 50,000, and a step that
 * routes on the value should not decide it as though it were zero.
 */
export function conditionHolds(rule: ApprovalCondition | undefined, facts: SubjectFacts): boolean {
  if (!rule) return true;
  const { operator } = rule;
  const expected = rule.value;

  const numeric = (): number | undefined => {
    if (rule.field === 'value') return facts.value ?? undefined;
    if (rule.field.startsWith('customField')) return facts.customFields[rule.field]?.number;
    return undefined;
  };

  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
    const left = numeric();
    if (left === undefined || typeof expected !== 'number') return false;
    if (operator === 'gt') return left > expected;
    if (operator === 'gte') return left >= expected;
    if (operator === 'lt') return left < expected;
    return left <= expected;
  }

  // Equality and membership: ids for the built-in fields, numbers or text for
  // a custom field.
  const candidates = (): string[] => {
    switch (rule.field) {
      case 'type':
        return facts.typeId ? [facts.typeId] : [];
      case 'priority':
        return facts.priorityId ? [facts.priorityId] : [];
      case 'project':
        return [facts.projectId];
      case 'portfolio':
        return facts.portfolioId ? [facts.portfolioId] : [];
      case 'value':
        return facts.value === null || facts.value === undefined ? [] : [String(facts.value)];
      default: {
        const field = facts.customFields[rule.field];
        if (!field) return [];
        return field.number !== undefined ? [String(field.number), ...field.texts] : field.texts;
      }
    }
  };

  const values = (Array.isArray(expected) ? expected : [expected]).map(String);
  const present = candidates();
  const matches = present.some((candidate) =>
    values.some((value) => {
      const a = Number(candidate);
      const b = Number(value);
      return candidate.trim() !== '' && value.trim() !== '' && Number.isFinite(a) && Number.isFinite(b)
        ? a === b
        : same(candidate, value);
    }),
  );

  return operator === 'eq' || operator === 'in' ? matches : !matches;
}

/** Names for ids, so a condition reads as a sentence. */
export interface ConditionNames {
  valueLabel?: string;
  field?: (field: string) => string | undefined;
  value?: (field: string, value: string) => string | undefined;
}

const OPERATOR_WORDS: Record<ApprovalCondition['operator'], string> = {
  gt: 'is above',
  gte: 'is at least',
  lt: 'is below',
  lte: 'is at most',
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
};

/** "Change value is above 50,000" — the condition as a person would say it. */
export function describeCondition(rule: ApprovalCondition, names: ConditionNames = {}): string {
  const label =
    rule.field === 'value'
      ? names.valueLabel ?? 'Value'
      : names.field?.(rule.field) ??
        ({ type: 'Type', priority: 'Priority', project: 'Project', portfolio: 'Portfolio' } as Record<string, string>)[
          rule.field
        ] ??
        rule.field;

  const show = (value: string | number) => {
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return names.value?.(rule.field, value) ?? value;
  };
  const shown = Array.isArray(rule.value) ? rule.value.map(show).join(', ') : show(rule.value);
  return `${label} ${OPERATOR_WORDS[rule.operator]} ${shown}`;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

type ChainRow = Awaited<ReturnType<typeof prisma.approvalChain.findFirstOrThrow>>;

export function toApprovalChain(row: ChainRow, requestCount = 0): ApprovalChain {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    subjectType: 'work_package',
    typeIds: row.typeIds,
    projectIds: row.projectIds,
    valueField: row.valueField ?? undefined,
    steps: (Array.isArray(row.steps) ? row.steps : []) as unknown as ApprovalStep[],
    onSubmitStatusId: row.onSubmitStatusId ?? undefined,
    onApproveStatusId: row.onApproveStatusId ?? undefined,
    onRejectStatusId: row.onRejectStatusId ?? undefined,
    allowSelfApproval: row.allowSelfApproval,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    requestCount,
  };
}

export async function listChains(): Promise<ApprovalChain[]> {
  const [rows, counts] = await Promise.all([
    prisma.approvalChain.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    prisma.approvalRequest.groupBy({ by: ['chainId'], _count: { _all: true } }),
  ]);
  const used = new Map(counts.map((row) => [row.chainId, row._count._all]));
  return rows.map((row) => toApprovalChain(row, used.get(row.id) ?? 0));
}

function rowData(input: ApprovalChainInput) {
  return {
    name: input.name,
    description: input.description ?? null,
    typeIds: input.typeIds,
    projectIds: input.projectIds,
    valueField: input.valueField ?? null,
    steps: input.steps as unknown as object,
    onSubmitStatusId: input.onSubmitStatusId ?? null,
    onApproveStatusId: input.onApproveStatusId ?? null,
    onRejectStatusId: input.onRejectStatusId ?? null,
    allowSelfApproval: input.allowSelfApproval,
    active: input.active,
  };
}

export async function createChain(input: unknown, actorId: string): Promise<ApprovalChain> {
  const chain = parseChain(input);
  const row = await withAudit(
    (tx) => tx.approvalChain.create({ data: { ...rowData(chain), createdBy: actorId } }),
    (created) => ({
      actorId,
      entityType: 'approval-chain',
      entityId: created.id,
      action: 'approval.chain.created',
      summary: `Approval chain "${created.name}" created with ${chain.steps.length} ${chain.steps.length === 1 ? 'step' : 'steps'}.`,
      after: chain,
    }),
  );
  forgetActiveChains();
  return toApprovalChain(row);
}

/**
 * Updates a chain. Requests already in flight keep the snapshot they were
 * submitted under, so an edit changes what happens to the next request only.
 */
export async function updateChain(id: string, input: unknown, actorId: string): Promise<ApprovalChain> {
  const existing = await prisma.approvalChain.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That approval chain');
  const chain = parseChain(input);

  const row = await withAudit(
    (tx) => tx.approvalChain.update({ where: { id }, data: rowData(chain) }),
    {
      actorId,
      entityType: 'approval-chain',
      entityId: id,
      action: 'approval.chain.updated',
      summary: `Approval chain "${chain.name}" changed${existing.active !== chain.active ? (chain.active ? ' and switched on' : ' and switched off') : ''}.`,
      before: toApprovalChain(existing),
      after: chain,
    },
  );
  forgetActiveChains();
  const count = await prisma.approvalRequest.count({ where: { chainId: id } });
  return toApprovalChain(row, count);
}

/** Deletes a chain nobody has used. A used one is switched off instead, keeping its history readable. */
export async function deleteChain(id: string, actorId: string): Promise<void> {
  const existing = await prisma.approvalChain.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That approval chain');
  const used = await prisma.approvalRequest.count({ where: { chainId: id } });
  if (used > 0) {
    throw EpmError.conflict(
      `"${existing.name}" has been used by ${used} ${used === 1 ? 'request' : 'requests'}, so it can be switched off but not deleted.`,
    );
  }
  await withAudit((tx) => tx.approvalChain.delete({ where: { id } }), {
    actorId,
    entityType: 'approval-chain',
    entityId: id,
    action: 'approval.chain.deleted',
    summary: `Approval chain "${existing.name}" deleted before it was ever used.`,
    before: toApprovalChain(existing),
  });
  forgetActiveChains();
}

/**
 * The chain that governs a subject, if any.
 *
 * When several active chains match, the most specific wins — one naming the
 * project over one for every project, one naming the type over one for every
 * type — and the most recently changed breaks a tie. Deterministic, so the
 * same subject always meets the same chain.
 */
export function pickChain(
  chains: ApprovalChain[],
  subject: { typeId?: string; projectId: string },
): ApprovalChain | undefined {
  const matching = chains.filter(
    (chain) =>
      chain.active &&
      (chain.typeIds.length === 0 || (subject.typeId !== undefined && chain.typeIds.includes(subject.typeId))) &&
      (chain.projectIds.length === 0 || chain.projectIds.includes(subject.projectId)),
  );
  const specificity = (chain: ApprovalChain) => (chain.projectIds.length > 0 ? 2 : 0) + (chain.typeIds.length > 0 ? 1 : 0);
  return matching.sort((a, b) => specificity(b) - specificity(a) || b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Every active chain, for matching. Cached briefly: it is read on every task page. */
let activeCache: { at: number; chains: ApprovalChain[] } | undefined;

export async function activeChains(): Promise<ApprovalChain[]> {
  if (activeCache && Date.now() - activeCache.at < 15_000) return activeCache.chains;
  const rows = await prisma.approvalChain.findMany({ where: { active: true } }).catch(() => []);
  const chains = rows.map((row) => toApprovalChain(row));
  activeCache = { at: Date.now(), chains };
  return chains;
}

export function forgetActiveChains(): void {
  activeCache = undefined;
}
