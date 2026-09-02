import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import { optional, prisma } from '../db/prisma.js';
import { getUsers } from '../mapping/users.js';
import { durationToHours } from '../lib/duration.js';
import type { OpMembership, OpPrincipal, OpTimeEntry } from '../openproject/types.js';
import type { EpmTeam, TeamMemberWorkload } from '../types/epm.js';

/**
 * Teams are OpenProject groups. This instance defines none, so `/teams` returns
 * an empty list — the UI's empty state is the correct thing to show, rather
 * than inventing a team structure that does not exist.
 */

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function loadTeams(signal: AbortSignal): Promise<EpmTeam[]> {
  const groups = await openProject
    .getAll<OpPrincipal>('/groups', { pageSize: 100 }, { signal })
    .catch(() => ({ items: [] as OpPrincipal[] }));

  if (groups.items.length === 0) return [];

  const [memberships, overlays] = await Promise.all([
    openProject
      .getAll<OpMembership>('/memberships', { pageSize: 100 }, { signal })
      .catch(() => ({ items: [] as OpMembership[] })),
    optional(() => prisma.teamProfile.findMany(), []),
  ]);

  const overlayById = new Map(overlays.map((row) => [row.openProjectId, row]));

  const projectsByPrincipal = new Map<string, string[]>();
  for (const membership of memberships.items) {
    const principalId = linkId(membership._links, 'principal');
    const projectId = linkId(membership._links, 'project');
    if (!principalId || !projectId) continue;
    const existing = projectsByPrincipal.get(principalId) ?? [];
    if (!existing.includes(projectId)) existing.push(projectId);
    projectsByPrincipal.set(principalId, existing);
  }

  return groups.items.map((group): EpmTeam => {
    const id = String(group.id);
    const overlay = overlayById.get(id);
    const memberLinks = group._links?.members;
    const memberIds = (Array.isArray(memberLinks) ? memberLinks : memberLinks ? [memberLinks] : [])
      .map((link) => link.href?.split('/').pop())
      .filter((value): value is string => Boolean(value));

    return {
      id,
      name: group.name,
      slug: overlay?.slug ?? slugify(group.name),
      description: overlay?.description ?? '',
      leadId: overlay?.leadId ?? '',
      memberIds,
      projectIds: [...new Set(memberIds.flatMap((member) => projectsByPrincipal.get(member) ?? []))],
      // Capacity and sprint progress need a EPM-side capacity model and
      // sprints; neither exists on this instance.
      capacity: 0,
      sprintProgress: 0,
    };
  });
}

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/teams', async (request) => loadTeams(requestSignal(request)));

  app.get('/teams/workloads', async (request) => {
    const signal = requestSignal(request);
    const { teamId } = z.object({ teamId: z.string().optional() }).parse(request.query);

    const [users, teams] = await Promise.all([getUsers(signal), loadTeams(signal)]);

    const scoped = teamId
      ? users.filter((user) => teams.find((team) => team.id === teamId)?.memberIds.includes(user.id))
      : users;

    const [timeEntries, profiles] = await Promise.all([
      openProject
        .getAll<OpTimeEntry>('/time_entries', { pageSize: 100 }, { signal })
        .catch(() => ({ items: [] as OpTimeEntry[] })),
      optional(() => prisma.userProfile.findMany(), []),
    ]);

    const capacityById = new Map(profiles.map((row) => [row.openProjectId, row.hoursCapacity]));

    const hoursByUser = new Map<string, number>();
    for (const entry of timeEntries.items) {
      const userId = linkId(entry._links, 'user');
      if (!userId) continue;
      hoursByUser.set(userId, (hoursByUser.get(userId) ?? 0) + (durationToHours(entry.hours) ?? 0));
    }

    const assigned = await Promise.all(
      scoped.map(async (user) => {
        const collection = await openProject
          .getCollection<unknown>(
            '/work_packages',
            {
              filters: [
                { field: 'assignee', operator: '=', values: [user.id] },
                { field: 'status', operator: 'o', values: [] },
              ],
              pageSize: 1,
            },
            signal,
          )
          .catch(() => ({ total: 0 }));
        return { user, open: collection.total ?? 0 };
      }),
    );

    return assigned.map(({ user, open }): TeamMemberWorkload => {
      const capacity = capacityById.get(user.id) ?? 40;
      const logged = hoursByUser.get(user.id) ?? 0;
      return {
        userId: user.id,
        allocation: capacity > 0 ? Math.min(100, Math.round((logged / capacity) * 100)) : 0,
        assignedTasks: open,
        // Requires sprints, which this instance has none of.
        completedThisSprint: 0,
        hoursLogged: Math.round(logged * 100) / 100,
        hoursCapacity: capacity,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/teams/:id', async (request) => {
    const teams = await loadTeams(requestSignal(request));
    const team = teams.find((candidate) => candidate.id === request.params.id);
    if (!team) throw EpmError.notFound('That team');
    return team;
  });
};
