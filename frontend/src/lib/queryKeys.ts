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
  // Beneath the project, so any project write refreshes its journal too.
  projectJournal: (id: ID) => ['projects', 'detail', id, 'journal'] as const,
  healthRules: () => ['health-rules'] as const,
  healthRuleOptions: () => ['health-rules', 'options'] as const,
  healthRuleHistory: () => ['health-rules', 'history'] as const,
  // Everything approval-related sits under ['approvals'], so one invalidation
  // after a decision refreshes the inbox, the badge, the lists and the panel.
  approvalChains: () => ['approvals', 'chains'] as const,
  approvalOptions: () => ['approvals', 'options'] as const,
  approvalSubject: (workPackageId: ID) => ['approvals', 'subject', workPackageId] as const,
  approvalInbox: () => ['approvals', 'inbox'] as const,
  approvalInboxCount: () => ['approvals', 'inbox', 'count'] as const,
  approvalRequests: (scope: string, status?: string) => ['approvals', 'requests', scope, status ?? 'all'] as const,
  approvalJournal: (requestId: ID) => ['approvals', 'journal', requestId] as const,
  approvalLink: (token: string) => ['approvals', 'link', token] as const,
  approvalDelegations: (all: boolean) => ['approvals', 'delegations', all] as const,
  // Rules and escalation, under ['automation'] for the same reason.
  automationStatus: () => ['automation', 'status'] as const,
  automationOptions: () => ['automation', 'options'] as const,
  automationRules: () => ['automation', 'rules'] as const,
  automationFirings: (ruleId?: ID) => ['automation', 'firings', ruleId ?? 'all'] as const,
  escalationPolicies: () => ['automation', 'policies'] as const,
  escalations: (state: string) => ['automation', 'escalations', state] as const,
  // The semantic layer and dashboards: under ['insights'], so a model refresh
  // can invalidate every figure at once.
  measures: () => ['insights', 'measures'] as const,
  measureValues: (ids: string[], query: object) => ['insights', 'values', ids.join(','), query] as const,
  measureMembers: (id: string, query: object) => ['insights', 'members', id, query] as const,
  measureTrend: (id: string, query: object) => ['insights', 'trend', id, query] as const,
  dashboards: () => ['insights', 'dashboards'] as const,
  dashboard: (id: string, query: object) => ['insights', 'dashboard', id, query] as const,
  stateAsAt: (at: string, scope?: string) => ['insights', 'state', at, scope ?? 'instance'] as const,
  // The model's administration.
  analyticsModel: () => ['analytics-model', 'status'] as const,
  analyticsRuns: (page: number, pageSize: number, kind?: string) =>
    ['analytics-model', 'runs', page, pageSize, kind ?? 'all'] as const,
  analyticsCaptures: (page: number, pageSize: number) => ['analytics-model', 'captures', page, pageSize] as const,
  analyticsCompare: (captureId: string) => ['analytics-model', 'compare', captureId] as const,
  analyticsAccess: () => ['analytics-model', 'access'] as const,

  // Scheduled reports: under one root, so running or editing one refreshes the list and the log.
  reportSchedules: () => ['report-schedules', 'list'] as const,
  reportScheduleOptions: () => ['report-schedules', 'options'] as const,
  reportRuns: (filter: object) => ['report-schedules', 'runs', filter] as const,
  reportRun: (id: string) => ['report-schedules', 'run', id] as const,

  // Portfolio views. The overviews and cost entries read the analytics model, so they sit under
  // ['insights'] with the dashboards; the saved views themselves are EPM rows of their own.
  portfolioOverview: (id: string, query: object) => ['insights', 'portfolio-overview', id, query] as const,
  portfolioViewOverview: (id: string, query: object) => ['insights', 'portfolio-view-overview', id, query] as const,
  costEntries: (measureId: string, projectId: string, query: object) =>
    ['insights', 'cost-entries', measureId, projectId, query] as const,
  portfolioViews: () => ['portfolio-views', 'list'] as const,
  portfolioView: (id: string) => ['portfolio-views', 'detail', id] as const,
  portfolioViewOptions: () => ['portfolio-views', 'options'] as const,

  // Critical path. Every write that can move a date sits behind `['schedule']`.
  criticalPath: (projectId: string) => ['schedule', 'project', projectId] as const,
  workPackageSchedule: (id: string) => ['schedule', 'work-package', id] as const,
  scheduleStatus: () => ['schedule', 'status'] as const,

  tasks: (filters?: TaskFilters) => ['tasks', filters ?? {}] as const,
  taskTimeline: (projectId: string) => ['tasks', 'timeline', projectId] as const,
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
  // `schedule` because a date, a parent or a deletion can move any float that
  // relations reach; the server waits for its pass before answering.
  taskWrite: [
    ['tasks'],
    ['queries'],
    ['schedule'],
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
