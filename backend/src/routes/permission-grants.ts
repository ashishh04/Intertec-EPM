import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { forgetPermissions } from '../auth/capabilities.js';
import { GRANT_CATALOGUE, isGrantable } from '../auth/grants.js';
import type { Permission } from '../auth/permissions.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { withAudit } from '../domain/audit.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getUsers } from '../mapping/users.js';
import type { PermissionGrant, PermissionGrants } from '../types/epm.js';
import { message, requestLanguage, t } from '../lib/i18n.js';

/**
 * EPM's own permissions, granted to people: the ones OpenProject has no
 * concept of — departments, health, rules, rates, the journal and the rest
 * (`auth/grants.ts`). Until this existed a grant was a row inserted by hand.
 *
 * Administrators only (`users:manage`), and not itself a grantable
 * permission: a grant that could grant would be every permission. Each grant
 * and each removal is journalled with who made it (BRL-02), and the person's
 * permissions are forgotten at once on this server — elsewhere within the
 * minute they are cached for.
 *
 * People named in EPM_ADMIN_USER_IDS hold every EPM permission from the
 * server's configuration. They are listed, and changed there, not here.
 */

const grantBody = z.object({
  userId: z.string().regex(/^\d+$/, 'userId is an OpenProject user id.'),
  permission: z.string(),
});

const LABEL = new Map(GRANT_CATALOGUE.map((entry) => [entry.permission, entry.label]));

export const permissionGrantRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/permission-grants', async (request): Promise<PermissionGrants> => {
    await guard.require(request, 'users:manage');

    const [rows, users] = await Promise.all([
      prisma.epmPermissionGrant.findMany({ orderBy: [{ permission: 'asc' }, { grantedAt: 'asc' }] }),
      getUsers(requestSignal(request)).catch(() => []),
    ]);
    const nameOf = new Map(users.map((user) => [user.id, user.name]));

    // The catalogue's words are the page's words, so they come back in the
    // language the page is shown in.
    const language = requestLanguage(request);
    return {
      catalogue: GRANT_CATALOGUE.map((entry) => ({
        ...entry,
        label: t(language, entry.label),
        description: t(language, entry.description),
      })),
      grants: rows
        // A row naming a permission that no longer exists grants nothing
        // (`applyEpmGrants`), so it is not shown as if it did.
        .filter((row) => isGrantable(row.permission))
        .map(
          (row): PermissionGrant => ({
            userId: row.openProjectId,
            userName: nameOf.get(row.openProjectId) ?? `User ${row.openProjectId}`,
            permission: row.permission as Permission,
            grantedAt: row.grantedAt.toISOString(),
            grantedById: row.grantedBy ?? undefined,
            grantedByName: row.grantedBy ? nameOf.get(row.grantedBy) : undefined,
          }),
        ),
      configured: env.EPM_ADMIN_USER_IDS.map((userId) => ({
        userId,
        userName: nameOf.get(userId) ?? `User ${userId}`,
      })),
    };
  });

  app.post('/admin/permission-grants', async (request, reply): Promise<PermissionGrant> => {
    await guard.require(request, 'users:manage');
    const body = grantBody.parse(request.body ?? {});
    if (!isGrantable(body.permission)) {
      throw EpmError.badRequest(message('{permission} is not a permission EPM grants.', { permission: body.permission }));
    }
    const permission = body.permission;

    const users = await getUsers(requestSignal(request));
    const person = users.find((user) => user.id === body.userId);
    if (!person) throw EpmError.notFound('That person');

    const existing = await prisma.epmPermissionGrant.findUnique({
      where: { openProjectId_permission: { openProjectId: body.userId, permission } },
    });
    if (existing) throw EpmError.conflict(message('{person} already holds {permission}.', { person: person.name, permission: LABEL.get(permission) ?? permission }));

    const grantedBy = request.auth!.userId;
    const row = await withAudit(
      (tx) => tx.epmPermissionGrant.create({ data: { openProjectId: body.userId, permission, grantedBy } }),
      (created) => ({
        entityType: 'permission_grant',
        entityId: `${created.openProjectId}:${created.permission}`,
        action: 'grant.created',
        summary: `Granted "${LABEL.get(permission) ?? permission}" to ${person.name}`,
        after: { userId: created.openProjectId, permission: created.permission },
      }),
    );
    forgetPermissions(body.userId);

    reply.code(201);
    return {
      userId: row.openProjectId,
      userName: person.name,
      permission,
      grantedAt: row.grantedAt.toISOString(),
      grantedById: grantedBy,
      grantedByName: users.find((user) => user.id === grantedBy)?.name,
    };
  });

  app.delete<{ Params: { userId: string; permission: string } }>(
    '/admin/permission-grants/:userId/:permission',
    async (request, reply) => {
      await guard.require(request, 'users:manage');
      const { userId, permission } = request.params;

      const existing = await prisma.epmPermissionGrant.findUnique({
        where: { openProjectId_permission: { openProjectId: userId, permission } },
      });
      if (!existing) throw EpmError.notFound('That grant');

      const users = await getUsers(requestSignal(request)).catch(() => []);
      const name = users.find((user) => user.id === userId)?.name ?? `User ${userId}`;

      await withAudit(
        (tx) =>
          tx.epmPermissionGrant.delete({
            where: { openProjectId_permission: { openProjectId: userId, permission } },
          }),
        {
          entityType: 'permission_grant',
          entityId: `${userId}:${permission}`,
          action: 'grant.removed',
          summary: `Removed "${LABEL.get(permission as Permission) ?? permission}" from ${name}`,
          before: { userId, permission, grantedAt: existing.grantedAt.toISOString(), grantedBy: existing.grantedBy },
        },
      );
      forgetPermissions(userId);

      reply.code(204);
    },
  );
};
