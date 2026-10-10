import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import * as guard from '../auth/guard.js';
import {
  changeState,
  createSeries,
  generateAllNow,
  generateOneNow,
  listProjectSeries,
  previewRule,
  seriesDetail,
  seriesProject,
  updateSeries,
  workPackageSeriesLink,
} from '../domain/task-series.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';

/**
 * Recurring tasks (BRQ-02: BR-105 to BR-107).
 *
 * A series is read with the caller's access to its project's work, as the
 * work itself is: `task:view` there to see it, `task:edit` to make one or to
 * change, pause, resume or cancel it. A series in a project the caller cannot
 * view is reported as absent rather than forbidden, so an id confirms nothing;
 * the tasks each lists are read with the caller's own access, so a task out of
 * their reach is left out. Previewing a rule saves and reveals nothing.
 */

const numeric = (value: string, what: ReturnType<typeof message>) => {
  if (!/^\d+$/.test(value)) throw EpmError.notFound(what);
  return value;
};

/** The series, if the caller may view its project's work; otherwise "not found". */
async function readable(request: FastifyRequest, id: string) {
  const found = await seriesProject(id);
  if (!(await guard.holds(request, 'task:view', found.projectId))) throw EpmError.notFound('That series');
  return found;
}

/** The series, if the caller may also edit its project's work. */
async function editable(request: FastifyRequest, id: string) {
  const found = await readable(request, id);
  await guard.require(request, 'task:edit', found.projectId);
  return found;
}

export const taskSeriesRoutes: FastifyPluginAsync = async (app) => {
  /** A project's recurring work: every series, active first. */
  app.get<{ Params: { id: string } }>('/projects/:id/task-series', async (request) => {
    const id = numeric(request.params.id, message('Project {id}', { id: request.params.id }));
    await guard.require(request, 'task:view', id);
    return listProjectSeries(id);
  });

  /** One series, with the tasks it made and the occurrences to come. */
  app.get<{ Params: { id: string } }>('/task-series/:id', async (request) => {
    const { row, projectId } = await readable(request, request.params.id);
    return seriesDetail(row, await guard.holds(request, 'task:edit', projectId));
  });

  /** What a work package is to a series: its template, one of its tasks, or neither. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/series', async (request) => {
    const id = numeric(request.params.id, message('Work package {id}', { id: request.params.id }));
    const projectId = await guard.projectOfWorkPackage(request, id);
    await guard.require(request, 'task:view', projectId);
    return workPackageSeriesLink(Number(id), await guard.holds(request, 'task:edit', projectId));
  });

  /** A rule's next dates and its words. Nothing is saved; a rule that is not valid says why. */
  app.post<{ Body: { rule?: unknown; limit?: number } }>('/task-series/preview', async (request) =>
    previewRule(request.body?.rule, Number(request.body?.limit ?? 10)),
  );

  /** Makes a work package the template of a series (BR-105). */
  app.post<{ Params: { id: string }; Body: unknown }>('/work-packages/:id/series', async (request, reply) => {
    const id = numeric(request.params.id, message('Work package {id}', { id: request.params.id }));
    const projectId = await guard.projectOfWorkPackage(request, id);
    await guard.require(request, 'task:edit', projectId);
    const row = await createSeries(id, request.body, request.auth!.userId);
    reply.status(201);
    return seriesDetail(row, true);
  });

  /** A new rule, lead time or duration: a new version. Tasks already made are left as they are. */
  app.patch<{ Params: { id: string }; Body: unknown }>('/task-series/:id', async (request) => {
    await editable(request, request.params.id);
    return seriesDetail(await updateSeries(request.params.id, request.body, request.auth!.userId), true);
  });

  for (const move of ['pause', 'resume', 'cancel'] as const) {
    /** BR-107. Cancelling is final: no more tasks are made, and those made stay, linked to the template. */
    app.post<{ Params: { id: string } }>(`/task-series/:id/${move}`, async (request) => {
      await editable(request, request.params.id);
      return seriesDetail(await changeState(request.params.id, move, request.auth!.userId), true);
    });
  }

  /** Makes this series' due tasks now rather than at the next tick. */
  app.post<{ Params: { id: string } }>('/task-series/:id/generate', async (request) => {
    await editable(request, request.params.id);
    return generateOneNow(request.params.id);
  });

  /**
   * Makes every series' due tasks now. For operators: it spans every project,
   * so it is guarded as the Administration area is, on `users:manage`.
   */
  app.post('/task-series/generate', async (request) => {
    await guard.require(request, 'users:manage');
    return generateAllNow();
  });
};
