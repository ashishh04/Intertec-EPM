import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';

/**
 * Work package watchers.
 *
 * Who may be added is asked of OpenProject rather than derived from the user
 * directory: `available_watchers` already excludes people who lack view
 * permission on the work package, and excludes those already watching. Offering
 * the full user list instead would propose additions that upstream refuses.
 *
 * One quirk shapes the design here — the `removeWatcher` affordance is
 * published on the *work package*, not on each watcher. There is no per-watcher
 * permission to read, so removal is a single capability covering all of them.
 */

interface OpUser {
  id: number;
  name?: string;
  firstName?: string;
  lastName?: string;
  _links?: Record<string, HalLink | undefined>;
}

/**
 * Only id and name. Upstream also returns `email` and `login` on this
 * collection for privileged callers, and neither is needed to render a watcher.
 */
export interface EpmWatcher {
  id: string;
  name: string;
}

/** The watcher panel's whole state, so the UI needs one request to render it. */
export interface EpmWatcherState {
  watchers: EpmWatcher[];
  /** Whether the requesting user is among them. */
  isWatching: boolean;
  can: {
    /** May add someone other than themselves. */
    add: boolean;
    /** May remove watchers. Covers every watcher — upstream offers no finer grain. */
    remove: boolean;
    /** May add or remove themselves, which OpenProject permits more widely than `add`. */
    watchSelf: boolean;
  };
}

function toEpmWatcher(user: OpUser): EpmWatcher {
  const name = user.name?.trim() || [user.firstName, user.lastName].filter(Boolean).join(' ');

  return { id: String(user.id), name: name || `User ${user.id}` };
}

/** The work package, read once for both its watcher affordances and its project. */
async function workPackageLinks(
  request: Parameters<typeof requestSignal>[0],
  id: string,
): Promise<Record<string, HalLink | undefined>> {
  const workPackage = await openProject
    .request<{ _links?: Record<string, HalLink | undefined> }>(`/work_packages/${id}`, {
      signal: requestSignal(request),
    })
    .catch(() => null);

  if (!workPackage?._links) throw EpmError.notFound(`Work package ${id}`);

  return workPackage._links;
}

export const watcherRoutes: FastifyPluginAsync = async (app) => {
  /** Who is watching, and what this user may do about it. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/watchers', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

    const links = await workPackageLinks(request, id);

    // `watch` and `unwatch` are mutually exclusive: OpenProject publishes
    // whichever one is the available next move, which is what makes the
    // presence of `unwatch` a reliable "you are watching this" signal.
    const isWatching = Object.hasOwn(links, 'unwatch');

    const collection = await openProject.getCollection<OpUser>(
      `/work_packages/${id}/watchers`,
      { pageSize: 100 },
      requestSignal(request),
    );

    return {
      watchers: (collection._embedded?.elements ?? []).map(toEpmWatcher),
      isWatching,
      can: {
        add: Object.hasOwn(links, 'addWatcher'),
        remove: Object.hasOwn(links, 'removeWatcher'),
        watchSelf: isWatching || Object.hasOwn(links, 'watch'),
      },
    } satisfies EpmWatcherState;
  });

  /**
   * People who could be added.
   *
   * Upstream's own candidate list, not the user directory — see the note at the
   * top of this file.
   */
  app.get<{ Params: { id: string } }>(
    '/work-packages/:id/available-watchers',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

      const collection = await openProject.getCollection<OpUser>(
        `/work_packages/${id}/available_watchers`,
        { pageSize: 100 },
        requestSignal(request),
      );

      return (collection._embedded?.elements ?? []).map(toEpmWatcher);
    },
  );

  /** Adds a watcher. */
  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/work-packages/:id/watchers',
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.body?.userId;

      if (!userId) throw EpmError.badRequest('A userId is required.');

      await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

      const links = await workPackageLinks(request, id);

      // Watching yourself is offered where adding others is not, so the two are
      // authorised against different affordances rather than one blanket check.
      const isSelf = userId === request.auth?.userId;
      const allowed = isSelf
        ? Object.hasOwn(links, 'watch') || Object.hasOwn(links, 'unwatch')
        : Object.hasOwn(links, 'addWatcher');

      if (!allowed) {
        throw EpmError.forbidden(
          isSelf
            ? 'You do not have permission to watch this work package.'
            : 'You do not have permission to add watchers to this work package.',
        );
      }

      const added = await openProject.request<OpUser>(`/work_packages/${id}/watchers`, {
        method: 'POST',
        body: { user: { href: `/api/v3/users/${userId}` } },
        signal: requestSignal(request),
      });

      reply.code(201);
      return toEpmWatcher(added);
    },
  );

  /** Removes a watcher. */
  app.delete<{ Params: { id: string; userId: string } }>(
    '/work-packages/:id/watchers/:userId',
    async (request, reply) => {
      const { id, userId } = request.params;

      await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));

      const links = await workPackageLinks(request, id);

      const isSelf = userId === request.auth?.userId;
      const allowed = isSelf
        ? Object.hasOwn(links, 'unwatch') || Object.hasOwn(links, 'removeWatcher')
        : Object.hasOwn(links, 'removeWatcher');

      if (!allowed) {
        throw EpmError.forbidden(
          isSelf
            ? 'You do not have permission to stop watching this work package.'
            : 'You do not have permission to remove watchers from this work package.',
        );
      }

      await openProject.request<void>(`/work_packages/${id}/watchers/${userId}`, {
        method: 'DELETE',
        signal: requestSignal(request),
      });

      reply.code(204);
    },
  );
};
