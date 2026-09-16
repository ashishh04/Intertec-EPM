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
  projectChildren: (id: ID) => ['projects', 'detail', id, 'children'] as const,

  tasks: (filters?: TaskFilters) => ['tasks', filters ?? {}] as const,
  task: (id: ID) => ['tasks', 'detail', id] as const,

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

  /**
   * Instance settings sections. Cached per section id, because a section is
   * fetched and written whole and the ids come from the instance rather than
   * from a list EPM keeps.
   */
  adminSettingsSections: ['admin', 'settings', 'sections'] as const,
  adminSettingsSection: (id: string) => ['admin', 'settings', 'sections', id] as const,

  /**
   * Administration catalogues. Cached per resource, because a catalogue is
   * fetched whole — the descriptor and its rows in one reply — and the
   * resources are the instance's, not a list EPM keeps.
   */
  adminCatalogs: ['admin', 'catalog'] as const,
  adminCatalog: (resource: string) => ['admin', 'catalog', resource] as const,

  notifications: ['notifications'] as const,
  documents: (params?: { projectId?: ID; search?: string }) => ['documents', params ?? {}] as const,
  integrationStatus: ['integrations', 'status'] as const,
  preferences: ['preferences'] as const,
  /** The token is the whole identity of an invitation; there is no id. */
  invite: (token: string) => ['invites', token] as const,
} as const;

/** Root keys used for coarse invalidation after a mutation. */
export const invalidationGroups = {
  taskWrite: [['tasks'], ['dashboard'], ['activity'], ['projects'], ['reports']],
  // `current-user` carries the per-project permission map, and it is fetched
  // once per session with `staleTime: Infinity`. Creating a project grants the
  // creator rights on it, so without this the new project's buttons stay
  // disabled for the rest of the session — the server says yes and the browser
  // is still holding an answer from before the project existed.
  projectWrite: [['projects'], ['dashboard'], ['activity'], ['reports'], ['current-user']],
  notificationWrite: [['notifications']],
} as const;
