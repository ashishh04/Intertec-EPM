import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { currentAuth } from '../auth/context.js';
import * as guard from '../auth/guard.js';
import { asCsv, asWorkbook, exportRows } from '../domain/task-export.js';
import { cancelImport, checkImport, getImport, importView, listImports, startImport, templateFor } from '../domain/task-import.js';
import { openProject } from '../openproject/client.js';
import { EpmError } from '../lib/errors.js';
import { contentDispositionFor } from '../lib/uploads.js';

/**
 * Importing tasks from a CSV (epics, tasks, subtasks, milestones, dates,
 * assignees, dependencies). Needs `task:create` in the project; the rows are
 * created under the importer's own account.
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
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/task-imports/template', async (request, reply) => {
    const projectId = await projectOf(request, request.params.projectId);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', contentDispositionFor(`epm-task-import-template.csv`))
      .header('Cache-Control', 'private, no-store');
    // A byte-order mark, so Excel reads the file as UTF-8.
    return reply.send(`﻿${await templateFor(projectId)}`);
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

  /** Uploads a CSV and checks every row; nothing is created yet. */
  app.post<{ Params: { projectId: string } }>('/projects/:projectId/task-imports', async (request, reply) => {
    const projectId = await projectOf(request, request.params.projectId);
    const uploaded = await request.file({ limits: { fileSize: FILE_LIMIT, files: 1 } }).catch(() => {
      throw EpmError.badRequest('Send the CSV as multipart/form-data.');
    });
    if (!uploaded) throw EpmError.badRequest('No file was uploaded.');
    const content = await uploaded.toBuffer();
    if (uploaded.file.truncated) throw EpmError.validation('The file is larger than 25 MB.');
    reply.code(201);
    return checkImport(projectId, uploaded.filename || 'tasks.csv', content.toString('utf8'), request.auth!.userId);
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
