import type { FastifyPluginAsync } from 'fastify';

import { anywhere } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { env } from '../config/env.js';
import { recordAuditQuietly } from '../domain/audit.js';
import {
  lastCompletedRun,
  projectCriticalPath,
  scheduleStatus,
  startSchedulePass,
  workPackageSchedule,
} from '../domain/schedule.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';

/**
 * Critical path and float (BRQ-01).
 *
 * Read from EPM's own records of the last pass over the network, each with the
 * caller's access applied the way the work itself is: a project's figures to
 * whoever may view its work packages, a work package's to whoever may view it.
 * `near` is the near-critical threshold in working days, for this read only.
 */

const numeric = (value: string, what: string) => {
  if (!/^\d+$/.test(value)) throw EpmError.notFound(what);
  return value;
};

export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  /** Every scheduled item of a project with its float, and the relations between them (BR-102). */
  app.get<{ Params: { id: string }; Querystring: { near?: string } }>(
    '/projects/:id/critical-path',
    async (request) => {
      const id = numeric(request.params.id, `Project ${request.params.id}`);
      await guard.require(request, 'task:view', id);
      return projectCriticalPath(id, request.query.near);
    },
  );

  /** One work package's dates, float and driving relations (BR-103). */
  app.get<{ Params: { id: string }; Querystring: { near?: string } }>(
    '/work-packages/:id/schedule',
    async (request) => {
      const id = numeric(request.params.id, `Work package ${request.params.id}`);
      await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));
      return workPackageSchedule(id, request.query.near);
    },
  );

  /** How the passes are going: the last one, how long it took, what it found (BR-104). */
  app.get('/schedule/status', async (request) => {
    if (!anywhere(await guard.permissionsFor(request), 'task:view')) {
      throw EpmError.forbidden('You do not have permission to view work packages.');
    }
    return scheduleStatus();
  });

  /**
   * Recalculates now. Waits for the pass while the network is small enough
   * for that to be quick, as a read does; above `EPM_SCHEDULE_SYNC_LIMIT` it
   * answers 202 at once and the pass carries on. For administrators — the
   * pass covers every project — and guarded as the Administration area is,
   * on `users:manage`: instance administration has no capability of its own
   * upstream.
   */
  app.post('/schedule/recalculate', async (request, reply) => {
    await guard.require(request, 'users:manage');
    if (!env.EPM_SCHEDULE_ENABLED) throw EpmError.conflict('The critical path is switched off on this server.');

    const last = await lastCompletedRun();
    const pass = startSchedulePass('manual');
    await recordAuditQuietly([
      {
        actorId: request.auth!.userId,
        entityType: 'schedule',
        entityId: 'network',
        action: 'schedule.recalculated',
        summary: message('Asked for the critical path and float to be recalculated now.'),
      },
    ]);
    if ((last?.workPackages ?? 0) > env.EPM_SCHEDULE_SYNC_LIMIT) {
      void pass.catch(() => undefined);
      reply.code(202);
      return scheduleStatus();
    }
    await pass;
    return scheduleStatus();
  });
};
