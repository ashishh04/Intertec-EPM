/**
 * Repository contracts.
 *
 * Each domain has exactly one interface with two implementations —
 * `Mock*Repository` (bundled demo data) and `Api*Repository` (Nexus backend).
 * The UI only ever sees these contracts, so switching data sources requires no
 * component changes.
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
  NexusDocument,
  NexusNotification,
  NexusProject,
  NexusSprint,
  NexusTask,
  NexusTeam,
  NexusUser,
  Paginated,
  ReportFilters,
  StatusDistribution,
  TaskComment,
  TaskFilters,
  TeamMemberWorkload,
  TimeEntrySummary,
  UpdateTaskInput,
} from '@/types';

export interface ProjectRepository {
  getProjects(params?: { search?: string; status?: string[] }): Promise<NexusProject[]>;
  getProject(id: ID): Promise<NexusProject>;
  getMilestones(projectId: ID): Promise<Milestone[]>;
  updateProject(id: ID, patch: Partial<NexusProject>): Promise<NexusProject>;
}

export interface TaskRepository {
  getTasks(filters?: TaskFilters): Promise<Paginated<NexusTask>>;
  getTask(id: ID): Promise<NexusTask>;
  getComments(taskId: ID): Promise<TaskComment[]>;
  addComment(taskId: ID, body: string): Promise<TaskComment>;
  createTask(input: CreateTaskInput): Promise<NexusTask>;
  updateTask(input: UpdateTaskInput): Promise<NexusTask>;
  bulkUpdate(ids: ID[], patch: Partial<UpdateTaskInput>): Promise<NexusTask[]>;
  deleteTasks(ids: ID[]): Promise<void>;
}

export interface UserRepository {
  getCurrentUser(): Promise<NexusUser>;
  getUsers(): Promise<NexusUser[]>;
  getUser(id: ID): Promise<NexusUser>;
}

export interface TeamRepository {
  getTeams(): Promise<NexusTeam[]>;
  getTeam(id: ID): Promise<NexusTeam>;
  getWorkloads(teamId?: ID): Promise<TeamMemberWorkload[]>;
}

export interface SprintRepository {
  getSprints(): Promise<NexusSprint[]>;
  getSprint(id: ID): Promise<NexusSprint>;
  getActiveSprint(): Promise<NexusSprint>;
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
  getNotifications(): Promise<NexusNotification[]>;
  markRead(ids: ID[]): Promise<void>;
  markAllRead(): Promise<void>;
}

export interface DocumentRepository {
  getDocuments(params?: { projectId?: ID; search?: string }): Promise<NexusDocument[]>;
  uploadDocument(file: { name: string; sizeBytes: number; projectId?: ID }): Promise<NexusDocument>;
}

export interface IntegrationRepository {
  getStatus(): Promise<IntegrationStatus>;
  triggerSync(): Promise<IntegrationStatus>;
}

export interface NexusRepositories {
  projects: ProjectRepository;
  tasks: TaskRepository;
  users: UserRepository;
  teams: TeamRepository;
  sprints: SprintRepository;
  dashboard: DashboardRepository;
  reports: ReportRepository;
  notifications: NotificationRepository;
  documents: DocumentRepository;
  integration: IntegrationRepository;
}
