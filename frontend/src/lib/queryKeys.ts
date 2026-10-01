import type { ID, ReportFilters, TaskFilters, TimeEntryFilters, TimeReportFilters } from '@/types';

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
  taskHierarchy: (id: ID) => ['tasks', 'detail', id, 'hierarchy'] as const,

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

  timeEntries: (filters?: TimeEntryFilters) => ['time-entries', filters ?? {}] as const,
  /** Under `time-entries` so logging time invalidates the report with the list. */
  timeReport: (filters: TimeReportFilters) => ['time-entries', 'report', filters] as const,

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
  // `queries` is load-bearing: a project's Tasks tab renders from a saved view
  // (`['queries', 'run', ...]`), not from `['tasks']`. Without it a bulk edit
  // reported "Updated 1 task" and the row kept showing the old value until the
  // page was reloaded.
  // `catalog/work-package-options` is the permitted-transition set, which the
  // status it was read against has just invalidated. Named precisely rather
  // than clearing `catalog`, which holds instance reference data no task write
  // can change.
  taskWrite: [
    ['tasks'],
    ['queries'],
    ['catalog', 'work-package-options'],
    ['dashboard'],
    ['activity'],
    ['projects'],
    ['reports'],
  ],
  // `current-user` carries the per-project permission map, and it is fetched
  // once per session with `staleTime: Infinity`. Creating a project grants the
  // creator rights on it, so without this the new project's buttons stay
  // disabled for the rest of the session — the server says yes and the browser
  // is still holding an answer from before the project existed.
  projectWrite: [['projects'], ['dashboard'], ['activity'], ['reports'], ['current-user']],
  notificationWrite: [['notifications']],
} as const;

/**
 * A predicate that spares one record's detail query from an invalidation.
 *
 * Deleting a record and refreshing its collection is the ordinary pattern, and it
 * has a trap: a detail query lives *under* its collection's key —
 * `['projects', 'detail', id]` beneath `['projects']` — so the same invalidation
 * refetches the record that has just been removed. The request 404s and the page
 * paints "Unable to load" over a successful delete, which reads as the delete
 * having failed.
 *
 * Navigating away first does not fix it: nothing guarantees React has committed
 * the unmount before the invalidation runs. Excluding the key does, whatever the
 * timing.
 *
 * Pass it alongside a `queryKey` filter; TanStack applies both.
 */
export function exceptDetailOf(root: string, id: ID) {
  return (query: { queryKey: readonly unknown[] }) =>
    !(query.queryKey[0] === root && query.queryKey[1] === 'detail' && query.queryKey[2] === id);
}
