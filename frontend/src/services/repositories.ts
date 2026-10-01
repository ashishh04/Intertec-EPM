/**
 * Repository contracts.
 *
 * Each domain has exactly one interface, implemented by `Api*Repository`
 * against the EPM backend. The UI only ever sees these contracts.
 */

import type {
  ActivityEntry,
  CalendarEvent,
  CreateTaskInput,
  TaskHierarchy,
  DashboardMetrics,
  DeliveryTrendPoint,
  ExecutiveInsights,
  ID,
  IntegrationStatus,
  InviteInfo,
  Milestone,
  EpmDocument,
  EpmNotification,
  EpmProject,
  HealthOverride,
  EpmSprint,
  EpmTask,
  EpmUser,
  Paginated,
  ReportFilters,
  StatusDistribution,
  TaskFilters,
  TimeEntrySummary,
  UpdateTaskInput,
  UserPreferences,
} from '@/types';

export interface ProjectRepository {
  getProjects(params?: { search?: string; status?: string[] }): Promise<EpmProject[]>;
  getProject(id: ID): Promise<EpmProject>;
  getMilestones(projectId: ID): Promise<Milestone[]>;
  updateProject(id: ID, patch: Partial<EpmProject>): Promise<EpmProject>;
  /** Pins health dimensions. EPM-owned, so its own endpoint and permission. */
  setHealthOverride(id: ID, override: HealthOverride): Promise<EpmProject>;
  /** The projects directly beneath this one. */
  getChildren(id: ID): Promise<EpmProject[]>;
  /** Moves it under another project, or to the top level with an empty id. */
  setParent(id: ID, parentId: string): Promise<EpmProject>;
}

export interface TaskRepository {
  getTasks(filters?: TaskFilters): Promise<Paginated<EpmTask>>;
  getTask(id: ID): Promise<EpmTask>;
  getHierarchy(id: ID): Promise<TaskHierarchy>;
  createTask(input: CreateTaskInput): Promise<EpmTask>;
  updateTask(input: UpdateTaskInput): Promise<EpmTask>;
  bulkUpdate(ids: ID[], patch: Partial<UpdateTaskInput>): Promise<EpmTask[]>;
  deleteTasks(ids: ID[]): Promise<void>;
}

export interface ProfileInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  language?: string;
  /** An IANA zone name, e.g. `Asia/Kolkata`. The instance validates it. */
  timezone?: string;
}

export interface UserRepository {
  getCurrentUser(): Promise<EpmUser>;
  getUsers(): Promise<EpmUser[]>;
  getUser(id: ID): Promise<EpmUser>;
  /** The timezone names the instance accepts, which are not the browser's. */
  getTimezones(): Promise<string[]>;
  /** Edits the signed-in person's own details. Returns their updated record. */
  updateProfile(input: ProfileInput): Promise<EpmUser>;
}

export interface CreateSprintInput {
  name: string;
  projectId: ID;
  startDate?: string;
  endDate?: string;
}

export interface SprintRepository {
  getSprints(): Promise<EpmSprint[]>;
  getSprint(id: ID): Promise<EpmSprint>;
  /**
   * The sprint currently running, or `null` when there is none. A team between
   * sprints is an ordinary state rather than a failure, so it resolves instead
   * of rejecting — callers that cannot tell the two apart end up rendering a
   * loading skeleton forever.
   */
  getActiveSprint(): Promise<EpmSprint | null>;
  createSprint(input: CreateSprintInput): Promise<{ id: ID; name: string }>;
  /** Starts (`active`) or completes (`completed`) a sprint. */
  setSprintState(id: ID, state: 'active' | 'completed'): Promise<EpmSprint>;
}

export interface DashboardRepository {
  getMetrics(): Promise<DashboardMetrics>;
  getActivity(params?: { projectId?: ID; limit?: number }): Promise<ActivityEntry[]>;
  getCalendarEvents(params: { from: string; to: string }): Promise<CalendarEvent[]>;
}

export interface ReportRepository {
  getDeliveryTrends(filters?: ReportFilters): Promise<DeliveryTrendPoint[]>;
  getStatusDistribution(filters?: ReportFilters): Promise<StatusDistribution[]>;
  getExecutiveInsights(filters?: ReportFilters): Promise<ExecutiveInsights>;
  getTimeSummary(filters?: ReportFilters): Promise<TimeEntrySummary[]>;
}

export interface NotificationRepository {
  getNotifications(): Promise<EpmNotification[]>;
  markRead(ids: ID[]): Promise<void>;
  markAllRead(): Promise<void>;
}

export interface DocumentRepository {
  getDocuments(params?: { projectId?: ID; search?: string }): Promise<EpmDocument[]>;
  uploadDocument(file: File, options?: { projectId?: ID; shared?: boolean }): Promise<EpmDocument>;
  deleteDocument(documentId: ID): Promise<void>;
  downloadUrl(documentId: ID): string;
}

export interface IntegrationRepository {
  getStatus(): Promise<IntegrationStatus>;
  triggerSync(): Promise<IntegrationStatus>;
}

/** The signed-in person's own settings. Server-side, so they follow the person between browsers. */
export interface PreferenceRepository {
  get(): Promise<UserPreferences>;
  /** Partial in; the merged whole out. */
  update(patch: Partial<UserPreferences>): Promise<UserPreferences>;
}

/**
 * Invitations, from the invited person's side. Both calls are public: the
 * token is the only proof of identity there is at this point.
 */
export interface InviteRepository {
  get(token: string): Promise<InviteInfo>;
  accept(token: string, password: string): Promise<{ login: string }>;
}

export interface EpmRepositories {
  projects: ProjectRepository;
  tasks: TaskRepository;
  users: UserRepository;
  sprints: SprintRepository;
  dashboard: DashboardRepository;
  reports: ReportRepository;
  notifications: NotificationRepository;
  documents: DocumentRepository;
  integration: IntegrationRepository;
}
