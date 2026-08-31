import type { ID, ReportFilters, TaskFilters } from '@/types';

/**
 * Centralized TanStack Query keys.
 *
 * Keeping them in one place means a future WebSocket/SSE layer can invalidate
 * precisely the right caches when the backend pushes a change event, without
 * hunting for inline key arrays across the codebase.
 */
export const queryKeys = {
  currentUser: ['current-user'] as const,
  users: ['users'] as const,
  user: (id: ID) => ['users', id] as const,

  projects: (params?: { search?: string; status?: string[] }) => ['projects', params ?? {}] as const,
  project: (id: ID) => ['projects', 'detail', id] as const,
  projectMilestones: (id: ID) => ['projects', 'detail', id, 'milestones'] as const,

  tasks: (filters?: TaskFilters) => ['tasks', filters ?? {}] as const,
  task: (id: ID) => ['tasks', 'detail', id] as const,
  taskComments: (id: ID) => ['tasks', 'detail', id, 'comments'] as const,

  teams: ['teams'] as const,
  team: (id: ID) => ['teams', id] as const,
  teamWorkloads: (id?: ID) => ['teams', 'workloads', id ?? 'all'] as const,

  sprints: ['sprints'] as const,
  sprint: (id: ID) => ['sprints', id] as const,
  activeSprint: ['sprints', 'active'] as const,

  dashboardMetrics: ['dashboard', 'metrics'] as const,
  activity: (params?: { projectId?: ID; limit?: number }) => ['activity', params ?? {}] as const,
  calendarEvents: (range: { from: string; to: string }) => ['calendar', range] as const,

  deliveryTrends: (filters?: ReportFilters) => ['reports', 'delivery-trends', filters ?? {}] as const,
  statusDistribution: (filters?: ReportFilters) =>
    ['reports', 'status-distribution', filters ?? {}] as const,
  executiveInsights: (filters?: ReportFilters) =>
    ['reports', 'executive-insights', filters ?? {}] as const,
  timeSummary: (filters?: ReportFilters) => ['reports', 'time-summary', filters ?? {}] as const,

  notifications: ['notifications'] as const,
  documents: (params?: { projectId?: ID; search?: string }) => ['documents', params ?? {}] as const,
  integrationStatus: ['integrations', 'openproject'] as const,
} as const;

/** Root keys used for coarse invalidation after a mutation. */
export const invalidationGroups = {
  taskWrite: [['tasks'], ['dashboard'], ['activity'], ['projects'], ['reports']],
  projectWrite: [['projects'], ['dashboard'], ['activity'], ['reports']],
  notificationWrite: [['notifications']],
} as const;
