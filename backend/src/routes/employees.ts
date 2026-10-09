import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { requestSignal } from '../lib/request-signal.js';
import {
  getEmployee,
  listEmployees,
  setCapacity,
  setMapping,
  setRate,
  type CapacityInput,
  type MappingInput,
  type EpmEmployee,
  type RateInput,
} from '../domain/employees.js';

/**
 * A person's hourly rate is pay information (BRL-01): the directory is open to
 * everyone signed in, the rate in it only to those allowed to read rates.
 */
export function withoutRate(employee: EpmEmployee): EpmEmployee {
  const { hourlyRate: _rate, ...rest } = employee;
  return rest;
}

/**
 * Employees.
 *
 * There is no create, no delete, and no way to change a name or an email. A
 * person is not an EPM resource — OpenProject owns identity — so the only thing
 * writable here is the mapping: which department and team they belong to.
 *
 * Reading is open to any signed-in caller, as for departments and teams; the
 * directory itself is already readable at `/users`. The hourly rate in it is
 * not: it is left out unless the caller may read rates. Assigning requires
 * `employees:manage`, which is a different responsibility from designing the org
 * structure and so is a permission of its own. See `auth/grants.ts`.
 */

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  /** The directory with each person's mapping. Unmapped people are included. */
  app.get<{
    Querystring: { departmentId?: string; teamId?: string; unmapped?: string; q?: string };
  }>('/employees', async (request) => {
    const [employees, rates] = await Promise.all([
      listEmployees(
        {
          departmentId: request.query.departmentId || undefined,
          teamId: request.query.teamId || undefined,
          unmapped: request.query.unmapped === 'true',
          q: request.query.q?.trim() || undefined,
        },
        requestSignal(request),
      ),
      guard.mayViewRates(request),
    ]);
    return rates ? employees : employees.map(withoutRate);
  });

  app.get<{ Params: { id: string } }>('/employees/:id', async (request) => {
    const [employee, rates] = await Promise.all([
      getEmployee(request.params.id, requestSignal(request)),
      guard.mayViewRates(request),
    ]);
    return rates ? employee : withoutRate(employee);
  });

  /**
   * Sets department and team together.
   *
   * One request carries the whole mapping, so the pair can be validated against
   * each other and never lands half-applied. Omitting a field, or sending null
   * or an empty string, clears it.
   */
  app.patch<{ Params: { id: string }; Body: MappingInput }>(
    '/employees/:id/mapping',
    async (request) => {
      await guard.require(request, 'employees:manage');

      return setMapping(request.params.id, request.body ?? {}, requestSignal(request));
    },
  );

  /**
   * Sets weekly capacity.
   *
   * Separate from the mapping route rather than folded into it: mapping writes
   * department and team as a unit so the pair can be validated against each
   * other, and a capacity edit that had to restate them would clear a person's
   * placement if a client sent only capacity. Different attribute, different
   * write semantics, same permission — capacity is set by whoever does staffing.
   */
  app.patch<{ Params: { id: string }; Body: CapacityInput }>(
    '/employees/:id/capacity',
    async (request) => {
      await guard.require(request, 'employees:manage');

      return setCapacity(request.params.id, request.body ?? {}, requestSignal(request));
    },
  );

  /**
   * Sets the internal hourly rate the Time & Costs report prices hours at.
   *
   * Same permission as capacity and for the same reason: both are staffing
   * attributes of a person, set by whoever does staffing. Sending `null`
   * clears it, which means "not costed" rather than "costs nothing".
   */
  app.patch<{ Params: { id: string }; Body: RateInput }>(
    '/employees/:id/rate',
    async (request) => {
      await guard.require(request, 'employees:manage');

      return setRate(request.params.id, request.body ?? {}, requestSignal(request));
    },
  );
};
