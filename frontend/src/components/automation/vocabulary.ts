import { createElement } from 'react';

import { t } from '@/lib/i18n';
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
  { id: 'type', get label() { return t('Type'); }, kind: 'ids', options: 'types' },
  { id: 'priority', get label() { return t('Priority'); }, kind: 'ids', options: 'priorities' },
  { id: 'status', get label() { return t('Status'); }, kind: 'ids', options: 'statuses' },
  { id: 'status_category', get label() { return t('Open or closed'); }, kind: 'status_category' },
  { id: 'assignee', get label() { return t('Assignee'); }, kind: 'ids', options: 'users' },
  { id: 'responsible', get label() { return t('Accountable'); }, kind: 'ids', options: 'users' },
  { id: 'author', get label() { return t('Author'); }, kind: 'ids', options: 'users' },
  { id: 'project', get label() { return t('Project'); }, kind: 'ids', options: 'projects' },
  { id: 'portfolio', get label() { return t('Portfolio'); }, kind: 'ids', options: 'portfolios' },
  { id: 'subject', get label() { return t('Subject'); }, kind: 'text' },
  { id: 'startDate', get label() { return t('Start date'); }, kind: 'date' },
  { id: 'dueDate', get label() { return t('Due date'); }, kind: 'date' },
  { id: 'createdAt', get label() { return t('Created'); }, kind: 'date' },
  { id: 'updatedAt', get label() { return t('Last changed'); }, kind: 'date' },
  { id: 'estimatedHours', get label() { return t('Estimate (hours)'); }, kind: 'number' },
  { id: 'percentageDone', get label() { return t('% complete'); }, kind: 'number' },
];

const PROJECT_FIELDS: FieldDef[] = [
  { id: 'health', get label() { return t('Health'); }, kind: 'health', options: 'health' },
  { id: 'project', get label() { return t('Project'); }, kind: 'ids', options: 'projects' },
  { id: 'portfolio', get label() { return t('Portfolio'); }, kind: 'ids', options: 'portfolios' },
  { id: 'name', get label() { return t('Name'); }, kind: 'text' },
  { id: 'active', get label() { return t('Active'); }, kind: 'boolean' },
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
  get in() { return t('is one of'); },
  get not_in() { return t('is none of'); },
  get is_empty() { return t('is empty'); },
  get is_set() { return t('is set'); },
  get eq() { return t('is'); },
  get neq() { return t('is not'); },
  get contains() { return t('contains'); },
  get not_contains() { return t('does not contain'); },
  get gt() { return t('is above'); },
  get gte() { return t('is at least'); },
  get lt() { return t('is below'); },
  get lte() { return t('is at most'); },
  get before_today() { return t('is in the past'); },
  get today_or_later() { return t('is today or later'); },
  get within_next_days() { return t('is within the next … days'); },
  get more_than_days_ago() { return t('is more than … days ago'); },
  get less_than_days_ago() { return t('is less than … days ago'); },
  get on_or_before() { return t('is on or before'); },
  get on_or_after() { return t('is on or after'); },
};

/** Operators that take no value. */
export const VALUELESS = new Set<RuleConditionOperator>(['is_empty', 'is_set', 'before_today', 'today_or_later']);
export const DAY_COUNT = new Set<RuleConditionOperator>(['within_next_days', 'more_than_days_ago', 'less_than_days_ago']);

export const EVENT_WORDS: Record<RuleEventKind, string> = {
  get 'work_package.created'() { return t('A work package is created'); },
  get 'work_package.updated'() { return t('A work package is changed'); },
  get 'project.created'() { return t('A project is created'); },
  get 'project.updated'() { return t('A project is changed'); },
  get 'project.health_changed'() { return t('A project\'s health changes'); },
};

export const EVENTS_BY_SUBJECT: Record<RuleSubjectType, RuleEventKind[]> = {
  work_package: ['work_package.created', 'work_package.updated'],
  project: ['project.created', 'project.updated', 'project.health_changed'],
};

export const ACTION_WORDS: Record<RuleAction['type'], string> = {
  get assign() { return t('Assign'); },
  get notify() { return t('Notify'); },
  get set_status() { return t('Change the status'); },
  get set_field() { return t('Set a field'); },
  get create_work_package() { return t('Create a linked work package'); },
  get call_endpoint() { return t('Call an outside endpoint'); },
};

export const ACTIONS_BY_SUBJECT: Record<RuleSubjectType, RuleAction['type'][]> = {
  work_package: ['assign', 'notify', 'set_status', 'set_field', 'create_work_package', 'call_endpoint'],
  project: ['notify', 'create_work_package', 'call_endpoint'],
};

export const RELATION_WORDS: Record<RuleRelation, string> = {
  get relates() { return t('Relates to it'); },
  get blocks() { return t('It blocks the new one'); },
  get blocked() { return t('It is blocked by the new one'); },
  get follows() { return t('The new one follows it'); },
  get precedes() { return t('The new one precedes it'); },
  get child() { return t('As a child of it'); },
  get none() { return t('Not linked'); },
};

export const HEALTH_WORDS: Record<string, string> = {
  get healthy() { return t('Healthy'); },
  get warning() { return t('At risk'); },
  get critical() { return t('Critical'); },
};

export const PERSON_WORDS: Record<PersonSpec['kind'], string> = {
  get user() { return t('A named person'); },
  get assignee() { return t('The assignee'); },
  get responsible() { return t('The accountable person'); },
  get author() { return t('The author'); },
  get project_owner() { return t('The project owner'); },
  get team_lead() { return t('The assignee\'s team lead'); },
  get department_manager() { return t('The assignee\'s department manager'); },
  get project_role() { return t('Everyone in a project role'); },
  get approvers() { return t('The approvers'); },
};

export const TRIGGER_WORDS: Record<EscalationTrigger, { label: string; unit: 'days' | 'hours'; explain: string }> = {
  untouched: {
    get label() { return t('Untouched work'); },
    unit: 'days',
    get explain() { return t('Open work nobody has changed for this many days.'); },
  },
  overdue: {
    get label() { return t('Overdue work'); },
    unit: 'days',
    get explain() { return t('Open work this many days past its due date.'); },
  },
  approval_sla: {
    get label() { return t('Approvals past their SLA'); },
    unit: 'hours',
    get explain() { return t('An approval step this many hours past its own SLA, after the step\'s escalation contact was told.'); },
  },
};

export const SETTABLE_FIELDS: { id: string; label: string }[] = [
  { id: 'priority', get label() { return t('Priority'); } },
  { id: 'dueDate', get label() { return t('Due date'); } },
  { id: 'startDate', get label() { return t('Start date'); } },
  { id: 'responsible', get label() { return t('Accountable'); } },
  { id: 'percentageDone', get label() { return t('% complete'); } },
  { id: 'estimatedHours', get label() { return t('Estimate (hours)'); } },
];

const PLACEHOLDERS =
  '{{key}} {{subject}} {{project}} {{status}} {{priority}} {{type}} {{assignee}} {{dueDate}} {{health}} {{url}} {{rule}}';

/**
 * The placeholders a message template may use. An element rather than a
 * string, so that the word in front of them is translated when the hint is
 * shown rather than once at import; the tokens themselves are code and are
 * passed in whole, since a message cannot hold literal braces.
 */
function PlaceholderHint() {
  return t('Placeholders: {list}', { list: PLACEHOLDERS });
}

export const PLACEHOLDER_HINT = createElement(PlaceholderHint);
