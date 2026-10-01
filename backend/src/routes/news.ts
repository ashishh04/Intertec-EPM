import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  abilitiesFor,
  namesFor,
  optionalProjectId,
  requireRecordWrite,
  requireScopeRead,
  requireScopeWrite,
  visibleProjects,
} from '../domain/collaboration.js';
import { notifyNewsPublished } from '../domain/collaboration-notifications.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { paginated, resolvePage } from '../lib/pagination.js';
import type { EpmNewsPost } from '../types/epm.js';

/**
 * News.
 *
 * Announcements, for a project or for the organisation. EPM's own records, for
 * the same reason meetings are: OpenProject's news module has no API v3 resource
 * behind it.
 *
 * `publishedAt` is the state rather than a separate flag, and drafts are visible
 * only to their author. That is enforced in the query — a draft nobody else may
 * read is excluded by the `where`, not filtered out afterwards — so paging and
 * totals are computed over what the caller may actually see.
 */

const listQuery = z.object({
  projectId: z.string().optional(),
  includeDrafts: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const writeBody = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(200),
  projectId: z.string().optional(),
  summary: z.string().trim().max(500).optional(),
  body: z.string().trim().min(1, 'A post needs some text.').max(100_000),
  published: z.boolean().optional(),
});

const patchBody = writeBody.partial();

type NewsRow = {
  id: string;
  title: string;
  summary: string | null;
  body: string;
  projectId: string | null;
  authorId: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toEpmNewsPost(
  row: NewsRow,
  names: Map<string, string>,
  projects: Map<string, string>,
  can: EpmNewsPost['can'],
): EpmNewsPost {
  return {
    id: row.id,
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    body: row.body,
    ...(row.projectId
      ? {
          projectId: row.projectId,
          ...(projects.has(row.projectId) ? { projectName: projects.get(row.projectId)! } : {}),
        }
      : {}),
    authorId: row.authorId,
    ...(names.has(row.authorId) ? { authorName: names.get(row.authorId)! } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    can,
  };
}

/** Loads a post the caller may read, or reports it absent. */
async function readable(request: FastifyRequest, id: string): Promise<NewsRow> {
  const post = await prisma.newsPost.findUnique({ where: { id } });
  if (!post) throw EpmError.notFound('That post');

  // A draft is its author's alone until it is published — reported as absent to
  // everybody else, because "forbidden" would confirm it exists.
  if (!post.publishedAt && post.authorId !== request.auth?.userId) {
    throw EpmError.notFound('That post');
  }

  await requireScopeRead(request, post.projectId).catch(() => {
    throw EpmError.notFound('That post');
  });

  return post;
}

export const newsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/news', async (request) => {
    const query = listQuery.parse(request.query);
    const page = resolvePage(query.page, query.pageSize);
    const userId = request.auth?.userId ?? '';

    const projectId = optionalProjectId(query.projectId);
    if (projectId) await requireScopeRead(request, projectId);

    const projects = await visibleProjects(request);

    const where = {
      ...(projectId
        ? { projectId }
        : { OR: [{ projectId: null }, { projectId: { in: [...projects.keys()] } }] }),
      // Published, or the caller's own draft. `includeDrafts` only ever widens
      // the set by the person's own unpublished posts — there is no request shape
      // that reveals somebody else's.
      AND: [
        query.includeDrafts
          ? { OR: [{ publishedAt: { not: null } }, { authorId: userId }] }
          : { publishedAt: { not: null } },
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.newsPost.findMany({
        where,
        // Newest first, and a draft sorts by when it was written: `publishedAt`
        // is null for one, so ordering on it alone would strand every draft at
        // one end regardless of age.
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.newsPost.count({ where }),
    ]);

    const names = await namesFor(rows.map((row) => row.authorId));
    const items = await Promise.all(
      rows.map(async (row) =>
        toEpmNewsPost(
          row,
          names,
          projects,
          await abilitiesFor(request, { authorId: row.authorId, projectId: row.projectId }),
        ),
      ),
    );

    return paginated(items, total, page);
  });

  app.get<{ Params: { id: string } }>('/news/:id', async (request) => {
    const row = await readable(request, request.params.id);
    const [names, projects] = await Promise.all([
      namesFor([row.authorId]),
      visibleProjects(request),
    ]);

    return toEpmNewsPost(
      row,
      names,
      projects,
      await abilitiesFor(request, { authorId: row.authorId, projectId: row.projectId }),
    );
  });

  app.post<{ Body: unknown }>('/news', async (request, reply) => {
    const input = writeBody.parse(request.body ?? {});
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    const projectId = optionalProjectId(input.projectId);
    await requireScopeWrite(request, projectId);

    const row = await prisma.newsPost.create({
      data: {
        title: input.title,
        summary: input.summary || null,
        body: input.body,
        projectId: projectId ?? null,
        authorId: userId,
        // Published unless explicitly asked to be a draft. The common case is
        // writing an announcement and posting it; a draft is the exception and
        // has to be asked for.
        publishedAt: input.published === false ? null : new Date(),
      },
    });

    // Published now: tell the audience. Not awaited on the response path — the
    // post is saved, and the reader should not wait on a mail fan-out to see it.
    if (row.publishedAt) {
      void notifyNewsPublished({ ...row, publishedAt: row.publishedAt });
    }

    const [names, projects] = await Promise.all([namesFor([userId]), visibleProjects(request)]);

    reply.code(201);
    return toEpmNewsPost(row, names, projects, { update: true, delete: true });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/news/:id', async (request) => {
    const input = patchBody.parse(request.body ?? {});
    if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');

    const existing = await readable(request, request.params.id);
    await requireRecordWrite(
      request,
      { authorId: existing.authorId, projectId: existing.projectId },
      'post',
    );

    const movingTo = input.projectId === undefined ? undefined : optionalProjectId(input.projectId);
    if (input.projectId !== undefined && (movingTo ?? null) !== existing.projectId) {
      await requireScopeWrite(request, movingTo);
    }

    const row = await prisma.newsPost.update({
      where: { id: existing.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary || null }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.projectId === undefined ? {} : { projectId: movingTo ?? null }),
        // Publishing stamps the moment it happened; re-publishing something
        // already published leaves the original timestamp alone, so the list does
        // not reorder itself every time a typo is fixed.
        ...(input.published === undefined
          ? {}
          : {
              publishedAt: input.published ? (existing.publishedAt ?? new Date()) : null,
            }),
      },
    });

    /*
     * Only on the transition to published.
     *
     * `existing.publishedAt` being null and the new one set is exactly "this has
     * just been announced". Editing an already-published post changes nothing
     * here, which is why fixing a typo does not mail the project again.
     */
    if (!existing.publishedAt && row.publishedAt) {
      void notifyNewsPublished({ ...row, publishedAt: row.publishedAt });
    }

    const [names, projects] = await Promise.all([
      namesFor([row.authorId]),
      visibleProjects(request),
    ]);
    return toEpmNewsPost(row, names, projects, { update: true, delete: true });
  });

  app.delete<{ Params: { id: string } }>('/news/:id', async (request, reply) => {
    const existing = await readable(request, request.params.id);
    await requireRecordWrite(
      request,
      { authorId: existing.authorId, projectId: existing.projectId },
      'post',
    );

    await prisma.newsPost.delete({ where: { id: existing.id } });
    reply.code(204);
  });
};
