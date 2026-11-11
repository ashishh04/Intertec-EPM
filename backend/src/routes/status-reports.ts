import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { withAudit } from '../domain/audit.js';
import { namesFor } from '../domain/collaboration.js';
import { getPortfolio, toPortfolioFacts } from '../domain/portfolios.js';
import { prisma } from '../db/prisma.js';
import { calendarDay } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { paginated, resolvePage } from '../lib/pagination.js';
import type { StatusRating, StatusReport } from '../types/epm.js';
import { appLog } from '../lib/log.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import { invalidateProjects, loadProjectsFor } from './projects.js';

/**
 * Status reports: where a project or a portfolio stands, in its manager's own
 * words, report by report.
 *
 * Reading follows the thing reported on: a project's reports to whoever can
 * see the project, a portfolio's to whoever can see the portfolio. Writing a
 * project's needs the right to edit the project; a portfolio's needs
 * portfolio management or the manager's health permission. The author may
 * always change or remove their own.
 */

const RATINGS = ['on_track', 'at_risk', 'off_track'] as const;
const rating = z.enum(RATINGS);
const text = (max: number) => z.string().trim().max(max);

const writeBody = z.object({
  scopeKind: z.enum(['project', 'portfolio']),
  scopeId: z.string().min(1).max(64),
  reportDate: calendarDay(),
  overall: rating,
  schedule: rating.nullable().optional(),
  budget: rating.nullable().optional(),
  scope: rating.nullable().optional(),
  resources: rating.nullable().optional(),
  summary: text(20_000).min(1, 'A summary is required.'),
  achievements: text(20_000).nullable().optional(),
  nextSteps: text(20_000).nullable().optional(),
  issues: text(20_000).nullable().optional(),
});

const listQuery = z.object({
  scopeKind: z.enum(['project', 'portfolio']),
  scopeId: z.string().min(1).max(64),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

type Row = Awaited<ReturnType<typeof prisma.statusReport.findUniqueOrThrow>>;

/** Whether the caller may read reports on this project or portfolio; answered as not found when not. */
async function requireRead(request: FastifyRequest, scopeKind: string, scopeId: string): Promise<string> {
  const projects = await loadProjectsFor(request);
  if (scopeKind === 'project') {
    const project = projects.find((candidate) => candidate.id === scopeId);
    if (!project) throw EpmError.notFound('That project');
    return project.name;
  }
  const portfolio = await getPortfolio(scopeId, toPortfolioFacts(projects)).catch(() => null);
  const manager = await guard.holds(request, 'portfolios:manage');
  if (!portfolio || (!manager && portfolio.projectCount === 0)) throw EpmError.notFound('That portfolio');
  return portfolio.name;
}

async function mayWrite(request: FastifyRequest, scopeKind: string, scopeId: string): Promise<boolean> {
  if (scopeKind === 'project') return guard.holds(request, 'project:edit', scopeId);
  return (await guard.holds(request, 'portfolios:manage')) || (await guard.holds(request, 'health:manage'));
}

async function requireWrite(request: FastifyRequest, scopeKind: string, scopeId: string): Promise<void> {
  if (await mayWrite(request, scopeKind, scopeId)) return;
  throw EpmError.forbidden(
    scopeKind === 'project'
      ? message('You may not write status reports for this project.')
      : message('You may not write status reports for this portfolio.'),
  );
}

function toReport(row: Row, names: Map<string, string>, canEdit: boolean, scopeName?: string): StatusReport {
  const optional = (value: string | null) => (value ? (value as StatusRating) : undefined);
  return {
    id: row.id,
    scopeKind: row.scopeKind as StatusReport['scopeKind'],
    scopeId: row.scopeId,
    ...(scopeName ? { scopeName } : {}),
    reportDate: row.reportDate.toISOString().slice(0, 10),
    overall: row.overall as StatusRating,
    ...(row.schedule ? { schedule: optional(row.schedule) } : {}),
    ...(row.budget ? { budget: optional(row.budget) } : {}),
    ...(row.scope ? { scope: optional(row.scope) } : {}),
    ...(row.resources ? { resources: optional(row.resources) } : {}),
    summary: row.summary,
    ...(row.achievements ? { achievements: row.achievements } : {}),
    ...(row.nextSteps ? { nextSteps: row.nextSteps } : {}),
    ...(row.issues ? { issues: row.issues } : {}),
    createdBy: row.createdBy,
    ...(names.has(row.createdBy) ? { createdByName: names.get(row.createdBy)! } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canEdit,
  };
}

/** What the journal keeps of a report. */
const record = (row: Row) => ({
  reportDate: row.reportDate.toISOString().slice(0, 10),
  overall: row.overall,
  schedule: row.schedule,
  budget: row.budget,
  scope: row.scope,
  resources: row.resources,
});

export const statusReportRoutes: FastifyPluginAsync = async (app) => {
  /** One project's or portfolio's reports, the latest first. */
  app.get('/status-reports', async (request) => {
    const query = listQuery.parse(request.query);
    const scopeName = await requireRead(request, query.scopeKind, query.scopeId);
    const page = resolvePage(query.page, query.pageSize);
    const where = { scopeKind: query.scopeKind, scopeId: query.scopeId };
    const [rows, total, writer] = await Promise.all([
      prisma.statusReport.findMany({
        where,
        orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.statusReport.count({ where }),
      mayWrite(request, query.scopeKind, query.scopeId),
    ]);
    const names = await namesFor(rows.map((row) => row.createdBy));
    const userId = request.auth?.userId;
    return paginated(
      rows.map((row) => toReport(row, names, writer || row.createdBy === userId, scopeName)),
      total,
      page,
    );
  });

  app.post<{ Body: unknown }>('/status-reports', async (request, reply) => {
    const input = writeBody.parse(request.body ?? {});
    const scopeName = await requireRead(request, input.scopeKind, input.scopeId);
    await requireWrite(request, input.scopeKind, input.scopeId);
    const userId = request.auth!.userId;
    const row = await withAudit(
      (tx) =>
        tx.statusReport.create({
          data: {
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            reportDate: new Date(`${input.reportDate}T00:00:00.000Z`),
            overall: input.overall,
            schedule: input.schedule ?? null,
            budget: input.budget ?? null,
            scope: input.scope ?? null,
            resources: input.resources ?? null,
            summary: input.summary,
            achievements: input.achievements || null,
            nextSteps: input.nextSteps || null,
            issues: input.issues || null,
            createdBy: userId,
          },
        }),
      (created) => ({
        entityType: 'status_report',
        entityId: created.id,
        projectId: input.scopeKind === 'project' ? input.scopeId : null,
        action: 'status_report.published',
        summary: message('Published a status report for {name}', { name: scopeName }),
        after: record(created),
      }),
    );
    // A project's own status in the delivery system follows its latest report,
    // so the two never disagree. Best effort: the report stands either way.
    if (input.scopeKind === 'project') {
      const latest = await prisma.statusReport.findFirst({
        where: { scopeKind: 'project', scopeId: input.scopeId },
        orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
        select: { id: true },
      });
      if (latest?.id === row.id) {
        await openProject
          .request(`/projects/${input.scopeId}`, {
            method: 'PATCH',
            body: {
              statusExplanation: { raw: input.summary },
              _links: { status: { href: `/api/v3/project_statuses/${input.overall}` } },
            },
            signal: requestSignal(request),
          })
          .then(() => invalidateProjects())
          .catch((error: unknown) => appLog.warn({ err: error, projectId: input.scopeId }, 'Project status not updated from its report'));
      }
    }

    const names = await namesFor([userId]);
    reply.code(201);
    return toReport(row, names, true, scopeName);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/status-reports/:id', async (request) => {
    const input = writeBody.omit({ scopeKind: true, scopeId: true }).partial().parse(request.body ?? {});
    if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');
    const existing = await prisma.statusReport.findUnique({ where: { id: request.params.id } });
    if (!existing) throw EpmError.notFound('That status report');
    const scopeName = await requireRead(request, existing.scopeKind, existing.scopeId);
    if (existing.createdBy !== request.auth?.userId) await requireWrite(request, existing.scopeKind, existing.scopeId);

    const row = await withAudit(
      (tx) =>
        tx.statusReport.update({
          where: { id: existing.id },
          data: {
            ...(input.reportDate === undefined ? {} : { reportDate: new Date(`${input.reportDate}T00:00:00.000Z`) }),
            ...(input.overall === undefined ? {} : { overall: input.overall }),
            ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
            ...(input.budget === undefined ? {} : { budget: input.budget }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.resources === undefined ? {} : { resources: input.resources }),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            ...(input.achievements === undefined ? {} : { achievements: input.achievements || null }),
            ...(input.nextSteps === undefined ? {} : { nextSteps: input.nextSteps || null }),
            ...(input.issues === undefined ? {} : { issues: input.issues || null }),
          },
        }),
      (updated) => ({
        entityType: 'status_report',
        entityId: updated.id,
        projectId: updated.scopeKind === 'project' ? updated.scopeId : null,
        action: 'status_report.changed',
        summary: message('Changed a status report for {name}', { name: scopeName }),
        before: record(existing),
        after: record(updated),
      }),
    );
    const names = await namesFor([row.createdBy]);
    return toReport(row, names, true, scopeName);
  });

  app.delete<{ Params: { id: string } }>('/status-reports/:id', async (request, reply) => {
    const existing = await prisma.statusReport.findUnique({ where: { id: request.params.id } });
    if (!existing) throw EpmError.notFound('That status report');
    const scopeName = await requireRead(request, existing.scopeKind, existing.scopeId);
    if (existing.createdBy !== request.auth?.userId) await requireWrite(request, existing.scopeKind, existing.scopeId);
    await withAudit((tx) => tx.statusReport.delete({ where: { id: existing.id } }), {
      entityType: 'status_report',
      entityId: existing.id,
      projectId: existing.scopeKind === 'project' ? existing.scopeId : null,
      action: 'status_report.deleted',
      summary: message('Deleted a status report for {name}', { name: scopeName }),
      before: record(existing),
    });
    reply.code(204);
  });
};
