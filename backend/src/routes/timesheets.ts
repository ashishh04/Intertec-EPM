import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { allows } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import { POLICY_NAMES, getTimeSettings, saveTimeSettings } from '../domain/time-rules.js';
import {
  managedPeople,
  reopenTimesheet,
  submitTimesheet,
  timesheetById,
  timesheetHistory,
  timesheetOverview,
  timesheetView,
  withdrawTimesheet,
  type TimesheetViewer,
} from '../domain/timesheets-store.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { requestLanguage, t } from '../lib/i18n.js';

/**
 * Timesheets and the time rules (Module 10: BR-304 to BR-306, BR-317).
 *
 * Everyone has their own timesheet. A line manager — team lead or department
 * manager — reads the timesheets of the people they manage; whoever holds
 * `timesheets:manage` reads everyone's and may reopen an approved one; the
 * approvers named on a request read the timesheet it is for. The settings are
 * read by anyone signed in, since the screens show the bounds and policies,
 * and changed with `time:configure`.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayQuery = z.object({ day: z.string().regex(DAY).optional() });

async function viewerOf(request: FastifyRequest): Promise<TimesheetViewer> {
  return { id: request.auth!.userId, manage: allows(await guard.permissionsFor(request), 'timesheets:manage') };
}

/** Self, whoever manages timesheets, or the person's line manager. */
async function assertMayReadPerson(viewer: TimesheetViewer, personId: string): Promise<void> {
  if (viewer.id === personId || viewer.manage) return;
  if ((await managedPeople(viewer.id)).has(personId)) return;
  throw EpmError.notFound('That timesheet');
}

export const timesheetRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------- settings */

  app.get('/time/settings', async (request) => {
    const language = requestLanguage(request);
    return {
      settings: await getTimeSettings(),
      policyNames: Object.fromEntries(Object.entries(POLICY_NAMES).map(([key, name]) => [key, t(language, name)])),
    };
  });

  app.put<{ Body: unknown }>('/time/settings', async (request) => {
    await guard.require(request, 'time:configure');
    // The settings alone, or the whole of what GET answers with them inside:
    // reading the rules and saving them back was refused as "not complete".
    const body = request.body as { settings?: unknown; timesheets?: unknown } | null;
    const settings = body && typeof body === 'object' && body.timesheets === undefined && body.settings ? body.settings : body;
    return saveTimeSettings(settings, request.auth!.userId);
  });

  /* ----------------------------------------------------------- timesheets */

  app.get('/timesheets/mine', async (request) => {
    const query = dayQuery.parse(request.query);
    const viewer = await viewerOf(request);
    return timesheetView(viewer.id, query.day ?? todayIso(), viewer);
  });

  /** The caller's own timesheets, newest first. */
  app.get('/timesheets/history', async (request) => timesheetHistory(request.auth!.userId));

  app.get<{ Params: { personId: string } }>('/timesheets/people/:personId', async (request) => {
    const { personId } = request.params;
    if (!/^\d+$/.test(personId)) throw EpmError.notFound('That timesheet');
    const query = dayQuery.parse(request.query);
    const viewer = await viewerOf(request);
    await assertMayReadPerson(viewer, personId);
    return timesheetView(personId, query.day ?? todayIso(), viewer);
  });

  /** Submits the caller's timesheet for the period the day falls in (BR-304). */
  app.post<{ Body: unknown }>('/timesheets/submit', async (request) => {
    const body = z.object({ day: z.string().regex(DAY).optional() }).parse(request.body ?? {});
    const viewerId = request.auth!.userId;
    return submitTimesheet(viewerId, body.day ?? todayIso(), viewerId);
  });

  /**
   * Everyone's timesheets for one period (BR-306): submitted, approved,
   * rejected and outstanding. All of them for `timesheets:manage`; a line
   * manager's own people otherwise.
   */
  app.get('/timesheets/overview', async (request) => {
    const query = z
      .object({
        day: z.string().regex(DAY).optional(),
        status: z.enum(['submitted', 'approved', 'rejected', 'outstanding']).optional(),
        teamId: z.string().max(40).optional(),
        departmentId: z.string().max(40).optional(),
        projectId: z.string().regex(/^\d+$/).optional(),
        personId: z.string().regex(/^\d+$/).optional(),
      })
      .parse(request.query);
    const viewer = await viewerOf(request);
    const scope = viewer.manage ? ('all' as const) : await managedPeople(viewer.id);
    if (scope !== 'all' && scope.size === 0) {
      throw EpmError.forbidden('The timesheet overview is for whoever manages timesheets, and for team leads and department managers.');
    }
    return timesheetOverview({ ...query, day: query.day ?? todayIso() }, scope);
  });

  app.get<{ Params: { id: string } }>('/timesheets/:id', async (request) => {
    const viewer = await viewerOf(request);
    const row = await prisma.timesheet.findUnique({ where: { id: request.params.id }, select: { personId: true, requestId: true } });
    if (!row) throw EpmError.notFound('That timesheet');
    // The approvers asked to decide it read it too.
    const asked = row.requestId
      ? await prisma.approvalTask.count({
          where: { requestId: row.requestId, OR: [{ approverId: viewer.id }, { delegateId: viewer.id }] },
        })
      : 0;
    if (asked === 0) await assertMayReadPerson(viewer, row.personId);
    return timesheetById(request.params.id, viewer);
  });

  app.post<{ Params: { id: string } }>('/timesheets/:id/withdraw', async (request) =>
    withdrawTimesheet(request.params.id, await viewerOf(request)),
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/timesheets/:id/reopen', async (request) =>
    reopenTimesheet(request.params.id, await viewerOf(request), request.body?.reason),
  );
};
