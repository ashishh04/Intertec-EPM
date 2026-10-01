import type { FastifyPluginAsync } from 'fastify';

import { prisma } from '../db/prisma.js';
import { getPreferences } from '../email/preferences.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import type { OpNotification } from '../openproject/types.js';
import type {
  EpmNotification,
  NotificationCategory,
  NotificationReason,
  UserPreferences,
} from '../types/epm.js';

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

/**
 * Which notification switch governs each upstream reason.
 *
 * Separate from `CATEGORY_BY_REASON` on purpose: that map decides how an item is
 * *displayed*, and several reasons share one display category while being
 * different things to opt out of. "Someone mentioned you" and "a date you watch
 * is approaching" both want their own switch; both being `deadline` or both
 * being `project_update` on screen does not change that.
 *
 * A reason with no entry here is always shown. That is the safe direction for
 * something that arrives from upstream: a reason added by an OpenProject upgrade
 * appears until EPM is taught what switch it belongs under, rather than being
 * silently swallowed by a preference nobody set.
 */
const SWITCH_BY_REASON: Record<string, keyof UserPreferences['notifications']> = {
  mentioned: 'mentions',
  assigned: 'assigned',
  // Accountable is a different relationship from assigned — one person does the
  // work, another answers for it — and OpenProject models it separately, so it
  // gets its own switch rather than riding on assignment.
  responsible: 'accountable',
  watched: 'watcher',
  shared: 'shared',
  created: 'participating',
  commented: 'participating',
  processed: 'participating',
  prioritized: 'participating',
  scheduled: 'dateAlerts',
  dateAlert: 'dateAlerts',
  dateAlertStartDate: 'dateAlerts',
  dateAlertDueDate: 'dateAlerts',
  // An explicit reminder somebody set, which is what the deadline-reminder
  // switch means. Distinct from a date alert: that fires off a field on the work
  // package, this off a reminder a person asked for.
  reminder: 'dueReminders',
};

/**
 * The reason EPM reports for each upstream reason.
 *
 * A narrowing rather than a rename: OpenProject distinguishes three flavours of
 * date alert and several kinds of "something about this changed", and a reader
 * filtering their feed does not. What survives is the set of relationships people
 * actually think in — mentioned, assigned, accountable, watching, dates,
 * reminders, shared — which is also the set the switches are written against, so
 * the filter chips and the settings cannot disagree.
 */
const REASON_BY_UPSTREAM: Record<string, NotificationReason> = {
  mentioned: 'mentioned',
  assigned: 'assignee',
  responsible: 'accountable',
  watched: 'watcher',
  shared: 'shared',
  commented: 'commented',
  created: 'commented',
  processed: 'commented',
  prioritized: 'commented',
  scheduled: 'dateAlert',
  dateAlert: 'dateAlert',
  dateAlertStartDate: 'dateAlert',
  dateAlertDueDate: 'dateAlert',
  reminder: 'reminder',
};

/**
 * Whether a switch is on, for the switches that are plain booleans.
 *
 * `pause` is an object in the same record, so the lookup is narrowed rather
 * than cast: a non-boolean switch means "not something this gates", which is
 * the always-show answer.
 */
function switchedOn(
  preferences: UserPreferences,
  key: keyof UserPreferences['notifications'] | undefined,
): boolean {
  if (!key) return true;
  const value = preferences.notifications[key];
  return typeof value === 'boolean' ? value : true;
}

/** Marks an id as EPM's, so the two sources stay distinguishable. */
const EPM_PREFIX = 'epm:';

const isEpmId = (id: string) => id.startsWith(EPM_PREFIX);
const epmIdOf = (id: string) => id.slice(EPM_PREFIX.length);

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/notifications', async (request) => {
    const signal = requestSignal(request);
    const recipientId = request.auth?.userId ?? '';

    const [upstream, own, preferences] = await Promise.all([
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
      // The feed is where the notification switches finally take effect. They
      // cannot be applied at the source — OpenProject creates its own
      // notifications and has no idea what EPM's settings say — so the filter
      // is here, on the read. An item someone turned off is therefore not
      // destroyed, and turning the switch back on reveals it again.
      getPreferences(recipientId),
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
        // An unmapped upstream reason reports as `reminder` rather than being
        // dropped: it is a real notification, and the feed showing it under a
        // slightly broad heading beats the feed not showing it.
        reason: REASON_BY_UPSTREAM[notification.reason] ?? 'reminder',
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
        // EPM's own: health transitions, capacity changes, capture failures.
        // None of them has an upstream reason, and none is about a work package.
        reason: 'epm',
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

    const wanted = upstream.items
      .map((notification, index) => ({ notification, mapped: fromUpstream[index]! }))
      .filter(({ notification }) => switchedOn(preferences, SWITCH_BY_REASON[notification.reason]))
      .map(({ mapped }) => mapped);

    // EPM's own are all project and staffing changes, which is what
    // `statusChanges` covers; there is no upstream reason to key them off.
    const ownWanted = preferences.notifications.statusChanges ? fromEpm : [];

    return [...ownWanted, ...wanted].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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

    // Sent together rather than one after another: a person clearing a full
    // panel marks dozens at once, and a serial walk makes that a visible wait.
    const upstream = await Promise.allSettled(
      upstreamIds.map((id) =>
        openProject.request<void>(`/notifications/${id}/read_ian`, { method: 'POST', signal }),
      ),
    );

    // Reported rather than swallowed. This used to catch-and-continue and then
    // answer 204, so an upstream refusal looked exactly like success and the
    // notification stayed unread with nobody any the wiser — which is what a
    // missing content-type header on the request above was doing.
    const failed = upstream.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      request.log.warn(
        { count: failed.length, of: upstreamIds.length },
        'Some notifications could not be marked read upstream',
      );
      throw EpmError.unavailable(
        failed.length === upstreamIds.length
          ? 'Those notifications could not be marked read.'
          : `${failed.length} of ${upstreamIds.length} notifications could not be marked read.`,
      );
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
