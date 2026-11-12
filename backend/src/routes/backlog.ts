import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import { aggregateCache } from '../lib/cache.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import { idFromHref, linkId, openProject } from '../openproject/client.js';
import { versionFilter, versionIdOf, versionLinks } from '../openproject/versions.js';
import type {
  BacklogSprint,
  EpmSprint,
  EpmTask,
  Impediment,
  ProjectBacklog,
} from '../types/epm.js';
import { loadSprints } from './sprints.js';

/**
 * A project's backlog and sprint planning, and a sprint's impediments.
 *
 * Sprints are versions, as everywhere in EPM. The delivery system's own
 * backlogs (17.x) plan into a sprint model of their own that EPM does not use,
 * so the order of the backlog and of each sprint's list is EPM's: a rank per
 * task (`backlog_ranks`). Which sprint a task is in stays the task's version,
 * written as any other edit, so the delivery system's permissions decide it.
 *
 * An impediment is a work item of the Impediment type (governance-types.rb)
 * in the sprint, with a "blocks" relation to each task it holds up.
 */

const projectParam = z.object({ id: z.string().regex(/^\d+$/) });

/** Turns an upstream refusal into EPM's own error, message intact. */
function rethrow(error: unknown): never {
  if (error instanceof OpenProjectError) {
    if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
    if (error.upstreamStatus === 404) throw EpmError.notFound('That task');
    if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
  }
  throw error;
}

/** The sprints a project can plan into: its own and those shared with it, not finished. */
const plannable = (sprints: EpmSprint[], projectId: string) =>
  sprints.filter((sprint) => sprint.projectIds.includes(projectId) && sprint.state !== 'completed');

/** Ranked first, by rank; the rest after them, oldest first. */
function inOrder<T extends { id: string }>(items: T[], ranks: Map<string, number>): T[] {
  return [...items].sort((a, b) => {
    const ra = ranks.get(a.id);
    const rb = ranks.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb || Number(a.id) - Number(b.id);
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return Number(a.id) - Number(b.id);
  });
}

async function ranksFor(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.backlogRank.findMany({ where: { workPackageId: { in: ids } } });
  return new Map(rows.map((row) => [row.workPackageId, row.rank]));
}

/** The project's open work in no sprint. */
async function backlogWork(projectId: string, signal: AbortSignal) {
  return openProject
    .getAll<WorkPackageWithPoints>(
      '/work_packages',
      {
        filters: [
          { field: 'project', operator: '=', values: [projectId] },
          { field: 'status', operator: 'o', values: [] },
          { field: 'version', operator: '!*', values: [] },
        ],
        sortBy: [['id', 'asc']],
        pageSize: 200,
      },
      { signal, maxPages: 5 },
    )
    .catch(rethrow);
}

/** The project's work in these sprints, open or done. */
async function sprintWork(projectId: string, sprintIds: string[], signal: AbortSignal) {
  if (sprintIds.length === 0) return { items: [] as WorkPackageWithPoints[] };
  return openProject
    .getAll<WorkPackageWithPoints>(
      '/work_packages',
      { filters: [{ field: 'project', operator: '=', values: [projectId] }, versionFilter(sprintIds)], sortBy: [['id', 'asc']], pageSize: 200 },
      { signal, maxPages: 5 },
    )
    .catch(rethrow);
}

/** The Impediment type, which governance-types.rb sets up. */
async function impedimentTypeId(signal: AbortSignal): Promise<string | undefined> {
  const catalog = await getCatalog(signal);
  return [...catalog.typeById.values()].find((type) => /^impediments?$/i.test(type.name.trim()))?.id;
}

async function impedimentsOf(request: FastifyRequest, sprintId: string, projectId: string | undefined): Promise<Impediment[]> {
  const signal = requestSignal(request);
  const typeId = await impedimentTypeId(signal);
  if (!typeId) return [];
  const [found, catalog, identifiers] = await Promise.all([
    openProject
      .getAll<WorkPackageWithPoints>(
        '/work_packages',
        {
          filters: [
            ...(projectId ? [{ field: 'project', operator: '=' as const, values: [projectId] }] : []),
            { field: 'type', operator: '=', values: [typeId] },
            versionFilter([sprintId]),
            { field: 'status', operator: '*', values: [] },
          ],
          sortBy: [['id', 'asc']],
          pageSize: 100,
        },
        { signal, maxPages: 2 },
      )
      .catch(rethrow),
    getCatalog(signal),
    projectIdentifiers(signal),
  ]);
  if (found.items.length === 0) return [];
  const impediments = found.items.map((item) => toEpmTask(item, catalog, identifiers));

  // What each holds up: its "blocks" relations, then those tasks, as far as the reader sees them.
  const relations = await openProject
    .getAll<{ type?: string; _links?: Record<string, { href?: string | null } | undefined> }>(
      '/relations',
      {
        filters: [
          { field: 'from', operator: '=', values: impediments.map((one) => one.id) },
          { field: 'type', operator: '=', values: ['blocks'] },
        ],
        pageSize: 200,
      },
      { signal, maxPages: 2 },
    )
    .catch(() => ({ items: [] }));
  const blockedBy = new Map<string, string[]>();
  for (const relation of relations.items) {
    const from = idFromHref(relation._links?.from?.href ?? '');
    const to = idFromHref(relation._links?.to?.href ?? '');
    if (!from || !to) continue;
    blockedBy.set(from, [...(blockedBy.get(from) ?? []), to]);
  }
  const blockedIds = [...new Set([...blockedBy.values()].flat())];
  const blocked = blockedIds.length
    ? await openProject
        .getAll<WorkPackageWithPoints>(
          '/work_packages',
          { filters: [{ field: 'id', operator: '=', values: blockedIds }, { field: 'status', operator: '*', values: [] }], pageSize: 200 },
          { signal, maxPages: 2 },
        )
        .then((result) => new Map(result.items.map((item) => [String(item.id), toEpmTask(item, catalog, identifiers)])))
        .catch(() => new Map<string, EpmTask>())
    : new Map<string, EpmTask>();

  return impediments
    .map((task): Impediment => ({
      id: task.id,
      key: task.key,
      subject: task.subject,
      ...(task.description ? { description: task.description } : {}),
      status: task.status,
      ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}),
      createdAt: task.createdAt,
      blocks: (blockedBy.get(task.id) ?? [])
        .map((id) => blocked.get(id))
        .filter((one): one is EpmTask => Boolean(one))
        .map((one) => ({ id: one.id, key: one.key, subject: one.subject })),
    }))
    .sort((a, b) => Number(a.status.isClosed) - Number(b.status.isClosed) || Number(b.id) - Number(a.id));
}

export const backlogRoutes: FastifyPluginAsync = async (app) => {
  /** The backlog in order, and each sprint the project can plan into with its work in order. */
  app.get('/projects/:id/backlog', async (request): Promise<ProjectBacklog> => {
    const { id } = projectParam.parse(request.params);
    await guard.require(request, 'task:view', id);
    const signal = requestSignal(request);
    const [sprints, backlog, catalog, identifiers, canPlan, versions] = await Promise.all([
      loadSprints(signal),
      backlogWork(id, signal),
      getCatalog(signal),
      projectIdentifiers(signal),
      guard.holds(request, 'task:edit', id),
      // The versions' own dates: a sprint fills today in for dates it lacks.
      openProject
        .getAll<{ id: number; startDate?: string | null; endDate?: string | null }>(`/projects/${id}/versions`, { pageSize: 200 }, { signal })
        .catch(() => ({ items: [] as { id: number; startDate?: string | null; endDate?: string | null }[] })),
    ]);
    const datesOf = new Map(versions.items.map((version) => [String(version.id), version]));
    const open = plannable(sprints, id).sort(
      (a, b) => Number(b.state === 'active') - Number(a.state === 'active') || a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name),
    );
    const planned = await sprintWork(id, open.map((sprint) => sprint.id), signal);
    const tasks = [...backlog.items, ...planned.items].map((item) => toEpmTask(item, catalog, identifiers));
    const ranks = await ranksFor(tasks.map((task) => task.id));

    // Velocity: the points finished in the project's last three closed sprints, on average.
    const finished = sprints
      .filter((sprint) => sprint.projectIds.includes(id) && sprint.state === 'completed')
      .sort((a, b) => b.endDate.localeCompare(a.endDate))
      .slice(0, 3);
    const velocity = finished.length ? Math.round((finished.reduce((sum, sprint) => sum + sprint.completedPoints, 0) / finished.length) * 10) / 10 : undefined;

    const backlogIds = new Set(backlog.items.map((item) => String(item.id)));
    const bySprint = new Map<string, EpmTask[]>();
    for (const item of planned.items) {
      const sprintId = versionIdOf(item._links);
      const task = tasks.find((one) => one.id === String(item.id));
      if (!sprintId || !task) continue;
      bySprint.set(sprintId, [...(bySprint.get(sprintId) ?? []), task]);
    }
    return {
      backlog: inOrder(tasks.filter((task) => backlogIds.has(task.id)), ranks),
      sprints: open.map((sprint): BacklogSprint => {
        const items = inOrder(bySprint.get(sprint.id) ?? [], ranks);
        const dates = datesOf.get(sprint.id);
        return {
          sprint,
          ...(dates?.startDate ? { startDate: dates.startDate } : {}),
          ...(dates?.endDate ? { endDate: dates.endDate } : {}),
          items,
          points: items.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0),
          ...(velocity !== undefined ? { velocity } : {}),
        };
      }),
      canPlan,
    };
  });

  /**
   * Moves a task into a sprint or back to the backlog, and to its place in
   * that list: before `beforeId`, or at the end.
   */
  app.post<{ Body: unknown }>('/projects/:id/backlog/move', async (request) => {
    const { id } = projectParam.parse(request.params);
    const body = z
      .object({
        workPackageId: z.string().regex(/^\d+$/),
        sprintId: z.string().regex(/^\d+$/).nullable(),
        beforeId: z.string().regex(/^\d+$/).optional(),
      })
      .parse(request.body ?? {});
    await guard.require(request, 'task:edit', id);
    const signal = requestSignal(request);

    const current = await openProject
      .request<WorkPackageWithPoints & { lockVersion: number }>(`/work_packages/${body.workPackageId}`, { signal })
      .catch(rethrow);
    if (linkId(current._links, 'project') !== id) throw EpmError.badRequest('That task is not in this project.');

    if (body.sprintId) {
      const sprints = await loadSprints(signal);
      if (!plannable(sprints, id).some((sprint) => sprint.id === body.sprintId)) {
        throw EpmError.badRequest('That sprint is finished, or not one this project can plan into.');
      }
    }
    const was = versionIdOf(current._links) ?? null;
    if (was !== body.sprintId) {
      await openProject
        .request(`/work_packages/${body.workPackageId}`, {
          method: 'PATCH',
          body: { lockVersion: current.lockVersion, _links: versionLinks(body.sprintId) },
          signal,
        })
        .catch(rethrow);
      aggregateCache.invalidatePrefix('sprints');
    }

    // The list it lands in, in its order, with it in its new place; every
    // rank in the list written again, so the order holds however it was before.
    const list = body.sprintId ? await sprintWork(id, [body.sprintId], signal) : await backlogWork(id, signal);
    const ids = list.items.map((item) => String(item.id)).filter((one) => one !== body.workPackageId);
    const ranks = await ranksFor(ids);
    const ordered = inOrder(ids.map((one) => ({ id: one })), ranks).map((one) => one.id);
    const at = body.beforeId ? ordered.indexOf(body.beforeId) : -1;
    ordered.splice(at >= 0 ? at : ordered.length, 0, body.workPackageId);
    const by = request.auth?.userId ?? null;
    await prisma.$transaction([
      prisma.backlogRank.deleteMany({ where: { workPackageId: { in: ordered } } }),
      prisma.backlogRank.createMany({ data: ordered.map((workPackageId, index) => ({ workPackageId, rank: index + 1, updatedBy: by })) }),
    ]);
    return { ok: true };
  });

  /** A sprint's impediments, open first, each with the tasks it holds up. */
  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>('/sprints/:id/impediments', async (request): Promise<Impediment[]> => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.params);
    const projectId = request.query.projectId && /^\d+$/.test(request.query.projectId) ? request.query.projectId : undefined;
    if (projectId) await guard.require(request, 'task:view', projectId);
    return impedimentsOf(request, id, projectId);
  });

  /** Raises an impediment in a sprint, blocking the tasks it holds up. */
  app.post<{ Params: { id: string }; Body: unknown }>('/sprints/:id/impediments', async (request, reply): Promise<Impediment> => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.params);
    const body = z
      .object({
        projectId: z.string().regex(/^\d+$/),
        subject: z.string().trim().min(1, 'A title is required.').max(255),
        description: z.string().trim().max(10_000).optional(),
        assigneeId: z.string().regex(/^\d+$/).optional(),
        blocksIds: z.array(z.string().regex(/^\d+$/)).min(1, 'Choose at least one task it holds up.').max(50),
      })
      .parse(request.body ?? {});
    await guard.require(request, 'task:create', body.projectId);
    const signal = requestSignal(request);

    const typeId = await impedimentTypeId(signal);
    if (!typeId) {
      throw EpmError.validation('Impediments are not set up on this server. An administrator runs the governance types set-up.');
    }
    const sprints = await loadSprints(signal);
    if (!plannable(sprints, body.projectId).some((sprint) => sprint.id === id)) {
      throw EpmError.badRequest('That sprint is finished, or not one this project can plan into.');
    }
    // The tasks it holds up: visible to the reader and in the same project.
    const targets = await openProject
      .getAll<WorkPackageWithPoints>(
        '/work_packages',
        { filters: [{ field: 'id', operator: '=', values: body.blocksIds }, { field: 'status', operator: '*', values: [] }], pageSize: 50 },
        { signal },
      )
      .catch(rethrow);
    const inProject = targets.items.filter((item) => linkId(item._links, 'project') === body.projectId);
    if (inProject.length !== new Set(body.blocksIds).size) {
      throw EpmError.badRequest('Every task it holds up has to be one of this project’s.');
    }

    const created = await openProject
      .request<{ id: number }>(`/projects/${body.projectId}/work_packages`, {
        method: 'POST',
        once: true,
        body: {
          subject: body.subject,
          ...(body.description ? { description: { raw: body.description } } : {}),
          _links: {
            type: { href: `/api/v3/types/${typeId}` },
            ...versionLinks(id),
            ...(body.assigneeId ? { assignee: { href: `/api/v3/users/${body.assigneeId}` } } : {}),
          },
        },
        signal,
      })
      .catch(rethrow);
    // One at a time: two relations on the same task at once can clash.
    for (const target of inProject) {
      await openProject
        .request(`/work_packages/${created.id}/relations`, {
          method: 'POST',
          once: true,
          body: { type: 'blocks', _links: { to: { href: `/api/v3/work_packages/${target.id}` } } },
          signal,
        })
        .catch(rethrow);
    }
    aggregateCache.invalidatePrefix('sprints');
    const all = await impedimentsOf(request, id, body.projectId);
    const made = all.find((one) => one.id === String(created.id));
    if (!made) throw EpmError.internal();
    reply.code(201);
    return made;
  });
};
