import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { getUsers } from '../mapping/users.js';
import { linkId, openProject } from '../openproject/client.js';
import { optional, prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { requestSignal } from '../lib/request-signal.js';
import { CAPACITY_DEFAULT, listTeamMembers, memberIdsOfTeam } from '../domain/employees.js';
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
 * `/teams/workloads` is about people rather than teams — the project team tab
 * calls it with no team at all. Its `teamId` filter now works, because employee
 * mapping supplies membership; before that there was nothing to scope by.
 */

/**
 * Monday to Sunday around today, as `[from, to]` dates.
 *
 * The window has to match the capacity period, or the ratio between them means
 * nothing.
 */
function currentWeek(): [string, string] {
  const today = new Date();
  const day = today.getUTCDay();
  // getUTCDay is 0 for Sunday, which belongs to the week that started six days
  // earlier rather than to the one starting today.
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - (day === 0 ? 6 : day - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return [iso(monday), iso(sunday)];
}

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
    const { teamId } = z.object({ teamId: z.string().optional() }).parse(request.query);

    const everyone = await getUsers(signal);

    // Scoping changes only which people are measured. Each person's numbers are
    // computed from their own work packages and time entries exactly as before,
    // so nothing about a team enters the arithmetic. A team with no members
    // yields an empty list, which is the honest answer.
    const users = teamId
      ? await memberIdsOfTeam(teamId).then((ids) => {
          const members = new Set(ids);
          return everyone.filter((user) => members.has(user.id));
        })
      : everyone;

    // Scoped to the current week, because capacity is weekly. Fetching every
    // entry ever recorded and dividing that by a weekly figure is what this did
    // before, which made a year of logged time read as permanent overload — and
    // the clamp below used to hide it.
    const [timeEntries, profiles] = await Promise.all([
      openProject
        .getAll<OpTimeEntry>(
          '/time_entries',
          {
            filters: [{ field: 'spent_on', operator: '<>d', values: currentWeek() }],
            pageSize: 100,
          },
          { signal },
        )
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
      const capacity = capacityById.get(user.id) ?? CAPACITY_DEFAULT;
      const logged = hoursByUser.get(user.id) ?? 0;

      return {
        userId: user.id,
        // Null rather than a number when there is no capacity to divide by.
        // Zero would read as "nothing logged", which is a different claim, and
        // a percentage of nothing is not a percentage.
        allocation: capacity > 0 ? Math.round((logged / capacity) * 100) : null,
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

  /**
   * People mapped to a team.
   *
   * Membership comes from EPM's employee mapping — never from OpenProject
   * groups, which is what teams used to be read from.
   */
  app.get<{ Params: { id: string } }>('/teams/:id/members', async (request) => {
    return listTeamMembers(request.params.id, requestSignal(request));
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
