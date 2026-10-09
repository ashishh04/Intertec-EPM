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
  /**
   * The account's language, as an instance locale code. Empty when the person
   * has never chosen one, in which case the instance default applies — which is
   * why this is not defaulted to `en` here: a value would claim a choice nobody
   * made and would override the instance setting for everybody.
   */
  language: string;
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

/**
 * What a revocation actually did.
 *
 * Every figure is counted from work that completed, not from work that was
 * attempted: an administrator offboarding somebody needs to know access is
 * gone, and "we tried" is not an answer. `problems` carries the memberships
 * that would not come off, so a partial revoke is reported as partial rather
 * than reported as done.
 */
export interface AccountRevocation {
  /** Browser sessions ended. Takes effect on that browser's next request. */
  sessionsEnded: number;
  /** Project memberships removed upstream. */
  membershipsRemoved: number;
  /** Whether instance-administrator rights were taken away by this call. */
  adminRevoked: boolean;
  /** Present only when something could not be revoked. */
  problems?: string[];
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
  | 'health:configure'
  | 'approvals:configure'
  | 'rules:configure'
  | 'portfolios:manage'
  | 'analytics:manage'
  | 'reports:schedule'
  | 'reports:approve'
  | 'teams:manage'
  | 'roles:manage'
  | 'system:manage';

/** Nested permission map as returned by `GET /me`. */
export type PermissionMap = Record<string, Record<string, boolean>>;

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export type ProjectStatus = 'on_track' | 'at_risk' | 'delayed' | 'completed' | 'paused';

/** Green, amber and red, in the words the product uses for them. */
export type HealthLevel = 'healthy' | 'warning' | 'critical';

/**
 * What project health is computed from (BR-204): how far the forecast finish
 * is past the planned one, spend against the budget planned to date, open
 * high-priority risks, and overdue work.
 */
export type HealthCriterion = 'schedule' | 'budget' | 'risks' | 'overdue';

/** The criteria, plus the overall derived from them. */
export type HealthDimension = HealthCriterion | 'overall';

/** Levels pinned over the calculated ones. Absent means "not overridden". */
export type HealthOverride = Partial<Record<HealthDimension, HealthLevel>>;

/**
 * A level per criterion, and overall.
 *
 * A criterion is null when it could not be assessed — no planned finish, no
 * budget, no risk type on the instance. That is not the same as green, and is
 * shown as "not assessed" rather than borrowing green's colour.
 */
export interface ProjectHealth {
  schedule: HealthLevel | null;
  budget: HealthLevel | null;
  risks: HealthLevel | null;
  overdue: HealthLevel | null;
  overall: HealthLevel;
}

export type HealthUnit = 'days' | 'percent' | 'count';

/** One criterion's result: the figure it measured and the rule it met. */
export interface HealthCriterionResult {
  criterion: HealthCriterion;
  /** Null when the criterion could not be assessed. */
  level: HealthLevel | null;
  /** The measured figure in `unit`. Null when not assessed. */
  value: number | null;
  unit: HealthUnit;
  /** One plain sentence naming the figures and the threshold that applied. */
  reason: string;
  /** The weight it carries in the overall. Zero means shown but not counted. */
  weight: number;
  amberAt: number;
  redAt: number;
}

/** The stored calculation behind a project's health (BR-205). */
export interface ProjectHealthDetail {
  criteria: HealthCriterionResult[];
  /** Why overall is what it is, in one sentence. */
  explanation: string;
  calculatedAt: ISODate;
  /** The version of the health rules the calculation used. */
  ruleVersion: number;
}

/** An override in force: what is pinned, why, by whom and when (BR-206). */
export interface HealthOverrideRecord {
  levels: HealthOverride;
  reason: string;
  /** OpenProject user id, or `unknown` for a pin carried over from before reasons. */
  setBy: ID;
  setAt: ISODate;
}

/** One criterion's rule: whether it counts, how much, and where it turns. */
export interface HealthCriterionRule {
  enabled: boolean;
  /** 0–100. Zero shows the criterion without letting it move the overall. */
  weight: number;
  /** The figure at which it turns amber, in the criterion's unit. */
  amberAt: number;
  /** The figure at which it turns red. Never below `amberAt`. */
  redAt: number;
}

/**
 * The administrator's health rules (BR-204).
 *
 * Overall is decided by weight: it is red when the red criteria carry at least
 * `redShare` percent of the weight of everything assessed, and amber when the
 * amber-or-red ones carry at least `amberShare`. With four criteria weighted
 * equally and both shares at 25, any one breach moves the overall.
 */
export interface HealthRules {
  /** Zero means the built-in defaults; every save makes a new version. */
  version: number;
  criteria: {
    /** Days the forecast finish is past the planned finish. */
    schedule: HealthCriterionRule;
    /** Percent of the budget by which spend is ahead of the plan to date. */
    budget: HealthCriterionRule;
    /** Open risks at a high priority. */
    risks: HealthCriterionRule & {
      /** Work package types that are risks. Empty means types named "Risk". */
      typeIds: ID[];
      /** Priorities that count as high. Empty means High and above. */
      priorityIds: ID[];
    };
    /** Open work packages past their due date. */
    overdue: HealthCriterionRule;
  };
  redShare: number;
  amberShare: number;
  updatedAt?: ISODate;
  updatedBy?: ID;
}

/** Choices the rules editor offers, read from the instance. */
export interface HealthRuleOptions {
  types: { id: ID; name: string }[];
  priorities: { id: ID; name: string }[];
  /** The types and priorities an empty selection resolves to today. */
  defaultRiskTypeIds: ID[];
  defaultHighPriorityIds: ID[];
}

/**
 * A project's plan as the editor sends it. `null` clears a field; one left out
 * is left alone. Every change is journalled with its before and after.
 */
export interface ProjectPlanInput {
  plannedStart?: ISODate | null;
  plannedFinish?: ISODate | null;
  budgetTotal?: number | null;
}

/**
 * One entry in the activity journal for EPM-owned data (BRL-02).
 *
 * Append-only: nothing in the API edits or deletes one, and the database
 * refuses to as well.
 */
export interface AuditEvent {
  id: ID;
  /** Position in the journal; strictly increasing. */
  seq: number;
  occurredAt: ISODate;
  /** Absent when EPM itself made the change, e.g. a scheduled recalculation. */
  actorId?: ID;
  /** `service`: EPM's automation account, acting for a rule (BR-217). */
  actorKind: 'user' | 'system' | 'service';
  projectId?: ID;
  entityType: string;
  entityId: ID;
  action: string;
  summary: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

/** One page of a journal, newest first, with the total it is a page of. */
export interface AuditPage {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
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
  /** Planned (baseline) start. EPM's own; an OpenProject project has no dates. */
  startDate?: ISODate;
  /** Planned (baseline) finish, which schedule variance is measured against. */
  dueDate?: ISODate;
  /**
   * When the open work is due to finish: the latest due date among it, and
   * never earlier than today while overdue work remains. Absent when no open
   * work has a date.
   */
  forecastFinish?: ISODate;
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
  /** Present only while an override is in force. */
  healthOverride?: HealthOverrideRecord;
  /** The calculation itself: each criterion's figure, level and reason. */
  healthDetail: ProjectHealthDetail;
  taskCount: number;
  completedTaskCount: number;
  /** Open work packages of a risk type, at any priority. */
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
  /**
   * Actual cost to date: every hour logged on the project at its person's
   * hourly rate. Calculated, never typed in; hours from somebody with no rate
   * are counted in `uncostedHours` rather than priced at zero.
   */
  budgetUsed: number;
  /** Hours logged by people with no hourly rate, left out of `budgetUsed`. */
  uncostedHours: number;
  /** The approved budget. Zero means none is set. */
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
  /**
   * Custom field values by OpenProject attribute name (`customField4`), as
   * shown: a number, a yes or no, or text — a list option's or a person's
   * name. Absent when the work package has none. Includes the critical path
   * fields EPM writes (BR-103), so a view can show them as columns.
   */
  customValues?: Record<string, number | boolean | string>;
}

/**
 * Where a work package sits in the tree.
 *
 * `ancestors` is ordered root first, so it renders straight into a breadcrumb.
 * Both sides are the full task so a row can show status, type and assignee
 * without a second lookup.
 */
export interface TaskHierarchy {
  ancestors: EpmTask[];
  children: EpmTask[];
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  /**
   * A category, which is lossy: EPM picks a representative OpenProject type
   * for it, and that type may not be one the project enables. Prefer `typeId`.
   */
  type?: TaskType;
  /**
   * The instance's own type id, taking precedence over `type`. A project only
   * enables a subset of the instance's types, so a picker that offers the
   * category union can name one this project refuses — which is how "Feature"
   * and "Bug" came back as "Type is not set to one of the allowed values".
   */
  typeId?: ID;
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
  /** Who raised it. The dashboard's "created by me" widget is this filter. */
  authorId?: ID;
  /** Who is following it, not who owns it. */
  watcherId?: ID;
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
  /** Set when the actor is not a person in the directory, e.g. EPM's automation account. */
  actorName?: string;
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

/**
 * Why a notification exists, as distinct from how it is displayed.
 *
 * `NotificationCategory` above groups items for the eye — a colour and a label —
 * and several reasons legitimately share one category. The reason is the thing
 * people actually opt in and out of: "somebody mentioned me" and "a date I watch
 * is approaching" are both worth their own switch, and both being `deadline` or
 * `project_update` on screen does not change that.
 *
 * The names follow OpenProject's own vocabulary, because it is the source for
 * every reason but the last: `epm` marks a notification EPM raised itself, for
 * events upstream has no concept of.
 */
export type NotificationReason =
  | 'mentioned'
  | 'assignee'
  | 'accountable'
  | 'watcher'
  | 'dateAlert'
  | 'reminder'
  | 'shared'
  | 'commented'
  | 'epm';

export interface EpmNotification {
  id: ID;
  category: NotificationCategory;
  /** Why it was raised. Drives the per-reason switches and the feed's filters. */
  reason: NotificationReason;
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
  /**
   * What this caller may do with it, read from the affordances OpenProject
   * publishes on the attachment rather than from a role. There is no
   * `document:delete` in the capabilities vocabulary to check against, so the
   * instance is the only authority — and it is stricter than any mapping would
   * be: whoever uploaded a file may remove it where a reader may not.
   */
  can: { delete: boolean };
}

/* -------------------------------------------------------------------------- */
/* Time entries                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Logged time, as OpenProject stores it.
 *
 * Hours are a number here and an ISO-8601 duration upstream; the conversion is
 * the backend's. `can` is read from the entry's own affordances rather than
 * from a role — OpenProject decides per entry, and it is stricter than any
 * mapping: a person may log their own time and still not edit someone else's.
 */
export interface EpmTimeEntry {
  id: ID;
  hours: number;
  spentOn: ISODate;
  comment?: string;
  projectId: ID;
  projectName?: string;
  workPackageId?: ID;
  workPackageSubject?: string;
  userId: ID;
  activityId?: ID;
  activityName?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  can: { update: boolean; delete: boolean };
}

export interface TimeEntryFilters {
  projectId?: ID;
  workPackageId?: ID;
  /**
   * A person's id, or the literal `me`.
   *
   * Use `me` for "my own time". A numeric id is validated by OpenProject against
   * the principals the caller can see, and somebody who belongs to no project is
   * not in their own visible set — so asking for their own timesheet by id is
   * refused, while `me` always resolves.
   */
  userId?: ID | 'me';
  /** Inclusive `spentOn` bounds. */
  from?: ISODate;
  to?: ISODate;
  page?: number;
  pageSize?: number;
}

/**
 * A time entry to write.
 *
 * Either a project or a work package is required — a work package implies its
 * project, so naming both is allowed but only the work package is needed.
 */
export interface CreateTimeEntryInput {
  projectId?: ID;
  workPackageId?: ID;
  hours: number;
  spentOn: ISODate;
  comment?: string;
  /** From the time entry form's allowed activities. */
  activityId?: ID;
}

export type UpdateTimeEntryInput = Partial<CreateTimeEntryInput>;

/** How a time report groups its rows. */
export type TimeReportGrouping = 'user' | 'project' | 'activity' | 'workPackage' | 'week' | 'day';

export interface TimeReportFilters {
  /** Inclusive `spentOn` bounds. Both are required — an unbounded report would
      read every entry the instance holds. */
  from: ISODate;
  to: ISODate;
  projectId?: ID;
  userId?: ID;
  groupBy?: TimeReportGrouping;
}

export interface TimeReportRow {
  /** The grouped value's id, or the bucket key for `week` and `day`. */
  key: string;
  label: string;
  hours: number;
  /** Absent when no hour in the row has a rate behind it. */
  cost?: number;
  /** Hours in this row that no rate applies to, so a total can say so. */
  hoursWithoutRate: number;
  entries: number;
}

/**
 * Logged time, aggregated.
 *
 * Grouping happens on the server because the range can hold thousands of
 * entries and the browser only needs the totals. `hoursWithoutRate` is
 * reported rather than hidden: a cost figure that quietly omits half the
 * hours is worse than one that says what it left out.
 */
export interface TimeReport {
  from: ISODate;
  to: ISODate;
  groupBy: TimeReportGrouping;
  totalHours: number;
  /** Absent when nothing in range has a rate. */
  totalCost?: number;
  hoursWithoutRate: number;
  currency: string;
  rows: TimeReportRow[];
  /** Daily totals across the whole range, for the trend chart. */
  byDay: { date: ISODate; hours: number }[];
  /** True when the range held more entries than one report may read. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Placeholder people                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A named stand-in for a role that is planned but not yet filled.
 *
 * EPM's own record. OpenProject has the same idea and gates creating one behind
 * an Enterprise licence, so this exists independently of it — which also fixes
 * the boundary: a placeholder counts toward team and portfolio capacity, and
 * cannot be a work package assignee, because only OpenProject can decide who is
 * assignable and it will not accept someone it has never heard of.
 */
export interface EpmPlaceholderPerson {
  id: ID;
  name: string;
  /** What the placeholder is for, e.g. "Backend engineer, Q2 start". */
  note?: string;
  department?: { id: ID; name: string; active: boolean };
  team?: { id: ID; name: string; active: boolean };
  hoursCapacity: number;
  /** Set once the placeholder has become a real account. */
  convertedToUserId?: ID;
  convertedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface PlaceholderPersonInput {
  name: string;
  note?: string;
  departmentId?: ID | null;
  teamId?: ID | null;
  hoursCapacity?: number;
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
  /** The bucket's label: `2026-09` for a month. */
  period: string;
  /** Delivered in the bucket, on the day each was closed (`work.completed`). */
  completed: number;
  created: number;
  /** Story points delivered in the bucket (`work.pointsDelivered`). */
  velocity: number;
}

export interface PortfolioRow {
  projectId: ID;
  projectName: string;
  identifier: string;
  schedule: HealthLevel | null;
  budget: HealthLevel | null;
  risks: HealthLevel | null;
  overdue: HealthLevel | null;
  overall: HealthLevel;
  /** What the rules calculated overall, shown beside an override (BR-206). */
  calculatedOverall: HealthLevel;
  /** Present while an override is in force, so a report carries its reason. */
  override?: { reason: string; setBy: ID; setAt: ISODate };
}

/**
 * The executive view's headline figures, each a measure of the semantic
 * layer (BR-404) for the report's scope and period. Null where there is
 * nothing to measure (no milestone decided, no sprint ended) rather than a
 * zero that reads as a result.
 */
export interface ExecutiveInsights {
  /** Share of active, assessed projects whose health is green (`health.greenPct`). */
  portfolioHealth: number | null;
  /** Milestones due in the period delivered on their date (`milestones.onTime`). */
  onTimeDelivery: number | null;
  openRisks: number | null;
  overdueTasks: number;
  /** Hours logged against capacity in the period (`utilisation`). */
  teamUtilization: number | null;
  /** Story points delivered per sprint, over sprints ended in the period (`sprint.velocity`). */
  sprintVelocity: number | null;
  velocityTrend: MetricTrend;
  matrix: PortfolioRow[];
  /** When the analytics model's data was read. */
  asOf: ISODate | null;
  /** Every figure above as its measure, with its definition. */
  measures: Record<string, MeasureResult>;
}

export interface ReportFilters {
  from?: ISODate;
  to?: ISODate;
  projectId?: ID;
  portfolioId?: ID;
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
  /** Hours from a person with no hourly rate, which no cost figure includes. */
  hoursUncosted: number;
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
/** Three-letter weekday keys, Monday first. Used by schedules and reminders. */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface UserPreferences {
  notifications: {
    assigned: boolean;
    mentions: boolean;
    statusChanges: boolean;
    dueReminders: boolean;
    digest: boolean;
    /**
     * Anything on work this person is involved in — raised it, or has commented
     * on it — rather than only work aimed at them. Being the assignee, the
     * accountable person or a watcher each has its own switch below, because
     * those are different relationships to a piece of work and people want them
     * separately.
     */
    participating: boolean;
    /** Named as accountable for the work, which is not the same as assigned it. */
    accountable: boolean;
    /** Following work without owning it. */
    watcher: boolean;
    /** Work or a project shared directly with them. */
    shared: boolean;
    /** A start or finish date coming up on work they are involved in. */
    dateAlerts: boolean;
    /**
     * Suspends notifications and email between two dates, inclusive.
     *
     * A window rather than a switch, because the thing people actually want is
     * "I am away next week" set before they leave. With `enabled` on and no
     * dates it pauses indefinitely, which is the switch.
     */
    pause: {
      enabled: boolean;
      from?: ISODate;
      to?: ISODate;
    };
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
    /**
     * Hour of the day the reminder sweep and the digest may reach this person,
     * 0-23, in their own timezone.
     *
     * Their timezone, not the server's: a reminder that lands at 07:00 UTC
     * arrives at 11:00 in Dubai and 02:00 in New York, and a deadline prompt
     * that wakes people is worse than none.
     */
    reminderHour: number;
    /**
     * Weekdays reminders go out on. Empty means never, which is a legitimate
     * way to keep the switch on but stop the mail.
     */
    reminderDays: Weekday[];
    /*
     * Everything that is not a work package.
     *
     * Separate switches because they are separate streams with different rhythms:
     * an announcement is occasional and usually wanted, a wiki edit can be
     * constant and usually is not. Folding them into `updates` would have meant
     * one switch governing "the field on my task changed" and "somebody fixed a
     * typo on a wiki page", which nobody wants to answer at once.
     */
    news: boolean;
    wiki: boolean;
    meetings: boolean;
    documents: boolean;
    comments: boolean;
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
  /**
   * Language and regional formatting.
   *
   * `language` is the instance's own code (`en`, `de`, …) and is written through
   * to OpenProject, which owns what it will accept. `dateFormat` is EPM's: it
   * decides how every date in the interface is written, and `system` means the
   * browser's locale rather than a format chosen here.
   */
  locale: {
    language: string;
    dateFormat: 'system' | 'iso' | 'dmy' | 'mdy';
  };
  /**
   * When this person works, and when they are away.
   *
   * Distinct from the weekly capacity on their employee record, which is an
   * administrator's figure used for team totals. This is the person's own
   * declaration: which days their week covers, and whether they are currently
   * out — both of which EPM honours rather than merely displays. Timesheet days
   * outside the working week are marked as such, and nothing is emailed to
   * someone who is away.
   */
  availability: {
    workingDays: Weekday[];
    /** Their normal day length, for reading a timesheet against. */
    hoursPerDay: number;
    outOfOffice: {
      enabled: boolean;
      from?: ISODate;
      to?: ISODate;
      /** Shown to colleagues on their profile, e.g. "Back on the 12th". */
      note?: string;
    };
  };
  workspace: {
    landingPage: 'dashboard' | 'my-work' | 'projects';
  };
  /**
   * The Overview page, as this person has arranged it.
   *
   * A list rather than a set of switches, because order is half the point: the
   * widget someone put first is the one they came to read. The ids are the
   * frontend's widget catalogue — an unknown id is skipped on render, so a
   * layout saved before a widget was retired still opens.
   */
  dashboard: {
    widgets: DashboardWidgetPlacement[];
  };
}

/** How wide a widget sits on the Overview grid. */
export type DashboardWidgetWidth = 'half' | 'full';

export interface DashboardWidgetPlacement {
  /** An id from the frontend's widget catalogue. */
  id: string;
  /**
   * Overrides the widget's natural width. Absent means the catalogue's default,
   * so a widget whose default changes does not have to migrate every layout.
   */
  width?: DashboardWidgetWidth;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One signed-in browser.
 *
 * Named apart from `EpmSession`, which is the signed-in person and their
 * permissions. This is the row behind a cookie.
 *
 * EPM's sessions are server-side rows, so this is the real list rather than a
 * reconstruction: the browser only ever holds an opaque id. No token is ever
 * included — the record carries when the session was opened, when it was last
 * used and what it says it is, which is everything needed to recognise it and
 * nothing that would let it be replayed.
 */
export interface EpmBrowserSession {
  id: ID;
  /** True for the session making the request, which cannot be revoked here. */
  current: boolean;
  createdAt: ISODate;
  lastSeenAt: ISODate;
  expiresAt: ISODate;
  /** Parsed from the user agent, e.g. "Chrome on Windows". Best effort. */
  device: string;
  /** The raw user agent, for a person who wants to be certain. */
  userAgent?: string;
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

/* -------------------------------------------------------------------------- */
/* Collaboration: meetings, news and the wiki                                  */
/* -------------------------------------------------------------------------- */

/*
 * These three differ from everything above in one important way: they are EPM's
 * own records rather than a normalised view of an OpenProject resource. All three
 * modules exist upstream and none is reachable — OpenProject serves meetings,
 * news and wiki pages from HTML controllers with no API v3 resource behind them —
 * so there is no upstream shape to mirror here and no id to overlay.
 *
 * They live in this file rather than one of their own because this file is the
 * contract: `npm run types:check` on the backend compares it byte for byte with
 * its mirror, and a second file would sit outside that check.
 */

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the caller may do to a record.
 *
 * Reported per record rather than inferred from a permission, because the answer
 * depends on the record: its author may edit their own meeting in a project
 * where they may not touch anybody else's. The UI offers what this says and the
 * backend enforces the same rule independently.
 */
export interface RecordAbilities {
  update: boolean;
  delete: boolean;
}

/** Where a collaboration record lives: one project, or the whole organisation. */
export interface CollaborationScope {
  /** Absent for an organisation-wide record. */
  projectId?: ID;
  /** Resolved for display. Absent when the record is organisation-wide. */
  projectName?: string;
}

/* -------------------------------------------------------------------------- */
/* Meetings                                                                   */
/* -------------------------------------------------------------------------- */

export type MeetingState = 'planned' | 'held' | 'cancelled';

export interface MeetingParticipant {
  /** OpenProject user id. */
  userId: ID;
  /** Resolved from the directory. Absent for somebody the caller cannot read. */
  name?: string;
  invited: boolean;
  /** Independent of `invited`: somebody can attend a meeting nobody invited them to. */
  attended: boolean;
}

export interface EpmMeeting extends CollaborationScope {
  id: ID;
  title: string;
  location?: string;
  /** Start instant. A meeting happens at a moment, not on a day. */
  startsAt: ISODate;
  durationMinutes: number;
  /** Derived from `startsAt` and the duration, so the two cannot disagree. */
  endsAt: ISODate;
  state: MeetingState;
  /** Markdown, written before the meeting. */
  agenda?: string;
  /** Markdown, written after it. */
  minutes?: string;
  createdBy: ID;
  createdByName?: string;
  participants: MeetingParticipant[];
  createdAt: ISODate;
  updatedAt: ISODate;
  can: RecordAbilities;
}

export interface MeetingFilters {
  projectId?: ID;
  /** `upcoming` is from now on; `past` is everything before. */
  window?: 'upcoming' | 'past' | 'all';
  state?: MeetingState;
  /** Only meetings this person is a participant of. */
  participantId?: ID;
  page?: number;
  pageSize?: number;
}

export interface MeetingInput {
  title: string;
  projectId?: ID;
  location?: string;
  startsAt: ISODate;
  durationMinutes: number;
  agenda?: string;
  minutes?: string;
  state?: MeetingState;
  /** The full participant list. Sending it replaces whatever was there. */
  participantIds?: ID[];
}

/* -------------------------------------------------------------------------- */
/* News                                                                       */
/* -------------------------------------------------------------------------- */

export interface EpmNewsPost extends CollaborationScope {
  id: ID;
  title: string;
  summary?: string;
  /** Markdown. */
  body: string;
  authorId: ID;
  authorName?: string;
  /** Absent while it is a draft, which only its author and administrators see. */
  publishedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  can: RecordAbilities;
}

export interface NewsFilters {
  projectId?: ID;
  /** Drafts are only ever the caller's own, whatever this asks for. */
  includeDrafts?: boolean;
  page?: number;
  pageSize?: number;
}

export interface NewsInput {
  title: string;
  projectId?: ID;
  summary?: string;
  body: string;
  /** True publishes it now; false returns it to a draft. */
  published?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Wiki                                                                       */
/* -------------------------------------------------------------------------- */

export interface EpmWikiPage extends CollaborationScope {
  id: ID;
  /** URL-safe, and unique within its project. Part of the page's address. */
  slug: string;
  title: string;
  /** Markdown. */
  body: string;
  parentId?: ID;
  updatedBy: ID;
  updatedByName?: string;
  /** How many past versions exist, so the history tab can say whether to open. */
  revisionCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  can: RecordAbilities;
}

/** A page in the navigation tree, without its body. */
export interface WikiTreeNode {
  id: ID;
  slug: string;
  title: string;
  children: WikiTreeNode[];
}

export interface WikiRevision {
  id: ID;
  /** What the page said before the edit that produced this record. */
  title: string;
  body: string;
  authorId: ID;
  authorName?: string;
  createdAt: ISODate;
}

export interface WikiPageInput {
  title: string;
  body: string;
  projectId?: ID;
  parentId?: ID;
  /** Derived from the title when absent. Changing it changes the page's address. */
  slug?: string;
}

/* -------------------------------------------------------------------------- */
/* Approvals (BRQ-09)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Who a step asks. Resolved to people when the request is submitted, so the
 * approvers of a request in flight do not change if, say, the project owner
 * does.
 */
export type ApprovalApproverSpec =
  | { kind: 'user'; userId: ID }
  /** EPM's project owner. */
  | { kind: 'project_owner' }
  /** Everyone holding this role in the subject's project. */
  | { kind: 'project_role'; roleId: ID }
  /** The requester's team lead, or failing that their department manager. */
  | { kind: 'requester_manager' };

export type ApprovalConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'in' | 'not_in';

/**
 * When a step applies (BR-211). `field` is `value` (the chain's value field),
 * `type`, `priority`, `project`, `portfolio`, or a custom field such as
 * `customField12`. Ids are compared for type, priority, project and
 * portfolio; a custom field is compared as a number when both sides are
 * numbers and as text otherwise.
 */
export interface ApprovalCondition {
  field: string;
  operator: ApprovalConditionOperator;
  value: number | string | string[];
}

export interface ApprovalStep {
  /** Stable within the chain. */
  id: string;
  name: string;
  approvers: ApprovalApproverSpec[];
  /** `all`: everyone named must approve. `any`: the first approval decides the step. */
  mode: 'all' | 'any';
  /** Absent: the step always applies. */
  condition?: ApprovalCondition;
  /** Hours the step may take before it is escalated (BR-214). Absent: no SLA. */
  slaHours?: number;
  /** Who is told when the SLA is breached. Absent or empty: the project owner. */
  escalateTo?: ApprovalApproverSpec[];
}

/** A chain as an administrator defines it (BR-211). */
export interface ApprovalChain {
  id: ID;
  name: string;
  description?: string;
  subjectType: 'work_package';
  /** Work package types it covers; empty means every type. */
  typeIds: ID[];
  /** Projects it covers; empty means every project. */
  projectIds: ID[];
  /** The custom field value thresholds are measured against, e.g. `customField3`. */
  valueField?: string;
  steps: ApprovalStep[];
  onSubmitStatusId?: ID;
  onApproveStatusId?: ID;
  onRejectStatusId?: ID;
  /** Off by default: whoever raised it does not approve it. */
  allowSelfApproval: boolean;
  active: boolean;
  createdBy: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Requests that have used it. A chain that has been used is retired, not deleted. */
  requestCount: number;
}

export type ApprovalChainInput = Pick<
  ApprovalChain,
  | 'name'
  | 'description'
  | 'typeIds'
  | 'projectIds'
  | 'valueField'
  | 'steps'
  | 'onSubmitStatusId'
  | 'onApproveStatusId'
  | 'onRejectStatusId'
  | 'allowSelfApproval'
  | 'active'
>;

/** What the chain editor offers, read from the instance. */
export interface ApprovalChainOptions {
  types: { id: ID; name: string }[];
  statuses: { id: ID; name: string; isClosed: boolean }[];
  priorities: { id: ID; name: string }[];
  roles: { id: ID; name: string }[];
  projects: { id: ID; name: string }[];
  portfolios: { id: ID; name: string }[];
  /** Work package custom fields; the numeric ones can be a chain's value field. */
  customFields: { id: string; name: string; numeric: boolean }[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type ApprovalTaskStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';

export interface ApprovalTaskView {
  id: ID;
  approverId: ID;
  /** Someone who may also decide, under a delegation (BR-212). */
  delegateId?: ID;
  status: ApprovalTaskStatus;
  activatedAt?: ISODate;
  /** When the step's SLA runs out. */
  dueAt?: ISODate;
  breachedAt?: ISODate;
  decidedAt?: ISODate;
  /** Who decided: the approver or their delegate. */
  decidedBy?: ID;
  /** Set when a delegate decided: whose authority they used. */
  onBehalfOf?: ID;
  comment?: string;
  /** Whether the caller may decide this now. */
  canDecide: boolean;
}

export interface ApprovalStepView {
  index: number;
  name: string;
  mode: 'all' | 'any';
  /** False when its condition did not hold at submission: shown, never run. */
  applies: boolean;
  /** Why it applies or not, in one sentence. */
  conditionText?: string;
  slaHours?: number;
  status: 'waiting' | 'active' | 'approved' | 'rejected' | 'skipped';
  tasks: ApprovalTaskView[];
}

export interface ApprovalRequestView {
  id: ID;
  chainId: ID;
  chainName: string;
  subjectType: 'work_package';
  subjectId: ID;
  projectId: ID;
  projectName?: string;
  /** The work package's key and subject. */
  title: string;
  value?: number;
  /** The value field's name, e.g. "Change value". */
  valueLabel?: string;
  requestedBy: ID;
  requestedAt: ISODate;
  status: ApprovalStatus;
  /** The step deciding now, while pending. */
  currentStep: number;
  completedAt?: ISODate;
  /** Set when the decision stood but moving the subject's status failed. */
  outcomeError?: string;
  steps: ApprovalStepView[];
  can: { cancel: boolean };
}

/** Approval state of one subject, for its own page. */
export interface ApprovalSubjectState {
  /** The chain that applies to it now, previewed against its current values. */
  chain?: {
    id: ID;
    name: string;
    steps: { name: string; applies: boolean; conditionText?: string }[];
  };
  canSubmit: boolean;
  /** Why it cannot be submitted, when it cannot. */
  submitBlocked?: string;
  /** The request in flight, or the latest one. */
  current?: ApprovalRequestView;
  /** Earlier requests for the same subject, newest first. */
  history: ApprovalRequestView[];
}

/** A person's approvals handed to someone else for a period (BR-212). */
export interface ApprovalDelegation {
  id: ID;
  delegatorId: ID;
  delegateId: ID;
  startsOn: ISODate;
  endsOn: ISODate;
  reason?: string;
  createdBy: ID;
  createdAt: ISODate;
  revokedAt?: ISODate;
  /** In force today. */
  active: boolean;
}

export interface ApprovalDelegationInput {
  delegateId: ID;
  startsOn: ISODate;
  endsOn: ISODate;
  reason?: string;
  /** Administrators may delegate for someone else; everyone else only for themselves. */
  delegatorId?: ID;
}

/** What a decide-from-email link opens on (BR-215). */
export interface ApprovalLinkView {
  request: ApprovalRequestView;
  taskId: ID;
  stepName: string;
  /** Set when the link's owner decides as a delegate. */
  onBehalfOf?: ID;
}

/* -------------------------------------------------------------------------- */
/* Rules and escalation (BRQ-10: BR-216 to BR-219)                            */
/* -------------------------------------------------------------------------- */

/** What a rule watches and acts on. */
export type RuleSubjectType = 'work_package' | 'project';

export type RuleEventKind =
  | 'work_package.created'
  | 'work_package.updated'
  | 'project.created'
  | 'project.updated'
  /** EPM's own: a project's overall health level changed. */
  | 'project.health_changed';

export type RuleConditionOperator =
  | 'in'
  | 'not_in'
  | 'is_empty'
  | 'is_set'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  /** Dates: before today, i.e. in the past. */
  | 'before_today'
  | 'today_or_later'
  /** Dates: between today and that many days ahead. */
  | 'within_next_days'
  /** Dates: more, or fewer, than that many days ago. */
  | 'more_than_days_ago'
  | 'less_than_days_ago'
  /** Dates: against a fixed YYYY-MM-DD. */
  | 'on_or_before'
  | 'on_or_after';

/**
 * One test on an item (BR-216). `field` is an attribute — `type`, `status`,
 * `priority`, `assignee`, `dueDate`, `customField7` and so on — and `value`
 * whatever the operator needs: ids for `in`, a number of days, a date, text.
 */
export interface RuleCondition {
  field: string;
  operator: RuleConditionOperator;
  value?: string | number | boolean | string[];
}

export interface RuleConditionGroup {
  /** `all`: every condition must hold. `any`: one is enough. None: always. */
  match: 'all' | 'any';
  conditions: RuleCondition[];
}

/** Who, relative to the item: for notifications, assignment and escalation paths. */
export type PersonSpec =
  | { kind: 'user'; userId: ID }
  | { kind: 'assignee' }
  | { kind: 'responsible' }
  | { kind: 'author' }
  | { kind: 'project_owner' }
  /** The assignee's team lead (for an approval: the approver's). */
  | { kind: 'team_lead' }
  /** The assignee's department manager (for an approval: the approver's). */
  | { kind: 'department_manager' }
  | { kind: 'project_role'; roleId: ID }
  /** Escalating an approval: the approvers it is waiting on. */
  | { kind: 'approvers' };

export type RuleRelation = 'relates' | 'blocks' | 'blocked' | 'follows' | 'precedes' | 'child' | 'none';

/** A date can be set relative to today or to the item's own dates. */
export type RuleFieldValue =
  | string
  | number
  | null
  | { relativeDays: number; from?: 'today' | 'startDate' | 'dueDate' };

/**
 * What a rule does (BR-217). Changes to OpenProject are made as the automation
 * account; `notify` and `call_endpoint` are EPM's own.
 */
export type RuleAction =
  | { type: 'assign'; to: PersonSpec | { kind: 'nobody' } }
  | {
      type: 'notify';
      recipients: PersonSpec[];
      /** Placeholders: {{key}} {{subject}} {{project}} {{status}} {{priority}} {{type}} {{assignee}} {{dueDate}} {{health}} {{url}} {{rule}} */
      title: string;
      message: string;
      severity?: 'info' | 'warning' | 'critical';
    }
  | { type: 'set_status'; statusId: ID }
  | { type: 'set_field'; field: string; value: RuleFieldValue }
  | {
      type: 'create_work_package';
      typeId: ID;
      subject: string;
      description?: string;
      assignee?: PersonSpec;
      /** How the new item relates to the one that fired the rule. `none` for project rules. */
      relation: RuleRelation;
      dueInDays?: number;
    }
  | { type: 'call_endpoint'; url: string };

export interface AutomationRule {
  id: ID;
  name: string;
  description?: string;
  active: boolean;
  subjectType: RuleSubjectType;
  events: RuleEventKind[];
  /** Empty means every project. */
  projectIds: ID[];
  conditions: RuleConditionGroup;
  /** `enter`: once as an item starts to match, again only after it stops. `every`: every matching event. */
  fireMode: 'enter' | 'every';
  actions: RuleAction[];
  version: number;
  createdBy: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  firingCount: number;
  lastFiredAt?: ISODate;
}

export type AutomationRuleInput = Pick<
  AutomationRule,
  'name' | 'description' | 'active' | 'subjectType' | 'events' | 'projectIds' | 'conditions' | 'fireMode' | 'actions'
>;

export interface RuleActionOutcome {
  type: RuleAction['type'];
  outcome: 'done' | 'failed' | 'skipped';
  /** What it did, or would have, in a sentence. */
  summary: string;
  error?: string;
}

/** One firing, with what each action did (BR-219). */
export interface RuleFiringView {
  id: ID;
  ruleId: ID;
  ruleName: string;
  ruleVersion: number;
  trigger: string;
  subjectType: RuleSubjectType;
  subjectId: ID;
  subjectTitle?: string;
  projectId?: ID;
  outcome: 'succeeded' | 'partial' | 'failed' | 'skipped';
  actions: RuleActionOutcome[];
  firedAt: ISODate;
  durationMs?: number;
}

export interface RuleDryRunItem {
  subjectType: RuleSubjectType;
  subjectId: ID;
  title: string;
  projectId?: ID;
  projectName?: string;
  /** What the rule would have done to it, action by action. Nothing was done. */
  actions: string[];
}

/** What a rule would have done over a past window, with nothing changed (BR-219). */
export interface RuleDryRunResult {
  windowDays: number;
  /** Items in scope changed within the window. */
  evaluated: number;
  matched: number;
  items: RuleDryRunItem[];
  truncated: boolean;
  notes: string[];
}

export type EscalationTrigger = 'untouched' | 'overdue' | 'approval_sla';

/** A level of an escalation path (BR-218). */
export interface EscalationLevel {
  /** Days untouched or overdue; hours past the SLA for approvals. */
  after: number;
  notify: PersonSpec[];
}

export interface EscalationPolicy {
  id: ID;
  name: string;
  description?: string;
  active: boolean;
  trigger: EscalationTrigger;
  /** Empty means every project, type or priority. */
  projectIds: ID[];
  typeIds: ID[];
  priorityIds: ID[];
  levels: EscalationLevel[];
  version: number;
  createdBy: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Escalations of this policy not yet resolved. */
  openCount: number;
}

export type EscalationPolicyInput = Pick<
  EscalationPolicy,
  'name' | 'description' | 'active' | 'trigger' | 'projectIds' | 'typeIds' | 'priorityIds' | 'levels'
>;

/** An escalation raised: by an approval step's own SLA, or by a policy's level. */
export interface EscalationView {
  id: ID;
  source: string;
  policyId?: ID;
  policyName?: string;
  subjectType: string;
  subjectId: ID;
  subjectTitle?: string;
  /** Where to open it in EPM. */
  link?: string;
  projectId?: ID;
  projectName?: string;
  level: number;
  raisedFor: ID[];
  reason: string;
  raisedAt: ISODate;
  resolvedAt?: ISODate;
}

/** What a policy would escalate now, with nothing raised or sent. */
export interface EscalationDryRunResult {
  evaluated: number;
  items: {
    subjectType: string;
    subjectId: ID;
    title: string;
    projectName?: string;
    level: number;
    since: ISODate;
    recipients: ID[];
    /** Already raised at this level: a real sweep would send nothing new. */
    alreadyRaised: boolean;
  }[];
  truncated: boolean;
}

export interface AutomationStatus {
  account: {
    configured: boolean;
    working: boolean;
    userId?: ID;
    name?: string;
    admin?: boolean;
    roleFound: boolean;
  };
  worker: { enabled: boolean; pollSeconds: number; queued: number; failed: number; lastProcessedAt?: ISODate };
  escalation: { enabled: boolean; intervalMinutes: number; lastRunAt?: ISODate };
  /** Changes made outside EPM reach the rules only through the webhook. */
  webhook: { secretConfigured: boolean; lastReceivedAt?: ISODate };
  outbound: { signing: boolean; allowlist: string[] };
}

/** What the rule and policy editors offer, read from the instance. */
export interface AutomationOptions {
  types: { id: ID; name: string }[];
  statuses: { id: ID; name: string; isClosed: boolean }[];
  priorities: { id: ID; name: string }[];
  roles: { id: ID; name: string }[];
  projects: { id: ID; name: string }[];
  portfolios: { id: ID; name: string }[];
  customFields: { id: string; name: string; numeric: boolean }[];
}

/* -------------------------------------------------------------------------- */
/* Reports, dashboards and analytics (BRQ-05: BR-401 to BR-405)                */
/* -------------------------------------------------------------------------- */

export type MeasureUnit = 'count' | 'percent' | 'hours' | 'money' | 'days' | 'perWeek' | 'points';
export type MeasureScopeKind = 'instance' | 'portfolio' | 'project' | 'department' | 'team' | 'person';
export type MeasureMemberKind = 'work_package' | 'project' | 'person';

export interface MeasureScope {
  kind: MeasureScopeKind;
  /** The portfolio, project, department, team or person; absent for the instance. */
  id?: ID;
}

export interface MeasurePeriod {
  /** First day, inclusive. */
  from: ISODate;
  /** Last day, inclusive. */
  to: ISODate;
}

/** A measure as the semantic layer defines it (BR-404). */
export interface MeasureInfo {
  id: string;
  label: string;
  unit: MeasureUnit;
  /** Exactly what is counted. */
  definition: string;
  scopes: MeasureScopeKind[];
  usesPeriod: boolean;
  memberKind?: MeasureMemberKind;
  trend?: 'period' | 'asAt';
  version: number;
  /** How a set of projects' figure is made from each project's (BR-201). */
  rollup?: { rule: 'sum' | 'max' | 'ratio'; describe: string };
  /** Money made of logged time: it drills to the priced time entries (BR-202). */
  entries?: 'to-date' | 'in-period';
}

/** A measure's value for one scope, period and viewer. */
export interface MeasureResult {
  id: string;
  label: string;
  unit: MeasureUnit;
  definition: string;
  memberKind?: MeasureMemberKind;
  /** False when the measure has no meaning for this kind of scope. */
  applicable: boolean;
  /** Null when there is nothing to measure; `note` says why. */
  value: number | null;
  note?: string;
  /** Ids of the work packages, projects or people behind the value. */
  members?: number[];
  parts?: Record<string, number | null>;
}

export interface MeasureEvaluation {
  scope: MeasureScope;
  period: MeasurePeriod;
  today: ISODate;
  /** When the analytics model's data was read. */
  asOf: ISODate | null;
  measures: Record<string, MeasureResult>;
}

export interface MeasureWorkMember {
  id: number;
  subject: string;
  projectId: number;
  projectName: string;
  type: string;
  status: string;
  statusCategory: string;
  priority: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  dueDate: ISODate | null;
  closedAt: ISODate | null;
  isMilestone: boolean;
  /** Why it is here, where the measure says: met, missed, late 3d. */
  flag?: string;
}

export interface MeasureProjectMember {
  id: number;
  name: string;
  identifier: string | null;
  portfolioId: string | null;
  health: HealthLevel | null;
  scheduleVarianceDays: number | null;
  budget: number | null;
}

export interface MeasurePersonMember {
  id: number;
  name: string;
  departmentId: string | null;
  teamId: string | null;
  weeklyCapacityHours: number;
  loggedHours: number;
  utilisation: number | null;
}

export type MeasureMembers =
  | { kind: 'work_package'; items: MeasureWorkMember[] }
  | { kind: 'project'; items: MeasureProjectMember[] }
  | { kind: 'person'; items: MeasurePersonMember[] };

/** The drill-through behind a measure's value. */
export interface MeasureMembersResult {
  measure: MeasureResult;
  asOf: ISODate | null;
  members: MeasureMembers;
}

export interface MeasureTrendPoint {
  from: ISODate;
  to: ISODate;
  value: number | null;
}

export interface MeasureTrend {
  measure: MeasureInfo;
  asOf: ISODate | null;
  points: MeasureTrendPoint[];
}

export type DashboardId = 'portfolio-health' | 'delivery' | 'utilisation' | 'budget' | 'risk';
export type DashboardLinkKind = 'portfolio' | 'project' | 'department' | 'team' | 'person' | 'work_package';

export interface DashboardColumn {
  key: string;
  label: string;
  unit?: MeasureUnit;
  measureId?: string;
}

export interface DashboardRow {
  key: string;
  cells: Record<string, string | number | null>;
  link?: { kind: DashboardLinkKind; id: string };
}

export interface DashboardTable {
  id: string;
  title: string;
  description?: string;
  columns: DashboardColumn[];
  rows: DashboardRow[];
}

export interface DashboardSeries {
  id: string;
  title: string;
  measureId: string;
  bucket: 'week' | 'month';
  points: MeasureTrendPoint[];
}

/** An executive or PMO dashboard (BR-405), described as data. */
export interface Dashboard {
  id: DashboardId;
  title: string;
  description: string;
  scope: MeasureScope & { name: string };
  period: MeasurePeriod;
  today: ISODate;
  asOf: ISODate | null;
  /** The measures on the tiles, in order. */
  tiles: string[];
  measures: Record<string, MeasureResult>;
  tables: DashboardTable[];
  series: DashboardSeries[];
  timing: { serverMs: number; targetMs: number; withinTarget: boolean };
}

/* ---------------------------------------------------- the analytics model */

export interface ReconciliationLine {
  entity: string;
  label: string;
  source: number;
  model: number;
  difference: number;
  /** Rows of difference the tolerance allows. */
  allowed: number;
  ok: boolean;
}

export interface AnalyticsRefreshRun {
  id: ID;
  kind: 'full' | 'incremental';
  trigger: 'schedule' | 'manual' | 'change';
  startedAt: ISODate;
  finishedAt: ISODate | null;
  status: 'running' | 'succeeded' | 'failed';
  durationMs: number | null;
  /** The agreed window a full refresh must finish within. */
  windowMs: number | null;
  withinWindow: boolean | null;
  rows: Record<string, number> | null;
  reconciliation: ReconciliationLine[] | null;
  reconciled: boolean | null;
  error: string | null;
}

export interface AnalyticsRefreshRunPage {
  items: AnalyticsRefreshRun[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AnalyticsModelStatus {
  enabled: boolean;
  asOf: ISODate | null;
  running: boolean;
  lastFull: AnalyticsRefreshRun | null;
  lastIncremental: AnalyticsRefreshRun | null;
  counts: Record<string, number>;
  windowMinutes: number;
  tolerancePct: number;
  fullRefreshHourUtc: number;
  intervalMinutes: number;
}

/** Every work package as API v3 reported it at a moment (BR-403). */
export interface WorkPackageCapture {
  id: ID;
  capturedAt: ISODate;
  trigger: string;
  workPackages: number;
}

export interface WorkPackageCapturePage {
  items: WorkPackageCapture[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReconstructionDifference {
  workPackageId: number;
  subject: string | null;
  field: string;
  label: string;
  captured: string | null;
  reconstructed: string | null;
}

/** Reconstruction from the journals, compared with a capture row by row. */
export interface ReconstructionCheck {
  capture: WorkPackageCapture;
  modelAsOf: ISODate | null;
  compared: number;
  matched: number;
  mismatched: number;
  deletedSince: number;
  missingFromHistory: number;
  differences: ReconstructionDifference[];
  matches: boolean;
}

/** The work in scope as it stood at an instant. */
export interface StateAsAt {
  at: ISODate;
  day: ISODate;
  total: number;
  open: number;
  closed: number;
  overdue: number;
  byStatus: { statusId: number; name: string; category: string; count: number }[];
  byProject: { projectId: number; name: string; total: number; open: number; overdue: number }[];
}

export interface AnalyticsAccessProbe {
  attempt: string;
  statement: string;
  /** A read worked; a write was refused. */
  ok: boolean;
  code?: string;
  message?: string;
}

/** Whether the analytics role reads everything and writes nothing (BR-401). */
export interface AnalyticsAccessCheck {
  configured: boolean;
  checkedAt: ISODate;
  role?: string;
  replica?: boolean;
  lagSeconds?: number | null;
  reads: AnalyticsAccessProbe[];
  writes: AnalyticsAccessProbe[];
  /** The role's privileges as the primary records them: the second lock. */
  grants: AnalyticsAccessProbe[];
  ok: boolean;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Scheduled report distribution (BRQ-08: BR-207 to BR-210)                    */
/* -------------------------------------------------------------------------- */

export type ReportFrequency = 'daily' | 'weekly' | 'monthly';
export type ReportPeriodPreset =
  | 'previous-week'
  | 'previous-month'
  | 'last-4-weeks'
  | 'last-12-weeks'
  | 'month-to-date'
  | 'year-to-date';
export type ReportFormat = 'pdf' | 'xlsx';

/** What a scheduled report is: its source, timetable and recipients. */
export interface ReportScheduleInput {
  name: string;
  description?: string | null;
  active: boolean;
  sourceKind: 'dashboard' | 'view';
  /** A dashboard id, or a saved view's id. */
  sourceId: string;
  /** For a dashboard: `instance`, `portfolio:<id>`, `project:<id>`, … */
  scope: string;
  periodPreset: ReportPeriodPreset;
  frequency: ReportFrequency;
  /** 1 Monday … 7 Sunday. */
  weekday?: number | null;
  /** 1–28, or 0 for the last day. */
  dayOfMonth?: number | null;
  /** `HH:MM`, wall-clock in `timezone`. */
  timeOfDay: string;
  timezone: string;
  windowMinutes: number;
  formats: ReportFormat[];
  recipientUserIds: ID[];
  externalEmails: string[];
}

export interface ReportSchedule extends ReportScheduleInput {
  id: ID;
  description: string | null;
  weekday: number | null;
  dayOfMonth: number | null;
  externalApproval: { required: boolean; approved: boolean; approvedBy?: ID; approvedAt?: ISODate; setBy?: ID };
  ownerId: ID;
  nextRunAt: ISODate | null;
  lastRunAt: ISODate | null;
  lastRunStatus: ReportRunStatus | null;
  /** "Mondays at 07:00 (Asia/Dubai)". */
  describedTiming: string;
  /** "Portfolio health — All projects". */
  sourceLabel: string;
  version: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ReportScheduleOptions {
  dashboards: { id: DashboardId; title: string }[];
  views: { id: ID; name: string }[];
}

export type ReportRunStatus = 'running' | 'rendered' | 'missed' | 'failed';

/** One recipient's copy of a run, and how its email went (BR-209, BR-210). */
export interface ReportDelivery {
  id: ID;
  recipientKind: 'user' | 'external';
  recipientUserId?: ID;
  recipientEmail?: string;
  renderStatus: 'rendered' | 'withheld' | 'failed';
  /** Why it was withheld or failed. */
  reason?: string;
  /** Projects this copy covered, and how many in scope this recipient's access left out. */
  projectCount: number;
  excludedProjects: number;
  emailStatus: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'withheld' | 'none';
  attempts: number;
  lastError?: string;
  sentAt?: ISODate;
  artifacts: { id: ID; format: ReportFormat; filename: string; size: number }[];
}

export interface ReportRun {
  id: ID;
  scheduleId: ID;
  scheduleName: string;
  /** The occurrence; null for a run asked for by hand. */
  scheduledFor: ISODate | null;
  trigger: 'schedule' | 'manual';
  triggeredBy?: ID;
  status: ReportRunStatus;
  deliveryState: 'delivered' | 'partial' | 'pending' | 'failed' | 'none';
  periodFrom?: ISODate;
  periodTo?: ISODate;
  startedAt: ISODate;
  finishedAt?: ISODate;
  error?: string;
  recipients: number;
  delivered: number;
  failed: number;
  withheld: number;
  /** In a single run's detail. */
  deliveries?: ReportDelivery[];
}

export interface ReportRunPage {
  items: ReportRun[];
  total: number;
  page: number;
  pageSize: number;
}

/* -------------------------------------------------------------------------- */
/* Portfolio views (BRQ-06: BR-201 to BR-203)                                  */
/* -------------------------------------------------------------------------- */

/** One figure for one project, or for a whole set. */
export interface OverviewFigure {
  value: number | null;
  parts?: Record<string, number | null>;
  note?: string;
}

export interface PortfolioOverviewProject {
  id: number;
  name: string;
  identifier: string | null;
  portfolioId: string | null;
  /** Effective overall health; null until assessed. */
  health: HealthLevel | null;
  /** Every overview measure, for this project alone. */
  figures: Record<string, OverviewFigure>;
  /** The next open milestone: the earliest due, which may already be past (negative days). */
  nextMilestone: { id: number; subject: string; dueDate: ISODate; daysToGo: number } | null;
}

/** A set figure checked against the roll-up of its project rows (BR-201). */
export interface ReconciliationLine {
  measureId: string;
  rule: 'sum' | 'max' | 'ratio';
  aggregate: number | null;
  fromProjects: number | null;
  matches: boolean;
}

/** A portfolio, or a saved view's projects, in one view, for the person asking. */
export interface PortfolioOverview {
  set: {
    kind: 'portfolio' | 'view';
    id: ID;
    name: string;
    /** Active projects the set selects. */
    projects: number;
    /** Of those, shown to this person. */
    shown: number;
    /** Left out because this person cannot see them. */
    hidden: number;
    /** Left out by a saved view's health filter. */
    filtered: number;
  };
  period: MeasurePeriod;
  today: ISODate;
  asOf: ISODate | null;
  /** Each figure for the whole set. */
  measures: Record<string, Omit<MeasureResult, 'members'>>;
  projects: PortfolioOverviewProject[];
  reconciliation: ReconciliationLine[];
  /** Every set figure agrees with its project rows. */
  reconciled: boolean;
}

/** A time entry behind a cost figure, priced by the labour cost rule (BR-202). */
export interface CostEntry {
  id: ID;
  spentOn: ISODate;
  hours: number;
  userId: ID;
  userName: string;
  workPackageId?: ID;
  workPackageSubject?: string;
  activity?: string;
  /** Null when the person has no hourly rate: such hours are not costed. */
  cost: number | null;
}

export interface CostEntries {
  measure: { id: string; label: string };
  project: { id: ID; name: string };
  /** Both null for every entry to date. */
  window: { from: ISODate | null; to: ISODate | null };
  entries: CostEntry[];
  total: number;
  page: number;
  pageSize: number;
  totals: { hours: number; costedHours: number; uncostedHours: number; cost: number };
  /** The labour cost the figure was made from, for this project, and whether these entries add up to it. */
  figure: { actual: number | null; matches: boolean };
}

export type PortfolioViewVisibility = 'private' | 'roles' | 'public';

/** What a project row can show: its health, or any overview measure. */
export type PortfolioOverviewColumn = 'health' | string;

export interface PortfolioViewDefinition {
  /** Projects in these portfolios… */
  portfolioIds: ID[];
  /** …and these projects; every project when both are empty. */
  projectIds: ID[];
  /** Only projects at these healths; empty for all. */
  health: HealthLevel[];
  periodPreset: ReportPeriodPreset;
  columns: PortfolioOverviewColumn[];
}

export interface PortfolioViewInput {
  name: string;
  description?: string | null;
  visibility: PortfolioViewVisibility;
  /** OpenProject role ids, for `roles`. */
  roleIds: ID[];
  definition: PortfolioViewDefinition;
}

/** A saved portfolio view (BR-203). */
export interface PortfolioView extends PortfolioViewInput {
  id: ID;
  description: string | null;
  roles: { id: ID; name: string }[];
  owner: { id: ID; name: string };
  mine: boolean;
  /** The owner may change it; so may someone who manages portfolios, once it is shared. */
  canEdit: boolean;
  version: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface PortfolioViewOptions {
  /** Project roles a view can be shared with. */
  roles: { id: ID; name: string }[];
  columns: PortfolioOverviewColumn[];
}

/* -------------------------------------------------------------------------- */
/* Critical path (BRQ-01)                                                     */
/* -------------------------------------------------------------------------- */

/** One work package's place in the schedule, in working days (BR-101). */
export interface ScheduleItem {
  id: ID;
  earlyStart: ISODate;
  earlyFinish: ISODate;
  lateStart: ISODate;
  lateFinish: ISODate;
  /** Working days it can slip without moving its project's finish. */
  totalFloat: number;
  /** Working days it can slip without moving any successor. */
  freeFloat: number;
  /** Total float of nought or less. */
  critical: boolean;
  /** Not critical, and total float within the threshold asked for (BR-102). */
  nearCritical: boolean;
  /** A parent: its figures are its children's, rolled up. */
  summary: boolean;
  /** Part of a cycle of relations, scheduled as if the cycle's relations were not there. */
  inCycle: boolean;
}

/** A `follows` relation, and whether it sets its successor's early start. */
export interface ScheduleLink {
  id: ID;
  predecessorId: ID;
  successorId: ID;
  /** Working days between the predecessor's finish and the successor's start. */
  lag: number;
  /** The successor could start no sooner: this predecessor holds it. */
  driving: boolean;
  /** Driving, between two critical items: a step of the critical path. */
  critical: boolean;
}

export interface ScheduleMeta {
  /** When the figures were computed; absent before the first pass. */
  computedAt?: ISODate;
  /** A pass is queued or running; the figures may be about to change. */
  pending: boolean;
  /** The near-critical threshold applied, in working days. */
  nearCriticalDays: number;
  /** The threshold a view starts from. */
  defaultNearCriticalDays: number;
  enabled: boolean;
}

/** A project's scheduled work with its float, and the relations between it. */
export interface ProjectCriticalPath extends ScheduleMeta {
  projectId: ID;
  items: ScheduleItem[];
  links: ScheduleLink[];
  /** The latest early finish of the project's work. */
  finish?: ISODate;
  /** Cycles among the project's work: each one's members. */
  cycles: ID[][];
  /** Leaf work only; parents are their children rolled up. */
  counts: { scheduled: number; critical: number; nearCritical: number };
}

/** One work package's figures, and the relations it is part of. */
export interface WorkPackageSchedule extends ScheduleMeta {
  workPackageId: ID;
  /** Absent when it has no dates, or before the first pass. */
  item?: ScheduleItem;
  predecessors: ScheduleLink[];
  successors: ScheduleLink[];
}

/** One pass over the network (BR-104). */
export interface ScheduleRun {
  id: ID;
  trigger: 'change' | 'check' | 'manual' | 'startup' | string;
  status: 'running' | 'completed' | 'failed' | string;
  startedAt: ISODate;
  finishedAt?: ISODate;
  workPackages: number;
  relations: number;
  scheduled: number;
  unscheduled: number;
  cycles: number[][];
  /** Stored figures written and removed. */
  changed: number;
  removed: number;
  /** Work packages whose OpenProject fields were rewritten. */
  mirrored: number;
  /** Scheduled work packages whose type does not hold the fields. */
  mirrorSkipped: number;
  mirrorError?: string;
  readMs?: number;
  computeMs?: number;
  storeMs?: number;
  mirrorMs?: number;
  durationMs?: number;
  error?: string;
}

export interface ScheduleStatus {
  enabled: boolean;
  mirrorEnabled: boolean;
  checkSeconds: number;
  /** Networks up to this size are waited for on a read; larger ones are not. */
  syncLimit: number;
  defaultNearCriticalDays: number;
  pending: boolean;
  lastRun?: ScheduleRun;
  lastCompleted?: ScheduleRun;
}
