import type { FastifyPluginAsync } from 'fastify';

import { permissionsFor } from '../auth/guard.js';
import { toNested } from '../auth/permissions.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { prisma } from '../db/prisma.js';
import { referenceCache } from '../lib/cache.js';
import { openProject } from '../openproject/client.js';
import { getCurrentUser, getUsers } from '../mapping/users.js';
import {
  checkPassword,
  getPasswordPolicy,
  type PasswordPolicy,
} from '../domain/password-policy.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The signed-in user plus their effective permissions.
   *
   * Permissions are computed from OpenProject's capabilities for this caller,
   * never assumed. `permissions` is what the UI may offer; `projectPermissions`
   * carries the per-project variation, because a user can be a manager in one
   * project and a reader in another.
   *
   * The upstream system is not named or located here.
   */
  app.get('/me', async (request) => {
    const [user, permissions, profile] = await Promise.all([
      getCurrentUser(requestSignal(request)),
      permissionsFor(request),
      // EPM's own gate, so a failure to read it must not lock anyone out: an
      // unreadable profile means "nothing is being asked of you".
      prisma.userProfile
        .findUnique({
          where: { openProjectId: request.auth?.userId ?? '' },
          select: { mustChangePassword: true },
        })
        .catch(() => null),
    ]);

    const projectPermissions: Record<string, Record<string, Record<string, boolean>>> = {};
    for (const [projectId, set] of permissions.byProject) {
      projectPermissions[projectId] = toNested(set);
    }

    return {
      ...user,
      permissions: toNested(permissions.global),
      projectPermissions,
      mustChangePassword: profile?.mustChangePassword ?? false,
    };
  });

  /**
   * Edits the signed-in person's own name, email and language.
   *
   * Written as that person rather than as an administrator, which is what
   * makes it self-service: OpenProject's own update contract lists firstname,
   * lastname, mail and language as writable by the user themselves, so the
   * instance enforces the rules and EPM needs no elevated rights.
   *
   * The name a person picks is not only theirs to see — it labels every task
   * they are assigned and every team they sit in — so the cached directory is
   * dropped here. Without that, the rest of the product would keep showing the
   * old name until the ten-minute cache expired.
   */
  app.patch<{ Body: Record<string, unknown> }>('/me', async (request) => {
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    const body = request.body ?? {};
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);

    const firstName = text(body.firstName);
    const lastName = text(body.lastName);
    const email = text(body.email);
    const language = text(body.language);
    const timezone = text(body.timezone);

    if (firstName === '' || lastName === '') {
      throw EpmError.badRequest('A first and last name are required.');
    }
    if (email === '') throw EpmError.badRequest('An email address is required.');

    const payload: Record<string, unknown> = {};
    if (firstName !== undefined) payload.firstName = firstName;
    if (lastName !== undefined) payload.lastName = lastName;
    if (email !== undefined) payload.email = email;
    if (language !== undefined) payload.language = language;

    if (Object.keys(payload).length === 0 && timezone === undefined) {
      throw EpmError.badRequest('Nothing to change.');
    }

    if (Object.keys(payload).length > 0) {
      await openProject.request<unknown>(`/users/${userId}`, {
        method: 'PATCH',
        body: payload,
        signal: requestSignal(request),
      });
    }

    // The timezone is a preference rather than an attribute of the account, so
    // it lives behind its own endpoint. The instance validates the value and
    // says so plainly, which is the message worth surfacing.
    if (timezone !== undefined) {
      await openProject.request<unknown>('/users/me/preferences', {
        method: 'PATCH',
        body: { timeZone: timezone },
        signal: requestSignal(request),
      });
    }

    // Both the directory listing and this person's own record are cached.
    referenceCache.invalidatePrefix('users');

    return getCurrentUser(requestSignal(request));
  });

  /**
   * Sets the signed-in person's own password.
   *
   * Written as that person, not as an administrator: the upstream API lets a
   * user change their own credentials, and doing it with their token means EPM
   * never needs elevated rights for a self-service action.
   *
   * Clearing `mustChangePassword` afterwards is the whole point — that flag is
   * what holds a newly created person at the door until the administrator's
   * handover password has been replaced.
   *
   * Rules are the instance's own. They are read from it rather than restated
   * here, so this cannot enforce something the instance does not — or miss
   * something it does. Checking them before the call is what makes the policy
   * real for any caller: the browser form can be bypassed, this cannot.
   *
   * The instance is still the final authority. Anything that passes here is
   * sent on, and if it refuses for a reason this does not model, its message is
   * the one shown.
   */
  /**
   * The password policy this instance enforces.
   *
   * Served so the form can show the requirements while someone types rather
   * than after they submit. Not a secret: telling people the rules is how they
   * comply with them.
   */
  app.get('/me/password-policy', async (request): Promise<PasswordPolicy> =>
    getPasswordPolicy(requestSignal(request)),
  );

  app.post<{ Body: { password?: unknown } }>('/me/password', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!password) throw EpmError.badRequest('A new password is required.');

    const failures = await checkPassword(password, requestSignal(request));
    if (failures.length > 0) {
      throw EpmError.badRequest(`That password needs: ${failures.join(', ')}.`);
    }

    await openProject.request<unknown>(`/users/${userId}`, {
      method: 'PATCH',
      body: { password },
      signal: requestSignal(request),
    });

    await prisma.userProfile
      .updateMany({ where: { openProjectId: userId }, data: { mustChangePassword: false } })
      .catch(() => undefined);

    reply.code(204);
  });

  /**
   * The timezone names this instance accepts.
   *
   * Served from upstream rather than from the browser: `Intl.supportedValuesOf`
   * reports canonical IANA ids, and for India that is Asia/Calcutta, which
   * OpenProject rejects in favour of Asia/Kolkata. A picker built from the
   * browser's list would offer choices the instance refuses.
   */
  app.get('/timezones', async (request): Promise<string[]> => {
    const body = await openProject.request<{ timezones?: string[] }>('/epm_admin/timezones', {
      root: true,
      signal: requestSignal(request),
    });
    return body.timezones ?? [];
  });

  app.get('/users', async (request) => getUsers(requestSignal(request)));

  /**
   * A person's avatar, streamed through EPM.
   *
   * The upstream record carries an absolute URL to the system behind EPM.
   * Handing that to the browser would put that host in every network log and
   * in the page source, and would break wherever the browser cannot reach it.
   * So the address never leaves the backend and this serves the bytes instead.
   */
  app.get<{ Params: { id: string } }>('/users/:id/avatar', async (request, reply) => {
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That avatar');

    const response = await openProject.stream(`/users/${id}/avatar`, requestSignal(request));
    if (!response.ok || !response.body) throw EpmError.notFound('That avatar');

    return reply
      .header('Content-Type', response.headers.get('content-type') ?? 'image/png')
      // A face behind a session is not for a shared cache, but it is worth
      // keeping in this browser for the length of a visit.
      .header('Cache-Control', 'private, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .send(response.body);
  });

  app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
    const users = await getUsers(requestSignal(request));
    const user = users.find((candidate) => candidate.id === request.params.id);
    if (!user) throw EpmError.notFound('That person');
    return user;
  });
};
