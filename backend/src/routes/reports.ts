import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { addDays, daysBetween, isCalendarDay, today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { healthViews, unassessedView } from '../domain/health.js';
import { modelFacts } from '../domain/measure-facts.js';
import {
  bucketsOf,
  contextFor,
  evaluateInContext,
  prepare,
  type MeasureContext,
  type Period,
  type Scope,
} from '../domain/measures.js';
import { viewerOf } from './measures.js';
import type {
  DeliveryTrendPoint,
  ExecutiveInsights,
  MetricTrend,
  PortfolioRow,
  StatusDistribution,
  TaskStatusCategory,
  TimeEntrySummary,
} from '../types/epm.js';

/**
 * Reports, computed by the semantic layer (BR-404) from the analytics model.
 *
 * Every figure here is a measure, or a breakdown of the same facts the
 * measures read, so the reports page, the executive view, the dashboards and a
 * scheduled report can never disagree about the same thing. The filters the
 * page offers are applied here: the period to everything that happens in time,
 * and the project, portfolio or team to everything — a team narrows to the
 * work assigned to its people and the time they logged.
 */

const day = z.string().refine(isCalendarDay, { message: 'Give a date that exists, e.g. 2026-10-31.' });

const filtersQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  projectId: z.string().regex(/^\d+$/).optional(),
  portfolioId: z.string().optional(),
  teamId: z.string().optional(),
  status: z.string().optional(),
});

type Filters = z.infer<typeof filtersQuery>;

const STATUS_LABEL: Record<TaskStatusCategory, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
};

/** The period asked for, or `days` back from today. */
function periodOf(filters: Filters, days: number): Period {
  const to = filters.to ?? todayIso();
  const from = filters.from ?? addDays(to, -(days - 1));
  if (from > to) throw EpmError.badRequest('from must not be after to.');
  if (daysBetween(from, to) > 731) throw EpmError.badRequest('A period can be at most two years long.');
  return { from, to };
}

/**
 * The filters as a scope: a project, else a portfolio, else the instance — and
 * a team narrows whichever of those to its people's work.
 */
async function contextOf(request: FastifyRequest, filters: Filters, period: Period): Promise<MeasureContext> {
  const viewer = await viewerOf(request);
  const shared = await prepare(viewer);
  const facts = await modelFacts();

  if (filters.projectId && !viewer.visibleProjectIds.has(Number(filters.projectId))) {
    throw EpmError.notFound('That project');
  }
  if (filters.portfolioId && !facts.portfolios.has(filters.portfolioId)) throw EpmError.notFound('That portfolio');
  if (filters.teamId && !facts.teams.has(filters.teamId)) throw EpmError.notFound('That team');

  const place: Scope = filters.projectId
    ? { kind: 'project', id: filters.projectId }
    : filters.portfolioId
      ? { kind: 'portfolio', id: filters.portfolioId }
      : { kind: 'instance' };

  if (!filters.teamId) return contextFor(shared, place, period, todayIso());

  // A team inside a place: the team's people, their work in that place.
  const within = new Set(contextFor(shared, place, period, todayIso()).projects.map((project) => project.id));
  return contextFor(shared, { kind: 'team', id: filters.teamId }, period, todayIso(), within);
}

/** The projects a report is about: those in scope, or — for a team — those its people have work in. */
function reportProjects(context: MeasureContext) {
  if (context.projects.length > 0) return context.projects.filter((project) => project.active);
  const ids = new Set(context.work.map((item) => item.projectId));
  return [...context.facts.projects.values()].filter((project) => project.active && ids.has(project.id));
}

function trendOf(current: number | null, previous: number | null, periodLabel: string): MetricTrend {
  if (current === null || previous === null || previous === 0) {
    return { changePct: 0, direction: 'flat', positiveIsUp: true, periodLabel };
  }
  const changePct = Math.round(((current - previous) / previous) * 100);
  return {
    changePct: Math.abs(changePct),
    direction: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat',
    positiveIsUp: true,
    periodLabel,
  };
}

export const reportRoutes: FastifyPluginAsync = async (app) => {
  /** Work in scope by EPM status category, now. */
  app.get('/reports/status-distribution', async (request) => {
    const filters = filtersQuery.parse(request.query);
    const context = await contextOf(request, filters, periodOf(filters, 90));
    const totals = new Map<TaskStatusCategory, number>();
    for (const item of context.work) {
      const category = item.statusCategory as TaskStatusCategory;
      totals.set(category, (totals.get(category) ?? 0) + 1);
    }
    return (Object.keys(STATUS_LABEL) as TaskStatusCategory[])
      .map((status): StatusDistribution => ({ status, label: STATUS_LABEL[status], count: totals.get(status) ?? 0 }))
      .filter((row) => row.count > 0);
  });

  /**
   * Created, delivered and story points delivered, per month of the period —
   * delivered on the day work was closed, not the day it was last edited.
   */
  app.get('/reports/delivery-trends', async (request) => {
    const filters = filtersQuery.parse(request.query);
    const context = await contextOf(request, filters, periodOf(filters, 365));
    const measures = ['work.created', 'work.completed', 'work.pointsDelivered'] as const;

    const points: DeliveryTrendPoint[] = [];
    for (const slice of bucketsOf(context.period, 'month')) {
      const values = await evaluateInContext([...measures], { ...context, period: slice });
      points.push({
        period: slice.from.slice(0, 7),
        created: values['work.created']?.value ?? 0,
        completed: values['work.completed']?.value ?? 0,
        velocity: values['work.pointsDelivered']?.value ?? 0,
      });
    }
    return points;
  });

  /** Hours logged in the period, per person, with what no cost figure includes. */
  app.get('/reports/time-summary', async (request) => {
    const filters = filtersQuery.parse(request.query);
    const context = await contextOf(request, filters, periodOf(filters, 90));
    const { period } = context;

    const byUser = new Map<number, { hours: number; uncosted: number; projects: Map<number, number> }>();
    for (const entry of context.time) {
      if (entry.userId === null || entry.spentOn < period.from || entry.spentOn > period.to) continue;
      const record = byUser.get(entry.userId) ?? { hours: 0, uncosted: 0, projects: new Map<number, number>() };
      record.hours += entry.hours;
      if (entry.cost === null) record.uncosted += entry.hours;
      if (entry.projectId !== null) record.projects.set(entry.projectId, (record.projects.get(entry.projectId) ?? 0) + entry.hours);
      byUser.set(entry.userId, record);
    }

    const round = (value: number) => Math.round(value * 100) / 100;
    return [...byUser.entries()].map(([userId, record]): TimeEntrySummary => ({
      userId: String(userId),
      hoursLogged: round(record.hours),
      hoursUncosted: round(record.uncosted),
      projectBreakdown: [...record.projects.entries()].map(([projectId, hours]) => ({
        projectId: String(projectId),
        hours: round(hours),
      })),
    }));
  });

  /** The executive view: headline measures for the scope and period, and each project's health. */
  app.get('/reports/executive-insights', async (request): Promise<ExecutiveInsights> => {
    const filters = filtersQuery.parse(request.query);
    const period = periodOf(filters, 90);
    const context = await contextOf(request, filters, period);

    const ids = [
      'health.greenPct',
      'milestones.onTime',
      'risk.open',
      'work.overdue',
      'utilisation',
      'sprint.velocity',
      'work.completed',
      'work.throughput',
    ];
    // People scopes carry no projects of their own; their project figures
    // are read across the projects their people work in.
    const projects = reportProjects(context);
    const measured = context.projects.length > 0 ? context : { ...context, projects };
    const measures = await evaluateInContext(ids, measured);

    // Velocity against the period of the same length just before.
    const span = daysBetween(period.from, period.to);
    const previous = { from: addDays(period.from, -span), to: addDays(period.from, -1) };
    const before = await evaluateInContext(['sprint.velocity'], { ...measured, period: previous });

    const health = await healthViews(projects);
    const matrix: PortfolioRow[] = projects
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => {
        const id = String(project.id);
        const view = health.get(id) ?? unassessedView('Health has not been calculated yet.');
        return {
          projectId: id,
          projectName: project.name,
          identifier: project.identifier ?? '',
          schedule: view.effective.schedule,
          budget: view.effective.budget,
          risks: view.effective.risks,
          overdue: view.effective.overdue,
          overall: view.effective.overall,
          calculatedOverall: view.calculated.overall,
          override: view.override
            ? { reason: view.override.reason, setBy: view.override.setBy, setAt: view.override.setAt }
            : undefined,
        };
      });

    const value = (id: string) => measures[id]?.value ?? null;
    return {
      portfolioHealth: value('health.greenPct'),
      onTimeDelivery: value('milestones.onTime'),
      openRisks: value('risk.open'),
      overdueTasks: value('work.overdue') ?? 0,
      teamUtilization: value('utilisation'),
      sprintVelocity: value('sprint.velocity'),
      velocityTrend: trendOf(value('sprint.velocity'), before['sprint.velocity']?.value ?? null, 'vs the period before'),
      matrix,
      asOf: context.facts.asOf,
      measures,
    };
  });
};
