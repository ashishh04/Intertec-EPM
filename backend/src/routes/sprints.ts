import type { FastifyPluginAsync } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { aggregateCache, userScopedKey } from '../lib/cache.js';
import { openProject, linkId } from '../openproject/client.js';
import { optional, prisma } from '../db/prisma.js';
import { getCatalog } from '../mapping/catalog.js';
import type { OpVersion, OpWorkPackage } from '../openproject/types.js';
import type { BurndownPoint, EpmSprint, SprintState } from '../types/epm.js';

/**
 * Sprints are OpenProject versions.
 *
 * This instance defines none and the API token cannot create them, so these
 * endpoints return empty. The mapping below is complete and will start
 * producing sprints the moment versions exist.
 */

function stateOf(version: OpVersion, today: string): SprintState {
  if (version.status === 'closed') return 'completed';
  // A version with no dates is a backlog, not a sprint that is running. It
  // reads as planned until someone starts it, which gives it a start date.
  if (!version.startDate && !version.endDate) return 'planned';
  if (version.startDate && version.startDate > today) return 'planned';
  if (version.endDate && version.endDate < today) return 'completed';
  return 'active';
}

function eachDay(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && days.length < 90) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

async function buildSprint(version: OpVersion, signal: AbortSignal): Promise<EpmSprint> {
  const id = String(version.id);
  const today = new Date().toISOString().slice(0, 10);
  const catalog = await getCatalog(signal);

  const workPackages = await openProject
    .getAll<OpWorkPackage & { storyPoints?: number | null }>(
      '/work_packages',
      { filters: [{ field: 'version', operator: '=', values: [id] }], pageSize: 100 },
      { signal },
    )
    .catch(() => ({ items: [] as (OpWorkPackage & { storyPoints?: number | null })[] }));

  let committed = 0;
  let completed = 0;
  for (const workPackage of workPackages.items) {
    const points = typeof workPackage.storyPoints === 'number' ? workPackage.storyPoints : 0;
    committed += points;
    const statusId = linkId(workPackage._links, 'status');
    if (statusId && catalog.statusById.get(statusId)?.epm === 'done') completed += points;
  }

  const [overlay, samples] = await Promise.all([
    optional(() => prisma.sprintProfile.findUnique({ where: { openProjectId: id } }), null),
    optional(
      () => prisma.burndownSample.findMany({ where: { sprintId: id }, orderBy: { sampledOn: 'asc' } }),
      [],
    ),
  ]);

  const committedPoints = overlay?.committedPoints ?? committed;
  const start = version.startDate ?? today;
  const end = version.endDate ?? today;
  const days = eachDay(start, end);

  const remainingByDay = new Map(
    samples.map((sample) => [sample.sampledOn.toISOString().slice(0, 10), sample.remainingPoints]),
  );

  const burndown: BurndownPoint[] = days.map((day, index) => ({
    date: day,
    label: day.slice(5),
    ideal:
      days.length > 1
        ? Math.round((committedPoints * (1 - index / (days.length - 1))) * 100) / 100
        : 0,
    // Only days actually sampled have a real remaining figure; future days are
    // null so the chart draws no line rather than a fabricated one.
    remaining: remainingByDay.get(day) ?? (day === today ? committedPoints - completed : null),
  }));

  return {
    id,
    name: version.name,
    goal: overlay?.goal ?? version.description?.raw ?? '',
    projectIds: [linkId(version._links, 'definingProject')].filter((value): value is string =>
      Boolean(value),
    ),
    state: stateOf(version, today),
    startDate: start,
    endDate: end,
    committedPoints,
    completedPoints: completed,
    burndown,
  };
}

/**
 * Every sprint route reads through here — the list, the active one, and a
 * single sprint by id — and each call fans out to one request per version.
 * Caching the loader rather than the routes covers all of them once.
 *
 * Keyed per user because the versions and their work packages are filtered by
 * the caller's permissions; invalidated on any sprint write so a new or
 * completed sprint appears immediately rather than after the TTL.
 */
async function loadSprints(signal: AbortSignal): Promise<EpmSprint[]> {
  return aggregateCache.get(userScopedKey('sprints'), async () => {
    const versions = await openProject
      .getAll<OpVersion>('/versions', { pageSize: 100 }, { signal })
      .catch(() => ({ items: [] as OpVersion[] }));

    return Promise.all(versions.items.map((version) => buildSprint(version, signal)));
  });
}

export const sprintRoutes: FastifyPluginAsync = async (app) => {
  app.get('/sprints', async (request) => loadSprints(requestSignal(request)));

  app.get('/sprints/active', async (request) => {
    const sprints = await loadSprints(requestSignal(request));
    const active = sprints.find((sprint) => sprint.state === 'active');
    if (!active) throw EpmError.notFound('An active sprint');
    return active;
  });

  app.get<{ Params: { id: string } }>('/sprints/:id', async (request) => {
    const sprints = await loadSprints(requestSignal(request));
    const sprint = sprints.find((candidate) => candidate.id === request.params.id);
    if (!sprint) throw EpmError.notFound('That sprint');
    return sprint;
  });

  /**
   * Creates a sprint.
   *
   * A sprint is an OpenProject version, which is why it needs a project to
   * belong to — versions are defined by one and shared from it. Nothing is
   * stored here; the sprint list already reads versions back.
   *
   * Authorised by asking upstream, not by a permission EPM derives.
   * `sprint:manage` has no capability behind it — `UNMAPPED` says as much, and
   * requiring it would deny everyone including an administrator. There is no
   * affordance on the project either.
   *
   * What upstream does offer is the version form: requesting it for a project
   * answers "may this caller define a version here" authoritatively, 200 or
   * 403. That is the check, made as the caller.
   */
  app.post<{ Body: { name?: unknown; projectId?: unknown; startDate?: unknown; endDate?: unknown } }>(
    '/sprints',
    async (request, reply) => {
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      const projectId =
        typeof request.body?.projectId === 'string' ? request.body.projectId.trim() : '';

      if (!name) throw EpmError.badRequest('A name is required.');
      if (!projectId) throw EpmError.badRequest('A project is required.');
      if (!/^\d+$/.test(projectId)) throw EpmError.badRequest('That project is not valid.');

      const mayDefine = await openProject
        .request<unknown>('/versions/form', {
          method: 'POST',
          body: { _links: { definingProject: { href: `/api/v3/projects/${projectId}` } } },
          signal: requestSignal(request),
        })
        .then(() => true)
        .catch(() => false);

      if (!mayDefine) {
        throw EpmError.forbidden('You do not have permission to create sprints in that project.');
      }

      const date = (value: unknown) =>
        typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;

      const created = await openProject.request<OpVersion>('/versions', {
        method: 'POST',
        body: {
          name,
          // Upstream calls the end of a version its `endDate`; the start is
          // `startDate`. Both optional — a version with neither is a backlog.
          ...(date(request.body?.startDate) ? { startDate: date(request.body?.startDate) } : {}),
          ...(date(request.body?.endDate) ? { endDate: date(request.body?.endDate) } : {}),
          _links: { definingProject: { href: `/api/v3/projects/${projectId}` } },
        },
        signal: requestSignal(request),
      });

      reply.code(201);
      return { id: String(created.id), name: created.name };
    },
  );

  /**
   * Starts or completes a sprint.
   *
   * A sprint's state is its version's status. Completing closes the version;
   * starting opens it and, if the planned start is still ahead, pulls the
   * start date to today so the sprint reads as active rather than planned.
   * Work packages are not touched either way — unfinished work stays where it
   * is, visibly, for someone to move.
   *
   * Gated on the `update` affordance the version publishes, the same signal
   * the delete route relies on.
   */
  app.patch<{ Params: { id: string }; Body: { state?: unknown } }>(
    '/sprints/:id',
    async (request) => {
      const { id } = request.params;
      if (!/^\d+$/.test(id)) throw EpmError.notFound('That sprint');

      const state = request.body?.state;
      if (state !== 'active' && state !== 'completed') {
        throw EpmError.badRequest('A sprint can only be started or completed.');
      }

      const signal = requestSignal(request);
      const version = await openProject
        .request<OpVersion>(`/versions/${id}`, { signal })
        .catch(() => null);
      if (!version) throw EpmError.notFound('That sprint');

      const links = version._links ?? {};
      if (!Object.hasOwn(links, 'update') && !Object.hasOwn(links, 'updateImmediately')) {
        throw EpmError.forbidden('You do not have permission to change this sprint.');
      }

      const today = new Date().toISOString().slice(0, 10);
      const body: Record<string, unknown> =
        state === 'completed'
          ? { status: 'closed' }
          : {
              status: 'open',
              ...(!version.startDate || version.startDate > today ? { startDate: today } : {}),
              // A sprint that ended in the past cannot be active again; give
              // it today as its end so it does not close the moment it opens.
              ...(version.endDate && version.endDate < today ? { endDate: today } : {}),
            };

      const updated = await openProject.request<OpVersion>(`/versions/${id}`, {
        method: 'PATCH',
        body,
        signal,
      });

      return buildSprint(updated, signal);
    },
  );

  /**
   * Deletes a sprint.
   *
   * Gated on the `delete` affordance the version itself publishes, which is
   * the only per-caller signal upstream offers for one. Work packages assigned
   * to it are not deleted — upstream detaches them, which is why this does not
   * refuse the way a department with people in it does.
   */
  app.delete<{ Params: { id: string } }>('/sprints/:id', async (request, reply) => {
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That sprint');

    const version = await openProject
      .request<{ _links?: Record<string, unknown> }>(`/versions/${id}`, {
        signal: requestSignal(request),
      })
      .catch(() => null);

    if (!version) throw EpmError.notFound('That sprint');

    if (!version._links || !Object.hasOwn(version._links, 'delete')) {
      throw EpmError.forbidden('You do not have permission to delete this sprint.');
    }

    await openProject.request<void>(`/versions/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    reply.code(204);
  });
};
