import type {
  AutomationOptions,
  EscalationTrigger,
  PersonSpec,
  RuleAction,
  RuleConditionOperator,
  RuleEventKind,
  RuleRelation,
  RuleSubjectType,
} from '@/types';

/**
 * The words the rule and escalation editors use. The backend checks the same
 * vocabulary (`domain/rule-model.ts`); this is how it reads to a person.
 */

export type FieldKind = 'ids' | 'text' | 'date' | 'number' | 'status_category' | 'health' | 'boolean' | 'custom_number' | 'custom_text';
export type OptionList = 'types' | 'statuses' | 'priorities' | 'projects' | 'portfolios' | 'users' | 'health';

export interface FieldDef {
  id: string;
  label: string;
  kind: FieldKind;
  options?: OptionList;
}

const WORK_PACKAGE_FIELDS: FieldDef[] = [
  { id: 'type', label: 'Type', kind: 'ids', options: 'types' },
  { id: 'priority', label: 'Priority', kind: 'ids', options: 'priorities' },
  { id: 'status', label: 'Status', kind: 'ids', options: 'statuses' },
  { id: 'status_category', label: 'Open or closed', kind: 'status_category' },
  { id: 'assignee', label: 'Assignee', kind: 'ids', options: 'users' },
  { id: 'responsible', label: 'Accountable', kind: 'ids', options: 'users' },
  { id: 'author', label: 'Author', kind: 'ids', options: 'users' },
  { id: 'project', label: 'Project', kind: 'ids', options: 'projects' },
  { id: 'portfolio', label: 'Portfolio', kind: 'ids', options: 'portfolios' },
  { id: 'subject', label: 'Subject', kind: 'text' },
  { id: 'startDate', label: 'Start date', kind: 'date' },
  { id: 'dueDate', label: 'Due date', kind: 'date' },
  { id: 'createdAt', label: 'Created', kind: 'date' },
  { id: 'updatedAt', label: 'Last changed', kind: 'date' },
  { id: 'estimatedHours', label: 'Estimate (hours)', kind: 'number' },
  { id: 'percentageDone', label: '% complete', kind: 'number' },
];

const PROJECT_FIELDS: FieldDef[] = [
  { id: 'health', label: 'Health', kind: 'health', options: 'health' },
  { id: 'project', label: 'Project', kind: 'ids', options: 'projects' },
  { id: 'portfolio', label: 'Portfolio', kind: 'ids', options: 'portfolios' },
  { id: 'name', label: 'Name', kind: 'text' },
  { id: 'active', label: 'Active', kind: 'boolean' },
];

/** The fields a rule on this subject can test, custom fields included for work packages. */
export function fieldsFor(subjectType: RuleSubjectType, options?: AutomationOptions): FieldDef[] {
  if (subjectType === 'project') return PROJECT_FIELDS;
  return [
    ...WORK_PACKAGE_FIELDS,
    ...(options?.customFields ?? []).map((field) => ({
      id: field.id,
      label: field.name,
      kind: (field.numeric ? 'custom_number' : 'custom_text') as FieldKind,
    })),
  ];
}

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

export const OPERATORS_BY_KIND: Record<FieldKind, RuleConditionOperator[]> = {
  ids: ['in', 'not_in', 'is_empty', 'is_set'],
  text: ['contains', 'not_contains', 'eq', 'neq', 'is_empty', 'is_set'],
  date: DATE_OPERATORS,
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'is_empty', 'is_set'],
  status_category: ['eq'],
  health: ['in', 'not_in'],
  boolean: ['eq'],
  custom_number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'is_empty', 'is_set'],
  custom_text: ['eq', 'neq', 'contains', 'not_contains', 'is_empty', 'is_set'],
};

export const OPERATOR_WORDS: Record<RuleConditionOperator, string> = {
  in: 'is one of',
  not_in: 'is none of',
  is_empty: 'is empty',
  is_set: 'is set',
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  gt: 'is above',
  gte: 'is at least',
  lt: 'is below',
  lte: 'is at most',
  before_today: 'is in the past',
  today_or_later: 'is today or later',
  within_next_days: 'is within the next … days',
  more_than_days_ago: 'is more than … days ago',
  less_than_days_ago: 'is less than … days ago',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
};

/** Operators that take no value. */
export const VALUELESS = new Set<RuleConditionOperator>(['is_empty', 'is_set', 'before_today', 'today_or_later']);
export const DAY_COUNT = new Set<RuleConditionOperator>(['within_next_days', 'more_than_days_ago', 'less_than_days_ago']);

export const EVENT_WORDS: Record<RuleEventKind, string> = {
  'work_package.created': 'A work package is created',
  'work_package.updated': 'A work package is changed',
  'project.created': 'A project is created',
  'project.updated': 'A project is changed',
  'project.health_changed': "A project's health changes",
};

export const EVENTS_BY_SUBJECT: Record<RuleSubjectType, RuleEventKind[]> = {
  work_package: ['work_package.created', 'work_package.updated'],
  project: ['project.created', 'project.updated', 'project.health_changed'],
};

export const ACTION_WORDS: Record<RuleAction['type'], string> = {
  assign: 'Assign',
  notify: 'Notify',
  set_status: 'Change the status',
  set_field: 'Set a field',
  create_work_package: 'Create a linked work package',
  call_endpoint: 'Call an outside endpoint',
};

export const ACTIONS_BY_SUBJECT: Record<RuleSubjectType, RuleAction['type'][]> = {
  work_package: ['assign', 'notify', 'set_status', 'set_field', 'create_work_package', 'call_endpoint'],
  project: ['notify', 'create_work_package', 'call_endpoint'],
};

export const RELATION_WORDS: Record<RuleRelation, string> = {
  relates: 'Relates to it',
  blocks: 'It blocks the new one',
  blocked: 'It is blocked by the new one',
  follows: 'The new one follows it',
  precedes: 'The new one precedes it',
  child: 'As a child of it',
  none: 'Not linked',
};

export const HEALTH_WORDS: Record<string, string> = { healthy: 'Healthy', warning: 'At risk', critical: 'Critical' };

export const PERSON_WORDS: Record<PersonSpec['kind'], string> = {
  user: 'A named person',
  assignee: 'The assignee',
  responsible: 'The accountable person',
  author: 'The author',
  project_owner: 'The project owner',
  team_lead: "The assignee's team lead",
  department_manager: "The assignee's department manager",
  project_role: 'Everyone in a project role',
  approvers: 'The approvers',
};

export const TRIGGER_WORDS: Record<EscalationTrigger, { label: string; unit: 'days' | 'hours'; explain: string }> = {
  untouched: {
    label: 'Untouched work',
    unit: 'days',
    explain: 'Open work nobody has changed for this many days.',
  },
  overdue: {
    label: 'Overdue work',
    unit: 'days',
    explain: 'Open work this many days past its due date.',
  },
  approval_sla: {
    label: 'Approvals past their SLA',
    unit: 'hours',
    explain: "An approval step this many hours past its own SLA, after the step's escalation contact was told.",
  },
};

export const SETTABLE_FIELDS: { id: string; label: string }[] = [
  { id: 'priority', label: 'Priority' },
  { id: 'dueDate', label: 'Due date' },
  { id: 'startDate', label: 'Start date' },
  { id: 'responsible', label: 'Accountable' },
  { id: 'percentageDone', label: '% complete' },
  { id: 'estimatedHours', label: 'Estimate (hours)' },
];

export const PLACEHOLDER_HINT =
  'Placeholders: {{key}} {{subject}} {{project}} {{status}} {{priority}} {{type}} {{assignee}} {{dueDate}} {{health}} {{url}} {{rule}}';
