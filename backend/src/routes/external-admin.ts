import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import {
  deleteExternalRole,
  grantExternalAccess,
  listExternalAccess,
  listExternalRoles,
  revokeExternalAccess,
  saveExternalRole,
  setExternal,
} from '../domain/external-access.js';

/**
 * Administering external users (Module 17): the roles and their permission
 * matrix, and who holds which role on which project. Needs `users:manage`.
 */
export const externalAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request) => {
    await guard.require(request, 'users:manage');
  });

  app.get('/admin/external-roles', async () => listExternalRoles());

  app.post<{ Body: unknown }>('/admin/external-roles', async (request, reply) => {
    reply.code(201);
    return saveExternalRole(null, request.body, request.auth!.userId);
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/admin/external-roles/:id', async (request) =>
    saveExternalRole(request.params.id, request.body, request.auth!.userId),
  );

  app.delete<{ Params: { id: string } }>('/admin/external-roles/:id', async (request, reply) => {
    await deleteExternalRole(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  app.get('/admin/external-access', async () => listExternalAccess());

  app.post<{ Body: unknown }>('/admin/external-access', async (request, reply) => {
    reply.code(201);
    return grantExternalAccess(request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/admin/external-access/:id', async (request, reply) => {
    await revokeExternalAccess(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /** Makes someone internal again, once they hold no external access. */
  app.patch<{ Params: { userId: string }; Body: unknown }>('/admin/external-users/:userId', async (request) => {
    const { external } = z.object({ external: z.boolean() }).parse(request.body ?? {});
    await setExternal(request.params.userId, external, request.auth!.userId);
    return { userId: request.params.userId, external };
  });
};
