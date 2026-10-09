import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { listInstanceJournal } from '../domain/audit.js';
import { modelFacts } from '../domain/measure-facts.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getUsers } from '../mapping/users.js';
import type { JournalPage } from '../types/epm.js';

/**
 * The instance-wide journal (BRL-02, NFR07): every change EPM recorded — to
 * projects' plans and health, approvals, rules, organisation data, permission
 * grants — in one place, filtered and paged, newest first.
 *
 * For people granted `audit:view` and for administrators. A project's own
 * journal stays on its Activity tab for anyone who can see the project; this
 * one crosses every project and the organisation, so it is an oversight role.
 * Names come from the directory and the analytics model, which know every
 * person and project: whoever may read the whole journal may know what it
 * refers to.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const journalQuery = z.object({
  entityType: z.string().max(80).optional(),
  action: z.string().max(80).optional(),
  actorId: z.string().regex(/^\d+$/).optional(),
  projectId: z.string().regex(/^\d+$/).optional(),
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const journalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/journal', async (request): Promise<JournalPage> => {
    // Administrators hold this too (`auth/grants.ts`).
    await guard.require(request, 'audit:view');
    const query = journalQuery.parse(request.query);
    if (query.from && query.to && query.to < query.from) {
      throw EpmError.badRequest('The range ends before it starts.');
    }

    const [page, users, facts] = await Promise.all([
      listInstanceJournal({
        entityType: query.entityType || undefined,
        actionPrefix: query.action || undefined,
        actorId: query.actorId,
        projectId: query.projectId,
        from: query.from,
        to: query.to,
        q: query.q || undefined,
        page: query.page,
        pageSize: query.pageSize,
      }),
      getUsers(requestSignal(request)).catch(() => []),
      modelFacts().catch(() => undefined),
    ]);
    const userName = new Map(users.map((user) => [user.id, user.name]));

    return {
      ...page,
      items: page.items.map((entry) => ({
        ...entry,
        actorName: entry.actorId
          ? userName.get(entry.actorId) ?? facts?.users.get(Number(entry.actorId))?.name
          : undefined,
        projectName: entry.projectId ? facts?.projects.get(Number(entry.projectId))?.name : undefined,
      })),
    };
  });
};
