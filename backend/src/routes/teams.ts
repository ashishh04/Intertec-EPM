import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { getUsers } from '../mapping/users.js';
import { linkId, openProject } from '../openproject/client.js';
import { optional, prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { requestSignal } from '../lib/request-signal.js';
import {
  createTeam,
  getTeam,
  listTeams,
  setTeamActive,
  updateTeam,
  type TeamInput,
} from '../domain/teams.js';
import type { OpTimeEntry } from '../openproject/types.js';
import type { TeamMemberWorkload } from '../types/epm.js';

/**
 * Teams.
 *
 * EPM-owned. These were previously a reading of OpenProject groups — which
 * could carry neither a department, a code, nor a lifecycle of their own, and
 * of which this instance defined none, so the feature was permanently empty.
 *
 * Reading is open to any signed-in caller, as for departments: teams are
 * organisational reference data that pickers elsewhere need. Writing requires
 * `teams:manage`, which OpenProject cannot grant because a team is not one of
 * its concepts; it comes from EPM's own grants. See `auth/grants.ts`.
 *
 * `/teams/workloads` is unchanged and deliberately kept. Despite the path it is
 * about people rather than teams — the project team tab calls it with no team —
 * and it does not touch anything above.
 */

export const teamRoutes: FastifyPluginAsync = async (app) => {
  /** Teams, optionally within one department. Inactive excluded unless asked for. */
  app.get<{ Querystring: { departmentId?: string; includeInactive?: string } }>(
    '/teams',
    async (request) => {
      return listTeams(
        {
          includeInactive: request.query.includeInactive === 'true',
          departmentId: request.query.departmentId || undefined,
        },
        requestSignal(request),
      );
    },
  );

  /**
   * Workload per person.
   *
   * Registered before `/teams/:id` so the literal path is not captured as an id.
   */
  app.get('/teams/workloads', async (request) => {
    const signal = requestSignal(request);
    // Team membership belongs to Employee Mapping and does not exist yet, so
    // there is nothing to scope by; the parameter is accepted and ignored
    // rather than silently returning an empty list for a plausible-looking call.
    z.object({ teamId: z.string().optional() }).parse(request.query);

    const users = await getUsers(signal);

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
      users.map(async (user) => {
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
    return getTeam(request.params.id, requestSignal(request));
  });

  app.post<{ Body: TeamInput }>('/teams', async (request, reply) => {
    await guard.require(request, 'teams:manage');

    const created = await createTeam(request.body ?? {}, requestSignal(request));

    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string }; Body: TeamInput }>('/teams/:id', async (request) => {
    await guard.require(request, 'teams:manage');

    return updateTeam(request.params.id, request.body ?? {}, requestSignal(request));
  });

  /** Deactivate. Named for the convention departments and projects already use. */
  app.patch<{ Params: { id: string } }>('/teams/:id/archive', async (request) => {
    await guard.require(request, 'teams:manage');

    return setTeamActive(request.params.id, false, requestSignal(request));
  });

  app.patch<{ Params: { id: string } }>('/teams/:id/restore', async (request) => {
    await guard.require(request, 'teams:manage');

    return setTeamActive(request.params.id, true, requestSignal(request));
  });
};
