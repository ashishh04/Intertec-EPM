import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { requestSignal } from '../lib/request-signal.js';
import {
  createDepartment,
  getDepartment,
  listDepartments,
  deleteDepartment,
  setDepartmentActive,
  updateDepartment,
  type DepartmentInput,
} from '../domain/departments.js';

/**
 * Departments.
 *
 * The first route file that never reaches OpenProject for its own data. EPM
 * owns departments outright; upstream is consulted only to resolve a manager's
 * name, and that happens in the domain module.
 *
 * Reading is open to any signed-in user, like the catalogue routes — a
 * department is organisational reference data, and hiding the list would break
 * every picker that needs it. Writing needs `departments:manage`, which
 * OpenProject cannot grant because it has no concept of a department; it comes
 * from EPM's own grants instead. See `auth/grants.ts`.
 */

export const departmentRoutes: FastifyPluginAsync = async (app) => {
  /** Every department. Inactive ones are excluded unless asked for. */
  app.get<{ Querystring: { includeInactive?: string } }>('/departments', async (request) => {
    return listDepartments(
      { includeInactive: request.query.includeInactive === 'true' },
      requestSignal(request),
    );
  });

  app.get<{ Params: { id: string } }>('/departments/:id', async (request) => {
    return getDepartment(request.params.id, requestSignal(request));
  });

  app.post<{ Body: DepartmentInput }>('/departments', async (request, reply) => {
    await guard.require(request, 'departments:manage');

    const created = await createDepartment(request.body ?? {}, requestSignal(request));

    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string }; Body: DepartmentInput }>(
    '/departments/:id',
    async (request) => {
      await guard.require(request, 'departments:manage');

      return updateDepartment(request.params.id, request.body ?? {}, requestSignal(request));
    },
  );

  /** Deactivate. Named for the project convention, which archives rather than deletes. */
  app.patch<{ Params: { id: string } }>('/departments/:id/archive', async (request) => {
    await guard.require(request, 'departments:manage');

    return setDepartmentActive(request.params.id, false, requestSignal(request));
  });

  app.patch<{ Params: { id: string } }>('/departments/:id/restore', async (request) => {
    await guard.require(request, 'departments:manage');

    return setDepartmentActive(request.params.id, true, requestSignal(request));
  });

  /**
   * Deletes a department for good.
   *
   * Archiving is still the ordinary lifecycle; this is for one created by
   * mistake. Refused while anything references it, rather than detaching people
   * or teams to make it succeed.
   */
  app.delete<{ Params: { id: string } }>('/departments/:id', async (request, reply) => {
    await guard.require(request, 'departments:manage');

    await deleteDepartment(request.params.id);
    reply.code(204);
  });
};
