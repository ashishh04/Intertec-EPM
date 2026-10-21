import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { currentAuth } from '../auth/context.js';
import * as guard from '../auth/guard.js';
import { asCsv, asWorkbook, exportRows } from '../domain/task-export.js';
import { cancelImport, checkImport, getImport, importView, listImports, startImport, templateFor } from '../domain/task-import.js';
import { openProject } from '../openproject/client.js';
import { parseCsv } from '../lib/csv-parse.js';
import { EpmError } from '../lib/errors.js';
import { contentDispositionFor } from '../lib/uploads.js';
import { isCompoundFile, readXls } from '../lib/xls-read.js';
import { isZip, readXlsx } from '../lib/xlsx-read.js';

/**
 * Importing tasks from a CSV or Excel file (.xlsx, or .xls as OpenProject exports it) — epics, tasks, subtasks, milestones,
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
   * The project's work packages in the import's columns, as CSV or Excel:
   * exported, edited and imported again, hierarchy and dependencies intact.
   * Read with the caller's access; needs only `task:view`.
   */
  app.get<{ Params: { projectId: string }; Querystring: { format?: string; closed?: string } }>('/projects/:projectId/task-exports', async (request, reply) => {
    const projectId = Number(request.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) throw EpmError.notFound('That project');
    await guard.require(request, 'task:view', String(projectId));
    const data = await exportRows(projectId, request.query.closed !== 'false');
    const project = await openProject.request<{ name: string; identifier?: string }>(`/projects/${projectId}`);
    const stem = `${(project.identifier ?? `project-${projectId}`).replace(/[^\w-]+/g, '-')}-tasks-${new Date().toISOString().slice(0, 10)}`;
    reply.header('Cache-Control', 'private, no-store');
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

  /** Uploads a CSV or .xlsx and checks every row; nothing is changed yet. */
  app.post<{ Params: { projectId: string } }>('/projects/:projectId/task-imports', async (request, reply) => {
    const projectId = await projectOf(request, request.params.projectId);
    const uploaded = await request.file({ limits: { fileSize: FILE_LIMIT, files: 1 } }).catch(() => {
      throw EpmError.badRequest('Send the file as multipart/form-data.');
    });
    if (!uploaded) throw EpmError.badRequest('No file was uploaded.');
    const content = await uploaded.toBuffer();
    if (uploaded.file.truncated) throw EpmError.validation('The file is larger than 25 MB.');
    let records;
    if (isCompoundFile(content)) {
      // An older Excel file (.xls): what OpenProject's own XLS export writes.
      try {
        records = readXls(content);
      } catch {
        throw EpmError.validation('This older Excel file (.xls) could not be read. Save it as .xlsx or CSV and upload it again.');
      }
    } else if (isZip(content)) {
      try {
        records = readXlsx(content);
      } catch {
        throw EpmError.validation('The Excel file could not be read. Save it again as .xlsx or CSV and upload it again.');
      }
    } else {
      records = parseCsv(content.toString('utf8'));
    }
    const mayEdit = await guard.holds(request, 'task:edit', String(projectId));
    reply.code(201);
    return checkImport(projectId, uploaded.filename || 'tasks.csv', records, request.auth!.userId, mayEdit);
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
