import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requestSignal } from '../lib/request-signal.js';
import { aggregateCache } from '../lib/cache.js';
import { openProject, linkId, type OpFilter } from '../openproject/client.js';
import { optional, prisma } from '../db/prisma.js';
import { getCatalog } from '../mapping/catalog.js';
import { getCurrentUser } from '../mapping/users.js';
import {
  computeHealth,
  effectiveHealth,
  getProjectAggregates,
  loadHealthOverrides,
} from '../mapping/projects.js';
import type { OpActivity, OpProject, OpWorkPackage } from '../openproject/types.js';
import type {
  ActivityEntry,
  CalendarEvent,
  DashboardMetrics,
  MetricTrend,
} from '../types/epm.js';

/** Counts without transferring rows — OpenProject returns `total` on any page. */
async function count(filters: OpFilter[], signal: AbortSignal): Promise<number> {
  const collection = await openProject
    .getCollection<unknown>('/work_packages', { filters, pageSize: 1 }, signal)
    .catch(() => ({ total: 0 }));
  return collection.total ?? 0;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * A trend is a change against the previous period, which OpenProject cannot
 * answer — it only knows today. Snapshots recorded in the overlay database
 * provide the history; until there are at least two, the trend is reported as
 * flat rather than as an invented percentage.
 */
async function trendFor(
  metric: string,
  current: number,
  scopeUserId: string | null,
  positiveIsUp: boolean,
): Promise<MetricTrend> {
  const flat: MetricTrend = {
    changePct: 0,
    direction: 'flat',
    positiveIsUp,
    periodLabel: 'vs last week',
  };

  const previous = await optional(async () => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 7);
    return prisma.metricSnapshot.findFirst({
      where: { metric, scopeUserId, sampledOn: { lte: cutoff } },
      orderBy: { sampledOn: 'desc' },
    });
  }, null);

  if (!previous || previous.value === 0) return flat;

  const changePct = Math.round(((current - previous.value) / previous.value) * 1000) / 10;
  return {
    changePct: Math.abs(changePct),
    direction: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat',
    positiveIsUp,
    periodLabel: 'vs last week',
  };
}

/** Records today's values so tomorrow's trends have something to compare to. */
async function recordSnapshots(values: Record<string, number>, scopeUserId: string) {
  const sampledOn = new Date(new Date().toISOString().slice(0, 10));
  await optional(
    () =>
      prisma.$transaction(
        Object.entries(values).map(([metric, value]) =>
          prisma.metricSnapshot.upsert({
            where: { scopeUserId_sampledOn_metric: { scopeUserId, sampledOn, metric } },
            create: { scopeUserId, sampledOn, metric, value },
            update: { value },
          }),
        ),
      ),
    null,
  );
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/dashboard/metrics', async (request) => {
    const signal = requestSignal(request);
    const today = new Date().toISOString().slice(0, 10);

    const [me, catalog, projects, aggregates] = await Promise.all([
      getCurrentUser(signal),
      getCatalog(signal),
      openProject
        .getAll<OpProject>('/projects', { pageSize: 100 }, { signal })
        .catch(() => ({ items: [] as OpProject[] })),
      getProjectAggregates(signal),
    ]);

    const mine: OpFilter = { field: 'assignee', operator: '=', values: [me.id] };
    const open: OpFilter = { field: 'status', operator: 'o', values: [] };

    const inProgressIds = catalog.statusIdsByEpm.get('in_progress') ?? [];
    const blockedIds = catalog.statusIdsByEpm.get('blocked') ?? [];
    const criticalIds = catalog.priorityIdsByEpm.get('critical') ?? [];

    const overdueFilters: OpFilter[] = [
      mine,
      open,
      { field: 'dueDate', operator: '<t-', values: ['0'] },
    ];

    const [myTasks, myTasksDueThisWeek, inProgress, inProgressBlocked, overdue, overdueCritical] =
      await Promise.all([
        count([mine, open], signal),
        count(
          [mine, open, { field: 'dueDate', operator: '<>d', values: [today, addDays(today, 7)] }],
          signal,
        ),
        inProgressIds.length
          ? count([mine, { field: 'status', operator: '=', values: inProgressIds }], signal)
          : Promise.resolve(0),
        blockedIds.length
          ? count([mine, { field: 'status', operator: '=', values: blockedIds }], signal)
          : Promise.resolve(0),
        count(overdueFilters, signal),
        criticalIds.length
          ? count([...overdueFilters, { field: 'priority', operator: '=', values: criticalIds }], signal)
          : Promise.resolve(0),
      ]);

    const active = projects.items.filter((project) => project.active);
    // Pins are honoured here too, so this count agrees with what the project
    // pages show rather than contradicting them.
    const overrides = await loadHealthOverrides();
    const atRisk = active.filter((project) => {
      const id = String(project.id);
      const { health } = computeHealth({
        total: aggregates.total.get(id) ?? 0,
        completed: aggregates.completed.get(id) ?? 0,
        overdue: aggregates.overdue.get(id) ?? 0,
        today,
      });
      return effectiveHealth(health, overrides.get(id)).overall !== 'healthy';
    }).length;

    await recordSnapshots(
      { myTasks, inProgress, overdue, activeProjects: active.length },
      me.id,
    );

    const [myTasksTrend, inProgressTrend, overdueTrend, activeProjectsTrend] = await Promise.all([
      trendFor('myTasks', myTasks, me.id, false),
      trendFor('inProgress', inProgress, me.id, true),
      trendFor('overdue', overdue, me.id, false),
      trendFor('activeProjects', active.length, me.id, true),
    ]);

    const metrics: DashboardMetrics = {
      myTasks,
      myTasksDueThisWeek,
      inProgress,
      inProgressBlocked,
      overdue,
      overdueCritical,
      activeProjects: active.length,
      projectsAtRisk: atRisk,
      // Requires sprints; this instance defines no versions.
      sprintProgress: 0,
      trends: {
        myTasks: myTasksTrend,
        inProgress: inProgressTrend,
        overdue: overdueTrend,
        activeProjects: activeProjectsTrend,
      },
    };

    return metrics;
  });

  /**
   * OpenProject exposes no global activity index on this instance, so the feed
   * is assembled from the most recently updated work packages and their own
   * activity records. Capped deliberately — this is a feed, not an audit log.
   */
  app.get('/activity', async (request) => {
    const { projectId, limit } = z
      .object({ projectId: z.string().optional(), limit: z.coerce.number().int().positive().optional() })
      .parse(request.query);

    const signal = requestSignal(request);
    const max = Math.min(limit ?? 20, 50);

    return aggregateCache.get(`activity:${projectId ?? 'all'}:${max}`, async () => {
      const filters: OpFilter[] = projectId
        ? [{ field: 'project', operator: '=', values: [projectId] }]
        : [];

      const recent = await openProject
        .getCollection<OpWorkPackage>(
          '/work_packages',
          { filters, sortBy: [['updatedAt', 'desc']], pageSize: max },
          signal,
        )
        .catch(() => ({ _embedded: { elements: [] as OpWorkPackage[] } }));

      const entries = await Promise.all(
        (recent._embedded?.elements ?? []).map(async (workPackage): Promise<ActivityEntry> => {
          const activities = await openProject
            .getAll<OpActivity>(
              `/work_packages/${workPackage.id}/activities`,
              { pageSize: 100 },
              { signal },
            )
            .catch(() => ({ items: [] as OpActivity[] }));

          const latest = activities.items[activities.items.length - 1];
          const actorLink = latest?._links?.user;
          const actorHref = Array.isArray(actorLink) ? actorLink[0]?.href : actorLink?.href;
          const commented = (latest?.comment?.raw ?? '').trim().length > 0;

          return {
            id: `${workPackage.id}-${latest?.id ?? 'update'}`,
            actorId: actorHref?.split('/').pop() ?? '',
            action: commented ? 'commented' : workPackage.createdAt === workPackage.updatedAt ? 'created' : 'updated',
            objectLabel: workPackage.subject,
            objectType: 'task',
            objectId: String(workPackage.id),
            projectId: linkId(workPackage._links, 'project'),
            detail: commented ? latest?.comment?.raw ?? undefined : undefined,
            timestamp: workPackage.updatedAt,
          };
        }),
      );

      return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    });
  });

  app.get('/calendar/events', async (request) => {
    const { from, to } = z.object({ from: z.string(), to: z.string() }).parse(request.query);
    const signal = requestSignal(request);

    const catalog = await getCatalog(signal);
    const milestoneTypeIds = catalog.typeIdsByEpm.get('milestone') ?? [];

    const workPackages = await openProject
      .getAll<OpWorkPackage>(
        '/work_packages',
        {
          filters: [{ field: 'datesInterval', operator: '<>d', values: [from, to] }],
          pageSize: 100,
        },
        { signal },
      )
      .catch(() => ({ items: [] as OpWorkPackage[] }));

    return workPackages.items.map((workPackage): CalendarEvent => {
      const typeId = linkId(workPackage._links, 'type');
      const isMilestone = typeId ? milestoneTypeIds.includes(typeId) : false;
      const date = workPackage.startDate ?? workPackage.date ?? workPackage.dueDate ?? from;

      return {
        id: String(workPackage.id),
        title: workPackage.subject,
        kind: isMilestone ? 'milestone' : 'task',
        date,
        endDate: workPackage.dueDate ?? undefined,
        projectId: linkId(workPackage._links, 'project'),
        taskId: String(workPackage.id),
        allDay: true,
      };
    });
  });
};
