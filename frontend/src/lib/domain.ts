import type {
  ActivityAction,
  ConnectionState,
  DocumentKind,
  HealthLevel,
  NotificationCategory,
  ProjectStatus,
  SprintState,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '@/types';

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

export const TASK_STATUS_META: Record<TaskStatus, StateMeta> = {
  backlog: { label: 'Backlog', tone: 'neutral', description: 'Not yet scheduled' },
  todo: { label: 'To Do', tone: 'primary', description: 'Scheduled, not started' },
  in_progress: { label: 'In Progress', tone: 'accent', description: 'Actively being worked on' },
  review: { label: 'Review', tone: 'highlight', description: 'Awaiting review or approval' },
  done: { label: 'Done', tone: 'success', description: 'Completed' },
  blocked: { label: 'Blocked', tone: 'danger', description: 'Blocked by a dependency' },
};

/** Column order used by the board, filters and status distribution charts. */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
];

export const ALL_TASK_STATUSES: TaskStatus[] = [...TASK_STATUS_ORDER, 'blocked'];

export const OPEN_TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'blocked'];

/* -------------------------------------------------------------------------- */
/* Priority                                                                    */
/* -------------------------------------------------------------------------- */

export const TASK_PRIORITY_META: Record<TaskPriority, StateMeta & { rank: number }> = {
  critical: { label: 'Critical', tone: 'danger', rank: 0, description: 'Needs immediate attention' },
  high: { label: 'High', tone: 'warning', rank: 1, description: 'Elevated priority' },
  medium: { label: 'Medium', tone: 'primary', rank: 2, description: 'Standard priority' },
  low: { label: 'Low', tone: 'neutral', rank: 3, description: 'Can be deferred' },
};

export const ALL_TASK_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

/* -------------------------------------------------------------------------- */
/* Work package type                                                           */
/* -------------------------------------------------------------------------- */

export const TASK_TYPE_META: Record<TaskType, StateMeta> = {
  task: { label: 'Task', tone: 'primary' },
  bug: { label: 'Bug', tone: 'danger' },
  feature: { label: 'Feature', tone: 'accent' },
  epic: { label: 'Epic', tone: 'highlight' },
  milestone: { label: 'Milestone', tone: 'warning' },
  support: { label: 'Support', tone: 'neutral' },
};

export const ALL_TASK_TYPES: TaskType[] = ['task', 'feature', 'bug', 'epic', 'milestone', 'support'];

/* -------------------------------------------------------------------------- */
/* Project status and health                                                   */
/* -------------------------------------------------------------------------- */

export const PROJECT_STATUS_META: Record<ProjectStatus, StateMeta> = {
  on_track: { label: 'On Track', tone: 'success', description: 'Delivery is on plan' },
  at_risk: { label: 'At Risk', tone: 'warning', description: 'Schedule or scope pressure' },
  delayed: { label: 'Delayed', tone: 'danger', description: 'Behind the committed plan' },
  completed: { label: 'Completed', tone: 'primary', description: 'Delivered and closed' },
  paused: { label: 'Paused', tone: 'neutral', description: 'Temporarily on hold' },
};

export const ALL_PROJECT_STATUSES: ProjectStatus[] = [
  'on_track',
  'at_risk',
  'delayed',
  'completed',
  'paused',
];

export const HEALTH_META: Record<HealthLevel, StateMeta> = {
  healthy: { label: 'Healthy', tone: 'success' },
  warning: { label: 'Warning', tone: 'warning' },
  critical: { label: 'Critical', tone: 'danger' },
};

/** Compact word used inside the portfolio matrix. */
export const HEALTH_MATRIX_LABEL: Record<HealthLevel, string> = {
  healthy: 'Good',
  warning: 'Risk',
  critical: 'Critical',
};

/* -------------------------------------------------------------------------- */
/* Sprints                                                                     */
/* -------------------------------------------------------------------------- */

export const SPRINT_STATE_META: Record<SprintState, StateMeta> = {
  planned: { label: 'Planned', tone: 'neutral' },
  active: { label: 'Active', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
};

/* -------------------------------------------------------------------------- */
/* Activity and notifications                                                  */
/* -------------------------------------------------------------------------- */

export const ACTIVITY_ACTION_LABEL: Record<ActivityAction, string> = {
  created: 'created',
  updated: 'updated',
  commented: 'commented on',
  completed: 'completed',
  assigned: 'assigned',
  status_changed: 'changed the status of',
  uploaded: 'uploaded',
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
  mention: { label: 'Mention', tone: 'highlight' },
  assignment: { label: 'Assignment', tone: 'primary' },
  project_update: { label: 'Project Update', tone: 'accent' },
  deadline: { label: 'Deadline', tone: 'warning' },
  system: { label: 'System', tone: 'neutral' },
};

/* -------------------------------------------------------------------------- */
/* Documents and integrations                                                  */
/* -------------------------------------------------------------------------- */

export const DOCUMENT_KIND_META: Record<DocumentKind, StateMeta & { extension: string }> = {
  pdf: { label: 'PDF', tone: 'danger', extension: 'pdf' },
  doc: { label: 'Document', tone: 'primary', extension: 'docx' },
  sheet: { label: 'Spreadsheet', tone: 'success', extension: 'xlsx' },
  slide: { label: 'Presentation', tone: 'warning', extension: 'pptx' },
  image: { label: 'Image', tone: 'highlight', extension: 'png' },
  archive: { label: 'Archive', tone: 'neutral', extension: 'zip' },
  markdown: { label: 'Markdown', tone: 'accent', extension: 'md' },
};

export const CONNECTION_STATE_META: Record<ConnectionState, StateMeta> = {
  connected: { label: 'Connected', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  disconnected: { label: 'Disconnected', tone: 'danger' },
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

/** Soft badge surface + readable text for a tone. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-muted-foreground border-border',
  primary: 'bg-primary-soft text-primary-dark border-primary/20 dark:text-primary',
  success: 'bg-success-soft text-success border-success/20',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-danger border-danger/20',
  accent: 'bg-accent-soft text-accent border-accent/20',
  highlight: 'bg-highlight-soft text-highlight border-highlight/20',
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  accent: 'text-accent',
  highlight: 'text-highlight',
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

export function statusColorVar(status: TaskStatus): string {
  return TONE_VAR[TASK_STATUS_META[status].tone];
}

export function projectStatusColorVar(status: ProjectStatus): string {
  return TONE_VAR[PROJECT_STATUS_META[status].tone];
}
