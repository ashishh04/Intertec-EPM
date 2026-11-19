import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { currentAuth } from '../auth/context.js';
import * as guard from '../auth/guard.js';
import { asCsv, asWorkbook, exportRows, readProjectWork } from '../domain/task-export.js';
import {
  assertMppWritable,
  isMsProjectXml,
  MS_PROJECT_FILE,
  msProjectFileToXml,
  msProjectMpp,
  msProjectXml,
  mppWriting,
  recordsFromMsProject,
} from '../domain/ms-project.js';
import { env } from '../config/env.js';
import { message } from '../lib/i18n.js';
import type { CsvRecord } from '../lib/csv-parse.js';
import type { TaskExportFormats } from '../types/epm.js';
import { cancelImport, checkImport, getImport, importView, listImports, startImport, templateFor } from '../domain/task-import.js';
import { openProject } from '../openproject/client.js';
import { decodeText, parseCsv } from '../lib/csv-parse.js';
import { EpmError } from '../lib/errors.js';
import { contentDispositionFor } from '../lib/uploads.js';
import { isCompoundFile, readXls } from '../lib/xls-read.js';
import { isZip, readXlsx } from '../lib/xlsx-read.js';

/**
 * Importing tasks from a CSV or Excel file (.xlsx, or .xls as OpenProject exports it), or a Microsoft Project plan (.mpp, .mpt, .mpx or its XML) — epics, tasks, subtasks, milestones,
 * dates, assignees, dependencies): rows are created, or update the work
 * packages their IDs name. Needs `task:create` in the project, and `task:edit`
 * for a file that changes existing work; every row is written under the
 * importer's own account.
 */

const FILE_LIMIT = 25 * 1024 * 1024;

async function projectOf(request: FastifyRequest, raw: string): Promise<number> {
  const projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) throw EpmError.notFound('That project');
  await guard.require(request, 'task:create', String(projectId));
  return projectId;
}

async function importOf(request: FastifyRequest, id: string) {
  const row = await getImport(id);
  await guard.require(request, 'task:create', String(row.projectId));
  return row;
}

/**
 * A Microsoft Project plan as the import's rows, its milestones and summary
 * tasks given the project's own types for them (a milestone type, and Phase
 * where the project has it).
 */
async function msProjectRecords(projectId: number, xml: string): Promise<CsvRecord[]> {
  const types = await openProject
    .getAll<{ name: string; isMilestone?: boolean }>(`/projects/${projectId}/types`, { pageSize: 200 })
    .catch(() => ({ items: [] as { name: string; isMilestone?: boolean }[] }));
  const plan = recordsFromMsProject(xml, {
    milestone: types.items.find((type) => type.isMilestone)?.name,
    summary: types.items.find((type) => /^(phase|summary task|summary)$/i.test(type.name))?.name,
  });
  if (plan.tasks === 0) throw EpmError.validation(message('The plan has no tasks to import.'));
  return plan.records;
}

/** The days OpenProject works, and those it does not, for a plan's calendar. */
async function workingCalendar() {
  const year = new Date().getUTCFullYear();
  const [week, holidays] = await Promise.all([
    openProject.getAll<{ day: number; working: boolean }>('/days/week').catch(() => null),
    openProject
      .getAll<{ date: string; name?: string }>('/days/non_working', {
        filters: [{ field: 'date', operator: '<>d', values: [`${year - 3}-01-01`, `${year + 3}-12-31`] }],
        pageSize: 1000,
      })
      .catch(() => null),
  ]);
  const working = week ? new Set(week.items.filter((day) => day.working).map((day) => day.day)) : new Set([1, 2, 3, 4, 5]);
  return { workingDays: working.size > 0 ? working : new Set([1, 2, 3, 4, 5]), holidays: holidays?.items ?? [] };
}

export const taskImportRoutes: FastifyPluginAsync = async (app) => {
  /** The import template for the project, as a workbook: a sheet to fill in, an example, and what each column takes. */
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/task-imports/template', async (request, reply) => {
    const projectId = await projectOf(request, request.params.projectId);
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', contentDispositionFor('epm-task-import-template.xlsx'))
      .header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(await templateFor(projectId)));
  });

  /**
   * The formats a project's tasks can be exported in beyond CSV, Excel and
   * Microsoft Project XML: .mpp only where its writer and licence are installed,
   * and if not, why not, so the export dialog says so before anyone chooses it.
   */
  app.get('/task-exports/formats', async (): Promise<TaskExportFormats> => {
    const mpp = await mppWriting();
    return { mpp: mpp.available, ...(mpp.reason ? { mppUnavailable: mpp.reason } : {}) };
  });

  /**
   * The project's work packages in the import's columns, as CSV or Excel:
   * exported, edited and imported again, hierarchy and dependencies intact.
   * Or, with `format=msproject`, as a Microsoft Project XML plan
   * (domain/ms-project.ts), which Microsoft Project opens and saves as .mpp;
   * with `format=mpp`, as the .mpp itself, where this server can write one.
   * Read with the caller's access; needs only `task:view`.
   */
  app.get<{ Params: { projectId: string }; Querystring: { format?: string; closed?: string } }>('/projects/:projectId/task-exports', async (request, reply) => {
    const projectId = Number(request.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) throw EpmError.notFound('That project');
    await guard.require(request, 'task:view', String(projectId));
    const project = await openProject.request<{ name: string; identifier?: string }>(`/projects/${projectId}`);
    const stem = `${(project.identifier ?? `project-${projectId}`).replace(/[^\w-]+/g, '-')}-tasks-${new Date().toISOString().slice(0, 10)}`;
    reply.header('Cache-Control', 'private, no-store');
    if (request.query.format === 'msproject' || request.query.format === 'mpp') {
      const mpp = request.query.format === 'mpp';
      // Refused before the project is read when this server writes no .mpp.
      if (mpp) await assertMppWritable();
      const [work, calendar] = await Promise.all([readProjectWork(projectId, request.query.closed !== 'false'), workingCalendar()]);
      const xml = msProjectXml({ projectName: project.name, fileName: `${stem}.${mpp ? 'mpp' : 'xml'}`, work, ...calendar, appBaseUrl: env.APP_BASE_URL });
      if (mpp) {
        const file = await msProjectMpp(xml);
        reply.header('Content-Type', 'application/vnd.ms-project').header('Content-Disposition', contentDispositionFor(`${stem}.mpp`));
        return reply.send(file);
      }
      reply.header('Content-Type', 'application/xml; charset=utf-8').header('Content-Disposition', contentDispositionFor(`${stem}.xml`));
      return reply.send(xml);
    }
    const data = await exportRows(projectId, request.query.closed !== 'false');
    if (request.query.format === 'xlsx') {
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', contentDispositionFor(`${stem}.xlsx`));
      return reply.send(Buffer.from(asWorkbook(data, project.name)));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', contentDispositionFor(`${stem}.csv`));
    return reply.send(asCsv(data));
  });

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/task-imports', async (request) =>
    listImports(await projectOf(request, request.params.projectId)),
  );

  /**
   * Uploads a CSV or .xlsx and checks every row; nothing is changed yet.
   * `withoutPeople=true` checks it to leave out the people the project cannot
   * give its tasks to, rather than stopping at them.
   */
  app.post<{ Params: { projectId: string }; Querystring: { withoutPeople?: string } }>('/projects/:projectId/task-imports', async (request, reply) => {
    const projectId = await projectOf(request, request.params.projectId);
    const uploaded = await request.file({ limits: { fileSize: FILE_LIMIT, files: 1 } }).catch(() => {
      throw EpmError.badRequest('Send the file as multipart/form-data.');
    });
    if (!uploaded) throw EpmError.badRequest('No file was uploaded.');
    const content = await uploaded.toBuffer();
    if (uploaded.file.truncated) throw EpmError.validation('The file is larger than 25 MB.');
    let records;
    const filename = uploaded.filename || '';
    if (MS_PROJECT_FILE.test(filename)) {
      // Microsoft Project's own file, read through MPXJ.
      records = await msProjectRecords(projectId, await msProjectFileToXml(content, filename));
    } else if (isMsProjectXml(content)) {
      records = await msProjectRecords(projectId, decodeText(content));
    } else if (isCompoundFile(content)) {
      // An older Excel file (.xls): what OpenProject's own XLS export writes.
      try {
        records = readXls(content);
      } catch {
        // Or a Microsoft Project file with another name: the same kind of container.
        const plan = env.EPM_MPXJ_HOME ? await msProjectFileToXml(content, 'plan.mpp').catch(() => null) : null;
        if (!plan) throw EpmError.validation('This older Excel file (.xls) could not be read. Save it as .xlsx or CSV and upload it again.');
        records = await msProjectRecords(projectId, plan);
      }
    } else if (isZip(content)) {
      try {
        records = readXlsx(content);
      } catch {
        throw EpmError.validation('The Excel file could not be read. Save it again as .xlsx or CSV and upload it again.');
      }
    } else {
      records = parseCsv(decodeText(content));
    }
    const mayEdit = await guard.holds(request, 'task:edit', String(projectId));
    reply.code(201);
    return checkImport(projectId, uploaded.filename || 'tasks.csv', records, request.auth!.userId, mayEdit, {
      withoutPeople: ['true', '1'].includes(request.query.withoutPeople ?? ''),
    });
  });

  app.get<{ Params: { id: string } }>('/task-imports/:id', async (request) => importView(await importOf(request, request.params.id)));

  /** Starts a checked import, or resumes one that stopped, in the background. */
  app.post<{ Params: { id: string } }>('/task-imports/:id/run', async (request, reply) => {
    await importOf(request, request.params.id);
    const auth = currentAuth();
    if (!auth) throw EpmError.unauthorized('Sign in to import.');
    reply.code(202);
    return startImport(request.params.id, auth);
  });

  app.post<{ Params: { id: string } }>('/task-imports/:id/cancel', async (request) => {
    await importOf(request, request.params.id);
    return cancelImport(request.params.id);
  });
};
