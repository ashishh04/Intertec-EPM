import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { verifyAnalyticsAccess } from '../domain/analytics-access.js';
import {
  captureWorkPackages,
  compareCapture,
  listCaptures,
  portfolioProjectsAsAt,
  stateAsAt,
} from '../domain/analytics-history.js';
import { listRefreshRuns, modelStatus, refreshModel } from '../domain/analytics-model.js';
import { modelFacts } from '../domain/measure-facts.js';
import { EpmError } from '../lib/errors.js';
import { scopeOf, viewerOf } from './measures.js';

/**
 * The analytics model's administration (BR-401, BR-402, BR-403).
 *
 * Its state, its refreshes and how each reconciled, the independent captures
 * and how reconstruction compares with them, and whether the analytics role
 * reads everything and writes nothing — all behind `analytics:manage`, like
 * the snapshots before them. Reading the portfolio as at a past date is open
 * to anyone, scoped to the projects they can see.
 */

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(15),
});

export const analyticsModelRoutes: FastifyPluginAsync = async (app) => {
  app.get('/analytics/model', async (request) => {
    await guard.require(request, 'analytics:manage');
    return modelStatus();
  });

  app.get('/analytics/model/runs', async (request) => {
    await guard.require(request, 'analytics:manage');
    const query = pageQuery.extend({ kind: z.enum(['full', 'incremental']).optional() }).parse(request.query);
    return listRefreshRuns(query);
  });

  /**
   * Refreshes now. Answers at once by default — a full refresh of a large
   * instance takes minutes — and the run appears in the list when it ends;
   * `wait` holds the answer until it does.
   */
  app.post('/analytics/model/refresh', async (request, reply) => {
    await guard.require(request, 'analytics:manage');
    const body = z
      .object({ kind: z.enum(['full', 'incremental']).default('full'), wait: z.boolean().default(false) })
      .parse(request.body ?? {});
    const running = refreshModel(body.kind, 'manual');
    if (!body.wait) {
      running.catch(() => undefined);
      reply.code(202);
      return { accepted: true, kind: body.kind };
    }
    const run = await running;
    if (!run) throw EpmError.conflict('Another server is refreshing the model; try again when it has finished.');
    return run;
  });

  app.get('/analytics/history/captures', async (request) => {
    await guard.require(request, 'analytics:manage');
    return listCaptures(pageQuery.parse(request.query));
  });

  /** Captures every work package as API v3 reports it now, without the journals. */
  app.post('/analytics/history/captures', async (request, reply) => {
    await guard.require(request, 'analytics:manage');
    reply.code(201);
    return captureWorkPackages('manual');
  });

  /** Reconstruction from the journals, against that capture, row by row. */
  app.get<{ Params: { id: string } }>('/analytics/history/captures/:id/compare', async (request) => {
    await guard.require(request, 'analytics:manage');
    if (!/^\d+$/.test(request.params.id)) throw EpmError.notFound('That capture');
    try {
      return await compareCapture(request.params.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'No such capture.') throw EpmError.notFound('That capture');
      throw error;
    }
  });

  /** The work in scope as it stood at an instant, rebuilt from the journals. */
  app.get('/analytics/history/state', async (request) => {
    const query = z
      .object({
        at: z.string().datetime({ offset: true, message: 'at must be an instant, e.g. 2026-09-15T00:00:00Z.' }),
        scope: z.string().optional(),
      })
      .parse(request.query);
    const at = new Date(query.at);
    if (at.getTime() > Date.now()) throw EpmError.badRequest('at must not be in the future.');

    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    if (!['instance', 'portfolio', 'project'].includes(scope.kind)) {
      throw EpmError.badRequest('History is kept per project: ask for the instance, a portfolio or a project.');
    }
    // A portfolio as it was composed then; what the viewer can see, as now.
    const facts = await modelFacts();
    const candidates =
      scope.kind === 'portfolio'
        ? await portfolioProjectsAsAt(scope.id!, at)
        : scope.kind === 'project'
          ? [Number(scope.id)]
          : [...facts.projects.keys()];
    return stateAsAt(
      at,
      candidates.filter((id) => viewer.visibleProjectIds.has(id)),
    );
  });

  /** Whether the analytics role reads everything and writes nothing (BR-401). */
  app.get('/analytics/access', async (request) => {
    await guard.require(request, 'analytics:manage');
    return verifyAnalyticsAccess();
  });
};
