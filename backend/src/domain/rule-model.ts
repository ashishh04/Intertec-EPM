import { z } from 'zod';

import type {
  AutomationRuleInput,
  PersonSpec,
  RuleAction,
  RuleCondition,
  RuleConditionGroup,
  RuleConditionOperator,
  RuleEventKind,
  RuleFieldValue,
  RuleSubjectType,
} from '../types/epm.js';
import { msg } from '../lib/i18n.js';

/**
 * The rules engine's vocabulary (BR-216, BR-217), with no I/O: what a rule may
 * test and do, whether an input is a valid rule, and whether an item matches.
 * Kept pure so `__checks__/rules.check.ts` can test it on worked examples.
 */

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

type FieldKind = 'ids' | 'text' | 'date' | 'datetime' | 'number' | 'status_category' | 'health' | 'boolean' | 'custom';

const WORK_PACKAGE_FIELDS: Record<string, FieldKind> = {
  type: 'ids',
  status: 'ids',
  status_category: 'status_category',
  priority: 'ids',
  project: 'ids',
  portfolio: 'ids',
  version: 'ids',
  assignee: 'ids',
  responsible: 'ids',
  author: 'ids',
  parent: 'ids',
  subject: 'text',
  startDate: 'date',
  dueDate: 'date',
  createdAt: 'datetime',
  updatedAt: 'datetime',
  estimatedHours: 'number',
  percentageDone: 'number',
  storyPoints: 'number',
};

const PROJECT_FIELDS: Record<string, FieldKind> = {
  project: 'ids',
  portfolio: 'ids',
  name: 'text',
  health: 'health',
  status: 'ids',
  active: 'boolean',
};

const DATE_OPERATORS: RuleConditionOperator[] = [
  'before_today',
  'today_or_later',
  'within_next_days',
  'more_than_days_ago',
  'less_than_days_ago',
  'on_or_before',
  'on_or_after',
  'is_empty',
  'is_set',
];

const OPERATORS: Record<FieldKind, RuleConditionOperator[]> = {
  ids: ['in', 'not_in', 'is_empty', 'is_set'],
  text: ['contains', 'not_contains', 'eq', 'neq', 'is_empty', 'is_set'],
  date: DATE_OPERATORS,
  datetime: DATE_OPERATORS,
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'is_empty', 'is_set'],
  status_category: ['eq'],
  // Overall health is always a level; "not assessed" applies to criteria, not to it.
  health: ['in', 'not_in'],
  boolean: ['eq'],
  custom: ['eq', 'neq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_empty', 'is_set'],
};

/** Ids OpenProject issues are digits; portfolios are EPM's own. */
const DIGIT_ID_FIELDS = new Set(['type', 'status', 'priority', 'project', 'version', 'assignee', 'responsible', 'author', 'parent']);

export const HEALTH_LEVELS = ['healthy', 'warning', 'critical'] as const;

function fieldKind(subjectType: RuleSubjectType, field: string): FieldKind | undefined {
  if (subjectType === 'work_package' && /^customField\d+$/.test(field)) return 'custom';
  return (subjectType === 'work_package' ? WORK_PACKAGE_FIELDS : PROJECT_FIELDS)[field];
}

export const EVENTS_BY_SUBJECT: Record<RuleSubjectType, RuleEventKind[]> = {
  work_package: ['work_package.created', 'work_package.updated'],
  project: ['project.created', 'project.updated', 'project.health_changed'],
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const digits = z.string().regex(/^\d+$/, 'An id is digits.');
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/** Checks one condition against the field catalogue; an error message, or undefined. */
export function conditionProblem(subjectType: RuleSubjectType, condition: RuleCondition): string | undefined {
  const kind = fieldKind(subjectType, condition.field);
  if (!kind) return `"${condition.field}" is not something a ${subjectType === 'project' ? 'project' : 'work package'} rule can test.`;
  if (!OPERATORS[kind].includes(condition.operator)) {
    return `"${condition.operator}" does not apply to ${condition.field}.`;
  }

  const { operator, value } = condition;
  switch (operator) {
    case 'is_empty':
    case 'is_set':
    case 'before_today':
    case 'today_or_later':
      return undefined;
    case 'in':
    case 'not_in': {
      if (!Array.isArray(value) || value.length === 0) return `Choose at least one value for ${condition.field}.`;
      if (value.length > 100) return 'At most a hundred values per condition.';
      if (DIGIT_ID_FIELDS.has(condition.field) && value.some((one) => !/^\d+$/.test(String(one)))) {
        return `${condition.field} is compared by id.`;
      }
      if (kind === 'health' && value.some((one) => !(HEALTH_LEVELS as readonly string[]).includes(String(one)))) {
        return 'Health is healthy, warning or critical.';
      }
      return undefined;
    }
    case 'eq':
    case 'neq':
      if (kind === 'status_category') return value === 'open' || value === 'closed' ? undefined : 'Choose open or closed.';
      if (kind === 'boolean') return typeof value === 'boolean' ? undefined : 'Choose yes or no.';
      if (kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? undefined : 'Compare with a number.';
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value).length <= 500
          ? undefined
          : 'Keep the value under 500 characters.'
        : 'Give a value to compare with.';
    case 'contains':
    case 'not_contains':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 ? undefined : 'Give some text to look for.';
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'Compare with a number.';
    case 'within_next_days':
    case 'more_than_days_ago':
    case 'less_than_days_ago':
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3650
        ? undefined
        : 'A number of days, from 0 to 3650.';
    case 'on_or_before':
    case 'on_or_after':
      return typeof value === 'string' && isoDay.test(value) ? undefined : 'A date, written YYYY-MM-DD.';
    default:
      return `Unknown operator "${operator as string}".`;
  }
}

const personSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: digits }),
  z.object({ kind: z.literal('assignee') }),
  z.object({ kind: z.literal('responsible') }),
  z.object({ kind: z.literal('author') }),
  z.object({ kind: z.literal('project_owner') }),
  z.object({ kind: z.literal('team_lead') }),
  z.object({ kind: z.literal('department_manager') }),
  z.object({ kind: z.literal('project_role'), roleId: digits }),
  z.object({ kind: z.literal('approvers') }),
]);

export const personSpecSchema = personSpec;

/** One person, for assigning: a role or a list of approvers would be several. */
const SINGLE_PERSON = new Set<PersonSpec['kind']>([
  'user',
  'responsible',
  'author',
  'project_owner',
  'team_lead',
  'department_manager',
]);

const relativeDate = z.object({
  relativeDays: z.number().int().min(-3650).max(3650),
  from: z.enum(['today', 'startDate', 'dueDate']).optional(),
});

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign'), to: z.union([personSpec, z.object({ kind: z.literal('nobody') })]) }),
  z.object({
    type: z.literal('notify'),
    recipients: z.array(personSpec).min(1, 'Say who to notify.').max(20),
    title: z.string().trim().min(1, 'A notification needs a title.').max(200),
    message: z.string().trim().min(1, 'A notification needs a message.').max(2000),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
  }),
  z.object({ type: z.literal('set_status'), statusId: digits }),
  z.object({
    type: z.literal('set_field'),
    field: z.string(),
    value: z.union([z.string().max(500), z.number().finite(), z.null(), relativeDate]),
  }),
  z.object({
    type: z.literal('create_work_package'),
    typeId: digits,
    subject: z.string().trim().min(1, 'The new work package needs a subject.').max(255),
    description: z.string().max(5000).optional(),
    assignee: personSpec.optional(),
    relation: z.enum(['relates', 'blocks', 'blocked', 'follows', 'precedes', 'child', 'none']),
    dueInDays: z.number().int().min(0).max(3650).optional(),
  }),
  z.object({ type: z.literal('call_endpoint'), url: z.string().trim().url('That is not a URL.').max(2000) }),
]);

/** Fields a `set_field` action may write, and what each takes. */
const SETTABLE: Record<string, 'id' | 'date' | 'percent' | 'hours' | 'nullableId'> = {
  priority: 'id',
  startDate: 'date',
  dueDate: 'date',
  responsible: 'nullableId',
  version: 'nullableId',
  percentageDone: 'percent',
  estimatedHours: 'hours',
};

function setFieldProblem(field: string, value: RuleFieldValue): string | undefined {
  if (/^customField\d+$/.test(field)) {
    return value === null || typeof value === 'string' || typeof value === 'number'
      ? undefined
      : 'A custom field takes a value, not a relative date.';
  }
  const kind = SETTABLE[field];
  if (!kind) return `A rule cannot set "${field}".`;
  if (kind === 'id') return typeof value === 'string' && /^\d+$/.test(value) ? undefined : `Choose a ${field}.`;
  if (kind === 'nullableId') {
    return value === null || (typeof value === 'string' && /^\d+$/.test(value)) ? undefined : `Choose a ${field}, or clear it.`;
  }
  if (kind === 'date') {
    if (value === null) return undefined;
    if (typeof value === 'string') return isoDay.test(value) ? undefined : 'A date, written YYYY-MM-DD.';
    return typeof value === 'object' && value && 'relativeDays' in value ? undefined : 'A date, or a number of days from one.';
  }
  if (kind === 'percent') {
    return typeof value === 'number' && value >= 0 && value <= 100 ? undefined : 'A percentage from 0 to 100.';
  }
  return typeof value === 'number' && value >= 0 && value <= 10_000 ? undefined : 'Hours, from 0.';
}

const ACTIONS_BY_SUBJECT: Record<RuleSubjectType, RuleAction['type'][]> = {
  work_package: ['assign', 'notify', 'set_status', 'set_field', 'create_work_package', 'call_endpoint'],
  project: ['notify', 'create_work_package', 'call_endpoint'],
};

const ruleSchema = z.object({
  name: z.string().trim().min(1, 'A rule needs a name.').max(120),
  description: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => value || undefined),
  active: z.boolean().default(true),
  subjectType: z.enum(['work_package', 'project']).default('work_package'),
  events: z.array(z.string()).min(1, 'Choose at least one event.').max(10),
  projectIds: z.array(digits).max(500).default([]),
  conditions: z
    .object({
      match: z.enum(['all', 'any']).default('all'),
      conditions: z
        .array(
          z.object({
            field: z.string().min(1).max(40),
            operator: z.string() as z.ZodType<RuleConditionOperator>,
            value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string().max(200))]).optional(),
          }),
        )
        .max(20, 'At most twenty conditions.'),
    })
    .default({ match: 'all', conditions: [] }),
  fireMode: z.enum(['enter', 'every']).default('enter'),
  actions: z.array(action).min(1, 'A rule needs at least one action.').max(10, 'At most ten actions.'),
});

/** The first problem found, as a sentence — or the rule, normalised. */
export function validateRule(input: unknown): { ok: true; rule: AutomationRuleInput } | { ok: false; problem: string } {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problem: parsed.error.issues[0]?.message ?? 'That rule is not valid.' };
  const rule = parsed.data;

  const allowedEvents = EVENTS_BY_SUBJECT[rule.subjectType];
  const strange = rule.events.find((event) => !(allowedEvents as string[]).includes(event));
  if (strange) return { ok: false, problem: `"${strange}" is not an event a ${rule.subjectType.replace('_', ' ')} rule can watch.` };

  for (const condition of rule.conditions.conditions) {
    const problem = conditionProblem(rule.subjectType, condition as RuleCondition);
    if (problem) return { ok: false, problem };
  }

  for (const one of rule.actions as RuleAction[]) {
    if (!ACTIONS_BY_SUBJECT[rule.subjectType].includes(one.type)) {
      return { ok: false, problem: `A ${rule.subjectType.replace('_', ' ')} rule cannot ${one.type.replace('_', ' ')}.` };
    }
    if (one.type === 'assign' && one.to.kind !== 'nobody' && !SINGLE_PERSON.has(one.to.kind)) {
      return { ok: false, problem: 'Assign to one person: a user, the accountable person, the project owner or a manager.' };
    }
    if (one.type === 'set_field') {
      const problem = setFieldProblem(one.field, one.value);
      if (problem) return { ok: false, problem };
    }
    if (one.type === 'create_work_package') {
      if (rule.subjectType === 'project' && one.relation !== 'none') {
        return { ok: false, problem: 'A work package created for a project has nothing to relate to.' };
      }
      if (one.assignee && !SINGLE_PERSON.has(one.assignee.kind)) {
        return { ok: false, problem: 'The new work package is assigned to one person.' };
      }
    }
    const people = one.type === 'notify' ? one.recipients : one.type === 'assign' && one.to.kind !== 'nobody' ? [one.to] : [];
    if (people.some((person) => person.kind === 'approvers')) {
      return { ok: false, problem: '"The approvers" applies to escalating an approval, not to a rule.' };
    }
    if (rule.subjectType === 'project' && people.some((person) => ['assignee', 'responsible', 'author', 'team_lead', 'department_manager'].includes(person.kind))) {
      return { ok: false, problem: 'A project has no assignee: notify the owner, a role or named people.' };
    }
  }

  return { ok: true, rule: rule as AutomationRuleInput };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

export type FactValue = string | number | boolean | null | undefined | string[];

/** An item as the conditions see it. */
export interface RuleFacts {
  subjectType: RuleSubjectType;
  id: string;
  projectId: string;
  values: Record<string, FactValue>;
  /** Each custom field as a number where it is one, and as the text a person sees. */
  customFields: Record<string, { texts: string[]; number?: number }>;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function isEmpty(value: FactValue | { texts: string[]; number?: number }): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return value.texts.length === 0 && value.number === undefined;
  return false;
}

const DAY_MS = 86_400_000;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/** Whether one condition holds for an item at `now`. */
export function conditionHolds(condition: RuleCondition, facts: RuleFacts, now: Date): boolean {
  const custom = /^customField\d+$/.test(condition.field);
  const field = custom ? facts.customFields[condition.field] : undefined;
  const value: FactValue = custom ? (field ? (field.number ?? field.texts) : undefined) : facts.values[condition.field];
  const { operator } = condition;
  const expected = condition.value;

  if (operator === 'is_empty') return custom ? !field || isEmpty(field) : isEmpty(value);
  if (operator === 'is_set') return custom ? Boolean(field) && !isEmpty(field) : !isEmpty(value);

  // The candidate values an item has for a field, as text.
  const present = (): string[] => {
    if (custom) return field ? [...field.texts, ...(field.number !== undefined ? [String(field.number)] : [])] : [];
    if (Array.isArray(value)) return value.map(String);
    return value === null || value === undefined ? [] : [String(value)];
  };

  if (operator === 'in' || operator === 'not_in') {
    const wanted = (Array.isArray(expected) ? expected : expected === undefined ? [] : [String(expected)]).map(String);
    const hit = present().some((one) => wanted.some((want) => same(one, want)));
    return operator === 'in' ? hit : !hit;
  }

  const numberOf = (): number | undefined => {
    if (custom) return field?.number;
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  };

  if (operator === 'eq' || operator === 'neq') {
    let equal: boolean;
    if (typeof expected === 'boolean') equal = value === expected;
    else if (typeof expected === 'number') equal = numberOf() === expected;
    else equal = present().some((one) => same(one, String(expected ?? '')));
    return operator === 'eq' ? equal : !equal;
  }

  if (operator === 'contains' || operator === 'not_contains') {
    const needle = String(expected ?? '').trim().toLowerCase();
    const found = needle !== '' && present().some((one) => one.toLowerCase().includes(needle));
    return operator === 'contains' ? found : !found;
  }

  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
    const left = numberOf();
    if (left === undefined || typeof expected !== 'number') return false;
    if (operator === 'gt') return left > expected;
    if (operator === 'gte') return left >= expected;
    if (operator === 'lt') return left < expected;
    return left <= expected;
  }

  // Dates. A date field is a calendar day; a timestamp is compared exactly
  // where "days ago" is asked and by its day otherwise. UTC throughout.
  if (typeof value !== 'string' || value === '') return false;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(time)) return false;
  const day = dayOf(new Date(time));
  const today = dayOf(now);
  const days = typeof expected === 'number' ? expected : 0;
  const timestamp = value.length > 10;

  switch (operator) {
    case 'before_today':
      return day < today;
    case 'today_or_later':
      return day >= today;
    case 'within_next_days':
      return day >= today && day <= addDays(today, days);
    case 'more_than_days_ago':
      return timestamp ? now.getTime() - time > days * DAY_MS : day < addDays(today, -days);
    case 'less_than_days_ago':
      return timestamp ? now.getTime() - time < days * DAY_MS : day > addDays(today, -days);
    case 'on_or_before':
      return typeof expected === 'string' && day <= expected;
    case 'on_or_after':
      return typeof expected === 'string' && day >= expected;
    default:
      return false;
  }
}

/** Whether the whole group holds. No conditions: every item in scope matches. */
export function ruleMatches(group: RuleConditionGroup, facts: RuleFacts, now: Date): boolean {
  if (group.conditions.length === 0) return true;
  return group.match === 'any'
    ? group.conditions.some((condition) => conditionHolds(condition, facts, now))
    : group.conditions.every((condition) => conditionHolds(condition, facts, now));
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/** `{{key}}`-style placeholders; an unknown one renders empty, never as itself. */
export function renderTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, name: string) => values[name] ?? '');
}

/** A date for `set_field`: fixed, cleared, or so many days from today or the item's own date. */
export function resolveDate(value: RuleFieldValue, facts: RuleFacts, now: Date): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && 'relativeDays' in value) {
    const from = value.from ?? 'today';
    const base = from === 'today' ? dayOf(now) : (facts.values[from] as string | undefined);
    return base ? addDays(base.slice(0, 10), value.relativeDays) : undefined;
  }
  return undefined;
}

export const PERSON_WORDS: Record<PersonSpec['kind'], string> = {
  user: msg('a named person'),
  assignee: msg('the assignee'),
  responsible: msg('the accountable person'),
  author: msg('the author'),
  project_owner: msg('the project owner'),
  team_lead: msg("the assignee's team lead"),
  department_manager: msg("the assignee's department manager"),
  project_role: msg('everyone in a project role'),
  approvers: msg('the approvers'),
};
