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
  DashboardMetrics,
  DeliveryTrendPoint,
  ExecutiveInsights,
  ID,
  IntegrationStatus,
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
} from '@/types';

export interface ProjectRepository {
  getProjects(params?: { search?: string; status?: string[] }): Promise<EpmProject[]>;
  getProject(id: ID): Promise<EpmProject>;
  getMilestones(projectId: ID): Promise<Milestone[]>;
  updateProject(id: ID, patch: Partial<EpmProject>): Promise<EpmProject>;
  /** Pins health dimensions. EPM-owned, so its own endpoint and permission. */
  setHealthOverride(id: ID, override: HealthOverride): Promise<EpmProject>;
}

export interface TaskRepository {
  getTasks(filters?: TaskFilters): Promise<Paginated<EpmTask>>;
  getTask(id: ID): Promise<EpmTask>;
  createTask(input: CreateTaskInput): Promise<EpmTask>;
  updateTask(input: UpdateTaskInput): Promise<EpmTask>;
  bulkUpdate(ids: ID[], patch: Partial<UpdateTaskInput>): Promise<EpmTask[]>;
  deleteTasks(ids: ID[]): Promise<void>;
}

export interface UserRepository {
  getCurrentUser(): Promise<EpmUser>;
  getUsers(): Promise<EpmUser[]>;
  getUser(id: ID): Promise<EpmUser>;
}

export interface SprintRepository {
  getSprints(): Promise<EpmSprint[]>;
  getSprint(id: ID): Promise<EpmSprint>;
  getActiveSprint(): Promise<EpmSprint>;
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
  uploadDocument(file: { name: string; sizeBytes: number; projectId?: ID }): Promise<EpmDocument>;
}

export interface IntegrationRepository {
  getStatus(): Promise<IntegrationStatus>;
  triggerSync(): Promise<IntegrationStatus>;
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
