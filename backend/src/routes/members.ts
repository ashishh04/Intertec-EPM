import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import * as guard from '../auth/guard.js';
import { allows } from '../auth/capabilities.js';
import { permissionsFor } from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { toEpmMemberCandidate, toEpmProjectMember, toEpmRole } from '../mapping/members.js';
import { linkId, openProject, type OpFilter } from '../openproject/client.js';
import type { OpMembership, OpPrincipal, OpRole } from '../openproject/types.js';

/**
 * Project membership.
 *
 * Memberships are OpenProject's, wholly. Adding someone to a project grants
 * them real access upstream, so this writes through and stores nothing — there
 * is no EPM table here and no sync step, and the project pages, workload list
 * and portfolio rollups all pick the change up on their next read because they
 * already derive from the same `/memberships` collection.
 *
 * Authorisation is the per-project `member:manage` capability. That is a
 * departure from the affordance-driven checks used for watchers, relations and
 * comments, and the reason is upstream: a membership's `_links` carry `update`
 * and `updateImmediately` but never `delete`, even when the caller may delete
 * it. Capabilities are the only signal OpenProject publishes for this, and
 * `ACTION_GRANTS` already maps `memberships/{create,update,destroy}` onto
 * `member:manage`, per project.
 */

/** Roles assignable to a project membership, per OpenProject's own filter. */
const PROJECT_ROLE_FILTER: OpFilter[] = [{ field: 'unit', operator: '=', values: ['project'] }];

/**
 * People who may be added: not locked, and not already a member.
 *
 * OpenProject computes this, so EPM never subtracts one list from another and
 * gets it wrong. Status `3` is locked and the `member` filter is negated
 * against the project.
 */
function candidateFilter(projectId: string): OpFilter[] {
  return [
    { field: 'status', operator: '!', values: ['3'] },
    { field: 'member', operator: '!', values: [projectId] },
  ];
}

function membershipsOf(projectId: string, signal: AbortSignal) {
  return openProject.getAll<OpMembership>(
    '/memberships',
    {
      pageSize: 100,
      filters: [{ field: 'project', operator: '=', values: [projectId] }],
    },
    { signal },
  );
}

/**
 * Loads a membership and proves it belongs to the project in the URL.
 *
 * Without this, holding `member:manage` on any one project would be enough to
 * change or delete a membership in any other simply by putting its id in the
 * path — the permission is checked per project, so the check has to be anchored
 * to the same project the record actually belongs to.
 *
 * A membership in another project is reported as missing rather than
 * forbidden: whether it exists is not this caller's business.
 */
async function membershipInProject(
  request: FastifyRequest,
  projectId: string,
  membershipId: string,
): Promise<OpMembership> {
  const membership = await openProject
    .request<OpMembership>(`/memberships/${membershipId}`, { signal: requestSignal(request) })
    .catch(() => null);

  if (!membership || linkId(membership._links, 'project') !== projectId) {
    throw EpmError.notFound('That membership does not exist on this project.');
  }

  return membership;
}

/** Validates and normalises a role list into HAL links. */
function roleLinks(roleIds: unknown): { href: string }[] {
  const list = Array.isArray(roleIds) ? roleIds : [];
  const ids = [...new Set(list.map((id) => String(id).trim()).filter(Boolean))];

  // Required upstream, and a membership with no role grants nothing — failing
  // here says so plainly rather than letting OpenProject return a form error.
  if (ids.length === 0) throw EpmError.badRequest('At least one role is required.');
  if (ids.some((id) => !/^\d+$/.test(id))) throw EpmError.badRequest('A role id is not valid.');

  return ids.map((id) => ({ href: `/api/v3/roles/${id}` }));
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  /** Roles that can be granted on a project. Not project-specific upstream. */
  app.get('/project-roles', async (request) => {
    const collection = await openProject.getAll<OpRole>(
      '/roles',
      { pageSize: 100, filters: PROJECT_ROLE_FILTER },
      { signal: requestSignal(request) },
    );

    return collection.items.map(toEpmRole);
  });

  /**
   * The project's members.
   *
   * Unguarded, like every other read here: OpenProject scopes `/memberships` to
   * what the caller may see, so someone without access gets an empty list from
   * upstream. Adding a `member:view` check on top would return 403 where the
   * system of record returns nothing — and would disagree with `memberIds` on
   * the project payload, which is derived from this same collection.
   */
  app.get<{ Params: { id: string } }>('/projects/:id/members', async (request) => {
    const { id } = request.params;

    // Asked once for the whole list: every row's answer is the same, because
    // the capability is granted per project rather than per membership.
    const permissions = await permissionsFor(request);
    const canManage = allows(permissions, 'member:manage', id);

    const memberships = await membershipsOf(id, requestSignal(request));

    return memberships.items.map((membership) => toEpmProjectMember(membership, canManage));
  });

  /**
   * Who could be added.
   *
   * Behind `member:manage` rather than `member:view`: this is the instance's
   * user directory filtered by a project, and someone who cannot add anyone has
   * no reason to enumerate it.
   */
  app.get<{ Params: { id: string } }>('/projects/:id/members/candidates', async (request) => {
    const { id } = request.params;

    await guard.require(request, 'member:manage', id);

    const collection = await openProject.getAll<OpPrincipal>(
      '/principals',
      { pageSize: 100, filters: candidateFilter(id) },
      { signal: requestSignal(request) },
    );

    // Users only. Groups and placeholder users come back from this endpoint
    // too, and adding those stays an OpenProject operation — EPM has no group
    // concept and inventing half of one here would be worse than omitting them.
    return collection.items
      .filter((principal) => principal._type === 'User')
      .map(toEpmMemberCandidate)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Adds a member. */
  app.post<{ Params: { id: string }; Body: { userId?: string; roleIds?: unknown } }>(
    '/projects/:id/members',
    async (request, reply) => {
      const { id } = request.params;
      const userId = String(request.body?.userId ?? '').trim();

      if (!userId) throw EpmError.badRequest('A userId is required.');

      await guard.require(request, 'member:manage', id);

      const roles = roleLinks(request.body?.roleIds);

      const created = await openProject.request<OpMembership>('/memberships', {
        method: 'POST',
        body: {
          _links: {
            project: { href: `/api/v3/projects/${id}` },
            principal: { href: `/api/v3/users/${userId}` },
            roles,
          },
        },
        signal: requestSignal(request),
      });

      // OpenProject emails the person it just granted access to. That is left
      // on: being added to a project is exactly what someone needs to know, and
      // suppressing it silently would be a worse default than a mail EPM did
      // not send itself. No EPM notification is created — it would duplicate a
      // message upstream has already delivered.
      reply.code(201);
      return toEpmProjectMember(created, true);
    },
  );

  /** Changes a member's roles. */
  app.patch<{ Params: { id: string; membershipId: string }; Body: { roleIds?: unknown } }>(
    '/projects/:id/members/:membershipId',
    async (request) => {
      const { id, membershipId } = request.params;

      await guard.require(request, 'member:manage', id);
      await membershipInProject(request, id, membershipId);

      const roles = roleLinks(request.body?.roleIds);

      const updated = await openProject.request<OpMembership>(`/memberships/${membershipId}`, {
        method: 'PATCH',
        body: { _links: { roles } },
        signal: requestSignal(request),
      });

      return toEpmProjectMember(updated, true);
    },
  );

  /** Removes a member from the project. */
  app.delete<{ Params: { id: string; membershipId: string } }>(
    '/projects/:id/members/:membershipId',
    async (request, reply) => {
      const { id, membershipId } = request.params;

      await guard.require(request, 'member:manage', id);
      await membershipInProject(request, id, membershipId);

      await openProject.request<void>(`/memberships/${membershipId}`, {
        method: 'DELETE',
        signal: requestSignal(request),
      });

      reply.code(204);
    },
  );
};
