import { createHash, randomBytes } from 'node:crypto';

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { namesFor } from '../domain/collaboration.js';
import { isExternal } from '../domain/external-access.js';
import { prisma } from '../db/prisma.js';
import { getPreferences } from '../email/preferences.js';
import { EpmError } from '../lib/errors.js';
import { t, type Language } from '../lib/i18n.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { OpWorkPackage } from '../openproject/types.js';
import { lastActivity } from './dashboard.js';

/**
 * Atom feeds, for a feed reader to follow what a person may see without
 * signing in: their notifications, and the activity of a project they are a
 * member of. The secret in the address is EPM's own (kept hashed, shown once),
 * every link in a feed opens EPM, and none of the delivery system's addresses
 * or keys appear. Revoking the token, or the person leaving the project or
 * being made external, ends what the feed shows.
 */

const ENTRIES = 50;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const base = () => env.APP_BASE_URL.replace(/\/+$/, '');
const feedUrl = (token: string, path: string) => `${base()}${env.API_PREFIX}/feed/${token}${path}`;

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

interface AtomEntry {
  id: string;
  title: string;
  updated: string;
  link: string;
  author?: string;
  summary?: string;
}

function atom(input: { id: string; title: string; self: string; alternate: string; entries: AtomEntry[] }): string {
  const updated = input.entries[0]?.updated ?? new Date().toISOString();
  const entries = input.entries
    .map(
      (entry) => `  <entry>
    <id>${escape(entry.id)}</id>
    <title type="text">${escape(entry.title)}</title>
    <updated>${escape(entry.updated)}</updated>
    <link rel="alternate" type="text/html" href="${escape(entry.link)}"/>
${entry.author ? `    <author><name>${escape(entry.author)}</name></author>\n` : ''}${entry.summary ? `    <summary type="text">${escape(entry.summary)}</summary>\n` : ''}  </entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escape(input.id)}</id>
  <title type="text">${escape(input.title)}</title>
  <updated>${escape(updated)}</updated>
  <link rel="self" type="application/atom+xml" href="${escape(input.self)}"/>
  <link rel="alternate" type="text/html" href="${escape(input.alternate)}"/>
  <generator>EPM</generator>
${entries}
</feed>
`;
}

const sendAtom = (reply: FastifyReply, xml: string) =>
  reply.header('Content-Type', 'application/atom+xml; charset=utf-8').header('Cache-Control', 'private, max-age=60').send(xml);

/** Who the token belongs to, while they may still have a feed. */
async function holderOf(token: string): Promise<{ userId: string; language: Language }> {
  // Nothing about the reason is said: a wrong, revoked or lapsed token reads the same.
  const missing = () => EpmError.notFound('That feed');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw missing();
  const row = await prisma.feedToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row) throw missing();
  // Only while the account is still open, and theirs is not a client's or a vendor's.
  const account = await runAsSystem(() => openProject.request<{ status?: string }>(`/users/${row.userId}`)).catch(() => null);
  if (!account || (account.status && account.status !== 'active') || (await isExternal(row.userId))) throw missing();
  await prisma.feedToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  const preferences = await getPreferences(row.userId).catch(() => null);
  // EPM's two languages; a preference to follow the browser has no browser here.
  const language: Language = preferences?.locale.language === 'ar' ? 'ar' : 'en';
  return { userId: row.userId, language };
}

export const feedRoutes: FastifyPluginAsync = async (app) => {
  /* --------------------------------------------- the token, signed in */

  app.get('/feeds/token', async (request) => {
    const row = await prisma.feedToken.findUnique({ where: { userId: request.auth!.userId } });
    return row ? { exists: true, createdAt: row.createdAt.toISOString(), ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}) } : { exists: false };
  });

  /** A new token, replacing any before it. Shown this once. */
  app.post('/feeds/token', async (request, reply) => {
    const userId = request.auth!.userId;
    const token = randomBytes(24).toString('base64url');
    await prisma.feedToken.upsert({
      where: { userId },
      create: { userId, tokenHash: hash(token) },
      update: { tokenHash: hash(token), createdAt: new Date(), lastUsedAt: null },
    });
    reply.code(201);
    return {
      token,
      notifications: feedUrl(token, '/notifications.atom'),
      /** A project's feed: replace {projectId}. */
      project: feedUrl(token, '/projects/{projectId}/activity.atom'),
    };
  });

  app.delete('/feeds/token', async (request, reply) => {
    await prisma.feedToken.deleteMany({ where: { userId: request.auth!.userId } });
    reply.code(204);
  });

  /* ------------------------------------------------ the feeds, public */

  app.get<{ Params: { token: string } }>('/feed/:token/notifications.atom', async (request, reply) => {
    const { userId, language } = await holderOf(request.params.token);
    const rows = await prisma.notification.findMany({ where: { recipientId: userId }, orderBy: { createdAt: 'desc' }, take: ENTRIES });
    return sendAtom(
      reply,
      atom({
        id: `urn:epm:feed:notifications:${userId}`,
        title: t(language, 'EPM · My notifications'),
        self: feedUrl(request.params.token, '/notifications.atom'),
        alternate: `${base()}/notifications`,
        entries: rows.map((row) => ({
          id: `urn:epm:notification:${row.id}`,
          title: row.title,
          updated: row.createdAt.toISOString(),
          link: row.link ? `${base()}${row.link.startsWith('/') ? row.link : `/${row.link}`}` : `${base()}/notifications`,
          ...(row.body ? { summary: row.body } : {}),
        })),
      }),
    );
  });

  app.get<{ Params: { token: string; id: string } }>('/feed/:token/projects/:id/activity.atom', async (request, reply) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.params);
    const { userId, language } = await holderOf(request.params.token);
    const signal = AbortSignal.timeout(60_000);

    const { project, recent } = await runAsSystem(async () => {
      // Members only: the people the project itself admits, by name.
      const memberships = await openProject.getAll<{ _links?: Record<string, { href?: string | null } | { href?: string | null }[] | undefined> }>(
        '/memberships',
        { filters: [{ field: 'project', operator: '=', values: [id] }], pageSize: 200 },
        { signal },
      );
      const member = memberships.items.some((membership) => {
        const principal = membership._links?.principal;
        const href = (Array.isArray(principal) ? principal[0] : principal)?.href ?? '';
        return /\/users\/(\d+)$/.exec(href)?.[1] === userId;
      });
      if (!member) throw EpmError.notFound('That feed');
      const [project, recent] = await Promise.all([
        openProject.request<{ name: string }>(`/projects/${id}`, { signal }),
        openProject.getCollection<OpWorkPackage>(
          '/work_packages',
          { filters: [{ field: 'project', operator: '=', values: [id] }, { field: 'status', operator: '*', values: [] }], sortBy: [['updatedAt', 'desc']], pageSize: 30 },
          signal,
        ),
      ]);
      const items = await Promise.all(
        (recent._embedded?.elements ?? []).map(async (workPackage) => ({ workPackage, latest: await lastActivity(String(workPackage.id), signal).catch(() => undefined) })),
      );
      return { project, recent: items };
    });

    const actorIds = recent.map(({ latest }) => {
      const link = latest?._links?.user;
      return idFromHref((Array.isArray(link) ? link[0] : link)?.href ?? '') ?? '';
    });
    const names = await namesFor(actorIds);
    return sendAtom(
      reply,
      atom({
        id: `urn:epm:feed:project:${id}:${userId}`,
        title: t(language, 'EPM · {project} · Activity', { project: project.name }),
        self: feedUrl(request.params.token, `/projects/${id}/activity.atom`),
        alternate: `${base()}/projects/${id}/activity`,
        entries: recent.map(({ workPackage, latest }, index) => {
          const comment = (latest?.comment?.raw ?? '').trim();
          const actor = names.get(actorIds[index] ?? '');
          const action = comment ? 'commented' : workPackage.createdAt === workPackage.updatedAt ? 'created' : 'updated';
          return {
            id: `urn:epm:activity:${workPackage.id}:${latest?.id ?? workPackage.updatedAt}`,
            title: t(language, '{action, select, commented {Comment on {task}} created {New: {task}} other {Updated: {task}}}', {
              action,
              task: workPackage.subject,
            }),
            updated: workPackage.updatedAt,
            link: `${base()}/tasks/${workPackage.id}`,
            ...(actor ? { author: actor } : {}),
            ...(comment ? { summary: comment.slice(0, 2000) } : {}),
          };
        }),
      }),
    );
  });
};

