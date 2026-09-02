import type { FastifyPluginAsync } from 'fastify';

import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import type { OpNotification } from '../openproject/types.js';
import type { EpmNotification, NotificationCategory } from '../types/epm.js';

/** OpenProject notifications, translated to the EPM categories. */

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

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/notifications', async (request) => {
    const signal = requestSignal(request);

    const notifications = await openProject
      .getAll<OpNotification>('/notifications', { pageSize: 100 }, { signal })
      .catch(() => ({ items: [] as OpNotification[] }));

    return notifications.items.map((notification): EpmNotification => {
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
  });

  app.patch<{ Body: { ids?: string[] } }>('/notifications/read', async (request, reply) => {
    const { ids = [] } = request.body ?? {};
    const signal = requestSignal(request);

    for (const id of ids) {
      await openProject
        .request<void>(`/notifications/${id}/read_ian`, { method: 'POST', signal })
        .catch(() => undefined);
    }

    reply.status(204);
  });

  app.patch('/notifications/read-all', async (request, reply) => {
    await openProject
      .request<void>('/notifications/read_ian', { method: 'POST', signal: requestSignal(request) })
      .catch(() => undefined);

    reply.status(204);
  });
};
