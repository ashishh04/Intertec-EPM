import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { captureSnapshot, coverage, trends, type ScopeType } from '../domain/analytics.js';
import { listPortfolios, toPortfolioFacts } from '../domain/portfolios.js';
import { loadProjects } from './projects.js';
import { message } from '../lib/i18n.js';

/**
 * Analytics.
 *
 * The overview is open to any signed-in caller. Trends are not: the snapshots
 * behind them see the whole organisation, so organisation-wide series need
 * `analytics:manage` and a personal series is its owner's (BRL-01). Capturing
 * a snapshot writes the historical record, and a bad or partial run is not
 * something an ordinary user should be able to cause.
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

  const facts = toPortfolioFacts(projects);

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
  // Health transitions are no longer noticed here: the health engine stores
  // each project's health and tells the owner the moment it is recalculated
  // into a different level, rather than once a day when this capture runs.
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
      throw EpmError.badRequest(message('{value} is not a scope type.', { value: query.scopeType }));
    }

    // The snapshots are captured with the service key, so they count every
    // project and every person whoever reads them later (BRL-01). Series about
    // the organisation are for those who manage analytics; a personal series
    // is for its owner. Everyone's own view of the organisation, limited to
    // their access, is the Insights dashboards (Module 12).
    const manager = await guard.holds(request, 'analytics:manage');
    if (scopeType === 'user') {
      if (!query.scopeId) throw EpmError.badRequest('A personal series needs scopeId.');
      if (!manager && query.scopeId !== request.auth?.userId) {
        throw EpmError.forbidden("You can read your own trends, not another person's.");
      }
    } else if (!manager) {
      throw EpmError.forbidden(
        'Organisation-wide trends are for people who manage analytics. Your own view of the organisation is under Insights.',
      );
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
