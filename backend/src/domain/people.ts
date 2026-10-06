import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { getUsers } from '../mapping/users.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type { PersonSpec } from '../types/epm.js';

/**
 * Who a rule or an escalation path means, for one item (BR-217, BR-218).
 *
 * "The assignee's team lead" and "the department manager" come from EPM's own
 * organisation data — teams and departments — the same way an approval chain
 * finds a requester's manager. For an approval being escalated, those are the
 * approvers' managers, since an approval is waiting on them.
 */

export interface PersonContext {
  projectId: string;
  assigneeId?: string;
  responsibleId?: string;
  authorId?: string;
  /** Escalating an approval: who it is waiting on. */
  approverIds?: string[];
}

async function membersWithRole(projectId: string, roleId: string): Promise<string[]> {
  const memberships = await openProject.getAll<{ _links?: Record<string, HalLink | HalLink[] | undefined> }>(
    '/memberships',
    { filters: [{ field: 'project', operator: '=', values: [projectId] }] },
  );
  return memberships.items.flatMap((membership) => {
    const principal = membership._links?.principal;
    const href = (Array.isArray(principal) ? principal[0] : principal)?.href ?? '';
    const user = /\/users\/(\d+)$/.exec(href)?.[1];
    if (!user) return [];
    const roles = membership._links?.roles;
    const ids = (Array.isArray(roles) ? roles : roles ? [roles] : []).map((role) => idFromHref(role.href));
    return ids.includes(roleId) ? [user] : [];
  });
}

/** The people a list of specs names, deduplicated. Unknown or departed people are left out. */
export async function resolvePeople(specs: PersonSpec[], context: PersonContext): Promise<string[]> {
  if (specs.length === 0) return [];
  return runAsSystem(async () => {
    const known = new Set((await getUsers()).map((user) => user.id));
    const people = new Set<string>();
    const add = (id: string | null | undefined) => {
      if (id && known.has(id)) people.add(id);
    };
    // Whose manager "the manager" is: the approvers for an approval, else the assignee.
    const subjects = context.approverIds?.length ? context.approverIds : context.assigneeId ? [context.assigneeId] : [];
    let managers: { leadId?: string | null; managerId?: string | null }[] | undefined;
    const loadManagers = async () => {
      managers ??= (
        await prisma.userProfile.findMany({
          where: { openProjectId: { in: subjects } },
          select: { team: { select: { leadId: true } }, departmentRef: { select: { managerId: true } } },
        })
      ).map((profile) => ({ leadId: profile.team?.leadId, managerId: profile.departmentRef?.managerId }));
      return managers;
    };

    for (const spec of specs) {
      switch (spec.kind) {
        case 'user':
          add(spec.userId);
          break;
        case 'assignee':
          add(context.assigneeId);
          break;
        case 'responsible':
          add(context.responsibleId);
          break;
        case 'author':
          add(context.authorId);
          break;
        case 'approvers':
          for (const id of context.approverIds ?? []) add(id);
          break;
        case 'project_owner': {
          const profile = await prisma.projectProfile.findUnique({
            where: { openProjectId: context.projectId },
            select: { ownerId: true },
          });
          add(profile?.ownerId);
          break;
        }
        case 'team_lead':
          for (const one of await loadManagers()) add(one.leadId);
          break;
        case 'department_manager':
          for (const one of await loadManagers()) add(one.managerId);
          break;
        case 'project_role':
          for (const id of await membersWithRole(context.projectId, spec.roleId).catch(() => [])) add(id);
          break;
      }
    }
    return [...people];
  });
}
