import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requestSignal } from '../lib/request-signal.js';
import { aggregateCache } from '../lib/cache.js';
import { openProject, linkId, type OpFilter } from '../openproject/client.js';
import { getCatalog } from '../mapping/catalog.js';
import { getProjectAggregates, computeHealth } from '../mapping/projects.js';
import { durationToHours } from '../lib/duration.js';
import type { HalCollection, OpProject, OpTimeEntry, OpWorkPackage } from '../openproject/types.js';
import type {
  DeliveryTrendPoint,
  ExecutiveInsights,
  HealthLevel,
  PortfolioRow,
  StatusDistribution,
  TaskStatusCategory,
  TimeEntrySummary,
} from '../types/epm.js';

/** Aggregates are computed server-side; the browser never sees a full dataset. */

const filtersQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  projectId: z.string().optional(),
  teamId: z.string().optional(),
  status: z.string().optional(),
});

const STATUS_LABEL: Record<TaskStatusCategory, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
};

interface GroupedCollection extends HalCollection<unknown> {
  groups?: { count: number; value?: string | null; _links?: { valueLink?: { href: string }[] } }[];
}

function scopeFilters(projectId?: string): OpFilter[] {
  return projectId ? [{ field: 'project', operator: '=', values: [projectId] }] : [];
}

/** Caps the walk — trend reporting should not stream an entire instance. */
const TREND_MAX_PAGES = 10;

export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/reports/status-distribution', async (request) => {
    const { projectId } = filtersQuery.parse(request.query);
    const signal = requestSignal(request);

    return aggregateCache.get(`status-distribution:${projectId ?? 'all'}`, async () => {
      const catalog = await getCatalog(signal);

      const collection = (await openProject.getCollection<unknown>(
        '/work_packages',
        { filters: scopeFilters(projectId), groupBy: 'status', pageSize: 1 },
        signal,
      )) as GroupedCollection;

      // Several OpenProject statuses collapse into one EPM status, so counts
      // must be summed rather than mapped one to one.
      const totals = new Map<TaskStatusCategory, number>();
      for (const group of collection.groups ?? []) {
        const id = group._links?.valueLink?.[0]?.href?.split('/').pop();
        const epm = id ? catalog.statusById.get(id)?.epm : undefined;
        if (!epm) continue;
        totals.set(epm, (totals.get(epm) ?? 0) + group.count);
      }

      return (Object.keys(STATUS_LABEL) as TaskStatusCategory[])
        .map((status): StatusDistribution => ({
          status,
          label: STATUS_LABEL[status],
          count: totals.get(status) ?? 0,
        }))
        .filter((row) => row.count > 0);
    });
  });

  app.get('/reports/delivery-trends', async (request) => {
    const { projectId } = filtersQuery.parse(request.query);
    const signal = requestSignal(request);

    return aggregateCache.get(`delivery-trends:${projectId ?? 'all'}`, async () => {
      const catalog = await getCatalog(signal);

      const workPackages = await openProject
        .getAll<OpWorkPackage>(
          '/work_packages',
          { filters: scopeFilters(projectId), pageSize: 100, sortBy: [['createdAt', 'desc']] },
          { signal, maxPages: TREND_MAX_PAGES },
        )
        .catch(() => ({ items: [] as OpWorkPackage[], truncated: false }));

      if ('truncated' in workPackages && workPackages.truncated) {
        request.log.warn('Delivery trends computed from a capped sample of work packages.');
      }

      const months = new Map<string, { created: number; completed: number; points: number }>();
      const bucket = (key: string) => {
        const existing = months.get(key) ?? { created: 0, completed: 0, points: 0 };
        months.set(key, existing);
        return existing;
      };

      for (const workPackage of workPackages.items) {
        bucket(workPackage.createdAt.slice(0, 7)).created += 1;

        const statusId = linkId(workPackage._links, 'status');
        if (statusId && catalog.statusById.get(statusId)?.epm === 'done') {
          const entry = bucket(workPackage.updatedAt.slice(0, 7));
          entry.completed += 1;
          const points = (workPackage as { storyPoints?: number | null }).storyPoints;
          if (typeof points === 'number') entry.points += points;
        }
      }

      return [...months.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([period, value]): DeliveryTrendPoint => ({
          period,
          created: value.created,
          completed: value.completed,
          velocity: value.points,
        }));
    });
  });

  app.get('/reports/time-summary', async (request) => {
    const { projectId } = filtersQuery.parse(request.query);
    const signal = requestSignal(request);

    const entries = await openProject
      .getAll<OpTimeEntry>(
        '/time_entries',
        { filters: scopeFilters(projectId), pageSize: 100 },
        { signal },
      )
      .catch(() => ({ items: [] as OpTimeEntry[] }));

    const byUser = new Map<string, { hours: number; projects: Map<string, number> }>();

    for (const entry of entries.items) {
      const userId = linkId(entry._links, 'user');
      if (!userId) continue;

      const hours = durationToHours(entry.hours) ?? 0;
      const record = byUser.get(userId) ?? { hours: 0, projects: new Map<string, number>() };
      record.hours += hours;

      const project = linkId(entry._links, 'project');
      if (project) record.projects.set(project, (record.projects.get(project) ?? 0) + hours);

      byUser.set(userId, record);
    }

    return [...byUser.entries()].map(([userId, record]): TimeEntrySummary => ({
      userId,
      hoursLogged: Math.round(record.hours * 100) / 100,
      // OpenProject does not mark billability without the cost module.
      hoursBillable: 0,
      projectBreakdown: [...record.projects.entries()].map(([id, hours]) => ({
        projectId: id,
        hours: Math.round(hours * 100) / 100,
      })),
    }));
  });

  app.get('/reports/executive-insights', async (request) => {
    const signal = requestSignal(request);
    const today = new Date().toISOString().slice(0, 10);

    const [projects, aggregates] = await Promise.all([
      openProject
        .getAll<OpProject>('/projects', { pageSize: 100 }, { signal })
        .catch(() => ({ items: [] as OpProject[] })),
      getProjectAggregates(signal),
    ]);

    const active = projects.items.filter((project) => project.active);

    const matrix: PortfolioRow[] = active.map((project) => {
      const id = String(project.id);
      const health = computeHealth({
        total: aggregates.total.get(id) ?? 0,
        completed: aggregates.completed.get(id) ?? 0,
        overdue: aggregates.overdue.get(id) ?? 0,
        today,
      });

      return {
        projectId: id,
        projectName: project.name,
        identifier: project.identifier,
        schedule: health.schedule,
        scope: health.scope,
        resources: health.resources,
        overall: health.overall,
      };
    });

    const healthy = matrix.filter((row) => row.overall === 'healthy').length;
    const totalTasks = [...aggregates.total.values()].reduce((sum, value) => sum + value, 0);
    const completedTasks = [...aggregates.completed.values()].reduce((sum, value) => sum + value, 0);
    const overdueTasks = [...aggregates.overdue.values()].reduce((sum, value) => sum + value, 0);

    const insights: ExecutiveInsights = {
      portfolioHealth: matrix.length ? Math.round((healthy / matrix.length) * 100) : 0,
      onTimeDelivery:
        completedTasks + overdueTasks > 0
          ? Math.round((completedTasks / (completedTasks + overdueTasks)) * 100)
          : 0,
      openRisks: overdueTasks,
      overdueTasks,
      // Needs a capacity model and logged time; this instance has almost none.
      teamUtilization: 0,
      sprintVelocity: 0,
      velocityTrend: { changePct: 0, direction: 'flat', positiveIsUp: true, periodLabel: 'vs last sprint' },
      matrix,
    };

    return insights;
  });
};
