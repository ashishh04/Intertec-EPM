import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { referenceCache } from '../lib/cache.js';
import { requestSignal } from '../lib/request-signal.js';
import { setCapacity, setMapping } from '../domain/employees.js';
import { toEpmAccount } from '../mapping/accounts.js';
import { openProject } from '../openproject/client.js';
import type { OpPrincipal } from '../openproject/types.js';
import type { EpmAccount } from '../types/epm.js';

/**
 * User accounts.
 *
 * Accounts are OpenProject's. Every write here goes straight through and EPM
 * stores nothing about the person — no shadow user table, and no id EPM minted.
 *
 * What EPM adds is the second half of the create flow: OpenProject's own new
 * user form cannot capture a department, a team or a weekly capacity, because
 * it has no such concepts. Creating someone here does both in one step, which
 * is the reason this belongs in EPM rather than being a link to the admin
 * console.
 *
 * Authorisation splits by operation, following whichever signal OpenProject
 * actually publishes:
 *
 * - **create** — the global `users:manage` permission, which `ACTION_GRANTS`
 *   already derives from OpenProject's `users/create` and `users/update`
 *   capabilities. No new permission is invented.
 * - **update, lock, unlock, delete** — the affordances on the account itself.
 *   OpenProject varies these by state and reports no capability for any of
 *   them, so the resource is the only honest source. `delete` in particular is
 *   absent unless the instance permits admins to delete users at all.
 */

/** Reads one account, or reports it missing. */
async function accountOf(request: FastifyRequest, id: string): Promise<OpPrincipal> {
  if (!/^\d+$/.test(id)) throw EpmError.notFound('That person');

  const account = await openProject
    .request<OpPrincipal>(`/users/${id}`, { signal: requestSignal(request) })
    .catch(() => null);

  if (!account) throw EpmError.notFound('That person');
  return account;
}

/**
 * Refuses unless OpenProject offered the operation on this very account.
 *
 * Checked against a freshly read resource rather than one the client sent, so a
 * caller cannot assert their own permission.
 */
function requireAffordance(
  account: OpPrincipal,
  link: 'updateImmediately' | 'lock' | 'unlock' | 'delete',
  message: string,
): void {
  if (!account._links || !Object.hasOwn(account._links, link)) throw EpmError.forbidden(message);
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Rejects a payload OpenProject would reject anyway, with a clearer message. */
function requireCreateFields(body: Record<string, unknown>): {
  login: string;
  firstName: string;
  lastName: string;
  email: string;
} {
  const login = text(body.login);
  const firstName = text(body.firstName);
  const lastName = text(body.lastName);
  const email = text(body.email);

  const missing = [
    ['a username', login],
    ['a first name', firstName],
    ['a last name', lastName],
    ['an email address', email],
  ]
    .filter(([, value]) => !value)
    .map(([label]) => label as string);

  if (missing.length > 0) {
    throw EpmError.badRequest(`Creating a person needs ${missing.join(', ')}.`);
  }

  // Not a full RFC check — OpenProject validates properly and its message is
  // the one worth showing. This only catches the obviously wrong.
  if (!email.includes('@')) throw EpmError.badRequest('That email address is not valid.');

  return { login, firstName, lastName, email };
}

export const accountRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The account directory.
   *
   * Behind `users:manage` rather than a read permission: `/users` upstream is
   * admin-only and 403s for anyone else, and this carries logins, emails and
   * account state that the ordinary `/users` directory deliberately omits.
   */
  app.get('/accounts', async (request) => {
    await guard.require(request, 'users:manage');

    const collection = await openProject.getAll<OpPrincipal>(
      '/users',
      { pageSize: 100 },
      { signal: requestSignal(request) },
    );

    return collection.items.map(toEpmAccount).sort((a, b) => a.name.localeCompare(b.name));
  });

  app.get<{ Params: { id: string } }>('/accounts/:id', async (request) => {
    await guard.require(request, 'users:manage');
    return toEpmAccount(await accountOf(request, request.params.id));
  });

  /**
   * Creates a person, and optionally places them in the organisation.
   *
   * `status: invited` deliberately: it is what OpenProject's own form does, it
   * needs no password, and it puts the account in the state where the person
   * sets their own credentials. EPM never handles a password.
   */
  app.post<{ Params: never; Body: Record<string, unknown> }>(
    '/accounts',
    async (request, reply) => {
      await guard.require(request, 'users:manage');

      const body = request.body ?? {};
      const { login, firstName, lastName, email } = requireCreateFields(body);
      const signal = requestSignal(request);

      const created = await openProject.request<OpPrincipal>('/users', {
        method: 'POST',
        body: {
          login,
          firstName,
          lastName,
          email,
          status: 'invited',
          ...(text(body.language) ? { language: text(body.language) } : {}),
          ...(typeof body.admin === 'boolean' ? { admin: body.admin } : {}),
        },
        signal,
      });

      const id = String(created.id);

      // The directory is cached, and a person who does not appear in it cannot
      // be mapped — so it is invalidated before the placement below.
      referenceCache.invalidate('users');

      // The EPM half. Failing here must not leave the caller believing nothing
      // happened: the account exists either way, so the problem is reported
      // against the placement rather than the creation.
      const placementProblems: string[] = [];

      if (text(body.departmentId) || text(body.teamId)) {
        await setMapping(
          id,
          { departmentId: text(body.departmentId), teamId: text(body.teamId) },
          signal,
        ).catch((error: unknown) => {
          placementProblems.push(error instanceof Error ? error.message : 'The placement failed.');
        });
      }

      if (body.hoursCapacity !== undefined && body.hoursCapacity !== null) {
        await setCapacity(id, { hoursCapacity: body.hoursCapacity }, signal).catch(
          (error: unknown) => {
            placementProblems.push(error instanceof Error ? error.message : 'The capacity failed.');
          },
        );
      }

      reply.code(201);

      const account: EpmAccount & { placementProblems?: string[] } = toEpmAccount(created);
      if (placementProblems.length > 0) account.placementProblems = placementProblems;
      return account;
    },
  );

  /** Edits a person's details. Not their password, which EPM never touches. */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/accounts/:id',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'users:manage');
      const account = await accountOf(request, id);

      requireAffordance(account, 'updateImmediately', 'You may not edit this person.');

      const body = request.body ?? {};
      const patch: Record<string, unknown> = {};

      for (const field of ['firstName', 'lastName', 'email', 'login', 'language'] as const) {
        if (body[field] !== undefined) {
          const value = text(body[field]);
          if (!value) throw EpmError.badRequest(`${field} cannot be empty.`);
          patch[field] = value;
        }
      }

      if (typeof body.admin === 'boolean') patch.admin = body.admin;

      if (Object.keys(patch).length === 0) throw EpmError.badRequest('Nothing to change.');

      const updated = await openProject.request<OpPrincipal>(`/users/${id}`, {
        method: 'PATCH',
        body: patch,
        signal: requestSignal(request),
      });

      // Name and email are carried in the cached directory.
      referenceCache.invalidate('users');

      return toEpmAccount(updated);
    },
  );

  /**
   * Deactivates an account.
   *
   * Locking, not deleting: it is reversible, it keeps the person's history
   * intact, and it is the same lifecycle every other archivable thing in EPM
   * uses. An invited account offers no `lock` link upstream, and the refusal
   * here says so rather than letting a 406 surface.
   */
  app.post<{ Params: { id: string } }>('/accounts/:id/lock', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    requireAffordance(account, 'lock', 'This person cannot be deactivated.');

    const locked = await openProject.request<OpPrincipal>(`/users/${id}/lock`, {
      method: 'POST',
      // A body so the client sends a content type; upstream refuses without one.
      body: {},
      signal: requestSignal(request),
    });

    referenceCache.invalidate('users');
    return toEpmAccount(locked);
  });

  /** Reactivates a locked account. */
  app.delete<{ Params: { id: string } }>('/accounts/:id/lock', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    requireAffordance(account, 'unlock', 'This person is not deactivated.');

    const unlocked = await openProject.request<OpPrincipal>(`/users/${id}/lock`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    referenceCache.invalidate('users');
    return toEpmAccount(unlocked);
  });

  /**
   * Deletes a person permanently.
   *
   * Gated on the `delete` affordance, which OpenProject publishes only when the
   * instance allows admins to delete users — off by default. No capability
   * reports this, so the resource is the only source, and offering the action
   * without it would promise something upstream refuses.
   *
   * Upstream returns 202: the work is queued, and the account disappears a
   * moment later rather than immediately. The EPM profile row goes too, since
   * it is keyed on a person who will no longer exist.
   */
  app.delete<{ Params: { id: string } }>('/accounts/:id', async (request, reply) => {
    const { id } = request.params;

    await guard.require(request, 'users:manage');
    const account = await accountOf(request, id);

    requireAffordance(
      account,
      'delete',
      'Deleting people is not enabled on this instance, so this person can only be deactivated.',
    );

    if (id === request.auth?.userId) {
      throw EpmError.badRequest('You cannot delete your own account.');
    }

    await openProject.request<void>(`/users/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    const { prisma } = await import('../db/prisma.js');
    await prisma.userProfile.deleteMany({ where: { openProjectId: id } }).catch(() => undefined);

    referenceCache.invalidate('users');
    reply.code(204);
  });
};
