import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { allows } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { backtest, latestBacktest, latestForecasts, latestRun, reproduceForecast, runForecasts } from '../domain/forecasting-store.js';
import { decideRecommendation, listRecommendations, recommendationProject } from '../domain/recommendations.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { listProjects } from '../mapping/projects.js';

/**
 * Delivery forecasts (BR-509, BR-510) and recommended actions (BR-511,
 * BR-512). Each person sees the forecasts and recommendations of the
 * projects they can see. Running the model and back-testing it are for
 * administrators; deciding a recommendation needs the right to make its change.
 */

/** Projects the caller can see, read with their own access. */
async function visibleProjectIds(request: FastifyRequest): Promise<number[]> {
  const projects = await listProjects(requestSignal(request));
  return projects.map((project) => Number(project.id));
}

export const forecastRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { projectId?: string } }>('/forecasts', async (request) => {
    const visible = await visibleProjectIds(request);
    const only = request.query.projectId ? Number(request.query.projectId) : undefined;
    const ids = only !== undefined ? visible.filter((id) => id === only) : visible;
    const [forecasts, run] = await Promise.all([latestForecasts(ids), latestRun()]);
    return { run, forecasts };
  });

  app.get<{ Params: { id: string } }>('/forecasts/:id/reproduce', async (request) => {
    const result = await reproduceForecast(request.params.id);
    if (!(await visibleProjectIds(request)).includes(result.stored.projectId)) throw EpmError.notFound('That forecast');
    return { identical: result.identical, recomputed: result.recomputed };
  });

  app.post('/forecasts/run', async (request, reply) => {
    await guard.require(request, 'users:manage');
    reply.code(201);
    return runForecasts('manual', request.auth!.userId);
  });

  app.get('/forecasts/backtest', async (request) => {
    await guard.require(request, 'users:manage');
    return { backtest: await latestBacktest() };
  });

  app.post<{ Body: unknown }>('/forecasts/backtest', async (request, reply) => {
    await guard.require(request, 'users:manage');
    const input = z
      .object({
        months: z.number().int().min(1).max(36).optional(),
        stepDays: z.number().int().min(7).max(120).optional(),
        tolerance: z
          .object({ brier: z.number().min(0).max(1).optional(), calibrationError: z.number().min(0).max(1).optional(), minCases: z.number().int().min(1).max(10_000).optional() })
          .optional(),
      })
      .parse(request.body ?? {});
    reply.code(201);
    return backtest(input, request.auth!.userId);
  });

  app.get<{ Querystring: { status?: string; projectId?: string } }>('/recommendations', async (request) => {
    const { status, projectId } = z
      .object({ status: z.enum(['proposed', 'applied', 'rejected', 'failed']).optional(), projectId: z.string().regex(/^\d+$/).optional() })
      .parse(request.query);
    const visible = await visibleProjectIds(request);
    return listRecommendations(projectId ? visible.filter((id) => id === Number(projectId)) : visible, status);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/recommendations/:id/decision', async (request) => {
    const input = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).nullable().optional() }).parse(request.body ?? {});
    const projectId = await recommendationProject(request.params.id);
    if (projectId === null || !(await visibleProjectIds(request)).includes(projectId)) throw EpmError.notFound('That recommendation');
    // Deciding is for whoever may make such a change in the project: editing
    // its plan or its work. Applying checks again, as the change is made as them.
    const permissions = await guard.permissionsFor(request);
    if (!allows(permissions, 'project:edit', String(projectId)) && !allows(permissions, 'task:edit', String(projectId))) {
      throw EpmError.forbidden('Deciding a recommendation needs the right to change this project.');
    }
    return decideRecommendation(request.params.id, input, { userId: request.auth!.userId, cookie: request.headers.cookie ?? '', app });
  });
};
