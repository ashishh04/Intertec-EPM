import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { contextLanguage, contextReader, t } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { aggregateCache, userScopedKey } from '../lib/cache.js';
import { openProject, linkId, type OpFilter } from '../openproject/client.js';
import { optional, prisma } from '../db/prisma.js';
import { getCatalog } from '../mapping/catalog.js';
import { getCurrentUser } from '../mapping/users.js';
import { listProjects } from '../mapping/projects.js';
import { addDays } from '../lib/dates.js';
import type { OpActivity, OpProject, OpWorkPackage } from '../openproject/types.js';
import type {
  ActivityEntry,
  CalendarEvent,
  DashboardMetrics,
  MetricTrend,
} from '../types/epm.js';
import { automationUserId } from '../domain/automation-account.js';
import { OVERDUE_DUE_FILTER } from '../domain/work-definitions.js';
import { evaluateMeasures } from '../domain/measures.js';
import { viewerOf } from './measures.js';

/** Counts without transferring rows — OpenProject returns `total` on any page. */
async function count(filters: OpFilter[], signal: AbortSignal): Promise<number> {
  const collection = await openProject
    .getCollection<unknown>('/work_packages', { filters, pageSize: 1 }, signal)
    .catch(() => ({ total: 0 }));
  return collection.total ?? 0;
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
    periodLabel: t(contextLanguage(), 'vs last week'),
  };

  const previous = await optional(async () => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 7);
    return prisma.metricSnapshot.findFirst({
      where: { metric, scopeType: 'user', scopeId: scopeUserId ?? '', sampledOn: { lte: cutoff } },
      orderBy: { sampledOn: 'desc' },
    });
  }, null);

  if (!previous || previous.value === 0) return flat;

  const changePct = Math.round(((current - previous.value) / previous.value) * 1000) / 10;
  return {
    changePct: Math.abs(changePct),
    direction: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat',
    positiveIsUp,
    periodLabel: t(contextLanguage(), 'vs last week'),
  };
}

/**
 * Records today's values so tomorrow's trends have something to compare to.
 *
 * Scoped to the signed-in user, as it always was — these are their counts, not
 * the instance's. Org-wide history comes from the analytics snapshot instead.
 */
async function recordSnapshots(values: Record<string, number>, scopeUserId: string) {
  const sampledOn = new Date(new Date().toISOString().slice(0, 10));
  await optional(
    () =>
      prisma.$transaction(
        Object.entries(values).map(([metric, value]) =>
          prisma.metricSnapshot.upsert({
            where: {
              scopeType_scopeId_sampledOn_metric: {
                scopeType: 'user',
                scopeId: scopeUserId,
                sampledOn,
                metric,
              },
            },
            create: { scopeType: 'user', scopeId: scopeUserId, sampledOn, metric, value },
            update: { value },
          }),
        ),
      ),
    null,
  );
}

/**
 * The most recent activity on one work package.
 *
 * Two bounded requests, not a walk. The obvious implementation reads every page
 * of the activity collection and keeps the last element, which is what this
 * replaced — and the cost of that is invisible until it is not: a work package
 * with 500 activities on it costs five upstream requests by itself, and the feed
 * does this for twenty work packages at once. A long-running project's dashboard
 * was therefore slower than a new one's, for no reason a reader could see.
 *
 * Instead: one request for the total, then one for the single element at the end.
 * Two requests whatever the history, and the second is skipped entirely when the
 * first page already holds everything — which is the common case.
 *
 * Failure is absence, not an error. A missing activity costs the feed an actor
 * name; it should never cost the reader the page.
 */
async function lastActivity(
  workPackageId: string,
  signal: AbortSignal,
): Promise<OpActivity | undefined> {
  const path = `/work_packages/${workPackageId}/activities`;

  const first = await openProject
    .getCollection<OpActivity>(path, { pageSize: ACTIVITY_PAGE }, signal)
    .catch(() => null);
  if (!first) return undefined;

  const elements = first._embedded?.elements ?? [];
  const total = first.total ?? elements.length;

  // Everything fits: the last element of this page is the last activity.
  if (total <= elements.length) return elements[elements.length - 1];

  // `offset` is a 1-based page number, so the final page of a one-per-page
  // collection is page `total`.
  const last = await openProject
    .getCollection<OpActivity>(path, { offset: total, pageSize: 1 }, signal)
    .catch(() => null);

  return last?._embedded?.elements?.[0] ?? elements[elements.length - 1];
}

/**
 * How much of an activity collection is read before falling back to a second
 * request. Sized so the overwhelming majority of work packages need only one.
 */
const ACTIVITY_PAGE = 100;

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/dashboard/metrics', async (request) => {
    const signal = requestSignal(request);
    const today = new Date().toISOString().slice(0, 10);

    /*
     * The costliest read on the dashboard: ~10 upstream calls across four
     * dependent waves, and it gates first paint because every KPI tile waits
     * on it. Cached on the short aggregate TTL, the same one the activity feed
     * and delivery trends already use, so the counters stay live enough to
     * trust while a reload costs nothing.
     *
     * Keyed per user — these are *your* counts, filtered by your permissions.
     */
    // Per language too: the comparison label inside is written for the reader.
    return aggregateCache.get(userScopedKey(`dashboard-metrics:${contextReader()}`), async () => {

    const [me, catalog, projects] = await Promise.all([
      getCurrentUser(signal),
      getCatalog(signal),
      listProjects(signal),
    ]);

    const mine: OpFilter = { field: 'assignee', operator: '=', values: [me.id] };
    const open: OpFilter = { field: 'status', operator: 'o', values: [] };

    const inProgressIds = catalog.statusIdsByEpm.get('in_progress') ?? [];
    const blockedIds = catalog.statusIdsByEpm.get('blocked') ?? [];
    const criticalIds = catalog.priorityIdsByEpm.get('critical') ?? [];

    const overdueFilters: OpFilter[] = [mine, open, OVERDUE_DUE_FILTER];

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

    // The project tiles are measures of the semantic layer (BR-404): the same
    // numbers, by the same definitions, as the executive view and the PMO
    // dashboards show for everything this person can see.
    const portfolio = await evaluateMeasures(
      ['projects.active', 'projects.atRisk', 'sprint.progress'],
      { kind: 'instance' },
      { from: addDays(today, -27), to: today },
      await viewerOf(request),
      today,
    );
    const activeProjects = portfolio.measures['projects.active']?.value ?? projects.filter((project) => project.active).length;
    const atRisk = portfolio.measures['projects.atRisk']?.value ?? 0;

    await recordSnapshots({ myTasks, inProgress, overdue, activeProjects }, me.id);

    const [myTasksTrend, inProgressTrend, overdueTrend, activeProjectsTrend] = await Promise.all([
      trendFor('myTasks', myTasks, me.id, false),
      trendFor('inProgress', inProgress, me.id, true),
      trendFor('overdue', overdue, me.id, false),
      trendFor('activeProjects', activeProjects, me.id, true),
    ]);

    const metrics: DashboardMetrics = {
      myTasks,
      myTasksDueThisWeek,
      inProgress,
      inProgressBlocked,
      overdue,
      overdueCritical,
      activeProjects,
      projectsAtRisk: atRisk,
      // Delivered of committed points across the sprints under way; 0 when none is.
      sprintProgress: portfolio.measures['sprint.progress']?.value ?? 0,
      trends: {
        myTasks: myTasksTrend,
        inProgress: inProgressTrend,
        overdue: overdueTrend,
        activeProjects: activeProjectsTrend,
      },
    };

      return metrics;
    });
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

    return aggregateCache.get(userScopedKey(`activity:${projectId ?? 'all'}:${max}`), async () => {
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

      // Not in the people directory, so named here: a rule's change reads as
      // the automation account's, not as an anonymous teammate's.
      const automationId = await automationUserId().catch(() => undefined);
      const entries = await Promise.all(
        (recent._embedded?.elements ?? []).map(async (workPackage): Promise<ActivityEntry> => {
          const latest = await lastActivity(String(workPackage.id), signal);
          const actorLink = latest?._links?.user;
          const actorHref = Array.isArray(actorLink) ? actorLink[0]?.href : actorLink?.href;
          const commented = (latest?.comment?.raw ?? '').trim().length > 0;
          const actorId = actorHref?.split('/').pop() ?? '';

          return {
            id: `${workPackage.id}-${latest?.id ?? 'update'}`,
            actorId,
            ...(automationId && actorId === automationId ? { actorName: 'EPM Automation' } : {}),
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

    // Meetings are EPM's own records, and sprints OpenProject's versions: the
    // calendar shows both beside the work, as it says it does.
    const viewer = await viewerOf(request);
    const visible = [...viewer.visibleProjectIds].map(String);
    const [meetings, versions] = await Promise.all([
      prisma.meeting
        .findMany({
          where: {
            startsAt: { gte: new Date(`${addDays(from, -1)}T00:00:00Z`), lte: new Date(`${addDays(to, 1)}T23:59:59Z`) },
            state: { not: 'cancelled' },
            OR: [{ projectId: null }, { projectId: { in: visible } }],
          },
          orderBy: { startsAt: 'asc' },
          take: 1000,
        })
        .catch(() => []),
      openProject
        .getAll<{ id: number; name: string; startDate?: string | null; endDate?: string | null; _links: Record<string, { href?: string } | undefined> }>('/versions', { pageSize: 500 }, { signal })
        .catch(() => ({ items: [] as { id: number; name: string; startDate?: string | null; endDate?: string | null; _links: Record<string, { href?: string } | undefined> }[] })),
    ]);
    const meetingEvents = meetings.map(
      (meeting): CalendarEvent => ({
        id: `meeting-${meeting.id}`,
        title: meeting.title,
        kind: 'meeting',
        date: meeting.startsAt.toISOString(),
        endDate: new Date(meeting.startsAt.getTime() + meeting.durationMinutes * 60_000).toISOString(),
        ...(meeting.projectId ? { projectId: meeting.projectId } : {}),
        link: `/meetings/${meeting.id}`,
        allDay: false,
      }),
    );
    const sprintEvents = versions.items
      .filter((version) => version.startDate && version.startDate <= to && (version.endDate ?? version.startDate) >= from)
      .map(
        (version): CalendarEvent => ({
          id: `sprint-${version.id}`,
          title: version.name,
          kind: 'sprint',
          date: version.startDate!,
          ...(version.endDate ? { endDate: version.endDate } : {}),
          allDay: true,
        }),
      );

    /*
     * Work is shown on its deadline and a milestone on its date: the calendar's
     * legend says "Task deadline" and the dashboard's "Coming up" says due
     * dates. Shown on its start date, a task looked due the day it began, a
     * week's view held none of the work due in it (only what started in it),
     * and "Coming up" listed work that began weeks ago. The filter above also
     * returns work that merely spans the period; it is left for the period its
     * deadline falls in.
     */
    const workEvents = workPackages.items.flatMap((workPackage): CalendarEvent[] => {
      const typeId = linkId(workPackage._links, 'type');
      const isMilestone = typeId ? milestoneTypeIds.includes(typeId) : false;
      const date = workPackage.dueDate ?? workPackage.date ?? workPackage.startDate;
      if (!date || date < from || date > to) return [];

      return [
        {
          id: String(workPackage.id),
          title: workPackage.subject,
          kind: isMilestone ? 'milestone' : 'task',
          date,
          endDate: workPackage.dueDate ?? undefined,
          projectId: linkId(workPackage._links, 'project'),
          taskId: String(workPackage.id),
          allDay: true,
        },
      ];
    });
    return [...workEvents, ...sprintEvents, ...meetingEvents];
  });
};
