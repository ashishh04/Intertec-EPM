import type { FastifyRequest } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { openProject } from '../openproject/client.js';
import { requestSignal } from '../lib/request-signal.js';
import { allows, loadPermissions, type EffectivePermissions } from './capabilities.js';
import type { Permission } from './permissions.js';

/**
 * Authorisation enforcement.
 *
 * The frontend hides what a user may not do; this rejects it. Those are
 * separate jobs — a hidden button is a courtesy, and a request that bypasses
 * the UI has to fail here or the permission model is decorative.
 *
 * Permissions are read once per request and cached on it, so a handler can ask
 * several questions without refetching.
 */

declare module 'fastify' {
  interface FastifyRequest {
    permissions?: EffectivePermissions;
  }
}

/** Effective permissions for this request's user, fetched at most once. */
export async function permissionsFor(request: FastifyRequest): Promise<EffectivePermissions> {
  if (request.permissions) return request.permissions;

  const auth = request.auth;
  if (!auth) throw EpmError.unauthorized();

  const permissions = await loadPermissions(auth.userId, requestSignal(request));
  request.permissions = permissions;
  return permissions;
}

/**
 * Requires a permission, optionally within a project.
 *
 * Omitting `projectId` asks the global question. For anything that acts on a
 * project's contents, pass the project — a user may hold the permission in one
 * project and not another, and the global set will not tell you that.
 */
export async function require(
  request: FastifyRequest,
  permission: Permission,
  projectId?: string,
): Promise<void> {
  const permissions = await permissionsFor(request);

  if (!allows(permissions, permission, projectId)) {
    // The message names the permission but not the project's existence: a user
    // without access should not learn whether project 7 is real.
    throw EpmError.forbidden(`You do not have permission to ${describe(permission)}.`);
  }
}

/**
 * Groups whose name is not simply pluralised.
 *
 * `task` reads better as the thing it maps to upstream, and `health` is a mass
 * noun that the rule below would turn into "healths".
 */
const SUBJECTS: Record<string, string> = {
  task: 'work packages',
  health: 'project health',
};

function describe(permission: Permission): string {
  const [group = '', action = ''] = permission.split(':');

  // Several groups are already plural — `departments`, `users`, `teams` — and
  // appending another `s` produced "manage departmentss".
  const subject = SUBJECTS[group] ?? (group.endsWith('s') ? group : `${group}s`);
  return `${action.replace('_', ' ')} ${subject}`;
}

/**
 * Resolves which project a work package belongs to.
 *
 * Authorisation for a work package is a question about its project, and the
 * client is not trusted to say which that is.
 */
export async function projectOfWorkPackage(
  request: FastifyRequest,
  workPackageId: string,
): Promise<string> {
  const workPackage = await openProject
    .request<{ _links?: { project?: { href?: string } } }>(`/work_packages/${workPackageId}`, {
      signal: requestSignal(request),
    })
    .catch(() => null);

  const href = workPackage?._links?.project?.href;
  const projectId = href?.split('/').pop();

  // A work package the caller cannot read is reported as absent rather than
  // forbidden, so the API does not confirm ids the user may not see.
  if (!projectId) throw EpmError.notFound(`Work package ${workPackageId}`);

  return projectId;
}

/**
 * Asserts OpenProject itself offers an action on a record.
 *
 * The capabilities vocabulary has no delete action, so deletion is authorised
 * from the record's own HAL links — which OpenProject computes per user and per
 * record state, and is therefore stricter than any mapping could be.
 */
export async function requireLink(
  request: FastifyRequest,
  path: string,
  rel: string,
  description: string,
): Promise<void> {
  const resource = await openProject
    .request<{ _links?: Record<string, unknown> }>(path, { signal: requestSignal(request) })
    .catch(() => null);

  if (!resource) throw EpmError.notFound('That resource');

  if (!resource._links || !Object.hasOwn(resource._links, rel)) {
    throw EpmError.forbidden(`You do not have permission to ${description}.`);
  }
}
