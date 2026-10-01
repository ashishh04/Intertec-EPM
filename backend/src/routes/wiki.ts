import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  abilitiesFor,
  namesFor,
  optionalProjectId,
  requireRecordWrite,
  requireScopeRead,
  requireScopeWrite,
  slugify,
  visibleProjects,
} from '../domain/collaboration.js';
import { notifyWikiChanged } from '../domain/collaboration-notifications.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import type { EpmWikiPage, WikiRevision, WikiTreeNode } from '../types/epm.js';

/**
 * The wiki.
 *
 * EPM's own records, as with meetings and news: OpenProject's wiki is a set of
 * HTML controllers with no API v3 resource behind it.
 *
 * Two things here are worth knowing before reading the handlers.
 *
 * A page is addressed by its slug within a scope, not by its id. That is what
 * makes a wiki link a wiki link — somebody can write `/wiki/deployment` in a
 * ticket and it keeps working. The id still exists and is what edits key off, so
 * renaming a page does not break its history.
 *
 * Every edit writes a revision holding what the page said *before* it. The newest
 * revision is therefore the previous version, and the page itself is current —
 * which makes restoring a version a plain copy rather than replaying a chain of
 * diffs, and means a page with no revisions has simply never been edited.
 */

const scopeQuery = z.object({ projectId: z.string().optional() });

const writeBody = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(200),
  body: z.string().max(200_000),
  projectId: z.string().optional(),
  parentId: z.string().optional(),
  slug: z.string().trim().max(80).optional(),
});

const patchBody = writeBody.partial();

type PageRow = {
  id: string;
  slug: string;
  title: string;
  body: string;
  projectId: string | null;
  parentId: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { revisions: number };
};

function toEpmWikiPage(
  row: PageRow,
  names: Map<string, string>,
  projects: Map<string, string>,
  can: EpmWikiPage['can'],
): EpmWikiPage {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    ...(row.projectId
      ? {
          projectId: row.projectId,
          ...(projects.has(row.projectId) ? { projectName: projects.get(row.projectId)! } : {}),
        }
      : {}),
    ...(row.parentId ? { parentId: row.parentId } : {}),
    updatedBy: row.updatedBy,
    ...(names.has(row.updatedBy) ? { updatedByName: names.get(row.updatedBy)! } : {}),
    revisionCount: row._count?.revisions ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    can,
  };
}

/**
 * The navigation tree for one scope.
 *
 * Built in memory from a single query rather than with a recursive one: a wiki
 * that outgrows a `findMany` is a wiki nobody can navigate anyway, and the flat
 * read is one round trip instead of one per level.
 *
 * A page whose parent is outside the scope — which the `SET NULL` on delete makes
 * impossible, but a hand-edited row could still produce — is attached at the root
 * rather than dropped, so nothing becomes unreachable.
 */
function buildTree(rows: { id: string; slug: string; title: string; parentId: string | null }[]): WikiTreeNode[] {
  const nodes = new Map<string, WikiTreeNode>(
    rows.map((row) => [row.id, { id: row.id, slug: row.slug, title: row.title, children: [] }]),
  );

  const roots: WikiTreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/** The scope filter for a project id, honouring the null-means-organisation rule. */
const scopeWhere = (projectId: string | undefined) => ({ projectId: projectId ?? null });

/** Loads a page the caller may read, or reports it absent. */
async function readable(request: FastifyRequest, id: string): Promise<PageRow> {
  const page = await prisma.wikiPage.findUnique({
    where: { id },
    include: { _count: { select: { revisions: true } } },
  });
  if (!page) throw EpmError.notFound('That page');

  await requireScopeRead(request, page.projectId).catch(() => {
    throw EpmError.notFound('That page');
  });

  return page;
}

/**
 * A slug that is free in this scope.
 *
 * Suffixed rather than refused when it collides: somebody writing a second page
 * called "Notes" wants a second page called "Notes", not an error telling them to
 * pick a different title. The database has the unique indexes that make this
 * safe; this only avoids hitting them in the ordinary case.
 */
async function freeSlug(
  wanted: string,
  projectId: string | undefined,
  exceptId?: string,
): Promise<string> {
  const base = slugify(wanted) || 'page';

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await prisma.wikiPage.findFirst({
      where: { ...scopeWhere(projectId), slug: candidate, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (!clash) return candidate;
  }

  // Fifty pages with the same title is not a naming problem any more.
  throw EpmError.badRequest('Too many pages share that title. Give this one a distinct name.');
}

/**
 * Checks a parent is a real page in the same scope and not a descendant.
 *
 * The cycle check is the important one: a page made its own ancestor disappears
 * from the tree entirely — `buildTree` attaches nothing to a root it never
 * reaches — and takes its whole subtree with it.
 */
async function resolveParent(
  parentId: string | undefined,
  projectId: string | undefined,
  pageId?: string,
): Promise<string | null> {
  if (!parentId) return null;

  const parent = await prisma.wikiPage.findUnique({
    where: { id: parentId },
    select: { id: true, projectId: true, parentId: true },
  });
  if (!parent) throw EpmError.badRequest('That parent page does not exist.');
  if (parent.projectId !== (projectId ?? null)) {
    throw EpmError.badRequest('A page cannot sit under one from another project.');
  }
  if (pageId && parent.id === pageId) {
    throw EpmError.badRequest('A page cannot be its own parent.');
  }

  if (pageId) {
    // Walk up from the proposed parent. If this page is anywhere above it, the
    // move would make a loop. Bounded, so a pre-existing cycle in the data
    // cannot spin here forever.
    let cursor: string | null = parent.parentId;
    for (let depth = 0; cursor && depth < 100; depth += 1) {
      if (cursor === pageId) {
        throw EpmError.badRequest('That would put the page inside one of its own subpages.');
      }
      const next: { parentId: string | null } | null = await prisma.wikiPage.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = next?.parentId ?? null;
    }
  }

  return parent.id;
}

export const wikiRoutes: FastifyPluginAsync = async (app) => {
  /** The navigation tree for a scope. Titles and slugs only — no bodies. */
  app.get('/wiki/tree', async (request): Promise<WikiTreeNode[]> => {
    const { projectId: raw } = scopeQuery.parse(request.query);
    const projectId = optionalProjectId(raw);
    await requireScopeRead(request, projectId);

    const rows = await prisma.wikiPage.findMany({
      where: scopeWhere(projectId),
      select: { id: true, slug: true, title: true, parentId: true },
      orderBy: { title: 'asc' },
    });

    return buildTree(rows);
  });

  /**
   * One page, by slug within its scope.
   *
   * The slug is in the query rather than the path so an organisation-wide page
   * and a project page use the same route — `/wiki/page?slug=x&projectId=7` —
   * and a slug containing characters a path segment would eat cannot break it.
   */
  app.get('/wiki/page', async (request): Promise<EpmWikiPage> => {
    const { slug, projectId: raw } = z
      .object({ slug: z.string().min(1), projectId: z.string().optional() })
      .parse(request.query);

    const projectId = optionalProjectId(raw);
    await requireScopeRead(request, projectId);

    const row = await prisma.wikiPage.findFirst({
      where: { ...scopeWhere(projectId), slug },
      include: { _count: { select: { revisions: true } } },
    });
    if (!row) throw EpmError.notFound('That page');

    const [names, projects] = await Promise.all([
      namesFor([row.updatedBy]),
      visibleProjects(request),
    ]);

    return toEpmWikiPage(
      row,
      names,
      projects,
      await abilitiesFor(request, { authorId: row.updatedBy, projectId: row.projectId }),
    );
  });

  app.get<{ Params: { id: string } }>('/wiki/pages/:id', async (request): Promise<EpmWikiPage> => {
    const row = await readable(request, request.params.id);
    const [names, projects] = await Promise.all([
      namesFor([row.updatedBy]),
      visibleProjects(request),
    ]);

    return toEpmWikiPage(
      row,
      names,
      projects,
      await abilitiesFor(request, { authorId: row.updatedBy, projectId: row.projectId }),
    );
  });

  /** Past versions, newest first. The current text is the page itself. */
  app.get<{ Params: { id: string } }>(
    '/wiki/pages/:id/revisions',
    async (request): Promise<WikiRevision[]> => {
      const page = await readable(request, request.params.id);

      const rows = await prisma.wikiRevision.findMany({
        where: { pageId: page.id },
        orderBy: { createdAt: 'desc' },
        // A page edited a thousand times does not need a thousand rows on screen.
        take: 100,
      });

      const names = await namesFor(rows.map((row) => row.authorId));

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        authorId: row.authorId,
        ...(names.has(row.authorId) ? { authorName: names.get(row.authorId)! } : {}),
        createdAt: row.createdAt.toISOString(),
      }));
    },
  );

  app.post<{ Body: unknown }>('/wiki/pages', async (request, reply) => {
    const input = writeBody.parse(request.body ?? {});
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    const projectId = optionalProjectId(input.projectId);
    await requireScopeWrite(request, projectId);

    const parentId = await resolveParent(input.parentId, projectId);
    const slug = await freeSlug(input.slug || input.title, projectId);

    const row = await prisma.wikiPage.create({
      data: {
        slug,
        title: input.title,
        body: input.body,
        projectId: projectId ?? null,
        parentId,
        updatedBy: userId,
      },
      include: { _count: { select: { revisions: true } } },
    });

    void notifyWikiChanged({ ...row, created: true });

    const [names, projects] = await Promise.all([namesFor([userId]), visibleProjects(request)]);

    reply.code(201);
    return toEpmWikiPage(row, names, projects, { update: true, delete: true });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/wiki/pages/:id', async (request) => {
    const input = patchBody.parse(request.body ?? {});
    if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');

    const existing = await readable(request, request.params.id);
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    await requireRecordWrite(
      request,
      { authorId: existing.updatedBy, projectId: existing.projectId },
      'page',
    );

    const movingTo = input.projectId === undefined ? undefined : optionalProjectId(input.projectId);
    const scope = input.projectId === undefined ? (existing.projectId ?? undefined) : movingTo;
    if (input.projectId !== undefined && (movingTo ?? null) !== existing.projectId) {
      await requireScopeWrite(request, movingTo);
    }

    const parentId =
      input.parentId === undefined
        ? undefined
        : await resolveParent(input.parentId, scope, existing.id);

    // Re-slugged only when asked for, or when the page is moving to another
    // project where its slug might already be taken. A title edit deliberately
    // leaves the address alone: links to it exist.
    const slug =
      input.slug !== undefined
        ? await freeSlug(input.slug || existing.title, scope, existing.id)
        : input.projectId !== undefined && (movingTo ?? null) !== existing.projectId
          ? await freeSlug(existing.slug, scope, existing.id)
          : undefined;

    const textChanged =
      (input.title !== undefined && input.title !== existing.title) ||
      (input.body !== undefined && input.body !== existing.body);

    /*
     * The snapshot and the edit, together or not at all.
     *
     * An interactive transaction rather than an array, because the array form is
     * a tuple whose shape depends on whether the snapshot is included — which
     * costs a cast at the end to recover the page. This reads as what it does.
     *
     * The snapshot holds what the page said *before* this edit, and is only
     * written when the text actually changed: moving a page or renaming its slug
     * is not a new version of its content, and recording one would fill the
     * history with entries identical to their neighbours.
     */
    const row = await prisma.$transaction(async (tx) => {
      if (textChanged) {
        await tx.wikiRevision.create({
          data: {
            pageId: existing.id,
            title: existing.title,
            body: existing.body,
            authorId: userId,
          },
        });
      }

      return tx.wikiPage.update({
        where: { id: existing.id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(slug === undefined ? {} : { slug }),
          ...(input.projectId === undefined ? {} : { projectId: movingTo ?? null }),
          ...(parentId === undefined ? {} : { parentId }),
          updatedBy: userId,
        },
        include: { _count: { select: { revisions: true } } },
      });
    });

    // Only a text change is worth telling anybody about. Moving a page or
    // renaming its slug is housekeeping, and `textChanged` already distinguishes
    // the two for the revision history.
    if (textChanged) void notifyWikiChanged({ ...row, created: false });

    const [names, projects] = await Promise.all([namesFor([userId]), visibleProjects(request)]);
    return toEpmWikiPage(row, names, projects, { update: true, delete: true });
  });

  /**
   * Restores a past version.
   *
   * A forward edit, not a rewind: the current text is snapshotted first, so the
   * restore itself appears in the history and can be undone the same way. A wiki
   * where restoring destroys what it replaced is a wiki nobody dares restore in.
   */
  app.post<{ Params: { id: string; revisionId: string } }>(
    '/wiki/pages/:id/revisions/:revisionId/restore',
    async (request) => {
      const existing = await readable(request, request.params.id);
      const userId = request.auth?.userId;
      if (!userId) throw EpmError.unauthorized();

      await requireRecordWrite(
        request,
        { authorId: existing.updatedBy, projectId: existing.projectId },
        'page',
      );

      const revision = await prisma.wikiRevision.findFirst({
        where: { id: request.params.revisionId, pageId: existing.id },
      });
      if (!revision) throw EpmError.notFound('That version');

      const [, row] = await prisma.$transaction([
        prisma.wikiRevision.create({
          data: {
            pageId: existing.id,
            title: existing.title,
            body: existing.body,
            authorId: userId,
          },
        }),
        prisma.wikiPage.update({
          where: { id: existing.id },
          data: { title: revision.title, body: revision.body, updatedBy: userId },
          include: { _count: { select: { revisions: true } } },
        }),
      ]);

      const [names, projects] = await Promise.all([namesFor([userId]), visibleProjects(request)]);
      return toEpmWikiPage(row, names, projects, { update: true, delete: true });
    },
  );

  app.delete<{ Params: { id: string } }>('/wiki/pages/:id', async (request, reply) => {
    const existing = await readable(request, request.params.id);
    await requireRecordWrite(
      request,
      { authorId: existing.updatedBy, projectId: existing.projectId },
      'page',
    );

    // Subpages survive and move to the root, by the `SET NULL` on the relation.
    // Deleting a section heading should not silently delete everything filed
    // under it — that is a different, much larger decision than the one the
    // person made.
    await prisma.wikiPage.delete({ where: { id: existing.id } });
    reply.code(204);
  });
};
