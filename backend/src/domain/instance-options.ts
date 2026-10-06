import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { getCatalog } from '../mapping/catalog.js';
import { listProjects } from '../mapping/projects.js';
import { openProject } from '../openproject/client.js';
import type { ApprovalChainOptions } from '../types/epm.js';
import { AUTOMATION_ROLE_NAME } from './automation-account.js';

/**
 * What the policy editors offer — approval chains, rules and escalation
 * policies alike: the instance's types, statuses, priorities, project roles,
 * active projects, portfolios and work package custom fields. Read on the
 * system key, because policy covers every project, not the ones its author
 * happens to be a member of.
 */
export function instanceOptions(): Promise<ApprovalChainOptions> {
  return runAsSystem(async () => {
    const [catalog, roles, projects, portfolios, fields] = await Promise.all([
      getCatalog(),
      openProject.getAll<{ id: number; name: string }>('/roles', { pageSize: 200 }).catch(() => ({ items: [] })),
      listProjects(),
      prisma.portfolio.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      openProject
        .request<{ rows?: { id: number | string; name?: string; fieldFormat?: string }[] }>('/epm_admin/catalog/custom-fields', {
          root: true,
        })
        .catch(() => ({ rows: [] })),
    ]);
    return {
      types: [...catalog.typeById.values()].map(({ id, name }) => ({ id, name })),
      statuses: [...catalog.statusById.values()].map(({ id, name, isClosed }) => ({ id, name, isClosed })),
      priorities: [...catalog.priorityById.values()].map(({ id, name }) => ({ id, name })),
      // Built-in roles for non-members and anonymous users are never project
      // members, and the automation account's role is not one people hold.
      roles: roles.items
        .filter((role) => !/^(non member|anonymous)$/i.test(role.name) && role.name !== AUTOMATION_ROLE_NAME)
        .map((role) => ({ id: String(role.id), name: role.name })),
      projects: projects.filter((project) => project.active).map((project) => ({ id: String(project.id), name: project.name })),
      portfolios,
      customFields: (fields.rows ?? []).map((field) => ({
        id: `customField${field.id}`,
        name: field.name ?? `Custom field ${field.id}`,
        numeric: field.fieldFormat === 'float' || field.fieldFormat === 'int',
      })),
    };
  });
}
