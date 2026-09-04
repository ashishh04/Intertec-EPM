import type { FastifyPluginAsync } from 'fastify';

import { permissionsFor } from '../auth/guard.js';
import { toNested } from '../auth/permissions.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { prisma } from '../db/prisma.js';
import { openProject } from '../openproject/client.js';
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
    const [user, permissions, profile] = await Promise.all([
      getCurrentUser(requestSignal(request)),
      permissionsFor(request),
      // EPM's own gate, so a failure to read it must not lock anyone out: an
      // unreadable profile means "nothing is being asked of you".
      prisma.userProfile
        .findUnique({
          where: { openProjectId: request.auth?.userId ?? '' },
          select: { mustChangePassword: true },
        })
        .catch(() => null),
    ]);

    const projectPermissions: Record<string, Record<string, Record<string, boolean>>> = {};
    for (const [projectId, set] of permissions.byProject) {
      projectPermissions[projectId] = toNested(set);
    }

    return {
      ...user,
      permissions: toNested(permissions.global),
      projectPermissions,
      mustChangePassword: profile?.mustChangePassword ?? false,
    };
  });

  /**
   * Sets the signed-in person's own password.
   *
   * Written as that person, not as an administrator: the upstream API lets a
   * user change their own credentials, and doing it with their token means EPM
   * never needs elevated rights for a self-service action.
   *
   * Clearing `mustChangePassword` afterwards is the whole point — that flag is
   * what holds a newly created person at the door until the administrator's
   * handover password has been replaced.
   *
   * Rules are the instance's own; its message is the one worth showing, so no
   * strength rules are duplicated here.
   */
  app.post<{ Body: { password?: unknown } }>('/me/password', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!password) throw EpmError.badRequest('A new password is required.');

    await openProject.request<unknown>(`/users/${userId}`, {
      method: 'PATCH',
      body: { password },
      signal: requestSignal(request),
    });

    await prisma.userProfile
      .updateMany({ where: { openProjectId: userId }, data: { mustChangePassword: false } })
      .catch(() => undefined);

    reply.code(204);
  });

  app.get('/users', async (request) => getUsers(requestSignal(request)));

  app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
    const users = await getUsers(requestSignal(request));
    const user = users.find((candidate) => candidate.id === request.params.id);
    if (!user) throw EpmError.notFound('That person');
    return user;
  });
};
