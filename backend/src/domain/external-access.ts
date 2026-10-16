import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message, msg } from '../lib/i18n.js';
import { openProject } from '../openproject/client.js';
import type { ExternalAccessView, ExternalPermission, ExternalRoleView } from '../types/epm.js';
import { withAudit } from './audit.js';

/**
 * External users and what they may do (Module 17: BR-611 to BR-613), as role-
 * based access: an external role is a permission matrix, and an external user
 * holds one role per project they are granted. An external user sees only the
 * portal — every other route refuses them (`auth/hook.ts`) — and in it only
 * what the matrix allows, on those projects.
 *
 * Their own account does the work, so OpenProject's permissions apply too:
 * granting access also makes them a member of the project, with the least
 * privileged project role that covers the matrix.
 */

export const EXTERNAL_PERMISSIONS: ExternalPermission[] = [
  'status',
  'milestones',
  'tasks.all',
  'tasks.assigned',
  'comment',
  'status.own',
  'time.own',
  'documents.view',
  'documents.upload',
  'approvals',
  'reports',
];

/** The project role permissions each matrix entry needs upstream. */
const NEEDS: Partial<Record<ExternalPermission, string[][]>> = {
  // `add_work_package_notes` until OpenProject 17 renamed it.
  comment: [['add_work_package_comments', 'add_work_package_notes']],
  // Working their own tasks means tasks can be assigned to them.
  'tasks.assigned': [['work_package_assigned']],
  'status.own': [['edit_work_packages', 'change_work_package_status'], ['work_package_assigned']],
  'time.own': [['log_own_time', 'log_time'], ['work_package_assigned']],
};

/* -------------------------------------------------------------------------- */
/* Who is external, and their scope                                           */
/* -------------------------------------------------------------------------- */

const externalCache = new Map<string, { at: number; value: boolean }>();
const scopeCache = new Map<string, { at: number; value: Map<number, ProjectScope> }>();
const CACHE_MS = 15_000;

export interface ProjectScope {
  roleName: string;
  permissions: Set<ExternalPermission>;
}

export function forgetExternal(userId?: string): void {
  if (userId) {
    externalCache.delete(userId);
    scopeCache.delete(userId);
  } else {
    externalCache.clear();
    scopeCache.clear();
  }
}

export async function isExternal(userId: string): Promise<boolean> {
  const cached = externalCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = await prisma.userProfile.findUnique({ where: { openProjectId: userId }, select: { external: true } });
  const value = row?.external === true;
  externalCache.set(userId, { at: Date.now(), value });
  return value;
}

/** The projects an external user is granted, with their role's matrix on each. */
export async function scopeOf(userId: string): Promise<Map<number, ProjectScope>> {
  const cached = scopeCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await prisma.externalAccess.findMany({ where: { userId }, include: { role: true } });
  const value = new Map(rows.map((row) => [row.projectId, { roleName: row.role.name, permissions: new Set(row.role.permissions as ExternalPermission[]) }]));
  scopeCache.set(userId, { at: Date.now(), value });
  return value;
}

/** The scope on one project, or 404 — an external user does not learn whether others exist. */
export async function requireScope(userId: string, projectId: number, permission?: ExternalPermission | ExternalPermission[]): Promise<ProjectScope> {
  const scope = (await scopeOf(userId)).get(projectId);
  if (!scope) throw EpmError.notFound('That project');
  if (permission) {
    const wanted = Array.isArray(permission) ? permission : [permission];
    if (!wanted.some((one) => scope.permissions.has(one))) throw EpmError.forbidden('Your access to this project does not include that.');
  }
  return scope;
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                      */
/* -------------------------------------------------------------------------- */

export async function listExternalRoles(): Promise<ExternalRoleView[]> {
  const rows = await prisma.externalRole.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { access: true } } } });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions as ExternalPermission[],
    builtIn: row.builtIn,
    grants: row._count.access,
  }));
}

const roleSchema = z.object({
  name: z.string().trim().min(1, msg('Name the role.')).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: z.array(z.enum(EXTERNAL_PERMISSIONS as [ExternalPermission, ...ExternalPermission[]])).max(20),
});

export async function saveExternalRole(id: string | null, input: unknown, actorId: string): Promise<ExternalRoleView> {
  const parsed = roleSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation(parsed.error.issues[0]?.message ?? 'The role is not complete.');
  const permissions = [...new Set(parsed.data.permissions)];
  const before = id ? await prisma.externalRole.findUnique({ where: { id } }) : null;
  if (id && !before) throw EpmError.notFound('That role');
  const saved = await withAudit(
    (tx) =>
      id
        ? tx.externalRole.update({ where: { id }, data: { name: parsed.data.name, description: parsed.data.description ?? null, permissions } })
        : tx.externalRole.create({ data: { name: parsed.data.name, description: parsed.data.description ?? null, permissions } }),
    (row) => ({
      actorId,
      entityType: 'external-role',
      entityId: row.id,
      action: id ? 'external.role.updated' : 'external.role.created',
      summary: message('External role {name} saved: {permissions}.', { name: row.name, permissions: permissions.join(', ') || '—' }),
      before: before ? { name: before.name, permissions: before.permissions } : null,
      after: { name: row.name, permissions },
    }),
  ).catch((error: unknown) => {
    if ((error as { code?: string }).code === 'P2002') throw EpmError.conflict('There is already a role with that name.');
    throw error;
  });
  forgetExternal();
  return (await listExternalRoles()).find((role) => role.id === saved.id)!;
}

export async function deleteExternalRole(id: string, actorId: string): Promise<void> {
  const role = await prisma.externalRole.findUnique({ where: { id }, include: { _count: { select: { access: true } } } });
  if (!role) throw EpmError.notFound('That role');
  if (role._count.access > 0) throw EpmError.conflict('People hold this role: move them to another first.');
  await withAudit(
    (tx) => tx.externalRole.delete({ where: { id } }),
    () => ({ actorId, entityType: 'external-role', entityId: id, action: 'external.role.deleted', summary: message('External role {name} removed.', { name: role.name }) }),
  );
}

/* -------------------------------------------------------------------------- */
/* Access                                                                     */
/* -------------------------------------------------------------------------- */

export async function listExternalAccess(): Promise<ExternalAccessView[]> {
  const rows = await prisma.externalAccess.findMany({ include: { role: true }, orderBy: { grantedAt: 'desc' } });
  const [users, projects] = await Promise.all([
    runAsSystem(() => openProject.getAll<{ id: number; name: string }>('/users', { pageSize: 1000 })).catch(() => ({ items: [] as { id: number; name: string }[] })),
    runAsSystem(() => openProject.getAll<{ id: number; name: string }>('/projects', { pageSize: 1000 })).catch(() => ({ items: [] as { id: number; name: string }[] })),
  ]);
  const userName = new Map(users.items.map((user) => [String(user.id), user.name]));
  const projectName = new Map(projects.items.map((project) => [project.id, project.name]));
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    userName: userName.get(row.userId) ?? `#${row.userId}`,
    projectId: String(row.projectId),
    projectName: projectName.get(row.projectId) ?? `#${row.projectId}`,
    roleId: row.roleId,
    roleName: row.role.name,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt.toISOString(),
  }));
}

interface OpRole {
  id: number | string;
  name: string;
  kind?: string;
  builtin?: boolean;
  permissions?: string[];
}

/** The project role with the fewest permissions that covers what the matrix needs. */
async function leastRoleFor(permissions: ExternalPermission[]): Promise<string> {
  const roles = await runAsSystem(() => openProject.request<OpRole[]>('/epm_admin/roles', { root: true }));
  const needs = permissions.flatMap((permission) => NEEDS[permission] ?? []);
  const fits = roles
    .filter((role) => role.kind === 'project' && !role.builtin && role.name !== 'EPM Automation')
    .filter((role) => (role.permissions ?? []).includes('view_work_packages'))
    .filter((role) => needs.every((anyOf) => anyOf.some((permission) => (role.permissions ?? []).includes(permission))))
    .sort((a, b) => (a.permissions?.length ?? 0) - (b.permissions?.length ?? 0));
  if (!fits[0]) throw EpmError.validation('No project role allows what this external role does: add one in the project roles first.');
  return String(fits[0].id);
}

const grantSchema = z.object({
  userId: z.union([z.string(), z.number()]).transform(String),
  projectId: z.union([z.string(), z.number()]).transform(Number),
  roleId: z.string().min(1),
});

/** Gives an external user a role on a project — making them external, and a member of it upstream. */
export async function grantExternalAccess(input: unknown, actorId: string): Promise<ExternalAccessView> {
  const parsed = grantSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('Choose the person, the project and the role.');
  const { userId, projectId, roleId } = parsed.data;
  if (userId === actorId) throw EpmError.validation('You cannot make yourself external.');
  const [role, user] = await Promise.all([
    prisma.externalRole.findUnique({ where: { id: roleId } }),
    runAsSystem(() => openProject.request<{ id: number; name: string; admin?: boolean }>(`/users/${userId}`)).catch(() => null),
  ]);
  if (!role) throw EpmError.notFound('That role');
  if (!user) throw EpmError.notFound('That person');
  if (user.admin) throw EpmError.validation('An administrator cannot be an external user.');

  // A member of the project upstream, with the least privileged role that covers the matrix.
  const memberships = await runAsSystem(() =>
    openProject.getAll<{ id: number; _links: { roles?: { href?: string }[] } }>('/memberships', {
      filters: [
        { field: 'project', operator: '=', values: [String(projectId)] },
        { field: 'principal', operator: '=', values: [userId] },
      ],
      pageSize: 10,
    }),
  );
  let membershipCreated = false;
  const roleIdUpstream = await leastRoleFor(role.permissions as ExternalPermission[]);
  if (memberships.items[0]) {
    // An external user's membership is what their external role needs, no more: changing the role changes it.
    await runAsSystem(() =>
      openProject.request(`/memberships/${memberships.items[0]!.id}`, {
        method: 'PATCH',
        body: { _links: { roles: [{ href: `/api/v3/roles/${roleIdUpstream}` }] } },
      }),
    );
  } else {
    await runAsSystem(() =>
      openProject.request('/memberships', {
        method: 'POST',
        body: {
          _links: {
            project: { href: `/api/v3/projects/${projectId}` },
            principal: { href: `/api/v3/users/${userId}` },
            roles: [{ href: `/api/v3/roles/${roleIdUpstream}` }],
          },
        },
      }),
    );
    membershipCreated = true;
  }

  const row = await withAudit(
    async (tx) => {
      await tx.userProfile.upsert({ where: { openProjectId: userId }, create: { openProjectId: userId, external: true }, update: { external: true } });
      return tx.externalAccess.upsert({
        where: { userId_projectId: { userId, projectId } },
        create: { userId, projectId, roleId, grantedBy: actorId },
        update: { roleId, grantedBy: actorId, grantedAt: new Date() },
      });
    },
    () => ({
      actorId,
      projectId: String(projectId),
      entityType: 'external-access',
      entityId: userId,
      action: 'external.access.granted',
      summary: message('{user} given external access to project #{project} as {role}.', { user: user.name, project: projectId, role: role.name }),
      after: { userId, projectId, roleId, membershipCreated },
    }),
  );
  forgetExternal(userId);
  return (await listExternalAccess()).find((entry) => entry.id === row.id)!;
}

/** Takes a project away from an external user, and their membership of it. They stay external. */
export async function revokeExternalAccess(id: string, actorId: string): Promise<void> {
  const row = await prisma.externalAccess.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That access');
  const memberships = await runAsSystem(() =>
    openProject.getAll<{ id: number }>('/memberships', {
      filters: [
        { field: 'project', operator: '=', values: [String(row.projectId)] },
        { field: 'principal', operator: '=', values: [row.userId] },
      ],
      pageSize: 10,
    }),
  ).catch(() => ({ items: [] as { id: number }[] }));
  for (const membership of memberships.items) {
    await runAsSystem(() => openProject.request(`/memberships/${membership.id}`, { method: 'DELETE' })).catch(() => undefined);
  }
  await withAudit(
    (tx) => tx.externalAccess.delete({ where: { id } }),
    () => ({
      actorId,
      projectId: String(row.projectId),
      entityType: 'external-access',
      entityId: row.userId,
      action: 'external.access.revoked',
      summary: message('External access of #{user} to project #{project} removed.', { user: row.userId, project: row.projectId }),
      before: { userId: row.userId, projectId: row.projectId, roleId: row.roleId },
    }),
  );
  forgetExternal(row.userId);
}

/** Turns an external user back into an internal one — only once they hold no external access. */
export async function setExternal(userId: string, external: boolean, actorId: string): Promise<void> {
  if (!external && (await prisma.externalAccess.count({ where: { userId } })) > 0) {
    throw EpmError.conflict('Remove their external access first.');
  }
  await withAudit(
    (tx) => tx.userProfile.upsert({ where: { openProjectId: userId }, create: { openProjectId: userId, external }, update: { external } }),
    () => ({
      actorId,
      entityType: 'user',
      entityId: userId,
      action: external ? 'external.user.marked' : 'external.user.unmarked',
      summary: external ? message('#{user} made an external user.', { user: userId }) : message('#{user} made an internal user again.', { user: userId }),
    }),
  );
  forgetExternal(userId);
}

