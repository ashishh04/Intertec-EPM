import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { captureSnapshot, coverage, trends, type ScopeType } from '../domain/analytics.js';
import { listPortfolios } from '../domain/portfolios.js';
import { loadProjects } from './projects.js';

/**
 * Analytics.
 *
 * Reading is open to any signed-in caller, as for every other EPM read surface.
 * Capturing a snapshot is not: it writes the historical record, and a bad or
 * partial run is not something an ordinary user should be able to cause.
 *
 * Trend queries touch only the snapshot table. That is the point of
 * snapshotting — the expensive work happens once a day, not on every page load.
 */

const SCOPE_TYPES: ScopeType[] = ['instance', 'user', 'portfolio', 'team', 'department'];

const trendQuery = z.object({
  metrics: z.string().optional(),
  scopeType: z.string().optional(),
  scopeId: z.string().optional(),
  days: z.coerce.number().int().positive().max(366).optional(),
});

/**
 * Projects and their portfolio rollups.
 *
 * Signal-based rather than request-based so the scheduler can call it too — it
 * has no request, only a timeout. Whose credential this travels on is decided
 * by the async auth context: a route runs inside a signed-in user's, and the
 * scheduler runs inside none, which is what makes the client fall back to the
 * configured service key.
 */
export async function loadSnapshotInputs(signal: AbortSignal) {
  const projects = await loadProjects(signal);

  const facts = projects
    .filter((project) => Boolean(project.portfolioId))
    .map((project) => ({
      portfolioId: project.portfolioId as string,
      active: project.status !== 'paused',
      overallHealth: project.health.overall,
      memberIds: project.memberIds,
    }));

  // Archived portfolios included: archiving is a visibility decision, and their
  // projects are still real. The live rollups make the same assumption.
  return { projects, portfolios: await listPortfolios({ includeInactive: true }, facts) };
}

/**
 * Captures one snapshot.
 *
 * The single entry point for both callers — the manual endpoint below and the
 * scheduler. There is exactly one implementation of the calculation, and the
 * scheduler reaches it by calling this rather than by making an HTTP request
 * back into itself.
 */
export async function runSnapshot(signal: AbortSignal) {
  const { projects, portfolios } = await loadSnapshotInputs(signal);
  return captureSnapshot(projects, portfolios);
}

async function portfoliosFor(request: Parameters<typeof requestSignal>[0]) {
  return loadSnapshotInputs(requestSignal(request));
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Current state, plus how much history exists.
   *
   * The coverage is what lets a client tell "no history yet" from "a flat
   * line", so it can say so rather than drawing an empty chart.
   */
  app.get('/analytics/overview', async (request) => {
    const { projects, portfolios } = await portfoliosFor(request);
    const active = projects.filter((project) => project.status !== 'paused');

    return {
      // Computed live, and labelled as such by the client.
      current: {
        projectsTotal: projects.length,
        projectsActive: active.length,
        health: {
          healthy: active.filter((project) => project.health.overall === 'healthy').length,
          warning: active.filter((project) => project.health.overall === 'warning').length,
          critical: active.filter((project) => project.health.overall === 'critical').length,
        },
        portfolios: portfolios.filter((portfolio) => portfolio.active).length,
        capacityHours:
          Math.round(portfolios.reduce((total, portfolio) => total + portfolio.capacityHours, 0) * 100) /
          100,
      },
      // Read from the snapshot table.
      history: await coverage(),
    };
  });

  /** A metric series, straight from the snapshots. */
  app.get('/analytics/trends', async (request) => {
    const query = trendQuery.parse(request.query);

    const metrics = (query.metrics ?? '')
      .split(',')
      .map((metric) => metric.trim())
      .filter(Boolean);

    if (metrics.length === 0) throw EpmError.badRequest('At least one metric is required.');
    if (metrics.length > 10) throw EpmError.badRequest('Ask for at most ten metrics at once.');

    const scopeType = (query.scopeType ?? 'instance') as ScopeType;
    if (!SCOPE_TYPES.includes(scopeType)) {
      throw EpmError.badRequest(`${query.scopeType} is not a scope type.`);
    }

    return trends({
      metrics,
      scopeType,
      scopeId: query.scopeId || undefined,
      days: query.days ?? 90,
    });
  });

  /**
   * Captures today.
   *
   * Idempotent: every row is upserted on its scope, metric and date, so calling
   * this twice in a day overwrites rather than doubling, and the count it
   * reports is the same both times.
   */
  app.post('/analytics/snapshots', async (request, reply) => {
    await guard.require(request, 'analytics:manage');

    // The same function the scheduler calls.
    const result = await runSnapshot(requestSignal(request));

    reply.code(201);
    return result;
  });
};
