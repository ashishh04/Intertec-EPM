import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { buildDashboard, DASHBOARD_IDS, type DashboardId } from '../domain/dashboards.js';
import { modelFacts } from '../domain/measure-facts.js';
import { documentOf, renderPdf, renderXlsx } from '../domain/report-render.js';
import {
  approveExternal,
  createSchedule,
  deleteSchedule,
  getArtifact,
  getRun,
  getSchedule,
  listRuns,
  listSchedules,
  runSchedule,
  sourceOptions,
  updateSchedule,
} from '../domain/scheduled-reports.js';
import { narrowedViewer, periodOf, scopeOf, scopeQuery, viewerOf } from './measures.js';

/**
 * Scheduled reports (BRQ-08) and downloading a dashboard.
 *
 * Defining, running and reading the log of scheduled reports needs
 * `reports:schedule`; approving their external recipients needs
 * `reports:approve`, from someone other than whoever added them. Downloading
 * the dashboard on the screen as a PDF or a workbook needs only a session: it
 * is the same figures, for the same person.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function checkRecipients(raw: unknown): Promise<void> {
  const ids = (raw as { recipientUserIds?: unknown })?.recipientUserIds;
  if (!Array.isArray(ids)) return;
  const facts = await modelFacts();
  const unknown = ids.map(String).filter((id) => !facts.people.has(Number(id)));
  if (unknown.length > 0) throw EpmError.badRequest(`Not people EPM knows: ${unknown.join(', ')}.`);
}

export const scheduledReportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/reports/schedules', async (request) => {
    await guard.require(request, 'reports:schedule');
    return listSchedules();
  });

  /** The dashboards, and the saved views the caller can see, to build a schedule from. */
  app.get('/reports/schedules/options', async (request) => {
    await guard.require(request, 'reports:schedule');
    return sourceOptions();
  });

  app.get<{ Params: { id: string } }>('/reports/schedules/:id', async (request) => {
    await guard.require(request, 'reports:schedule');
    return getSchedule(request.params.id);
  });

  app.post('/reports/schedules', async (request, reply) => {
    await guard.require(request, 'reports:schedule');
    await checkRecipients(request.body);
    reply.code(201);
    return createSchedule(request.body, request.auth!.userId);
  });

  app.patch<{ Params: { id: string } }>('/reports/schedules/:id', async (request) => {
    await guard.require(request, 'reports:schedule');
    await checkRecipients(request.body);
    return updateSchedule(request.params.id, request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/reports/schedules/:id', async (request) => {
    await guard.require(request, 'reports:schedule');
    return { outcome: await deleteSchedule(request.params.id, request.auth!.userId) };
  });

  app.post<{ Params: { id: string } }>('/reports/schedules/:id/approve', async (request) => {
    await guard.require(request, 'reports:approve');
    return approveExternal(request.params.id, request.auth!.userId);
  });

  /** Runs a schedule now, outside its timetable. */
  app.post<{ Params: { id: string } }>('/reports/schedules/:id/run', async (request) => {
    await guard.require(request, 'reports:schedule');
    const outcome = await runSchedule(request.params.id, { trigger: 'manual', triggeredBy: request.auth!.userId });
    if (!outcome) throw EpmError.conflict('That report is running already.');
    return getRun(outcome.runId);
  });

  /** The log: runs by schedule and by date (BR-210). */
  app.get('/reports/runs', async (request) => {
    await guard.require(request, 'reports:schedule');
    const query = z
      .object({
        scheduleId: z.string().optional(),
        from: z.string().regex(DAY).optional(),
        to: z.string().regex(DAY).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(15),
      })
      .parse(request.query);
    return listRuns(query);
  });

  app.get<{ Params: { id: string } }>('/reports/runs/:id', async (request) => {
    await guard.require(request, 'reports:schedule');
    return getRun(request.params.id);
  });

  app.get<{ Params: { id: string; artifactId: string } }>('/reports/runs/:id/files/:artifactId', async (request, reply) => {
    await guard.require(request, 'reports:schedule');
    const file = await getArtifact(request.params.id, request.params.artifactId);
    reply
      .header('Content-Type', file.contentType)
      .header('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(file.content));
  });

  /** The dashboard on the screen, as a file: the same figures, for the same person. */
  app.get<{ Params: { id: string } }>('/dashboards/:id/export', async (request, reply) => {
    const query = scopeQuery.extend({ format: z.enum(['pdf', 'xlsx']).default('pdf') }).parse(request.query);
    if (!DASHBOARD_IDS.includes(request.params.id as DashboardId)) throw EpmError.notFound('That dashboard');
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    const period = periodOf(query);
    const dashboard = await buildDashboard(request.params.id as DashboardId, scope, period, await narrowedViewer(viewer, query.within), todayIso());
    const facts = await modelFacts();
    const name = facts.users.get(Number(request.auth!.userId))?.name ?? 'you';
    const content = {
      title: `${dashboard.title} — ${dashboard.scope.name}`,
      subtitle: `${period.from} to ${period.to}${dashboard.asOf ? ` · data as of ${dashboard.asOf.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
      preparedFor: `Prepared for ${name}, with their access`,
      generatedAt: new Date(),
      document: documentOf(dashboard),
    };
    const bytes = query.format === 'pdf' ? renderPdf(content) : renderXlsx(content);
    const filename = `${dashboard.id}-${dashboard.scope.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${period.to}.${query.format}`;
    reply
      .header('Content-Type', query.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(bytes));
  });
};
