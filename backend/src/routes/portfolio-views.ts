import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { portfolioOverview, portfolioSet } from '../domain/portfolio-overview.js';
import {
  createView,
  deleteView,
  getView,
  listViews,
  updateView,
  viewOptions,
  viewOverview,
} from '../domain/portfolio-views.js';
import { periodOf, viewerOf } from './measures.js';

/**
 * Portfolios in one view, and saved views of them (BR-201 to BR-203).
 *
 * Open to anyone signed in, and always built for the caller: a portfolio or a
 * view shows only the projects they may read, and says how many it left out.
 * Making a view needs only a session — sharing it shares a selection, not
 * access. Changing or deleting one is for whoever made it, or for someone who
 * manages portfolios when it is shared.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const periodQuery = z.object({
  from: z.string().regex(DAY, 'from must be a date, e.g. 2026-10-01.').optional(),
  to: z.string().regex(DAY, 'to must be a date, e.g. 2026-10-31.').optional(),
});

async function caller(request: FastifyRequest): Promise<{ userId: string; manager: boolean }> {
  const permissions = await guard.permissionsFor(request);
  return { userId: request.auth!.userId, manager: Boolean(permissions.global['portfolios:manage']) };
}

export const portfolioViewRoutes: FastifyPluginAsync = async (app) => {
  /** A portfolio in one view: each figure for the whole, each project's, and whether they agree. */
  app.get<{ Params: { id: string } }>('/portfolios/:id/overview', async (request) => {
    const query = periodQuery.parse(request.query);
    const set = await portfolioSet(request.params.id);
    if (!set) throw EpmError.notFound('That portfolio');
    return portfolioOverview(set, await viewerOf(request), periodOf(query), todayIso());
  });

  /** The views this person may see: their own, those shared with their roles, and public ones. */
  app.get('/portfolio-views', async (request) => {
    const { userId, manager } = await caller(request);
    return listViews(userId, manager);
  });

  app.get('/portfolio-views/options', async () => viewOptions());

  app.post('/portfolio-views', async (request, reply) => {
    const { userId } = await caller(request);
    reply.code(201);
    return createView(request.body, userId);
  });

  app.get<{ Params: { id: string } }>('/portfolio-views/:id', async (request) => {
    const { userId, manager } = await caller(request);
    return getView(request.params.id, userId, manager);
  });

  app.patch<{ Params: { id: string } }>('/portfolio-views/:id', async (request) => {
    const { userId, manager } = await caller(request);
    return updateView(request.params.id, request.body, userId, manager);
  });

  app.delete<{ Params: { id: string } }>('/portfolio-views/:id', async (request, reply) => {
    const { userId, manager } = await caller(request);
    await deleteView(request.params.id, userId, manager);
    return reply.code(204).send();
  });

  /** The view for the caller, over its own period unless one is asked for. */
  app.get<{ Params: { id: string } }>('/portfolio-views/:id/overview', async (request) => {
    const query = periodQuery.parse(request.query);
    const { userId } = await caller(request);
    const period = query.from || query.to ? periodOf(query) : undefined;
    return viewOverview(request.params.id, userId, await viewerOf(request), todayIso(), period);
  });
};
