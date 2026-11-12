import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { namesFor } from '../domain/collaboration.js';
import { prisma } from '../db/prisma.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { linkId, openProject } from '../openproject/client.js';

/**
 * Internal comments: a task's discussion for the organisation's own people.
 * External users (clients, vendors) reach only the portal's routes (auth/hook),
 * so nothing here is ever shown to them. Anyone who can see the task can read
 * and add them; the author edits or deletes their own, and an administrator
 * may delete any.
 */

interface InternalCommentView {
  id: string;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  updatedAt?: string;
  editable: boolean;
  deletable: boolean;
  internal: true;
}

const bodySchema = z.object({ body: z.string().trim().min(1, 'Write something first.').max(20_000) });

/** The task's project, as the reader sees the task; refused when they cannot see it. */
async function projectOf(request: FastifyRequest, workPackageId: string): Promise<string> {
  if (!/^\d+$/.test(workPackageId)) throw EpmError.notFound('That work package');
  const workPackage = await openProject
    .request<{ _links?: Record<string, { href?: string | null } | undefined> }>(`/work_packages/${workPackageId}`, { signal: requestSignal(request) })
    .catch((error) => {
      if (error instanceof OpenProjectError && (error.upstreamStatus === 404 || error.upstreamStatus === 403)) throw EpmError.notFound('That work package');
      throw error;
    });
  const projectId = linkId(workPackage._links as never, 'project');
  if (!projectId) throw EpmError.notFound('That work package');
  await guard.require(request, 'task:view', projectId);
  return projectId;
}

async function views(rows: { id: string; authorId: string; body: string; edited: boolean; createdAt: Date; updatedAt: Date }[], viewerId: string, admin: boolean): Promise<InternalCommentView[]> {
  const names = await namesFor(rows.map((row) => row.authorId));
  return rows.map((row) => ({
    id: row.id,
    author: { id: row.authorId, name: names.get(row.authorId) ?? row.authorId },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    ...(row.edited ? { updatedAt: row.updatedAt.toISOString() } : {}),
    editable: row.authorId === viewerId,
    deletable: row.authorId === viewerId || admin,
    internal: true,
  }));
}

export const internalCommentRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/work-packages/:id/internal-comments', async (request) => {
    await projectOf(request, request.params.id);
    const rows = await prisma.internalComment.findMany({ where: { workPackageId: request.params.id }, orderBy: { createdAt: 'asc' } });
    return views(rows, request.auth!.userId, await guard.holds(request, 'users:manage'));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/work-packages/:id/internal-comments', async (request, reply) => {
    const projectId = await projectOf(request, request.params.id);
    const { body } = bodySchema.parse(request.body ?? {});
    const row = await prisma.internalComment.create({
      data: { workPackageId: request.params.id, projectId, authorId: request.auth!.userId, body },
    });
    reply.code(201);
    return (await views([row], request.auth!.userId, false))[0];
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/internal-comments/:id', async (request) => {
    const row = await prisma.internalComment.findUnique({ where: { id: request.params.id } });
    if (!row) throw EpmError.notFound('That comment');
    await projectOf(request, row.workPackageId);
    if (row.authorId !== request.auth!.userId) throw EpmError.forbidden('Only whoever wrote a comment can change it.');
    const { body } = bodySchema.parse(request.body ?? {});
    const updated = await prisma.internalComment.update({ where: { id: row.id }, data: { body, edited: true } });
    return (await views([updated], request.auth!.userId, false))[0];
  });

  app.delete<{ Params: { id: string } }>('/internal-comments/:id', async (request, reply) => {
    const row = await prisma.internalComment.findUnique({ where: { id: request.params.id } });
    if (!row) throw EpmError.notFound('That comment');
    await projectOf(request, row.workPackageId);
    if (row.authorId !== request.auth!.userId && !(await guard.holds(request, 'users:manage'))) {
      throw EpmError.forbidden('Only whoever wrote a comment, or an administrator, can delete it.');
    }
    await prisma.internalComment.delete({ where: { id: row.id } });
    reply.code(204);
  });
};
