import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { GRANT_CATALOGUE } from '../auth/grants.js';
import { APP_ROLES, ASSIGNABLE_ROLES, ROLE_PERMISSIONS, ROLE_TEXT, roleOfAccount } from '../auth/roles.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { assignRole } from '../domain/app-roles.js';
import { listExternalAccess } from '../domain/external-access.js';
import { EpmError } from '../lib/errors.js';
import { message, requestLanguage, t } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { getUsers } from '../mapping/users.js';
import type { AppRoleAssignment, AppRoles } from '../types/epm.js';

/**
 * EPM roles, assigned to people (`auth/roles.ts`): Manager, HR, Employee or
 * External. Administrators are the instance's administrator accounts and are
 * listed as such, not assigned here.
 *
 * Administrators only, like the permission grants. Each change is journalled
 * and takes effect at once (`domain/app-roles.ts`).
 */

const roleBody = z.object({ role: z.enum(ASSIGNABLE_ROLES) });

export const appRoleRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/app-roles', async (request): Promise<AppRoles> => {
    await guard.require(request, 'users:manage');

    const [users, profiles, externalRoles] = await Promise.all([
      getUsers(requestSignal(request)),
      prisma.userProfile.findMany({
        where: { OR: [{ appRole: { not: null } }, { external: true }] },
        select: { openProjectId: true, appRole: true, external: true },
      }),
      prisma.externalRole.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    ]);
    const stored = new Map(profiles.map((row) => [row.openProjectId, row]));

    // Which projects each external person may see in the portal, and as what.
    // Asked only when someone is external: the names come from upstream.
    const grants = profiles.some((row) => row.external) ? await listExternalAccess().catch(() => []) : [];
    const grantsByUser = new Map<string, { projectName: string; roleName: string }[]>();
    for (const grant of grants) {
      const list = grantsByUser.get(grant.userId) ?? [];
      list.push({ projectName: grant.projectName, roleName: grant.roleName });
      grantsByUser.set(grant.userId, list);
    }

    const language = requestLanguage(request);
    const permissionLabel = new Map(GRANT_CATALOGUE.map((entry) => [entry.permission, t(language, entry.label)]));

    const people = users
      .map((user): AppRoleAssignment => {
        const administrator = user.role === 'Administrator' || env.EPM_ADMIN_USER_IDS.includes(user.id);
        const profile = stored.get(user.id);
        const role = roleOfAccount(user.id, administrator, profile?.appRole, profile?.external);
        return {
          userId: user.id,
          userName: user.name,
          email: user.email,
          role,
          administrator,
          ...(role === 'external' ? { externalAccess: grantsByUser.get(user.id) ?? [] } : {}),
        };
      })
      .sort((a, b) => a.userName.localeCompare(b.userName));

    return {
      catalogue: APP_ROLES.map((role) => ({
        role,
        label: t(language, ROLE_TEXT[role].label),
        description: t(language, ROLE_TEXT[role].description),
        assignable: role !== 'admin',
        permissions: ROLE_PERMISSIONS[role].map((permission) => permissionLabel.get(permission) ?? permission),
        // The client and vendor roles an external person can hold on a project.
        ...(role === 'external' ? { kinds: externalRoles.map((row) => row.name) } : {}),
      })),
      people,
    };
  });

  app.put<{ Params: { userId: string } }>('/admin/app-roles/:userId', async (request) => {
    await guard.require(request, 'users:manage');
    const { role } = roleBody.parse(request.body ?? {});
    const { userId } = request.params;

    const users = await getUsers(requestSignal(request));
    const person = users.find((user) => user.id === userId);
    if (!person) throw EpmError.notFound('That person');
    if (person.role === 'Administrator' || env.EPM_ADMIN_USER_IDS.includes(userId)) {
      throw EpmError.badRequest(message('{person} is an administrator; that is set on their account, not here.', { person: person.name }));
    }

    await assignRole({ userId, personName: person.name, role, actorId: request.auth!.userId });
    return { userId, role };
  });
};
