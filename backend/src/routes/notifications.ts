import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../db/prisma.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import type { OpNotification } from '../openproject/types.js';
import type { EpmNotification, NotificationCategory } from '../types/epm.js';

/**
 * Notifications, from two places.
 *
 * OpenProject's own — mentions, assignments, date alerts — read through and
 * translated to the EPM categories, as they always were. And EPM's, for events
 * upstream has no concept of: a project's health turning critical, someone's
 * capacity changing, a snapshot capture failing.
 *
 * The two are merged newest-first. EPM ids carry an `epm:` prefix so they
 * cannot collide with upstream's numeric ones and so a read-marking call knows
 * which store owns the id it was given.
 *
 * Recipient isolation holds on both sides and by different means: upstream
 * scopes to whoever's token made the call, and every EPM query filters on the
 * caller's id. A write filters the same way, so marking someone else's
 * notification read updates zero rows rather than theirs.
 */

const CATEGORY_BY_REASON: Record<string, NotificationCategory> = {
  mentioned: 'mention',
  assigned: 'assignment',
  responsible: 'assignment',
  watched: 'project_update',
  created: 'project_update',
  processed: 'project_update',
  prioritized: 'project_update',
  scheduled: 'deadline',
  dateAlert: 'deadline',
  dateAlertStartDate: 'deadline',
  dateAlertDueDate: 'deadline',
  shared: 'system',
};

/** Marks an id as EPM's, so the two sources stay distinguishable. */
const EPM_PREFIX = 'epm:';

const isEpmId = (id: string) => id.startsWith(EPM_PREFIX);
const epmIdOf = (id: string) => id.slice(EPM_PREFIX.length);

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/notifications', async (request) => {
    const signal = requestSignal(request);
    const recipientId = request.auth?.userId ?? '';

    const [upstream, own] = await Promise.all([
      openProject
        .getAll<OpNotification>('/notifications', { pageSize: 100 }, { signal })
        .catch(() => ({ items: [] as OpNotification[] })),
      // Scoped in the query, not checked afterwards.
      prisma.notification
        .findMany({
          where: { recipientId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
        .catch(() => []),
    ]);

    const fromUpstream = upstream.items.map((notification): EpmNotification => {
      const resourceHref = (() => {
        const link = notification._links?.resource;
        return Array.isArray(link) ? link[0]?.href : link?.href;
      })();
      const isWorkPackage = resourceHref?.includes('/work_packages/') ?? false;

      return {
        id: String(notification.id),
        category: CATEGORY_BY_REASON[notification.reason] ?? 'system',
        title: notification.subject ?? 'Notification',
        body: notification.message?.raw ?? '',
        actorId: linkId(notification._links, 'actor'),
        taskId: isWorkPackage ? resourceHref?.split('/').pop() : undefined,
        projectId: linkId(notification._links, 'project'),
        read: notification.readIAN,
        timestamp: notification.createdAt,
      };
    });

    const fromEpm = own.map(
      (notification): EpmNotification => ({
        id: `${EPM_PREFIX}${notification.id}`,
        category: notification.category as NotificationCategory,
        title: notification.title,
        body: notification.body,
        // An EPM route. Never an OpenProject URL — that is what `link` exists
        // for, since a team or an employee has no taskId or projectId.
        link: notification.link ?? undefined,
        severity: notification.severity as EpmNotification['severity'],
        read: notification.readAt !== null,
        timestamp: notification.createdAt.toISOString(),
      }),
    );

    return [...fromEpm, ...fromUpstream].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  });

  app.patch<{ Body: { ids?: string[] } }>('/notifications/read', async (request, reply) => {
    const { ids = [] } = request.body ?? {};
    const signal = requestSignal(request);
    const recipientId = request.auth?.userId ?? '';

    const epmIds = ids.filter(isEpmId).map(epmIdOf);
    const upstreamIds = ids.filter((id) => !isEpmId(id));

    if (epmIds.length > 0) {
      // Filtered on the caller, so an id belonging to someone else matches
      // nothing and updates nothing. Ownership is enforced by the query rather
      // than checked and then trusted.
      await prisma.notification
        .updateMany({
          where: { id: { in: epmIds }, recipientId, readAt: null },
          data: { readAt: new Date() },
        })
        .catch(() => undefined);
    }

    for (const id of upstreamIds) {
      await openProject
        .request<void>(`/notifications/${id}/read_ian`, { method: 'POST', signal })
        .catch(() => undefined);
    }

    reply.status(204);
  });

  app.patch('/notifications/read-all', async (request, reply) => {
    const recipientId = request.auth?.userId ?? '';

    await Promise.all([
      prisma.notification
        .updateMany({ where: { recipientId, readAt: null }, data: { readAt: new Date() } })
        .catch(() => undefined),
      openProject
        .request<void>('/notifications/read_ian', { method: 'POST', signal: requestSignal(request) })
        .catch(() => undefined),
    ]);

    reply.status(204);
  });
};
