/**
 * Mock repository implementations.
 *
 * They satisfy exactly the same contracts as the API repositories, including
 * server-side concerns like filtering, sorting and pagination, so the UI never
 * has to behave differently between demo and live data.
 */

import { addDays, isWithinInterval, parseISO, startOfDay } from 'date-fns';
import { integrationStatus as seedIntegration, deliveryTrends, meetings } from '@/mocks/data';
import { OPEN_TASK_STATUSES, TASK_PRIORITY_META, TASK_STATUS_META } from '@/lib/domain';
import { daysFromToday, toISODateOnly } from '@/lib/utils';
import type {
  ActivityEntry,
  CalendarEvent,
  CreateTaskInput,
  DashboardMetrics,
  DeliveryTrendPoint,
  ExecutiveInsights,
  HealthLevel,
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
  PortfolioRow,
  ReportFilters,
  StatusDistribution,
  TaskComment,
  TaskFilters,
  TaskStatus,
  TeamMemberWorkload,
  TimeEntrySummary,
  UpdateTaskInput,
} from '@/types';
import type {
  DashboardRepository,
  DocumentRepository,
  IntegrationRepository,
  NotificationRepository,
  ProjectRepository,
  ReportRepository,
  SprintRepository,
  TaskRepository,
  TeamRepository,
  UserRepository,
} from '../repositories';
import {
  CURRENT_USER_ID,
  clone,
  delay,
  nextId,
  nextTaskKey,
  recordActivity,
  refreshProjectCounters,
  store,
} from './store';

function notFound(entity: string, id: ID): never {
  throw new Error(`${entity} "${id}" could not be found.`);
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export class MockProjectRepository implements ProjectRepository {
  async getProjects(params: { search?: string; status?: string[] } = {}): Promise<NexusProject[]> {
    let result = store.projects;

    if (params.search) {
      const needle = params.search.toLowerCase();
      result = result.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) ||
          project.identifier.toLowerCase().includes(needle) ||
          project.portfolio.toLowerCase().includes(needle),
      );
    }

    if (params.status?.length) {
      result = result.filter((project) => params.status!.includes(project.status));
    }

    return delay(clone(result));
  }

  async getProject(id: ID): Promise<NexusProject> {
    const project = store.projects.find((item) => item.id === id || item.identifier === id);
    if (!project) notFound('Project', id);
    return delay(clone(project));
  }

  async getMilestones(projectId: ID): Promise<Milestone[]> {
    return delay(clone(store.milestones.filter((item) => item.projectId === projectId)));
  }

  async updateProject(id: ID, patch: Partial<NexusProject>): Promise<NexusProject> {
    const project = store.projects.find((item) => item.id === id);
    if (!project) notFound('Project', id);
    Object.assign(project, patch, { updatedAt: new Date().toISOString() });
    recordActivity({
      actorId: CURRENT_USER_ID,
      action: 'updated',
      objectLabel: project.name,
      objectType: 'project',
      objectId: project.id,
      projectId: project.id,
      detail: 'Project details updated',
    });
    return delay(clone(project));
  }
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

function matchesBucket(task: NexusTask, bucket: TaskFilters['bucket']): boolean {
  if (!bucket || bucket === 'all') return true;
  const delta = daysFromToday(task.dueDate);
  switch (bucket) {
    case 'open':
      return task.status !== 'done';
    case 'completed':
      return task.status === 'done';
    case 'overdue':
      return task.status !== 'done' && delta !== null && delta < 0;
    case 'today':
      return task.status !== 'done' && delta === 0;
    case 'upcoming':
      return task.status !== 'done' && delta !== null && delta > 0;
    default:
      return true;
  }
}

export class MockTaskRepository implements TaskRepository {
  async getTasks(filters: TaskFilters = {}): Promise<Paginated<NexusTask>> {
    const {
      page = 1,
      pageSize = 25,
      sortBy = 'dueDate',
      sortDir = 'asc',
      search,
      ...rest
    } = filters;

    let result = store.tasks.filter((task) => {
      if (rest.projectId && task.projectId !== rest.projectId) return false;
      if (rest.assigneeId && task.assigneeId !== rest.assigneeId) return false;
      if (rest.sprintId && task.sprintId !== rest.sprintId) return false;
      if (rest.status?.length && !rest.status.includes(task.status)) return false;
      if (rest.priority?.length && !rest.priority.includes(task.priority)) return false;
      if (rest.type?.length && !rest.type.includes(task.type)) return false;
      if (!matchesBucket(task, rest.bucket)) return false;
      return true;
    });

    if (search) {
      const needle = search.toLowerCase();
      result = result.filter(
        (task) =>
          task.subject.toLowerCase().includes(needle) ||
          task.key.toLowerCase().includes(needle) ||
          task.labels.some((label) => label.includes(needle)),
      );
    }

    const direction = sortDir === 'asc' ? 1 : -1;
    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case 'priority':
          return (TASK_PRIORITY_META[a.priority].rank - TASK_PRIORITY_META[b.priority].rank) * direction;
        case 'subject':
          return a.subject.localeCompare(b.subject) * direction;
        case 'status':
          return TASK_STATUS_META[a.status].label.localeCompare(TASK_STATUS_META[b.status].label) * direction;
        case 'updatedAt':
          return (a.updatedAt < b.updatedAt ? -1 : 1) * direction;
        case 'dueDate':
        default: {
          const left = a.dueDate ?? '9999-12-31';
          const right = b.dueDate ?? '9999-12-31';
          return (left < right ? -1 : left > right ? 1 : 0) * direction;
        }
      }
    });

    const start = (page - 1) * pageSize;
    const items = result.slice(start, start + pageSize);

    return delay({
      items: clone(items),
      total: result.length,
      page,
      pageSize,
      hasMore: start + pageSize < result.length,
    });
  }

  async getTask(id: ID): Promise<NexusTask> {
    const task = store.tasks.find((item) => item.id === id || item.key === id);
    if (!task) notFound('Task', id);
    return delay(clone(task));
  }

  async getComments(taskId: ID): Promise<TaskComment[]> {
    const result = store.comments
      .filter((comment) => comment.taskId === taskId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return delay(clone(result));
  }

  async addComment(taskId: ID, body: string): Promise<TaskComment> {
    const comment: TaskComment = {
      id: nextId('cmt'),
      taskId,
      authorId: CURRENT_USER_ID,
      body,
      createdAt: new Date().toISOString(),
    };
    store.comments.push(comment);

    const task = store.tasks.find((item) => item.id === taskId);
    if (task) {
      recordActivity({
        actorId: CURRENT_USER_ID,
        action: 'commented',
        objectLabel: task.key,
        objectType: 'task',
        objectId: task.id,
        projectId: task.projectId,
        detail: task.subject,
      });
    }

    return delay(clone(comment), 160);
  }

  async createTask(input: CreateTaskInput): Promise<NexusTask> {
    const now = new Date().toISOString();
    const task: NexusTask = {
      id: nextId('tsk'),
      key: nextTaskKey(),
      subject: input.subject,
      description: input.description,
      type: input.type,
      status: input.status,
      priority: input.priority,
      projectId: input.projectId,
      assigneeId: input.assigneeId,
      authorId: CURRENT_USER_ID,
      parentId: input.parentId,
      sprintId: input.sprintId,
      startDate: input.startDate,
      dueDate: input.dueDate,
      estimatedHours: input.estimatedHours,
      spentHours: 0,
      storyPoints: input.storyPoints,
      labels: input.labels ?? [],
      progress: 0,
      watcherIds: [CURRENT_USER_ID],
      createdAt: now,
      updatedAt: now,
    };

    store.tasks.unshift(task);
    refreshProjectCounters(task.projectId);
    recordActivity({
      actorId: CURRENT_USER_ID,
      action: 'created',
      objectLabel: task.key,
      objectType: 'task',
      objectId: task.id,
      projectId: task.projectId,
      detail: task.subject,
    });

    return delay(clone(task), 320);
  }

  async updateTask(input: UpdateTaskInput): Promise<NexusTask> {
    const task = store.tasks.find((item) => item.id === input.id);
    if (!task) notFound('Task', input.id);

    const statusChanged = input.status !== undefined && input.status !== task.status;
    const assigneeChanged = input.assigneeId !== undefined && input.assigneeId !== task.assigneeId;

    Object.assign(task, input, { updatedAt: new Date().toISOString() });
    if (statusChanged) {
      task.progress = task.status === 'done' ? 100 : task.status === 'review' ? 90 : task.progress;
    }
    refreshProjectCounters(task.projectId);

    recordActivity({
      actorId: CURRENT_USER_ID,
      action: statusChanged ? 'status_changed' : assigneeChanged ? 'assigned' : 'updated',
      objectLabel: task.key,
      objectType: 'task',
      objectId: task.id,
      projectId: task.projectId,
      detail: task.subject,
    });

    return delay(clone(task), 200);
  }

  async bulkUpdate(ids: ID[], patch: Partial<UpdateTaskInput>): Promise<NexusTask[]> {
    const updated: NexusTask[] = [];
    for (const id of ids) {
      const task = store.tasks.find((item) => item.id === id);
      if (!task) continue;
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
      refreshProjectCounters(task.projectId);
      updated.push(task);
    }
    return delay(clone(updated), 340);
  }

  async deleteTasks(ids: ID[]): Promise<void> {
    const affected = new Set(
      store.tasks.filter((task) => ids.includes(task.id)).map((task) => task.projectId),
    );
    store.tasks = store.tasks.filter((task) => !ids.includes(task.id));
    affected.forEach(refreshProjectCounters);
    await delay(undefined, 280);
  }
}

/* -------------------------------------------------------------------------- */
/* Users and teams                                                             */
/* -------------------------------------------------------------------------- */

export class MockUserRepository implements UserRepository {
  async getCurrentUser(): Promise<NexusUser> {
    const user = store.users.find((item) => item.id === CURRENT_USER_ID);
    if (!user) notFound('User', CURRENT_USER_ID);
    return delay(clone(user), 120);
  }

  async getUsers(): Promise<NexusUser[]> {
    return delay(clone(store.users), 140);
  }

  async getUser(id: ID): Promise<NexusUser> {
    const user = store.users.find((item) => item.id === id);
    if (!user) notFound('User', id);
    return delay(clone(user), 120);
  }
}

export class MockTeamRepository implements TeamRepository {
  async getTeams(): Promise<NexusTeam[]> {
    return delay(clone(store.teams));
  }

  async getTeam(id: ID): Promise<NexusTeam> {
    const team = store.teams.find((item) => item.id === id || item.slug === id);
    if (!team) notFound('Team', id);
    return delay(clone(team));
  }

  async getWorkloads(teamId?: ID): Promise<TeamMemberWorkload[]> {
    if (!teamId) return delay(clone(store.workloads));
    const team = store.teams.find((item) => item.id === teamId);
    const memberIds = team?.memberIds ?? [];
    return delay(clone(store.workloads.filter((item) => memberIds.includes(item.userId))));
  }
}

/* -------------------------------------------------------------------------- */
/* Sprints                                                                     */
/* -------------------------------------------------------------------------- */

export class MockSprintRepository implements SprintRepository {
  async getSprints(): Promise<NexusSprint[]> {
    return delay(clone(store.sprints));
  }

  async getSprint(id: ID): Promise<NexusSprint> {
    const sprint = store.sprints.find((item) => item.id === id);
    if (!sprint) notFound('Sprint', id);
    return delay(clone(sprint));
  }

  async getActiveSprint(): Promise<NexusSprint> {
    const sprint = store.sprints.find((item) => item.state === 'active') ?? store.sprints[0];
    return delay(clone(sprint));
  }
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export class MockDashboardRepository implements DashboardRepository {
  async getMetrics(): Promise<DashboardMetrics> {
    const mine = store.tasks.filter((task) => task.assigneeId === CURRENT_USER_ID);
    const openMine = mine.filter((task) => task.status !== 'done');

    const dueThisWeek = openMine.filter((task) => {
      const delta = daysFromToday(task.dueDate);
      return delta !== null && delta >= 0 && delta <= 7;
    }).length;

    const overdueTasks = openMine.filter((task) => {
      const delta = daysFromToday(task.dueDate);
      return delta !== null && delta < 0;
    });

    const activeProjects = store.projects.filter(
      (project) => project.status !== 'completed' && project.status !== 'paused',
    );
    const activeSprint = store.sprints.find((sprint) => sprint.state === 'active');

    return delay({
      myTasks: openMine.length,
      myTasksDueThisWeek: dueThisWeek,
      inProgress: openMine.filter((task) => task.status === 'in_progress').length,
      inProgressBlocked: openMine.filter((task) => task.status === 'blocked').length,
      overdue: overdueTasks.length,
      overdueCritical: overdueTasks.filter((task) => task.priority === 'critical').length,
      activeProjects: activeProjects.length,
      projectsAtRisk: activeProjects.filter(
        (project) => project.status === 'at_risk' || project.status === 'delayed',
      ).length,
      sprintProgress: activeSprint
        ? Math.round((activeSprint.completedPoints / activeSprint.committedPoints) * 100)
        : 0,
      trends: {
        myTasks: { changePct: 12, direction: 'up', positiveIsUp: false, periodLabel: 'from last week' },
        inProgress: { changePct: 8, direction: 'up', positiveIsUp: true, periodLabel: 'from last week' },
        overdue: { changePct: 25, direction: 'down', positiveIsUp: false, periodLabel: 'from last week' },
        activeProjects: { changePct: 0, direction: 'flat', positiveIsUp: true, periodLabel: 'from last month' },
      },
    });
  }

  async getActivity(params: { projectId?: ID; limit?: number } = {}): Promise<ActivityEntry[]> {
    let result = store.activity;
    if (params.projectId) {
      result = result.filter((entry) => entry.projectId === params.projectId);
    }
    return delay(clone(result.slice(0, params.limit ?? 20)));
  }

  async getCalendarEvents(params: { from: string; to: string }): Promise<CalendarEvent[]> {
    const interval = { start: startOfDay(parseISO(params.from)), end: addDays(parseISO(params.to), 1) };
    const inRange = (value: string) => {
      const date = parseISO(value);
      return isWithinInterval(date, interval);
    };

    const events: CalendarEvent[] = [];

    for (const task of store.tasks) {
      if (task.dueDate && inRange(task.dueDate) && task.status !== 'done') {
        events.push({
          id: `evt-task-${task.id}`,
          title: `${task.key} · ${task.subject}`,
          kind: 'task',
          date: task.dueDate,
          projectId: task.projectId,
          taskId: task.id,
          allDay: true,
        });
      }
    }

    for (const milestone of store.milestones) {
      if (inRange(milestone.date)) {
        events.push({
          id: `evt-mls-${milestone.id}`,
          title: `${milestone.name} milestone`,
          kind: 'milestone',
          date: milestone.date,
          projectId: milestone.projectId,
          allDay: true,
        });
      }
    }

    for (const sprint of store.sprints) {
      if (inRange(sprint.startDate)) {
        events.push({
          id: `evt-spr-start-${sprint.id}`,
          title: `${sprint.name} starts`,
          kind: 'sprint',
          date: sprint.startDate,
          allDay: true,
        });
      }
      if (inRange(sprint.endDate)) {
        events.push({
          id: `evt-spr-end-${sprint.id}`,
          title: `${sprint.name} ends`,
          kind: 'sprint',
          date: sprint.endDate,
          allDay: true,
        });
      }
    }

    for (const meeting of meetings) {
      if (inRange(meeting.date)) {
        events.push({
          id: meeting.id,
          title: meeting.title,
          kind: 'meeting',
          date: meeting.date,
          allDay: false,
        });
      }
    }

    return delay(events);
  }
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

function worstHealth(...levels: HealthLevel[]): HealthLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'healthy';
}

export class MockReportRepository implements ReportRepository {
  async getDeliveryTrends(_filters: ReportFilters = {}): Promise<DeliveryTrendPoint[]> {
    void _filters;
    return delay(clone(deliveryTrends));
  }

  async getStatusDistribution(filters: ReportFilters = {}): Promise<StatusDistribution[]> {
    const scoped = filters.projectId
      ? store.tasks.filter((task) => task.projectId === filters.projectId)
      : store.tasks;

    const counts = new Map<TaskStatus, number>();
    for (const task of scoped) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }

    const result: StatusDistribution[] = [...counts.entries()].map(([status, count]) => ({
      status,
      label: TASK_STATUS_META[status].label,
      count,
    }));

    return delay(result);
  }

  async getExecutiveInsights(_filters: ReportFilters = {}): Promise<ExecutiveInsights> {
    void _filters;
    const active = store.projects.filter((project) => project.status !== 'completed');
    const healthy = active.filter((project) => project.health.overall === 'healthy').length;

    const overdueTasks = store.tasks.filter(
      (task) => task.status !== 'done' && (daysFromToday(task.dueDate) ?? 0) < 0,
    ).length;

    const matrix: PortfolioRow[] = active.map((project) => ({
      projectId: project.id,
      projectName: project.name,
      identifier: project.identifier,
      schedule: project.health.schedule,
      scope: project.health.scope,
      resources: project.health.resources,
      overall: worstHealth(project.health.schedule, project.health.scope, project.health.resources),
    }));

    const utilization = Math.round(
      store.workloads.reduce((sum, item) => sum + item.allocation, 0) / store.workloads.length,
    );

    const activeSprint = store.sprints.find((sprint) => sprint.state === 'active');

    return delay({
      portfolioHealth: Math.round((healthy / Math.max(1, active.length)) * 100),
      onTimeDelivery: 86,
      openRisks: store.projects.reduce((sum, project) => sum + project.openRiskCount, 0),
      overdueTasks,
      teamUtilization: utilization,
      sprintVelocity: activeSprint?.completedPoints ?? 0,
      velocityTrend: {
        changePct: 9,
        direction: 'up',
        positiveIsUp: true,
        periodLabel: 'vs. 3-sprint average',
      },
      matrix,
    });
  }

  async getTimeSummary(_filters: ReportFilters = {}): Promise<TimeEntrySummary[]> {
    void _filters;
    const result: TimeEntrySummary[] = store.users.map((user) => {
      const userTasks = store.tasks.filter((task) => task.assigneeId === user.id);
      const byProject = new Map<ID, number>();
      let logged = 0;

      for (const task of userTasks) {
        const hours = task.spentHours ?? 0;
        logged += hours;
        byProject.set(task.projectId, (byProject.get(task.projectId) ?? 0) + hours);
      }

      return {
        userId: user.id,
        hoursLogged: logged,
        hoursBillable: Math.round(logged * 0.82),
        projectBreakdown: [...byProject.entries()].map(([projectId, hours]) => ({ projectId, hours })),
      };
    });

    return delay(result);
  }
}

/* -------------------------------------------------------------------------- */
/* Notifications, documents, integration                                       */
/* -------------------------------------------------------------------------- */

export class MockNotificationRepository implements NotificationRepository {
  async getNotifications(): Promise<NexusNotification[]> {
    return delay(clone(store.notifications), 180);
  }

  async markRead(ids: ID[]): Promise<void> {
    store.notifications.forEach((notification) => {
      if (ids.includes(notification.id)) notification.read = true;
    });
    await delay(undefined, 120);
  }

  async markAllRead(): Promise<void> {
    store.notifications.forEach((notification) => {
      notification.read = true;
    });
    await delay(undefined, 160);
  }
}

export class MockDocumentRepository implements DocumentRepository {
  async getDocuments(params: { projectId?: ID; search?: string } = {}): Promise<NexusDocument[]> {
    let result = store.documents;
    if (params.projectId) {
      result = result.filter((document) => document.projectId === params.projectId);
    }
    if (params.search) {
      const needle = params.search.toLowerCase();
      result = result.filter((document) => document.name.toLowerCase().includes(needle));
    }
    return delay(clone(result));
  }

  async uploadDocument(file: { name: string; sizeBytes: number; projectId?: ID }): Promise<NexusDocument> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const kind: NexusDocument['kind'] =
      extension === 'pdf'
        ? 'pdf'
        : ['xlsx', 'xls', 'csv'].includes(extension)
          ? 'sheet'
          : ['pptx', 'ppt'].includes(extension)
            ? 'slide'
            : ['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(extension)
              ? 'image'
              : ['zip', 'tar', 'gz'].includes(extension)
                ? 'archive'
                : extension === 'md'
                  ? 'markdown'
                  : 'doc';

    const document: NexusDocument = {
      id: nextId('doc'),
      name: file.name,
      kind,
      projectId: file.projectId,
      ownerId: CURRENT_USER_ID,
      sizeBytes: file.sizeBytes,
      updatedAt: new Date().toISOString(),
      shared: false,
    };

    store.documents.unshift(document);
    return delay(clone(document), 600);
  }
}

export class MockIntegrationRepository implements IntegrationRepository {
  async getStatus(): Promise<IntegrationStatus> {
    return delay(clone(seedIntegration), 200);
  }

  async triggerSync(): Promise<IntegrationStatus> {
    const now = new Date().toISOString();
    const refreshed: IntegrationStatus = {
      ...clone(seedIntegration),
      lastSyncAt: now,
      syncedResources: seedIntegration.syncedResources.map((resource) => ({
        ...resource,
        lastSyncAt: now,
      })),
    };
    return delay(refreshed, 900);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers shared with derived views                                           */
/* -------------------------------------------------------------------------- */

/** Open statuses, exported so board and filter defaults stay consistent. */
export const DEFAULT_OPEN_STATUSES = OPEN_TASK_STATUSES;

/** Today as an ISO date, used by calendar range defaults. */
export const todayISO = () => toISODateOnly(new Date());
