import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { paginated, resolvePage } from '../lib/pagination.js';
import { hoursToDuration } from '../lib/duration.js';
import { openProject, type OpFilter, type SortDirection } from '../openproject/client.js';
import { getCatalog } from '../mapping/catalog.js';
import { expandIds, toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import type { OpActivity, OpProject } from '../openproject/types.js';
import type { EpmTask, TaskComment } from '../types/epm.js';

/**
 * Work packages.
 *
 * Filtering, sorting and pagination are pushed down to OpenProject — the
 * frontend never holds a full task list, and neither does this service.
 */

const csv = (value: unknown) =>
  typeof value === 'string' && value.length > 0
    ? value.split(',').map((part) => part.trim()).filter(Boolean)
    : undefined;

const listQuery = z.object({
  projectId: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z.preprocess(csv, z.array(z.string()).optional()),
  priority: z.preprocess(csv, z.array(z.string()).optional()),
  type: z.preprocess(csv, z.array(z.string()).optional()),
  sprintId: z.string().optional(),
  search: z.string().optional(),
  bucket: z.enum(['open', 'today', 'upcoming', 'overdue', 'completed', 'all']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['dueDate', 'priority', 'updatedAt', 'subject', 'status']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const OP_SORT_FIELD: Record<string, string> = {
  dueDate: 'dueDate',
  subject: 'subject',
  updatedAt: 'updatedAt',
  status: 'status',
  priority: 'priority',
};

async function projectIdentifiers(signal: AbortSignal): Promise<Map<string, string>> {
  const projects = await openProject
    .getAll<OpProject>('/projects', { pageSize: 100 }, { signal })
    .catch(() => ({ items: [] as OpProject[] }));
  return new Map(projects.items.map((project) => [String(project.id), project.identifier]));
}

function bucketFilters(bucket: string | undefined, today: string): OpFilter[] {
  switch (bucket) {
    case 'overdue':
      return [
        { field: 'status', operator: 'o', values: [] },
        { field: 'dueDate', operator: '<t-', values: ['0'] },
      ];
    case 'today':
      return [
        { field: 'status', operator: 'o', values: [] },
        { field: 'dueDate', operator: '=', values: [today] },
      ];
    case 'upcoming':
      return [
        { field: 'status', operator: 'o', values: [] },
        { field: 'dueDate', operator: '>t-', values: ['0'] },
      ];
    case 'completed':
      return [{ field: 'status', operator: 'c', values: [] }];
    case 'open':
      return [{ field: 'status', operator: 'o', values: [] }];
    // `all` and undefined both mean "no status restriction", which requires an
    // explicit empty filter set — see the note in the OpenProject client.
    default:
      return [];
  }
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  app.get('/tasks', async (request) => {
    const query = listQuery.parse(request.query);
    const signal = requestSignal(request);
    const today = new Date().toISOString().slice(0, 10);

    const [catalog, identifiers] = await Promise.all([
      getCatalog(signal),
      projectIdentifiers(signal),
    ]);

    const filters: OpFilter[] = [...bucketFilters(query.bucket, today)];

    if (query.projectId) {
      filters.push({ field: 'project', operator: '=', values: [query.projectId] });
    }
    if (query.assigneeId) {
      filters.push({ field: 'assignee', operator: '=', values: [query.assigneeId] });
    }
    if (query.sprintId) {
      filters.push({ field: 'version', operator: '=', values: [query.sprintId] });
    }
    if (query.search) {
      filters.push({ field: 'subjectOrId', operator: '**', values: [query.search] });
    }

    const statusIds = expandIds(query.status as never, catalog.statusIdsByEpm as never);
    if (statusIds) filters.push({ field: 'status', operator: '=', values: statusIds });

    const priorityIds = expandIds(query.priority as never, catalog.priorityIdsByEpm as never);
    if (priorityIds) filters.push({ field: 'priority', operator: '=', values: priorityIds });

    const typeIds = expandIds(query.type as never, catalog.typeIdsByEpm as never);
    if (typeIds) filters.push({ field: 'type', operator: '=', values: typeIds });

    const page = resolvePage(query.page, query.pageSize);
    const sortField = query.sortBy ? OP_SORT_FIELD[query.sortBy] : undefined;
    const sortBy: [string, SortDirection][] = sortField
      ? [[sortField, (query.sortDir ?? 'asc') as SortDirection]]
      : [['updatedAt', 'desc']];

    const collection = await openProject.getCollection<WorkPackageWithPoints>(
      '/work_packages',
      { filters, sortBy, offset: page.page, pageSize: page.pageSize },
      signal,
    );

    const items = (collection._embedded?.elements ?? []).map((workPackage) =>
      toEpmTask(workPackage, catalog, identifiers),
    );

    return paginated(items, collection.total ?? items.length, page);
  });

  app.get<{ Params: { id: string } }>('/tasks/:id', async (request) => {
    const signal = requestSignal(request);
    const [catalog, identifiers] = await Promise.all([
      getCatalog(signal),
      projectIdentifiers(signal),
    ]);

    const workPackage = await openProject.request<WorkPackageWithPoints>(
      `/work_packages/${request.params.id}`,
      { signal },
    );

    return toEpmTask(workPackage, catalog, identifiers);
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/comments', async (request) => {
    const signal = requestSignal(request);

    const activities = await openProject
      .getAll<OpActivity>(
        `/work_packages/${request.params.id}/activities`,
        { pageSize: 100 },
        { signal },
      )
      .catch(() => ({ items: [] as OpActivity[] }));

    return activities.items
      .filter((activity) => (activity.comment?.raw ?? '').trim().length > 0)
      .map((activity): TaskComment => {
        const author = activity._links?.user;
        const href = Array.isArray(author) ? author[0]?.href : author?.href;
        return {
          id: String(activity.id),
          taskId: request.params.id,
          authorId: href?.split('/').pop() ?? '',
          body: activity.comment?.raw ?? '',
          createdAt: activity.createdAt,
        };
      });
  });

  app.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/tasks/:id/comments',
    async (request, reply) => {
      const body = request.body?.body?.trim();
      if (!body) throw EpmError.badRequest('A comment cannot be empty.');

      // No capability covers commenting; the work package advertises it.
      await guard.requireLink(
        request,
        `/work_packages/${request.params.id}`,
        'addComment',
        'comment on this work package',
      );

      const activity = await openProject.request<OpActivity>(
        `/work_packages/${request.params.id}/activities`,
        { method: 'POST', body: { comment: { raw: body } }, signal: requestSignal(request) },
      );

      reply.status(201);
      const author = activity._links?.user;
      const href = Array.isArray(author) ? author[0]?.href : author?.href;

      return {
        id: String(activity.id),
        taskId: request.params.id,
        authorId: href?.split('/').pop() ?? '',
        body: activity.comment?.raw ?? body,
        createdAt: activity.createdAt,
      } satisfies TaskComment;
    },
  );

  app.post<{ Body: Record<string, unknown> }>('/tasks', async (request, reply) => {
    const signal = requestSignal(request);
    const input = request.body ?? {};

    const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
    if (!projectId) throw EpmError.badRequest('A project is required to create a task.');

    await guard.require(request, 'task:create', projectId);

    const [catalog, identifiers] = await Promise.all([
      getCatalog(signal),
      projectIdentifiers(signal),
    ]);

    const created = await openProject.request<WorkPackageWithPoints>(
      `/projects/${projectId}/work_packages`,
      {
        method: 'POST',
        query: { notify: 'false' },
        body: buildWorkPackageBody(input, catalog),
        signal,
      },
    );

    reply.status(201);
    return toEpmTask(created, catalog, identifiers);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/tasks/:id',
    async (request) => {
      await guard.require(
        request,
        'task:edit',
        await guard.projectOfWorkPackage(request, request.params.id),
      );

      const signal = requestSignal(request);
      const [catalog, identifiers] = await Promise.all([
        getCatalog(signal),
        projectIdentifiers(signal),
      ]);

      const updated = await patchWorkPackage(request.params.id, request.body ?? {}, catalog, signal);
      return toEpmTask(updated, catalog, identifiers);
    },
  );

  app.patch<{ Body: { ids?: string[]; patch?: Record<string, unknown> } }>(
    '/tasks/bulk',
    async (request) => {
      const { ids = [], patch = {} } = request.body ?? {};
      if (ids.length === 0) return [];

      const signal = requestSignal(request);
      const [catalog, identifiers] = await Promise.all([
        getCatalog(signal),
        projectIdentifiers(signal),
      ]);

      // Authorised per item: a bulk selection can span projects, and holding
      // the permission in one is not permission for the rest.
      for (const id of ids) {
        await guard.require(request, 'task:edit', await guard.projectOfWorkPackage(request, id));
      }

      const updated: EpmTask[] = [];
      for (const id of ids) {
        const result = await patchWorkPackage(id, patch, catalog, signal);
        updated.push(toEpmTask(result, catalog, identifiers));
      }
      return updated;
    },
  );

  app.delete<{ Body: { ids?: string[] } }>('/tasks/bulk', async (request, reply) => {
    const { ids = [] } = request.body ?? {};
    const signal = requestSignal(request);

    // Checked for every id before deleting any, so a partly-permitted selection
    // fails outright instead of half-completing.
    for (const id of ids) {
      await guard.requireLink(
        request,
        `/work_packages/${id}`,
        'delete',
        'delete this work package',
      );
    }

    for (const id of ids) {
      await openProject.request<void>(`/work_packages/${id}`, { method: 'DELETE', signal });
    }

    reply.status(204);
  });
};

/**
 * OpenProject rejects a PATCH without the current `lockVersion`, so the work
 * package is read immediately before writing.
 */
async function patchWorkPackage(
  id: string,
  patch: Record<string, unknown>,
  catalog: Awaited<ReturnType<typeof getCatalog>>,
  signal: AbortSignal,
): Promise<WorkPackageWithPoints> {
  const current = await openProject.request<WorkPackageWithPoints>(`/work_packages/${id}`, { signal });

  return openProject.request<WorkPackageWithPoints>(`/work_packages/${id}`, {
    method: 'PATCH',
    query: { notify: 'false' },
    body: { lockVersion: current.lockVersion, ...buildWorkPackageBody(patch, catalog) },
    signal,
  });
}

function buildWorkPackageBody(
  input: Record<string, unknown>,
  catalog: Awaited<ReturnType<typeof getCatalog>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const links: Record<string, { href: string | null }> = {};

  if (typeof input.subject === 'string') body.subject = input.subject;
  if (typeof input.description === 'string') {
    body.description = { format: 'markdown', raw: input.description };
  }
  if (typeof input.startDate === 'string') body.startDate = input.startDate;
  if (typeof input.dueDate === 'string') body.dueDate = input.dueDate;
  if (typeof input.storyPoints === 'number') body.storyPoints = input.storyPoints;
  if (typeof input.estimatedHours === 'number') {
    body.estimatedTime = hoursToDuration(input.estimatedHours);
  }

  // EPM values map to whichever OpenProject id the instance uses; the first
  // candidate is the representative one.
  const first = (ids: string[] | undefined) => (ids && ids.length > 0 ? ids[0] : undefined);

  if (typeof input.status === 'string') {
    const id = first(catalog.statusIdsByEpm.get(input.status as never));
    if (id) links.status = { href: `/api/v3/statuses/${id}` };
  }
  if (typeof input.priority === 'string') {
    const id = first(catalog.priorityIdsByEpm.get(input.priority as never));
    if (id) links.priority = { href: `/api/v3/priorities/${id}` };
  }
  if (typeof input.type === 'string') {
    const id = first(catalog.typeIdsByEpm.get(input.type as never));
    if (id) links.type = { href: `/api/v3/types/${id}` };
  }
  if (typeof input.assigneeId === 'string') {
    links.assignee = { href: `/api/v3/users/${input.assigneeId}` };
  }
  if (input.assigneeId === null) links.assignee = { href: null };
  if (typeof input.parentId === 'string') {
    links.parent = { href: `/api/v3/work_packages/${input.parentId}` };
  }

  if (Object.keys(links).length > 0) body._links = links;
  return body;
}
