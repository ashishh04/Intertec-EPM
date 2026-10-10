import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { allows } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import {
  applyLevelling,
  discardLevelling,
  getLevellingRun,
  listLevellingRuns,
  listPins,
  pinOf,
  pinWorkPackage,
  proposeLevelling,
  undoLevelling,
  unpinWorkPackage,
} from '../domain/levelling-store.js';
import {
  addTimeOff,
  allocationOf,
  capacityGrid,
  cellDetail,
  createAllocation,
  createRole,
  deleteAllocation,
  deleteSchedule,
  deleteTimeOff,
  getResourceSettings,
  importHr,
  listAllocations,
  listRoles,
  overAllocations,
  personAvailability,
  reconcileHr,
  saveResourceSettings,
  setPersonRole,
  setSchedule,
  updateAllocation,
  updateRole,
  updateTimeOff,
  type GridQuery,
} from '../domain/resources-store.js';
import { EpmError } from '../lib/errors.js';

/**
 * Resources and capacity (Module 6: BR-110 to BR-112, BR-312 to BR-315).
 *
 * Who may do what:
 * - Seeing everyone's load across every project — the heatmap, over-allocation,
 *   levelling — is `resources:plan`: it reads work in projects the planner may
 *   not belong to. Levelling still moves only work they may edit.
 * - People's availability — schedules, time off, the HR source — and roles are
 *   people data: `employees:manage`. A person may read their own.
 * - The thresholds and what is billable are policy: `resources:configure`.
 * - Booking planned work to a project: a planner, or whoever may edit the project.
 */

const gridQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weeks: z.coerce.number().int().min(1).max(52).optional(),
  group: z.enum(['team', 'role', 'department', 'none']).optional(),
  teamId: z.string().optional(),
  roleId: z.string().optional(),
  departmentId: z.string().optional(),
  placeholders: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

const numeric = (value: string, what: string) => {
  if (!/^\d+$/.test(value)) throw EpmError.notFound(what);
  return value;
};

async function mayPlan(request: FastifyRequest): Promise<boolean> {
  const permissions = await guard.permissionsFor(request);
  return allows(permissions, 'resources:plan') || allows(permissions, 'employees:manage');
}

async function requirePlanner(request: FastifyRequest): Promise<void> {
  if (!(await mayPlan(request))) throw EpmError.forbidden('Planning resources needs the resource planning permission.');
}

/** A planner anywhere, or whoever may edit that project. */
async function requireBooking(request: FastifyRequest, projectId: string): Promise<void> {
  if (await mayPlan(request)) return;
  await guard.require(request, 'project:edit', projectId);
}

export const resourceRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------------------ */
  /* Settings and roles                                                       */
  /* ------------------------------------------------------------------------ */

  app.get('/resources/settings', async () => {
    const [settings, activities] = await Promise.all([
      getResourceSettings(),
      prisma.$queryRawUnsafe<{ activity_id: number; activity_name: string | null }[]>(
        `SELECT DISTINCT activity_id, activity_name FROM analytics.fact_time_entry
          WHERE activity_id IS NOT NULL ORDER BY activity_name`,
      ),
    ]);
    return {
      settings,
      activities: activities.map((row) => ({ id: String(row.activity_id), name: row.activity_name ?? `#${row.activity_id}` })),
    };
  });

  app.put<{ Body: unknown }>('/resources/settings', async (request) => {
    await guard.require(request, 'resources:configure');
    return saveResourceSettings(request.body, request.auth!.userId);
  });

  app.get<{ Querystring: { includeArchived?: string } }>('/resources/roles', async (request) =>
    listRoles(request.query.includeArchived === 'true'),
  );

  app.post<{ Body: unknown }>('/resources/roles', async (request, reply) => {
    await guard.require(request, 'employees:manage');
    reply.code(201);
    return createRole(request.body, request.auth!.userId);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/resources/roles/:id', async (request) => {
    await guard.require(request, 'employees:manage');
    return updateRole(request.params.id, request.body, request.auth!.userId);
  });

  app.patch<{ Params: { id: string }; Body: { roleId?: unknown } }>('/employees/:id/role', async (request) => {
    await guard.require(request, 'employees:manage');
    const id = numeric(request.params.id, 'That person');
    const roleId = request.body?.roleId;
    if (roleId !== null && typeof roleId !== 'string') throw EpmError.validation('roleId is a role, or null for none.');
    return setPersonRole(id, roleId, request.auth!.userId);
  });

  /* ------------------------------------------------------------------------ */
  /* Availability (BR-312)                                                    */
  /* ------------------------------------------------------------------------ */

  app.get<{ Params: { id: string }; Querystring: { from?: string; weeks?: string } }>(
    '/resources/people/:id/availability',
    async (request) => {
      const id = numeric(request.params.id, 'That person');
      const permissions = await guard.permissionsFor(request);
      const manager = allows(permissions, 'employees:manage');
      const self = request.auth!.userId === id;
      if (!manager && !self && !allows(permissions, 'resources:plan')) {
        throw EpmError.forbidden('Planning resources needs the resource planning permission.');
      }
      const query = z
        .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), weeks: z.coerce.number().int().min(1).max(104).optional() })
        .parse(request.query);
      return personAvailability(id, { ...query, full: manager || self });
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>('/resources/people/:id/schedules', async (request) => {
    await guard.require(request, 'employees:manage');
    return setSchedule(numeric(request.params.id, 'That person'), request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string; scheduleId: string } }>('/resources/people/:id/schedules/:scheduleId', async (request, reply) => {
    await guard.require(request, 'employees:manage');
    await deleteSchedule(numeric(request.params.id, 'That person'), request.params.scheduleId, request.auth!.userId);
    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/resources/people/:id/time-off', async (request, reply) => {
    await guard.require(request, 'employees:manage');
    reply.code(201);
    return addTimeOff(numeric(request.params.id, 'That person'), request.body, request.auth!.userId);
  });

  app.patch<{ Params: { id: string; entryId: string }; Body: unknown }>('/resources/people/:id/time-off/:entryId', async (request) => {
    await guard.require(request, 'employees:manage');
    return updateTimeOff(numeric(request.params.id, 'That person'), request.params.entryId, request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string; entryId: string } }>('/resources/people/:id/time-off/:entryId', async (request, reply) => {
    await guard.require(request, 'employees:manage');
    await deleteTimeOff(numeric(request.params.id, 'That person'), request.params.entryId, request.auth!.userId);
    reply.code(204);
  });

  app.post<{ Body: unknown }>('/resources/hr/import', async (request) => {
    await guard.require(request, 'employees:manage');
    return importHr(request.body, request.auth!.userId);
  });

  app.post<{ Body: unknown }>('/resources/hr/reconcile', async (request) => {
    await guard.require(request, 'employees:manage');
    return reconcileHr(request.body);
  });

  /* ------------------------------------------------------------------------ */
  /* Planned allocations (BR-313)                                             */
  /* ------------------------------------------------------------------------ */

  app.get<{ Querystring: { projectId?: string; personId?: string; placeholderId?: string; roleId?: string } }>(
    '/resources/allocations',
    async (request) => {
      if (!(await mayPlan(request))) {
        const projectId = request.query.projectId;
        if (!projectId) throw EpmError.forbidden('Planning resources needs the resource planning permission.');
        await guard.require(request, 'task:view', numeric(projectId, 'That project'));
      }
      return listAllocations(request.query);
    },
  );

  app.post<{ Body: { projectId?: unknown } }>('/resources/allocations', async (request, reply) => {
    const projectId = String(request.body?.projectId ?? '');
    await requireBooking(request, numeric(projectId, 'That project'));
    reply.code(201);
    return createAllocation(request.body, request.auth!.userId);
  });

  app.patch<{ Params: { id: string }; Body: { projectId?: unknown } }>('/resources/allocations/:id', async (request) => {
    const existing = await allocationOf(request.params.id);
    if (!existing) throw EpmError.notFound('That booking');
    await requireBooking(request, String(existing.projectId));
    if (request.body?.projectId !== undefined) await requireBooking(request, numeric(String(request.body.projectId), 'That project'));
    return updateAllocation(request.params.id, request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/resources/allocations/:id', async (request, reply) => {
    const existing = await allocationOf(request.params.id);
    if (!existing) throw EpmError.notFound('That booking');
    await requireBooking(request, String(existing.projectId));
    await deleteAllocation(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /* ------------------------------------------------------------------------ */
  /* The heatmap, the forecast and over-allocation (BR-110, BR-313, BR-314)   */
  /* ------------------------------------------------------------------------ */

  app.get('/resources/capacity', async (request) => {
    await requirePlanner(request);
    return capacityGrid(gridQuery.parse(request.query) as GridQuery);
  });

  app.get('/resources/capacity/cell', async (request) => {
    await requirePlanner(request);
    const query = gridQuery
      .extend({ key: z.string().min(1).max(200), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(request.query);
    const { key, week, ...rest } = query;
    return cellDetail(key, week, rest as GridQuery);
  });

  app.get('/resources/over-allocations', async (request) => {
    await requirePlanner(request);
    return overAllocations(gridQuery.parse(request.query) as GridQuery);
  });

  /* ------------------------------------------------------------------------ */
  /* Levelling (BR-111, BR-112)                                               */
  /* ------------------------------------------------------------------------ */

  app.get<{ Querystring: { limit?: string } }>('/resources/levelling', async (request) => {
    await requirePlanner(request);
    return listLevellingRuns(Number(request.query.limit ?? 20) || 20);
  });

  app.post<{ Body: unknown }>('/resources/levelling', async (request, reply) => {
    await requirePlanner(request);
    const permissions = await guard.permissionsFor(request);
    const run = await proposeLevelling(request.body, {
      id: request.auth!.userId,
      mayEdit: (projectId) => allows(permissions, 'task:edit', String(projectId)),
    });
    reply.code(201);
    return run;
  });

  app.get<{ Params: { id: string } }>('/resources/levelling/:id', async (request) => {
    await requirePlanner(request);
    return getLevellingRun(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/resources/levelling/:id/apply', async (request) => {
    await requirePlanner(request);
    return applyLevelling(request.params.id, request.auth!.userId);
  });

  app.post<{ Params: { id: string } }>('/resources/levelling/:id/undo', async (request) => {
    await requirePlanner(request);
    return undoLevelling(request.params.id, request.auth!.userId);
  });

  app.post<{ Params: { id: string } }>('/resources/levelling/:id/discard', async (request) => {
    await requirePlanner(request);
    return discardLevelling(request.params.id, request.auth!.userId);
  });

  /* ------------------------------------------------------------------------ */
  /* Pins (BR-111)                                                            */
  /* ------------------------------------------------------------------------ */

  app.get<{ Querystring: { projectId?: string } }>('/resources/pins', async (request) => {
    const projectId = request.query.projectId;
    if (projectId) await guard.require(request, 'task:view', numeric(projectId, 'That project'));
    else await requirePlanner(request);
    return listPins(projectId);
  });

  app.get<{ Params: { id: string } }>('/work-packages/:id/pin', async (request) => {
    const id = numeric(request.params.id, 'That work package');
    const projectId = await guard.projectOfWorkPackage(request, id);
    await guard.require(request, 'task:view', projectId);
    return { pin: await pinOf(id) };
  });

  app.put<{ Params: { id: string }; Body: { reason?: unknown } }>('/work-packages/:id/pin', async (request) => {
    const id = numeric(request.params.id, 'That work package');
    const projectId = await guard.projectOfWorkPackage(request, id);
    await guard.require(request, 'task:edit', projectId);
    const reason = typeof request.body?.reason === 'string' ? request.body.reason : null;
    return { pin: await pinWorkPackage(id, reason, request.auth!.userId) };
  });

  app.delete<{ Params: { id: string } }>('/work-packages/:id/pin', async (request, reply) => {
    const id = numeric(request.params.id, 'That work package');
    const projectId = await guard.projectOfWorkPackage(request, id);
    await guard.require(request, 'task:edit', projectId);
    await unpinWorkPackage(id, request.auth!.userId);
    reply.code(204);
  });
};
