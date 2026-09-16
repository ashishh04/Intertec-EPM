/**
 * Normalized EPM domain models.
 *
 * These are deliberately NOT OpenProject API shapes. The EPM backend adapter is
 * responsible for transforming OpenProject `_embedded`/`_links` HAL payloads into
 * these flat, UI-friendly models, so the frontend never has to know about
 * OpenProject's internal schema, HAL links, or API versioning.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** ISO-8601 date string, e.g. "2026-09-18" or "2026-09-18T14:32:00Z". */
export type ISODate = string;

export type ID = string;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/* -------------------------------------------------------------------------- */
/* People, teams, permissions                                                  */
/* -------------------------------------------------------------------------- */

export type UserStatus = 'online' | 'away' | 'offline';

export type AvatarAccent = 'blue' | 'teal' | 'violet' | 'amber' | 'rose' | 'slate';

export interface EpmUser {
  id: ID;
  name: string;
  /**
   * The two halves of the name, as the directory stores them. Present so a
   * person can edit their own name without EPM guessing where to split the
   * display form. Empty for a principal the caller may not read in full.
   */
  firstName: string;
  lastName: string;
  initials: string;
  email: string;
  role: string;
  department: string;
  avatarUrl?: string;
  status: UserStatus;
  timezone: string;
  /** Deterministic accent used for the generated initials avatar. */
  accent: AvatarAccent;
}

/**
 * The account's state in OpenProject.
 *
 * Not `UserStatus` above, which is a presence indicator. `invited` means an
 * invitation was sent and not yet accepted; `locked` is deactivation, and is
 * reversible.
 */
export type AccountStatus = 'active' | 'invited' | 'registered' | 'locked';

/**
 * What OpenProject says this caller may do to this account, read from the
 * resource's own links rather than inferred from a role.
 *
 * The set varies by state, which is why it is per account and not per caller:
 * an active user offers `lock`, a locked one offers `unlock`, and an invited
 * one offers neither. `delete` appears only when the instance permits deletion
 * at all — it is disabled by default, and no capability advertises it.
 */
export interface AccountAffordances {
  update: boolean;
  lock: boolean;
  unlock: boolean;
  remove: boolean;
}

/**
 * A person as the administration surface sees them.
 *
 * Distinct from `EpmUser`, which is the read-only directory entry every other
 * screen uses and which carries no account state. Nothing here is stored by
 * EPM: accounts are OpenProject's, and this is a view of them.
 */
/**
 * The signed-in user, with what they may do and whether they are held at the
 * door.
 *
 * `mustChangePassword` is EPM's own gate: an administrator who creates a person
 * chooses their first password, and that is a handover credential rather than
 * the person's own. The upstream API cannot express this — it has the column
 * but ignores the field — so EPM enforces it around its own session.
 */
export interface EpmSession extends EpmUser {
  permissions: Record<string, Record<string, boolean>>;
  projectPermissions: Record<string, Record<string, Record<string, boolean>>>;
  mustChangePassword: boolean;
}

export interface EpmAccount {
  id: ID;
  login: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  /** Instance administrator upstream. Unrelated to any EPM permission. */
  admin: boolean;
  status: AccountStatus;
  language?: string;
  createdAt: ISODate;
  can: AccountAffordances;
}

export interface TeamMemberWorkload {
  userId: ID;
  /**
   * Hours logged this week as a percentage of weekly capacity.
   *
   * Not clamped: over 100 means overallocated, which is the single most useful
   * thing this figure can say. `null` when capacity is zero — there is nothing
   * to divide by, and reporting 0 would read as "nothing logged".
   */
  allocation: number | null;
  assignedTasks: number;
  completedThisSprint: number;
  /** Hours logged in the current week, matching the capacity period. */
  hoursLogged: number;
  hoursCapacity: number;
}

/** Coarse UI permission model. The real boundary is enforced by the EPM backend. */
/**
 * EPM permissions, mirroring the backend vocabulary.
 *
 * These are derived from the signed-in user's OpenProject capabilities. They
 * decide what the UI offers; the backend decides what actually happens, and
 * never trusts these.
 */
export type Permission =
  | 'project:view'
  | 'project:create'
  | 'project:edit'
  | 'project:archive'
  | 'task:view'
  | 'task:create'
  | 'task:edit'
  | 'task:delete'
  | 'task:assign'
  | 'task:status_change'
  | 'member:view'
  | 'member:manage'
  | 'sprint:view'
  | 'sprint:manage'
  | 'time:view'
  | 'time:log'
  | 'document:view'
  | 'document:upload'
  | 'users:manage'
  | 'groups:manage'
  | 'departments:manage'
  | 'employees:manage'
  | 'health:manage'
  | 'portfolios:manage'
  | 'analytics:manage'
  | 'teams:manage'
  | 'roles:manage'
  | 'system:manage';

/** Nested permission map as returned by `GET /me`. */
export type PermissionMap = Record<string, Record<string, boolean>>;

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export type ProjectStatus = 'on_track' | 'at_risk' | 'delayed' | 'completed' | 'paused';

export type HealthLevel = 'healthy' | 'warning' | 'critical';

/** The four measured dimensions, plus the overall derived from them. */
export type HealthDimension = 'scope' | 'schedule' | 'resources' | 'budget' | 'overall';

/** A partial pin over the calculated values. Absent means "not overridden". */
export type HealthOverride = Partial<Record<HealthDimension, HealthLevel>>;

export interface ProjectHealth {
  scope: HealthLevel;
  schedule: HealthLevel;
  resources: HealthLevel;
  budget: HealthLevel;
  overall: HealthLevel;
}

export interface EpmProject {
  id: ID;
  /** Human-readable short code, e.g. "AOP". Maps to the OpenProject identifier. */
  identifier: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  /** 0-100 completion. */
  progress: number;
  ownerId: ID;
  memberIds: ID[];
  startDate?: ISODate;
  dueDate?: ISODate;
  priority: TaskPriority;
  /**
   * Effective health: what the rules produced, with any overridden dimension
   * replaced. This is the value to display — every existing consumer reads it.
   */
  health: ProjectHealth;
  /**
   * What the rules produced, always, override or not. Kept visible so a pin
   * never hides the signal underneath it from whoever is reading.
   */
  healthCalculated: ProjectHealth;
  /** Present only where a dimension has been pinned. */
  healthOverride?: HealthOverride;
  /** One plain sentence per dimension naming the figures it came from. */
  healthReasons: Record<HealthDimension, string>;
  taskCount: number;
  completedTaskCount: number;
  openRiskCount: number;
  /**
   * The portfolio's name, resolved for display. Falls back to the legacy
   * free-text column for a project that has not been linked yet.
   */
  portfolio: string;
  /** The linked portfolio, where there is one. Absent means unassigned. */
  portfolioId?: ID;
  /**
   * The project this one sits under in the delivery hierarchy, where there is
   * one. Upstream's own `parent` link, not an EPM overlay — so a hierarchy
   * built in the instance shows here without EPM being told about it.
   */
  parentId?: ID;
  /** The parent's name, resolved for display. Absent when there is no parent. */
  parentName?: string;
  budgetUsed: number;
  budgetTotal: number;
  /**
   * What the caller may do to the project itself, read from the resource's own
   * links rather than inferred. Deleting is published only where the instance
   * and the caller both allow it, so a UI that offered it unconditionally would
   * be offering something upstream refuses.
   */
  can: {
    archive: boolean;
    /** Permanent, and takes every work package in the project with it. */
    remove: boolean;
  };
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Milestone {
  id: ID;
  projectId: ID;
  name: string;
  date: ISODate;
  status: 'completed' | 'in_progress' | 'upcoming';
}

/* -------------------------------------------------------------------------- */
/* Project membership                                                          */
/* -------------------------------------------------------------------------- */

/** A role assignable within a project. OpenProject owns the vocabulary. */
export interface EpmRole {
  id: ID;
  name: string;
}

/**
 * One person's membership of one project.
 *
 * `membershipId` is not the user's id — it identifies the association, and it
 * is what a role change or a removal acts on. Keeping both means a caller never
 * has to look one up from the other.
 */
export interface EpmProjectMember {
  membershipId: ID;
  userId: ID;
  roles: EpmRole[];
  /**
   * Whether the caller may change or remove this membership.
   *
   * Unlike watchers, relations and comments, this is not read from an
   * affordance: OpenProject publishes `update` on a membership but no `delete`,
   * even where deleting is permitted. So it comes from the per-project
   * `member:manage` capability, which is the only signal upstream actually
   * offers. The backend re-checks it on every write regardless.
   */
  canManage: boolean;
  createdAt: ISODate;
}

/**
 * Someone who could be added to a project.
 *
 * OpenProject computes this set — people who are neither locked nor already a
 * member — so EPM never has to subtract one list from another and get it wrong.
 * Groups and placeholder users are excluded: adding those stays an OpenProject
 * operation.
 */
export interface EpmMemberCandidate {
  userId: ID;
  name: string;
}

/* -------------------------------------------------------------------------- */
/* Work packages (tasks)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * EPM's progress classification for a work package.
 *
 * This is not the workflow status. OpenProject's statuses are
 * instance-configurable — fourteen on the reference instance — and several map
 * onto one category here: New, In specification and Specified are all `todo`.
 *
 * The category exists so that boards, charts and metrics have a small, stable
 * set to group and colour by. Anything that shows a user "the status" should
 * use `EpmTask.status`, which carries what OpenProject actually says.
 */
export type TaskStatusCategory =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked';

/**
 * A work package's actual status, as OpenProject defines it.
 *
 * Identity is upstream's: the id is the OpenProject status id, and the name is
 * whatever an administrator called it. Nothing here is invented, so a renamed
 * or newly added status flows through without code changes.
 */
export interface TaskStatusRef {
  id: ID;
  name: string;
  /** The upstream notion of "this status closes the work package". */
  isClosed: boolean;
}

/**
 * The instance's own priority, exactly as configured there.
 *
 * Distinct from `TaskPriority`, which is EPM's four-way grouping used for tone,
 * ranking and filters. The two are not the same list: an instance can define
 * any number of priorities with any names, and collapsing them for display
 * renames real values — showing "Medium" for a task whose priority is
 * "Normal", or "Critical" for one that is "Immediate".
 */
export interface TaskPriorityRef {
  id: ID;
  name: string;
}

/**
 * The instance's own work package type, exactly as configured there.
 *
 * Same relationship to `TaskType` as `TaskPriorityRef` has to `TaskPriority`:
 * an instance defines its own types — User story, Epic, Phase — and EPM's
 * handful of categories is a grouping of them, not a replacement for them.
 */
export interface TaskTypeRef {
  id: ID;
  name: string;
}

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export type TaskType = 'task' | 'bug' | 'feature' | 'epic' | 'milestone' | 'support';

export interface EpmTask {
  id: ID;
  /** Display key shown throughout the UI, e.g. "OP-142". */
  key: string;
  subject: string;
  description?: string;
  /** EPM's coarse kind grouping. Presentation and analytics only. */
  type: TaskType;
  /** What the instance calls this work package's type. Authoritative. */
  typeRef: TaskTypeRef;
  /** What the instance calls this work package's status. Authoritative. */
  status: TaskStatusRef;
  /** EPM's coarse progress grouping. Presentation and analytics only. */
  statusCategory: TaskStatusCategory;
  /** What the instance calls this work package's priority. Authoritative. */
  priorityRef: TaskPriorityRef;
  /** EPM's coarse urgency grouping. Presentation, ranking and filters only. */
  priority: TaskPriority;
  projectId: ID;
  assigneeId?: ID;
  authorId: ID;
  parentId?: ID;
  sprintId?: ID;
  version?: string;
  startDate?: ISODate;
  dueDate?: ISODate;
  estimatedHours?: number;
  spentHours?: number;
  storyPoints?: number;
  labels: string[];
  /** 0-100 completion ratio (OpenProject percentageDone). */
  progress: number;
  watcherIds: ID[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  type: TaskType;
  /**
   * Written as a category, which is lossy: EPM picks a representative
   * OpenProject status for it. The full-fidelity path is the schema-driven
   * work package form, which writes the real status id.
   */
  status: TaskStatusCategory;
  priority: TaskPriority;
  projectId: ID;
  assigneeId?: ID;
  parentId?: ID;
  sprintId?: ID;
  startDate?: ISODate;
  dueDate?: ISODate;
  estimatedHours?: number;
  storyPoints?: number;
  labels?: string[];
}

/**
 * `statusId`, `priorityId` and `typeId` are the instance's own ids and take
 * precedence over the category fields above, which are lossy — a category can
 * only resolve to a representative value. The backend turns an id into an
 * upstream link, so the browser never constructs one.
 */
export type UpdateTaskInput = Partial<CreateTaskInput> & {
  id: ID;
  statusId?: ID;
  priorityId?: ID;
  typeId?: ID;
};

export interface TaskFilters {
  projectId?: ID;
  assigneeId?: ID;
  status?: TaskStatusCategory[];
  priority?: TaskPriority[];
  type?: TaskType[];
  sprintId?: ID;
  search?: string;
  /** Personal work-queue buckets used by My Work and the dashboard. */
  bucket?: 'open' | 'today' | 'upcoming' | 'overdue' | 'completed' | 'all';
  page?: number;
  pageSize?: number;
  sortBy?: 'dueDate' | 'priority' | 'updatedAt' | 'subject' | 'status';
  sortDir?: 'asc' | 'desc';
}

/* -------------------------------------------------------------------------- */
/* Sprints                                                                     */
/* -------------------------------------------------------------------------- */

export type SprintState = 'planned' | 'active' | 'completed';

export interface BurndownPoint {
  date: ISODate;
  label: string;
  ideal: number;
  remaining: number | null;
}

export interface EpmSprint {
  id: ID;
  name: string;
  goal: string;
  projectIds: ID[];
  state: SprintState;
  startDate: ISODate;
  endDate: ISODate;
  committedPoints: number;
  completedPoints: number;
  /** Ideal vs. actual remaining points, one entry per sprint day. */
  burndown: BurndownPoint[];
}

/* -------------------------------------------------------------------------- */
/* Activity, notifications, documents                                          */
/* -------------------------------------------------------------------------- */

export type ActivityAction =
  | 'created'
  | 'updated'
  | 'commented'
  | 'completed'
  | 'assigned'
  | 'status_changed'
  | 'uploaded';

export interface ActivityEntry {
  id: ID;
  actorId: ID;
  action: ActivityAction;
  /** What the action was performed on, e.g. "OP-142" or "Design Sign-off". */
  objectLabel: string;
  objectType: 'task' | 'project' | 'milestone' | 'document' | 'sprint';
  objectId?: ID;
  projectId?: ID;
  detail?: string;
  timestamp: ISODate;
}

export type NotificationCategory =
  | 'mention'
  | 'assignment'
  | 'project_update'
  | 'deadline'
  | 'system';

export interface EpmNotification {
  id: ID;
  category: NotificationCategory;
  title: string;
  body: string;
  actorId?: ID;
  taskKey?: string;
  taskId?: ID;
  projectId?: ID;
  /**
   * An EPM route to open, for notifications about things a task or project id
   * cannot address — a team, an employee, the analytics page. Never an
   * OpenProject URL.
   */
  link?: string;
  /** Present on EPM-generated notifications; absent on OpenProject's. */
  severity?: 'info' | 'warning' | 'critical';
  read: boolean;
  timestamp: ISODate;
}

export type DocumentKind = 'pdf' | 'doc' | 'sheet' | 'slide' | 'image' | 'archive' | 'markdown';

export interface EpmDocument {
  id: ID;
  name: string;
  kind: DocumentKind;
  projectId?: ID;
  ownerId: ID;
  sizeBytes: number;
  updatedAt: ISODate;
  shared: boolean;
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

export type CalendarEventKind = 'task' | 'milestone' | 'sprint' | 'meeting';

export interface CalendarEvent {
  id: ID;
  title: string;
  kind: CalendarEventKind;
  date: ISODate;
  endDate?: ISODate;
  projectId?: ID;
  taskId?: ID;
  allDay: boolean;
}

/* -------------------------------------------------------------------------- */
/* Dashboard, reporting and intelligence                                       */
/* -------------------------------------------------------------------------- */

export interface MetricTrend {
  /** Percentage change against the previous period. */
  changePct: number;
  direction: 'up' | 'down' | 'flat';
  /** Whether an upward movement is a good thing for this metric. */
  positiveIsUp: boolean;
  periodLabel: string;
}

export interface DashboardMetrics {
  myTasks: number;
  myTasksDueThisWeek: number;
  inProgress: number;
  inProgressBlocked: number;
  overdue: number;
  overdueCritical: number;
  activeProjects: number;
  projectsAtRisk: number;
  sprintProgress: number;
  trends: {
    myTasks: MetricTrend;
    inProgress: MetricTrend;
    overdue: MetricTrend;
    activeProjects: MetricTrend;
  };
}

export interface DeliveryTrendPoint {
  period: string;
  completed: number;
  created: number;
  velocity: number;
}

export interface PortfolioRow {
  projectId: ID;
  projectName: string;
  identifier: string;
  schedule: HealthLevel;
  scope: HealthLevel;
  resources: HealthLevel;
  overall: HealthLevel;
}

export interface ExecutiveInsights {
  portfolioHealth: number;
  onTimeDelivery: number;
  openRisks: number;
  overdueTasks: number;
  teamUtilization: number;
  sprintVelocity: number;
  velocityTrend: MetricTrend;
  matrix: PortfolioRow[];
}

export interface ReportFilters {
  from?: ISODate;
  to?: ISODate;
  projectId?: ID;
  teamId?: ID;
  status?: ProjectStatus[];
}

export interface StatusDistribution {
  /** A progress category, not a workflow status — see TaskStatusCategory. */
  status: TaskStatusCategory;
  label: string;
  count: number;
}

export interface TimeEntrySummary {
  userId: ID;
  hoursLogged: number;
  hoursBillable: number;
  projectBreakdown: { projectId: ID; hours: number }[];
}

/* -------------------------------------------------------------------------- */
/* Integration                                                                 */
/* -------------------------------------------------------------------------- */

export type ConnectionState = 'connected' | 'degraded' | 'disconnected';

export interface IntegrationStatus {
  state: ConnectionState;
  apiState: ConnectionState;
  webhookState: ConnectionState;
  lastSyncAt: ISODate;
  apiVersion: string;
  syncedResources: { resource: string; count: number; lastSyncAt: ISODate }[];
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A person's own settings. Stored server-side so they follow the person
 * between browsers and so the email worker can honour them without a browser
 * being open. The shape is deliberately the one the Settings page renders.
 */
export interface UserPreferences {
  notifications: {
    assigned: boolean;
    mentions: boolean;
    statusChanges: boolean;
    dueReminders: boolean;
    digest: boolean;
  };
  email: {
    /** Master switch. Off means no email of any kind, including invites resent later. */
    enabled: boolean;
    assigned: boolean;
    mentions: boolean;
    /** Being given access to a project. */
    membership: boolean;
    /** Status and field changes on work the person is assigned to or watches. */
    updates: boolean;
    dueReminders: boolean;
    /** One summary a day for everything not sent immediately. */
    digest: boolean;
  };
  appearance: {
    compactTables: boolean;
    reduceMotion: boolean;
    showAvatars: boolean;
  };
  workweek: {
    startOfWeek: 'monday' | 'sunday';
    timeFormat: '24h' | '12h';
  };
  workspace: {
    landingPage: 'dashboard' | 'my-work' | 'projects';
  };
}

/* -------------------------------------------------------------------------- */
/* Invitations                                                                 */
/* -------------------------------------------------------------------------- */

/** What the invite page may show before the person has proven who they are. */
export interface InviteInfo {
  firstName: string;
  email: string;
  organisation: string;
  expiresAt: ISODate;
  /** `expired` and `used` are both terminal; the page explains which. */
  state: 'valid' | 'expired' | 'used';
}

/* -------------------------------------------------------------------------- */
/* Assistant                                                                   */
/* -------------------------------------------------------------------------- */

export type AssistantRole = 'user' | 'assistant';

export interface AssistantToolCall {
  id: string;
  /** Tool name as the model called it, e.g. `list_tasks`. */
  name: string;
  /** Short human label for the chip, e.g. "Looked up overdue tasks". */
  label: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'done' | 'failed';
}

export interface AssistantMessage {
  id: ID;
  conversationId: ID;
  role: AssistantRole;
  content: string;
  toolCalls: AssistantToolCall[];
  createdAt: ISODate;
}

export interface AssistantConversation {
  id: ID;
  title: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Whether the assistant can answer at all, and what to say if it cannot. */
export interface AssistantStatus {
  available: boolean;
  reason?: string;
  model?: string;
}

/**
 * One frame of the streamed reply. Sent as server-sent events with the frame
 * as JSON in `data:`. `delta` frames concatenate into the assistant's text.
 */
export type AssistantStreamEvent =
  | { type: 'conversation'; conversationId: ID; title: string }
  | { type: 'tool'; call: AssistantToolCall }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; message: string };

/* -------------------------------------------------------------------------- */
/* Administration settings sections                                            */
/* -------------------------------------------------------------------------- */

export interface AdminSettingOption {
  value: string;
  label: string;
}

/**
 * One setting, described by the instance rather than by EPM.
 *
 * The backend returns the type, the current value, the choices where there are
 * any, and whether the instance will accept a change. A section therefore
 * renders from its descriptor alone, so a setting added upstream appears here
 * without a new page being written for it.
 */
export interface AdminSettingField {
  key: string;
  label: string;
  help?: string;
  type: 'boolean' | 'integer' | 'string' | 'text' | 'enum' | 'multi_enum';
  value: boolean | number | string | string[];
  /** False when the instance pins it by environment or configuration file. */
  writable: boolean;
  options?: AdminSettingOption[];
}

export interface AdminSettingsSection {
  id: string;
  label: string;
  description: string;
  fields: AdminSettingField[];
}

export interface AdminSettingsSectionSummary {
  id: string;
  label: string;
  description: string;
}

/* -------------------------------------------------------------------------- */
/* Administration catalogues                                                   */
/* -------------------------------------------------------------------------- */

export interface AdminCatalogOption {
  value: string;
  label: string;
  /** Present on colour options, so a swatch can be filled rather than named. */
  hex?: string;
}

/** One column of a catalogue, described by the instance rather than by EPM. */
export interface AdminCatalogField {
  key: string;
  label: string;
  type: 'string' | 'text' | 'boolean' | 'integer' | 'enum';
  required?: boolean;
  help?: string;
  /** A secret the instance accepts but never reads back, such as a signing key. */
  writeOnly?: boolean;
  options?: AdminCatalogOption[];
}

/**
 * One row. The declared keys are always present; the rest are the catalogue's
 * own fields, which vary by resource and are read through the descriptor.
 */
export interface AdminCatalogRow {
  id: ID;
  /** False when the instance would refuse to remove it. */
  deletable: boolean;
  /** Why it cannot be removed, when it cannot. */
  undeletableReason?: string;
  [field: string]: unknown;
}

export interface AdminCatalog {
  resource: string;
  label: string;
  /** The noun for one row, for buttons and confirmations. */
  singular: string;
  description: string;
  fields: AdminCatalogField[];
  rows: AdminCatalogRow[];
}

export interface AdminCatalogSummary {
  id: string;
  label: string;
  singular: string;
  description: string;
}

/** The character classes an instance can require in a password. */
export type PasswordRule = 'lowercase' | 'uppercase' | 'numeric' | 'special';

/**
 * The password rules an instance enforces.
 *
 * `minAdheredRules` is how many of `activeRules` a password must satisfy, not a
 * boolean: zero means none of them are required and only `minLength` applies.
 */
export interface PasswordPolicy {
  minLength: number;
  activeRules: PasswordRule[];
  minAdheredRules: number;
}

