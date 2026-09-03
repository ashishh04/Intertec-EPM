import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { requestSignal } from '../lib/request-signal.js';
import {
  createPortfolio,
  getPortfolio,
  listPortfolios,
  setPortfolioActive,
  updatePortfolio,
  type PortfolioInput,
  type PortfolioProjectFacts,
} from '../domain/portfolios.js';
import { loadProjectsFor } from './projects.js';

/**
 * Portfolios.
 *
 * EPM-owned. Nothing here copies a project: the association is one nullable
 * reference on a project's EPM profile, and every project fact in a rollup is
 * read live from the projects the caller can already see — so a portfolio can
 * never report a project the caller is not allowed to know about.
 *
 * Reading is open to any signed-in caller, as for departments and teams.
 * Writing needs `portfolios:manage`, which OpenProject cannot grant because it
 * has no portfolio concept. See `auth/grants.ts`.
 */

/** Live project facts for the rollups, from projects this caller can see. */
async function factsFor(
  request: Parameters<typeof requestSignal>[0],
): Promise<PortfolioProjectFacts[]> {
  const projects = await loadProjectsFor(request);

  return projects
    .filter((project) => Boolean(project.portfolioId))
    .map((project) => ({
      portfolioId: project.portfolioId as string,
      // OpenProject's own state, not a copy: `status` is derived per read.
      active: project.status !== 'paused',
      overallHealth: project.health.overall,
      memberIds: project.memberIds,
    }));
}

export const portfolioRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { includeInactive?: string } }>('/portfolios', async (request) => {
    return listPortfolios(
      { includeInactive: request.query.includeInactive === 'true' },
      await factsFor(request),
    );
  });

  app.get<{ Params: { id: string } }>('/portfolios/:id', async (request) => {
    return getPortfolio(request.params.id, await factsFor(request));
  });

  /**
   * The projects in a portfolio.
   *
   * Filtered from the live project list rather than read from the association
   * table, so a project archived or removed upstream simply stops appearing
   * instead of leaving a row that names something gone.
   */
  app.get<{ Params: { id: string } }>('/portfolios/:id/projects', async (request) => {
    const { id } = request.params;

    // Confirms it exists, so the route cannot be used to probe for ids.
    await getPortfolio(id, []);

    const projects = await loadProjectsFor(request);
    return projects.filter((project) => project.portfolioId === id);
  });

  app.post<{ Body: PortfolioInput }>('/portfolios', async (request, reply) => {
    await guard.require(request, 'portfolios:manage');

    const created = await createPortfolio(request.body ?? {}, await factsFor(request));

    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string }; Body: PortfolioInput }>('/portfolios/:id', async (request) => {
    await guard.require(request, 'portfolios:manage');

    return updatePortfolio(request.params.id, request.body ?? {}, await factsFor(request));
  });

  /** Deactivate. Named for the convention departments and teams already use. */
  app.patch<{ Params: { id: string } }>('/portfolios/:id/archive', async (request) => {
    await guard.require(request, 'portfolios:manage');

    return setPortfolioActive(request.params.id, false, await factsFor(request));
  });

  app.patch<{ Params: { id: string } }>('/portfolios/:id/restore', async (request) => {
    await guard.require(request, 'portfolios:manage');

    return setPortfolioActive(request.params.id, true, await factsFor(request));
  });
};
