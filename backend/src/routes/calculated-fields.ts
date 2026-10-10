import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { anywhere } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { env } from '../config/env.js';
import {
  calculatedIdle,
  calculatedStatus,
  createCalculatedField,
  deleteCalculatedField,
  formulaReference,
  getCalculatedField,
  lastCompletedCalculatedRun,
  listCalculatedFields,
  noteManualRecalc,
  setCalculatedFieldActive,
  startCalculatedPass,
  updateCalculatedField,
  validateFormula,
  workPackageCalculatedValues,
} from '../domain/calculated-fields.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';

/**
 * Calculated fields (BRQ-04: BR-406 to BR-408).
 *
 * Defining one — creating, changing, switching off, deleting, recalculating —
 * needs `fields:configure`, an EPM permission granted on the EPM permissions
 * page: a formula sets figures on every project's work. Reading the
 * definitions needs only that the caller works with work packages somewhere;
 * a work package's values follow the work package. The values themselves are
 * also in every view, through the OpenProject field each definition writes.
 */

const numeric = (value: string, what: string) => {
  if (!/^\d+$/.test(value)) throw EpmError.notFound(message('Work package {id}', { id: what }));
  return value;
};

/** Anyone who works with work packages somewhere may read the definitions. */
async function requireTaskViewer(request: FastifyRequest): Promise<void> {
  if (!anywhere(await guard.permissionsFor(request), 'task:view')) {
    throw EpmError.forbidden('You do not have permission to view work packages.');
  }
}

export const calculatedFieldRoutes: FastifyPluginAsync = async (app) => {
  /** Every definition, with how many values each holds and how many are empty. */
  app.get('/calculated-fields', async (request) => {
    await requireTaskViewer(request);
    return listCalculatedFields();
  });

  /** What a formula can read and call: for the editor's reference. */
  app.get('/calculated-fields/reference', async (request) => {
    await requireTaskViewer(request);
    return formulaReference();
  });

  /** How the passes are going: the last one, how long it took, what it changed. */
  app.get('/calculated-fields/status', async (request) => {
    await requireTaskViewer(request);
    return calculatedStatus();
  });

  app.get<{ Params: { id: string } }>('/calculated-fields/:id', async (request) => {
    await requireTaskViewer(request);
    return getCalculatedField(request.params.id);
  });

  /**
   * Checks a formula as it is typed — syntax, types, references, circles and
   * the bounds, with positions — and, given a work package the caller can see,
   * works it out there. Never saves anything.
   */
  app.post<{ Body: Record<string, unknown> }>('/calculated-fields/validate', async (request) => {
    await guard.require(request, 'fields:configure');
    const workPackageId = request.body?.workPackageId;
    if (workPackageId !== undefined && workPackageId !== null && workPackageId !== '') {
      const id = numeric(String(workPackageId), String(workPackageId));
      await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));
    }
    return validateFormula({ ...(request.body ?? {}), workPackageId: workPackageId === '' || workPackageId === null ? undefined : workPackageId });
  });

  app.post<{ Body: unknown }>('/calculated-fields', async (request, reply) => {
    await guard.require(request, 'fields:configure');
    const created = await createCalculatedField(request.body, request.auth!.userId);
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/calculated-fields/:id', async (request) => {
    await guard.require(request, 'fields:configure');
    return updateCalculatedField(request.params.id, request.body, request.auth!.userId);
  });

  app.post<{ Params: { id: string } }>('/calculated-fields/:id/deactivate', async (request) => {
    await guard.require(request, 'fields:configure');
    return setCalculatedFieldActive(request.params.id, false, request.auth!.userId);
  });

  app.post<{ Params: { id: string } }>('/calculated-fields/:id/activate', async (request) => {
    await guard.require(request, 'fields:configure');
    return setCalculatedFieldActive(request.params.id, true, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/calculated-fields/:id', async (request, reply) => {
    await guard.require(request, 'fields:configure');
    await deleteCalculatedField(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /**
   * Recalculates every field now, journalled. Waits for the pass while it is
   * quick — up to twenty seconds — and otherwise answers 202 and lets it run.
   */
  app.post('/calculated-fields/recalculate', async (request, reply) => {
    await guard.require(request, 'fields:configure');
    if (!env.EPM_CALCULATED_ENABLED) throw EpmError.conflict('Calculated fields are switched off on this server.');
    await noteManualRecalc(request.auth!.userId);
    const pass = startCalculatedPass('manual');
    const finished = await Promise.race([
      pass.then(() => true).catch(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!finished) {
      reply.code(202);
      return { pending: true };
    }
    await calculatedIdle();
    const last = await lastCompletedCalculatedRun();
    return { ...(await calculatedStatus()), finishedAt: last?.finishedAt?.toISOString() };
  });

  /** One work package's calculated values, each with why it is empty when it is. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/calculated-values', async (request) => {
    const id = numeric(request.params.id, request.params.id);
    await guard.require(request, 'task:view', await guard.projectOfWorkPackage(request, id));
    return workPackageCalculatedValues(Number(id));
  });
};
