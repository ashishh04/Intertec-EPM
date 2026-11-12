import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { getReview, projectGates, requestReview, reviewView, withdrawReview, type GateViewer } from '../domain/stage-gates.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import type { ProjectGate, ProjectPhases, StageGateReview } from '../types/epm.js';

const projectParam = z.object({ id: z.string().regex(/^\d+$/) });

async function viewerOf(request: FastifyRequest): Promise<GateViewer> {
  return { id: request.auth!.userId, manage: await guard.holds(request, 'approvals:configure') };
}

/** The project's life cycle as the reader may see it, through the EPM add-on. */
async function phasesOf(request: FastifyRequest, projectId: string): Promise<ProjectPhases> {
  return openProject
    .request<ProjectPhases>(`/epm_project/projects/${projectId}/phases`, { root: true, signal: requestSignal(request) })
    .catch((error) => {
      if (error instanceof OpenProjectError && error.upstreamStatus === 404) throw EpmError.notFound('That project');
      if (error instanceof OpenProjectError && error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
      throw error;
    });
}

export const stageGateRoutes: FastifyPluginAsync = async (app) => {
  /** The project's gates, each with its latest review. */
  app.get('/projects/:id/gates', async (request): Promise<ProjectGate[]> => {
    const { id } = projectParam.parse(request.params);
    await guard.require(request, 'task:view', id);
    const [phases, viewer, mayRequest] = await Promise.all([phasesOf(request, id), viewerOf(request), guard.holds(request, 'project:edit', id)]);
    return projectGates(phases, id, viewer, mayRequest);
  });

  /** Asks for a gate to be reviewed: the project's managers. */
  app.post<{ Body: unknown }>('/projects/:id/gates/:definitionId/:gate/review', async (request, reply): Promise<StageGateReview> => {
    const { id, definitionId, gate } = z
      .object({ id: z.string().regex(/^\d+$/), definitionId: z.string().regex(/^\d+$/), gate: z.enum(['start', 'finish']) })
      .parse(request.params);
    const { notes } = z.object({ notes: z.string().trim().max(20_000).optional() }).parse(request.body ?? {});
    await guard.require(request, 'project:edit', id);
    const created = await requestReview(await phasesOf(request, id), { projectId: id, definitionId, gate, ...(notes ? { notes } : {}) }, await viewerOf(request));
    reply.code(201);
    return created;
  });

  app.get('/stage-gate-reviews/:id', async (request): Promise<StageGateReview> => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const row = await getReview(id);
    await guard.require(request, 'task:view', row.projectId);
    return reviewView(row, await viewerOf(request));
  });

  app.post('/stage-gate-reviews/:id/withdraw', async (request): Promise<StageGateReview> => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const row = await getReview(id);
    await guard.require(request, 'task:view', row.projectId);
    return withdrawReview(id, await viewerOf(request));
  });
};
