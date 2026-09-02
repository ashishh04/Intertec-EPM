import type { FastifyPluginAsync } from 'fastify';

import { permissionsFor } from '../auth/guard.js';
import { toNested } from '../auth/permissions.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCurrentUser, getUsers } from '../mapping/users.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The signed-in user plus their effective permissions.
   *
   * Permissions are computed from OpenProject's capabilities for this caller,
   * never assumed. `permissions` is what the UI may offer; `projectPermissions`
   * carries the per-project variation, because a user can be a manager in one
   * project and a reader in another.
   *
   * The upstream system is not named or located here.
   */
  app.get('/me', async (request) => {
    const [user, permissions] = await Promise.all([
      getCurrentUser(requestSignal(request)),
      permissionsFor(request),
    ]);

    const projectPermissions: Record<string, Record<string, Record<string, boolean>>> = {};
    for (const [projectId, set] of permissions.byProject) {
      projectPermissions[projectId] = toNested(set);
    }

    return {
      ...user,
      permissions: toNested(permissions.global),
      projectPermissions,
    };
  });

  app.get('/users', async (request) => getUsers(requestSignal(request)));

  app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
    const users = await getUsers(requestSignal(request));
    const user = users.find((candidate) => candidate.id === request.params.id);
    if (!user) throw EpmError.notFound('That person');
    return user;
  });
};
