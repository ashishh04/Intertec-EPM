import type {
  ActivityAction,
  ConnectionState,
  DocumentKind,
  HealthCriterion,
  HealthLevel,
  HealthUnit,
  NotificationCategory,
  NotificationReason,
  ProjectStatus,
  SprintState,
  TaskPriority,
  TaskStatusCategory,
  TaskType,
} from '@/types';
import { t } from '@/lib/i18n';

/**
 * A single source of truth for how state is expressed in the UI.
 *
 * Every badge, chart, board column and table cell reads its label and tone from
 * here, so the status system stays identical across the whole product. Each
 * entry also carries a non-colour signal (shape/icon/label) so state is never
 * communicated by colour alone.
 */

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'highlight';

export interface StateMeta {
  label: string;
  tone: Tone;
  /** Short description surfaced in tooltips and screen-reader text. */
  description?: string;
}

/* -------------------------------------------------------------------------- */
/* Task status                                                                 */
/* -------------------------------------------------------------------------- */

// Labels are getters: they are read where they are shown, in the reader's language.
export const TASK_STATUS_META: Record<TaskStatusCategory, StateMeta> = {
  backlog: { get label() { return t('Backlog'); }, tone: 'neutral', get description() { return t('Not yet scheduled'); } },
  todo: { get label() { return t('To Do'); }, tone: 'primary', get description() { return t('Scheduled, not started'); } },
  in_progress: { get label() { return t('In Progress'); }, tone: 'accent', get description() { return t('Actively being worked on'); } },
  review: { get label() { return t('Review'); }, tone: 'highlight', get description() { return t('Awaiting review or approval'); } },
  done: { get label() { return t('Done'); }, tone: 'success', get description() { return t('Completed'); } },
  blocked: { get label() { return t('Blocked'); }, tone: 'danger', get description() { return t('Blocked by a dependency'); } },
};

/** Column order used by the board, filters and status distribution charts. */
export const TASK_STATUS_ORDER: TaskStatusCategory[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
];

export const ALL_TASK_STATUSES: TaskStatusCategory[] = [...TASK_STATUS_ORDER, 'blocked'];

/* -------------------------------------------------------------------------- */
/* Priority                                                                    */
/* -------------------------------------------------------------------------- */

export const TASK_PRIORITY_META: Record<TaskPriority, StateMeta & { rank: number }> = {
  critical: { get label() { return t('Critical'); }, tone: 'danger', rank: 0, get description() { return t('Needs immediate attention'); } },
  high: { get label() { return t('High'); }, tone: 'warning', rank: 1, get description() { return t('Elevated priority'); } },
  medium: { get label() { return t('Medium'); }, tone: 'primary', rank: 2, get description() { return t('Standard priority'); } },
  low: { get label() { return t('Low'); }, tone: 'neutral', rank: 3, get description() { return t('Can be deferred'); } },
};

export const ALL_TASK_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

/* -------------------------------------------------------------------------- */
/* Work package type                                                           */
/* -------------------------------------------------------------------------- */

export const TASK_TYPE_META: Record<TaskType, StateMeta> = {
  task: { get label() { return t('Task'); }, tone: 'primary' },
  bug: { get label() { return t('Bug'); }, tone: 'danger' },
  feature: { get label() { return t('Feature'); }, tone: 'accent' },
  epic: { get label() { return t('Epic'); }, tone: 'highlight' },
  milestone: { get label() { return t('Milestone'); }, tone: 'warning' },
  support: { get label() { return t('Support'); }, tone: 'neutral' },
};

export const ALL_TASK_TYPES: TaskType[] = ['task', 'feature', 'bug', 'epic', 'milestone', 'support'];

/* -------------------------------------------------------------------------- */
/* Project status and health                                                   */
/* -------------------------------------------------------------------------- */

export const PROJECT_STATUS_META: Record<ProjectStatus, StateMeta> = {
  on_track: { get label() { return t('On Track'); }, tone: 'success', get description() { return t('Delivery is on plan'); } },
  at_risk: { get label() { return t('At Risk'); }, tone: 'warning', get description() { return t('Schedule or scope pressure'); } },
  delayed: { get label() { return t('Delayed'); }, tone: 'danger', get description() { return t('Behind the committed plan'); } },
  completed: { get label() { return t('Completed'); }, tone: 'primary', get description() { return t('Delivered and closed'); } },
  paused: { get label() { return t('Paused'); }, tone: 'neutral', get description() { return t('Temporarily on hold'); } },
};

export const ALL_PROJECT_STATUSES: ProjectStatus[] = [
  'on_track',
  'at_risk',
  'delayed',
  'completed',
  'paused',
];

export const HEALTH_META: Record<HealthLevel, StateMeta> = {
  healthy: { get label() { return t('Healthy'); }, tone: 'success' },
  warning: { get label() { return t('Warning'); }, tone: 'warning' },
  critical: { get label() { return t('Critical'); }, tone: 'danger' },
};

/**
 * A criterion that could not be measured — no planned finish, no budget, no
 * risk type. Neutral on purpose: borrowing green's colour for it is how a
 * project with no budget used to read as on budget.
 */
export const HEALTH_NOT_ASSESSED: StateMeta = {
  get label() {
    return t('Not assessed');
  },
  tone: 'neutral',
  get description() {
    return t('There is nothing to measure this against yet.');
  },
};

/** The health criteria (BR-204), in the order they are shown everywhere. */
export const HEALTH_CRITERIA_META: {
  key: HealthCriterion;
  label: string;
  short: string;
  unit: HealthUnit;
  hint: string;
}[] = [
  {
    key: 'schedule',
    get label() { return t('Schedule variance'); },
    get short() { return t('Schedule'); },
    unit: 'days',
    get hint() { return t('Days the forecast finish is past the planned finish.'); },
  },
  {
    key: 'budget',
    get label() { return t('Budget variance'); },
    get short() { return t('Budget'); },
    unit: 'percent',
    get hint() { return t('Spend ahead of the budget planned to date, as a share of the budget.'); },
  },
  {
    key: 'risks',
    get label() { return t('Open high risks'); },
    get short() { return t('Risks'); },
    unit: 'count',
    get hint() { return t('Open risks at high priority.'); },
  },
  {
    key: 'overdue',
    get label() { return t('Overdue items'); },
    get short() { return t('Overdue'); },
    unit: 'count',
    get hint() { return t('Open work packages past their due date.'); },
  },
];

/** "+12 days", "-3.5%", "4" — a criterion's measured figure in its unit. */
export function formatHealthValue(value: number | null, unit: HealthUnit): string {
  if (value === null) return '—';
  const sign = unit !== 'count' && value > 0 ? '+' : '';
  if (unit === 'days') return `${sign}${t('{days, plural, one {# day} other {# days}}', { days: value })}`;
  if (unit === 'percent') return `${sign}${value}%`;
  return String(value);
}

/** Compact word used inside the portfolio matrix. */
export const HEALTH_MATRIX_LABEL: Record<HealthLevel, string> = {
  get healthy() {
    return t('Good');
  },
  get warning() {
    return t('Risk');
  },
  get critical() {
    return t('Critical');
  },
};

/* -------------------------------------------------------------------------- */
/* Sprints                                                                     */
/* -------------------------------------------------------------------------- */

export const SPRINT_STATE_META: Record<SprintState, StateMeta> = {
  planned: { get label() { return t('Planned'); }, tone: 'neutral' },
  active: { get label() { return t('Active'); }, tone: 'accent' },
  completed: { get label() { return t('Completed'); }, tone: 'success' },
};

/* -------------------------------------------------------------------------- */
/* Activity and notifications                                                  */
/* -------------------------------------------------------------------------- */

/** The verb between the person and the thing, in "Sara created Payroll export". */
export const ACTIVITY_ACTION_LABEL: Record<ActivityAction, string> = {
  get created() { return t('created'); },
  get updated() { return t('updated'); },
  get commented() { return t('commented on'); },
  get completed() { return t('completed'); },
  get assigned() { return t('assigned'); },
  get status_changed() { return t('changed the status of'); },
  get uploaded() { return t('uploaded'); },
};

export const ACTIVITY_ACTION_TONE: Record<ActivityAction, Tone> = {
  created: 'primary',
  updated: 'neutral',
  commented: 'highlight',
  completed: 'success',
  assigned: 'accent',
  status_changed: 'warning',
  uploaded: 'neutral',
};

export const NOTIFICATION_CATEGORY_META: Record<NotificationCategory, StateMeta> = {
  mention: { get label() { return t('Mention'); }, tone: 'highlight' },
  assignment: { get label() { return t('Assignment'); }, tone: 'primary' },
  project_update: { get label() { return t('Project Update'); }, tone: 'accent' },
  deadline: { get label() { return t('Deadline'); }, tone: 'warning' },
  system: { get label() { return t('System'); }, tone: 'neutral' },
};

/**
 * Why each notification exists, in the reader's words.
 *
 * Reasons, not categories: this is what somebody filtering their feed thinks in —
 * "show me only what I was mentioned in" — and it matches the switches in Settings
 * one for one, so turning a filter's subject off in Settings makes that filter
 * empty rather than leaving the two describing different things.
 */
export const NOTIFICATION_REASON_META: Record<NotificationReason, StateMeta> = {
  mentioned: { get label() { return t('Mentioned'); }, tone: 'highlight' },
  assignee: { get label() { return t('Assignee'); }, tone: 'primary' },
  accountable: { get label() { return t('Accountable'); }, tone: 'primary' },
  watcher: { get label() { return t('Watcher'); }, tone: 'accent' },
  dateAlert: { get label() { return t('Date alert'); }, tone: 'warning' },
  reminder: { get label() { return t('Reminder'); }, tone: 'warning' },
  shared: { get label() { return t('Shared'); }, tone: 'highlight' },
  commented: { get label() { return t('Activity'); }, tone: 'accent' },
  epm: { get label() { return t('Project update'); }, tone: 'neutral' },
};

/* -------------------------------------------------------------------------- */
/* Documents and integrations                                                  */
/* -------------------------------------------------------------------------- */

export const DOCUMENT_KIND_META: Record<DocumentKind, StateMeta & { extension: string }> = {
  // PDF and Markdown are format names, the same in every language.
  pdf: { label: 'PDF', tone: 'danger', extension: 'pdf' },
  doc: { get label() { return t('Document'); }, tone: 'primary', extension: 'docx' },
  sheet: { get label() { return t('Spreadsheet'); }, tone: 'success', extension: 'xlsx' },
  slide: { get label() { return t('Presentation'); }, tone: 'warning', extension: 'pptx' },
  image: { get label() { return t('Image'); }, tone: 'highlight', extension: 'png' },
  archive: { get label() { return t('Archive'); }, tone: 'neutral', extension: 'zip' },
  markdown: { label: 'Markdown', tone: 'accent', extension: 'md' },
};

export const CONNECTION_STATE_META: Record<ConnectionState, StateMeta> = {
  connected: { get label() { return t('Connected'); }, tone: 'success' },
  degraded: { get label() { return t('Degraded'); }, tone: 'warning' },
  disconnected: { get label() { return t('Disconnected'); }, tone: 'danger' },
};

/* -------------------------------------------------------------------------- */
/* Tone helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Solid dot / bar fill for a tone. */
export const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-neutral',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent',
  highlight: 'bg-highlight',
};

/**
 * Soft badge surface + readable text for a tone.
 *
 * Text uses the `-strong` step, not the vivid base: badge labels render at
 * 11px, and the vivid green and amber measure 2.49:1 and 2.10:1 against their
 * own soft surfaces. The `-strong` step is the same hue darkened until it
 * clears 4.5:1.
 */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-muted-foreground border-border',
  primary: 'bg-primary-soft text-primary-dark border-primary/20',
  success: 'bg-success-soft text-success-strong border-success/20',
  warning: 'bg-warning-soft text-warning-strong border-warning/25',
  danger: 'bg-danger-soft text-danger-strong border-danger/20',
  accent: 'bg-accent-soft text-accent-strong border-accent/20',
  highlight: 'bg-highlight-soft text-highlight-strong border-highlight/20',
};

/** Tone as bare text on the page. Same reasoning as `TONE_SOFT`. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  primary: 'text-primary',
  success: 'text-success-strong',
  warning: 'text-warning-strong',
  danger: 'text-danger-strong',
  accent: 'text-accent-strong',
  highlight: 'text-highlight-strong',
};

/** Chart-safe CSS colour reference for a tone. */
export const TONE_VAR: Record<Tone, string> = {
  neutral: 'hsl(var(--neutral))',
  primary: 'hsl(var(--primary))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  danger: 'hsl(var(--danger))',
  accent: 'hsl(var(--accent))',
  highlight: 'hsl(var(--highlight))',
};

