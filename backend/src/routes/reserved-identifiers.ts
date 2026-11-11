import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { listReservations, release, reserve } from '../domain/reserved-identifiers.js';
import { namesFor } from '../domain/collaboration.js';

/**
 * Reserved project identifiers (Administration → Projects → Identifiers).
 *
 * Kept and released by an administrator. Read by anyone who may create
 * projects, so the reason an identifier is refused can be looked up.
 */
export const reservedIdentifierRoutes: FastifyPluginAsync = async (app) => {
  app.get('/reserved-identifiers', async (request) => {
    if (!(await guard.holds(request, 'users:manage'))) await guard.require(request, 'project:create');
    const rows = await listReservations();
    const names = await namesFor(rows.map((row) => row.reservedBy));
    return rows.map((row) => ({ ...row, ...(names.has(row.reservedBy) ? { reservedByName: names.get(row.reservedBy)! } : {}) }));
  });

  app.post<{ Body: { identifier?: unknown; note?: unknown } }>('/reserved-identifiers', async (request, reply) => {
    await guard.require(request, 'users:manage');
    const created = await reserve(request.body ?? {}, request.auth!.userId);
    reply.code(201);
    return created;
  });

  app.delete<{ Params: { identifier: string } }>('/reserved-identifiers/:identifier', async (request, reply) => {
    await guard.require(request, 'users:manage');
    await release(request.params.identifier);
    reply.code(204);
  });
};
