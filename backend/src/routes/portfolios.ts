import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import {
  createPortfolio,
  getPortfolio,
  listPortfolios,
  deletePortfolio,
  setPortfolioActive,
  toPortfolioFacts,
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
 * Reading follows the projects: a project's overview links to its portfolio for
 * anyone who can see that project, and that is the portfolios someone sees.
 * Whoever holds `portfolios:manage` sees them all, empty ones included. Writing
 * needs that permission too, which OpenProject cannot grant because it has no
 * portfolio concept. See `auth/grants.ts`.
 */

/** Live project facts for the rollups, from projects this caller can see. */
async function factsFor(
  request: Parameters<typeof requestSignal>[0],
): Promise<PortfolioProjectFacts[]> {
  return toPortfolioFacts(await loadProjectsFor(request));
}

export const portfolioRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { includeInactive?: string } }>('/portfolios', async (request) => {
    const [portfolios, manager] = await Promise.all([
      factsFor(request).then((facts) =>
        listPortfolios({ includeInactive: request.query.includeInactive === 'true' }, facts),
      ),
      guard.holds(request, 'portfolios:manage'),
    ]);
    // Counted from the projects this caller can see, so a portfolio with none of
    // theirs in it was only ever telling them its name.
    return manager ? portfolios : portfolios.filter((portfolio) => portfolio.projectCount > 0);
  });

  app.get<{ Params: { id: string } }>('/portfolios/:id', async (request) => {
    const [portfolio, manager] = await Promise.all([
      factsFor(request).then((facts) => getPortfolio(request.params.id, facts)),
      guard.holds(request, 'portfolios:manage'),
    ]);
    // As if it did not exist, like a project they cannot see.
    if (!manager && portfolio.projectCount === 0) throw EpmError.notFound('That portfolio');
    return portfolio;
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

    const [projects, manager] = await Promise.all([
      loadProjectsFor(request),
      guard.holds(request, 'portfolios:manage'),
    ]);
    const inPortfolio = projects.filter((project) => project.portfolioId === id);
    if (!manager && inPortfolio.length === 0) throw EpmError.notFound('That portfolio');
    return inPortfolio;
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

  /** Deletes a portfolio for good. Refused while any project is still in it. */
  app.delete<{ Params: { id: string } }>('/portfolios/:id', async (request, reply) => {
    await guard.require(request, 'portfolios:manage');

    await deletePortfolio(request.params.id);
    reply.code(204);
  });
};
