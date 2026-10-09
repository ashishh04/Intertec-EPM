import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { addDays, daysBetween, today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { costEntries } from '../domain/cost-entries.js';
import { buildDashboard, DASHBOARD_IDS, DASHBOARDS, type DashboardId } from '../domain/dashboards.js';
import { modelFacts } from '../domain/measure-facts.js';
import {
  catalogue,
  evaluateMeasures,
  measureById,
  measureMembers,
  measureTrend,
  type Period,
  type Scope,
  type Viewer,
} from '../domain/measures.js';

/**
 * The semantic layer and the dashboards built on it (BR-404, BR-405).
 *
 * Open to any signed-in person, and always scoped to them: a measure counts
 * only the projects in which they may read work packages, so what one person
 * sees of a portfolio is never more than their own access allows. Asking for a
 * project they cannot see is answered as if it did not exist.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const scopeQuery = z.object({
  scope: z
    .string()
    .regex(/^(instance|portfolio:[\w-]+|project:\d+|department:[\w-]+|team:[\w-]+|person:\d+)$/, 'scope is not one EPM knows.')
    .optional(),
  from: z.string().regex(DAY, 'from must be a date, e.g. 2026-10-01.').optional(),
  to: z.string().regex(DAY, 'to must be a date, e.g. 2026-10-31.').optional(),
  /** Narrows the scope to a project or a portfolio as well: a team's work in one project. */
  within: z.string().regex(/^(portfolio:[\w-]+|project:\d+)$/, 'within is a project or a portfolio.').optional(),
});

/** The viewer, narrowed to the projects `within` names, if it names any. */
export async function narrowedViewer(viewer: Viewer, within: string | undefined): Promise<Viewer> {
  if (!within) return viewer;
  const [kind, id] = within.split(':') as ['portfolio' | 'project', string];
  const facts = await modelFacts();
  if (kind === 'project' && !viewer.visibleProjectIds.has(Number(id))) throw EpmError.notFound('That project');
  if (kind === 'portfolio' && !facts.portfolios.has(id)) throw EpmError.notFound('That portfolio');
  const ids = [...facts.projects.values()]
    .filter((project) => (kind === 'project' ? String(project.id) === id : project.portfolioId === id))
    .map((project) => project.id)
    .filter((projectId) => viewer.visibleProjectIds.has(projectId));
  return { visibleProjectIds: new Set(ids) };
}

/** The projects in which this person may read work packages. */
export async function viewerOf(request: FastifyRequest): Promise<Viewer> {
  const permissions = await guard.permissionsFor(request);
  const visibleProjectIds = new Set<number>();
  for (const [projectId, set] of permissions.byProject) {
    if (set['project:view']) visibleProjectIds.add(Number(projectId));
  }
  return { visibleProjectIds };
}

/** Twelve weeks to today unless asked otherwise; at most two years. */
export function periodOf(query: { from?: string; to?: string }, today = todayIso()): Period {
  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -83);
  if (from > to) throw EpmError.badRequest('from must not be after to.');
  if (daysBetween(from, to) > 731) throw EpmError.badRequest('A period can be at most two years long.');
  return { from, to };
}

/**
 * The scope asked for, checked against what exists and what the viewer can
 * see. A project out of their sight is a 404, exactly like one that does not
 * exist.
 */
export async function scopeOf(raw: string | undefined, viewer: Viewer): Promise<Scope> {
  if (!raw || raw === 'instance') return { kind: 'instance' };
  const [kind, id] = raw.split(':') as [Scope['kind'], string];
  const facts = await modelFacts();
  const known =
    kind === 'portfolio'
      ? facts.portfolios.has(id)
      : kind === 'project'
        ? facts.projects.has(Number(id)) && viewer.visibleProjectIds.has(Number(id))
        : kind === 'department'
          ? facts.departments.has(id)
          : kind === 'team'
            ? facts.teams.has(id)
            : facts.people.has(Number(id));
  if (!known) throw EpmError.notFound(kind === 'person' ? 'That person' : `That ${kind}`);
  return { kind, id };
}

export const measureRoutes: FastifyPluginAsync = async (app) => {
  /** The catalogue: every measure, its unit, and exactly what it counts. */
  app.get('/measures', async () => catalogue());

  app.get('/measures/values', async (request) => {
    const query = scopeQuery.extend({ ids: z.string().min(1, 'Name the measures: ids=a,b.') }).parse(request.query);
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    const ids = query.ids.split(',').map((id) => id.trim()).filter(Boolean);
    const unknown = ids.filter((id) => !measureById(id));
    if (unknown.length > 0) throw EpmError.badRequest(`Unknown measures: ${unknown.join(', ')}.`);
    return evaluateMeasures(ids, scope, periodOf(query), await narrowedViewer(viewer, query.within), todayIso());
  });

  /** Drill-through: the work packages, projects or people behind a measure's value. */
  app.get<{ Params: { id: string } }>('/measures/:id/members', async (request) => {
    const query = scopeQuery.parse(request.query);
    const measure = measureById(request.params.id);
    if (!measure) throw EpmError.notFound('That measure');
    if (!measure.memberKind) throw EpmError.badRequest(`${measure.label} is a figure, not a list of things to open.`);
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    return measureMembers(measure.id, scope, periodOf(query), await narrowedViewer(viewer, query.within), todayIso());
  });

  /**
   * The priced time entries behind a cost figure, for one project (BR-202):
   * the end of the drill from a portfolio's budget variance through its
   * projects. Read with the caller's session, so OpenProject decides which
   * entries they may see.
   */
  app.get<{ Params: { id: string } }>('/measures/:id/entries', async (request) => {
    const query = scopeQuery
      .extend({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);
    const measure = measureById(request.params.id);
    if (!measure) throw EpmError.notFound('That measure');
    if (!measure.entries) throw EpmError.badRequest(`${measure.label} is not made of logged time.`);
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    if (scope.kind !== 'project') throw EpmError.badRequest('Time entries are listed for one project: scope=project:<id>.');
    return costEntries(measure.id, scope.id!, periodOf(query), viewer, todayIso(), query.page, query.pageSize);
  });

  app.get<{ Params: { id: string } }>('/measures/:id/trend', async (request) => {
    const query = scopeQuery.extend({ bucket: z.enum(['week', 'month']).default('week') }).parse(request.query);
    const measure = measureById(request.params.id);
    if (!measure) throw EpmError.notFound('That measure');
    if (!measure.trend) throw EpmError.badRequest(`${measure.label} has no series over time.`);
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    return measureTrend(measure.id, scope, periodOf(query), query.bucket, await narrowedViewer(viewer, query.within), todayIso());
  });

  app.get('/dashboards', async () => DASHBOARDS);

  /** One dashboard, timed against the response target; the time is in Server-Timing too. */
  app.get<{ Params: { id: string } }>('/dashboards/:id', async (request, reply) => {
    const query = scopeQuery.parse(request.query);
    if (!DASHBOARD_IDS.includes(request.params.id as DashboardId)) throw EpmError.notFound('That dashboard');
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    const dashboard = await buildDashboard(
      request.params.id as DashboardId,
      scope,
      periodOf(query),
      await narrowedViewer(viewer, query.within),
      todayIso(),
    );
    reply.header('Server-Timing', `dashboard;dur=${dashboard.timing.serverMs}`);
    return dashboard;
  });
};
