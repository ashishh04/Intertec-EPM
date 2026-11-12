import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { ganttRange, renderGanttPdf } from '../domain/gantt-pdf.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { contextConventions, contextLanguage } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import { openProject } from '../openproject/client.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A project's Gantt chart as a PDF, in the reader's language, of the work they can see. */
export const ganttPdfRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/projects/:id/gantt.pdf', async (request, reply) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.params);
    const range = z.object({ from: day.optional(), to: day.optional() }).parse(request.query);
    await guard.require(request, 'task:view', id);
    const signal = requestSignal(request);

    const [project, work, catalog, identifiers] = await Promise.all([
      openProject.request<{ name: string; identifier: string }>(`/projects/${id}`, { signal }).catch((error) => {
        if (error instanceof OpenProjectError && (error.upstreamStatus === 404 || error.upstreamStatus === 403)) throw EpmError.notFound('That project');
        throw error;
      }),
      openProject.getAll<WorkPackageWithPoints>(
        '/work_packages',
        { filters: [{ field: 'project', operator: '=', values: [id] }, { field: 'status', operator: '*', values: [] }], sortBy: [['id', 'asc']], pageSize: 200 },
        { signal, maxPages: 10 },
      ),
      getCatalog(signal),
      projectIdentifiers(signal),
    ]);
    const tasks = work.items.map((item) => toEpmTask(item, catalog, identifiers));
    const today = new Date().toISOString().slice(0, 10);
    const fitted = ganttRange(tasks, today);
    const from = range.from ?? fitted.from;
    const to = range.to ?? fitted.to;
    if (to < from) throw EpmError.badRequest('The end of the range cannot be before its start.');

    const pdf = renderGanttPdf({
      projectName: project.name,
      tasks,
      from,
      to,
      today,
      generatedAt: new Date(),
      language: contextLanguage(),
      conventions: contextConventions(),
    });
    const filename = `${project.identifier || 'project'}-gantt-${today}.pdf`.replace(/[^\w.-]+/g, '-');
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(pdf));
  });
};
