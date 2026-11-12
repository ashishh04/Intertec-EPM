import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import {
  approvedRequest,
  completeRequest,
  createRequest,
  deleteRequest,
  getRequest,
  listRequests,
  submitRequest,
  updateRequest,
  withdrawRequest,
  type RequestViewer,
} from '../domain/project-requests.js';
import { assertIdentifierAllowed } from '../domain/reserved-identifiers.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import type { ProjectRequestCreation } from '../types/epm.js';
import { invalidateProjects } from './projects.js';

/** What a template brings to a project made from a request: the copy dialog's own defaults. */
const COPY_PARTS = ['members', 'versions', 'categories', 'work_packages', 'wiki', 'queries', 'boards', 'overview', 'phases'];

const idParam = z.object({ id: z.string().min(1).max(64) });

async function viewerOf(request: FastifyRequest): Promise<RequestViewer> {
  const [manage, review, createProjects] = await Promise.all([
    guard.holds(request, 'portfolios:manage'),
    guard.holds(request, 'requests:review'),
    guard.holds(request, 'project:create'),
  ]);
  return { id: request.auth!.userId, manage, review: review || manage, createProjects };
}

function rethrow(error: unknown): never {
  if (error instanceof OpenProjectError) {
    if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
    if (error.upstreamStatus === 404) throw EpmError.notFound('That template');
    if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
  }
  throw error;
}

export const projectRequestRoutes: FastifyPluginAsync = async (app) => {
  /** The reader's own requests, or every one for whoever reviews them (`scope=all`). */
  app.get<{ Querystring: { scope?: string } }>('/project-requests', async (request) =>
    listRequests(await viewerOf(request), request.query.scope === 'all' ? 'all' : 'mine'),
  );

  app.get('/project-requests/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    return getRequest(id, await viewerOf(request));
  });

  app.post<{ Body: unknown }>('/project-requests', async (request, reply) => {
    const created = await createRequest(request.body, await viewerOf(request));
    reply.code(201);
    return created;
  });

  app.patch<{ Body: unknown }>('/project-requests/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    return updateRequest(id, request.body, await viewerOf(request));
  });

  app.delete('/project-requests/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await deleteRequest(id, await viewerOf(request));
    reply.code(204);
  });

  app.post('/project-requests/:id/submit', async (request) => {
    const { id } = idParam.parse(request.params);
    return submitRequest(id, await viewerOf(request));
  });

  app.post('/project-requests/:id/withdraw', async (request) => {
    const { id } = idParam.parse(request.params);
    return withdrawRequest(id, await viewerOf(request));
  });

  /**
   * Turns an approved request into a project, as the signed-in person: blank,
   * at once; or as a copy of its template, which runs in the background and is
   * followed like any copy, then recorded with `/link` once it exists.
   */
  app.post('/project-requests/:id/create-project', async (request, reply): Promise<ProjectRequestCreation> => {
    const { id } = idParam.parse(request.params);
    await guard.require(request, 'project:create');
    const row = await approvedRequest(id);
    const signal = requestSignal(request);
    if (row.identifier) await assertIdentifierAllowed(row.identifier, await guard.holds(request, 'users:manage'));
    const description = [row.description, row.businessCase].filter(Boolean).join('\n\n');

    if (row.templateId) {
      const started = await openProject
        .request<{ jobId: string }>(`/epm_project/projects/${row.templateId}/copy`, {
          root: true,
          method: 'POST',
          body: { name: row.title, ...(row.identifier ? { identifier: row.identifier } : {}), only: COPY_PARTS },
          signal,
        })
        .catch(rethrow);
      reply.code(202);
      return { jobId: started.jobId };
    }

    const created = await openProject
      .request<{ id: number }>('/projects', {
        method: 'POST',
        once: true,
        body: {
          name: row.title,
          ...(row.identifier ? { identifier: row.identifier } : {}),
          ...(description ? { description: { raw: description } } : {}),
        },
        signal,
      })
      .catch(rethrow);
    await completeRequest(row, String(created.id), request.auth!.userId);
    invalidateProjects();
    reply.code(201);
    return { projectId: String(created.id) };
  });

  /** Records the project a template copy made for the request. */
  app.post<{ Body: unknown }>('/project-requests/:id/link', async (request) => {
    const { id } = idParam.parse(request.params);
    const { projectId } = z.object({ projectId: z.string().regex(/^\d+$/) }).parse(request.body ?? {});
    await guard.require(request, 'project:create');
    const row = await approvedRequest(id);
    // The project must exist and be visible to whoever made it.
    await openProject.request(`/projects/${projectId}`, { signal: requestSignal(request) }).catch(rethrow);
    await completeRequest(row, projectId, request.auth!.userId);
    invalidateProjects();
    return getRequest(id, await viewerOf(request));
  });
};
