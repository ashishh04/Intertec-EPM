import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { allows } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import { listAudit } from '../domain/audit.js';
import { createChain, deleteChain, listChains, updateChain } from '../domain/approval-chains.js';
import {
  cancelRequest,
  createDelegation,
  decideTask,
  decideViaLink,
  inbox,
  listDelegations,
  listRequests,
  requestById,
  resolveLink,
  revokeDelegation,
  subjectState,
  submitForApproval,
  toRequestViews,
} from '../domain/approvals.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { listProjects } from '../mapping/projects.js';
import { openProject } from '../openproject/client.js';
import type { ApprovalChainOptions, ApprovalDelegationInput, ApprovalLinkView } from '../types/epm.js';
import { loadProjects } from './projects.js';

/**
 * Approvals (BRQ-09).
 *
 * Configuring chains needs `approvals:configure`. Submitting needs the right
 * to edit the work package. Deciding needs no permission at all — only being
 * the approver the chain named, or their delegate — and that is checked inside
 * the engine, under the request's lock, on every path including the email
 * link.
 */

const decisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).optional(),
});

async function mayConfigure(request: FastifyRequest): Promise<boolean> {
  return allows(await guard.permissionsFor(request), 'approvals:configure');
}

/**
 * Whether the caller may read a request: they raised it, decide in it, can see
 * its project, or administer approvals. Being named as an approver is enough
 * on its own — a finance approver need not be a member of every project.
 */
async function assertMayRead(request: FastifyRequest, id: string) {
  const row = await requestById(id);
  if (!row) throw EpmError.notFound('That approval request');
  const viewer = request.auth!.userId;
  const involved =
    row.requestedBy === viewer || row.tasks.some((task) => task.approverId === viewer || task.delegateId === viewer);
  if (involved || (await mayConfigure(request))) return row;

  const visible = (await loadProjects(requestSignal(request))).some((project) => project.id === row.projectId);
  if (visible && allows(await guard.permissionsFor(request), 'task:view', row.projectId)) return row;
  throw EpmError.notFound('That approval request');
}

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------- chains */

  app.get('/approvals/chains', async (request) => {
    await guard.require(request, 'approvals:configure');
    return listChains();
  });

  app.post<{ Body: unknown }>('/approvals/chains', async (request, reply) => {
    await guard.require(request, 'approvals:configure');
    reply.code(201);
    return createChain(request.body ?? {}, request.auth!.userId);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/approvals/chains/:id', async (request) => {
    await guard.require(request, 'approvals:configure');
    return updateChain(request.params.id, request.body ?? {}, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/approvals/chains/:id', async (request, reply) => {
    await guard.require(request, 'approvals:configure');
    await deleteChain(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /** What the chain editor offers: types, statuses, roles, fields, projects. */
  app.get('/approvals/options', async (request): Promise<ApprovalChainOptions> => {
    await guard.require(request, 'approvals:configure');
    return runAsSystem(async () => {
      const [catalog, roles, projects, portfolios, fields] = await Promise.all([
        getCatalog(),
        openProject.getAll<{ id: number; name: string }>('/roles', { pageSize: 200 }).catch(() => ({ items: [] })),
        listProjects(),
        prisma.portfolio.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        openProject
          .request<{ rows?: { id: number | string; name?: string; fieldFormat?: string }[] }>('/epm_admin/catalog/custom-fields', {
            root: true,
          })
          .catch(() => ({ rows: [] })),
      ]);
      return {
        types: [...catalog.typeById.values()].map(({ id, name }) => ({ id, name })),
        statuses: [...catalog.statusById.values()].map(({ id, name, isClosed }) => ({ id, name, isClosed })),
        priorities: [...catalog.priorityById.values()].map(({ id, name }) => ({ id, name })),
        // Built-in roles for non-members and anonymous users are never project members.
        roles: roles.items
          .filter((role) => !/^(non member|anonymous)$/i.test(role.name))
          .map((role) => ({ id: String(role.id), name: role.name })),
        projects: projects.filter((project) => project.active).map((project) => ({ id: String(project.id), name: project.name })),
        portfolios,
        customFields: (fields.rows ?? []).map((field) => ({
          id: `customField${field.id}`,
          name: field.name ?? `Custom field ${field.id}`,
          numeric: field.fieldFormat === 'float' || field.fieldFormat === 'int',
        })),
      };
    });
  });

  /* ------------------------------------------------------------ subjects */

  /** The approval state of one work package: the chain that applies, the request in flight, the history. */
  app.get<{ Params: { id: string } }>('/approvals/subjects/work-packages/:id', async (request) => {
    // Read with the caller's own token: someone who cannot see the work
    // package learns nothing about its approvals either.
    const projectId = await guard.projectOfWorkPackage(request, request.params.id);
    const permissions = await guard.permissionsFor(request);
    return subjectState({
      subjectId: request.params.id,
      viewerId: request.auth!.userId,
      canEdit: allows(permissions, 'task:edit', projectId),
      mayCancelAny: allows(permissions, 'approvals:configure'),
    });
  });

  app.post<{ Params: { id: string } }>('/approvals/subjects/work-packages/:id/submit', async (request, reply) => {
    const projectId = await guard.projectOfWorkPackage(request, request.params.id);
    await guard.require(request, 'task:edit', projectId);
    await submitForApproval(request.params.id, request.auth!.userId);
    const permissions = await guard.permissionsFor(request);
    reply.code(201);
    return subjectState({
      subjectId: request.params.id,
      viewerId: request.auth!.userId,
      canEdit: true,
      mayCancelAny: allows(permissions, 'approvals:configure'),
    });
  });

  /* ------------------------------------------------------------ requests */

  /** Waiting on the caller, as approver or delegate. */
  app.get('/approvals/inbox', async (request) => inbox(request.auth!.userId, await mayConfigure(request)));

  app.get('/approvals/inbox/count', async (request) => ({
    count: (await inbox(request.auth!.userId, false)).length,
  }));

  /**
   * Requests: the caller's own (`scope=mine`, the default), or every request
   * in the projects whose work the caller can see (`scope=projects`).
   */
  app.get<{ Querystring: { scope?: string; status?: string } }>('/approvals/requests', async (request) => {
    const query = z
      .object({
        scope: z.enum(['mine', 'projects']).optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
      })
      .parse(request.query);
    const viewerId = request.auth!.userId;
    const configure = await mayConfigure(request);

    if (query.scope === 'projects') {
      const permissions = await guard.permissionsFor(request);
      const projectIds = (await loadProjects(requestSignal(request)))
        .filter((project) => allows(permissions, 'task:view', project.id))
        .map((project) => project.id);
      return listRequests({ viewerId, mayCancelAny: configure, projectIds, status: query.status });
    }
    return listRequests({ viewerId, mayCancelAny: configure, requestedBy: viewerId, status: query.status });
  });

  app.get<{ Params: { id: string } }>('/approvals/requests/:id', async (request) => {
    const row = await assertMayRead(request, request.params.id);
    return (await toRequestViews([row], request.auth!.userId, await mayConfigure(request)))[0];
  });

  /** The request's journal, oldest first: every step, decision and comment in sequence (BR-213). */
  app.get<{ Params: { id: string } }>('/approvals/requests/:id/journal', async (request) => {
    await assertMayRead(request, request.params.id);
    return (await listAudit({ entityType: 'approval-request', entityId: request.params.id, limit: 200 })).reverse();
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/approvals/requests/:id/cancel', async (request) => {
    const row = await assertMayRead(request, request.params.id);
    const configure = await mayConfigure(request);
    await cancelRequest({
      requestId: row.id,
      actorId: request.auth!.userId,
      mayCancelAny: configure,
      reason: typeof request.body?.reason === 'string' ? request.body.reason : undefined,
    });
    const fresh = await requestById(row.id);
    return (await toRequestViews([fresh!], request.auth!.userId, configure))[0];
  });

  /** Decides one task in the app. Authority is checked inside, under the request's lock. */
  app.post<{ Params: { id: string }; Body: unknown }>('/approvals/tasks/:id/decide', async (request) => {
    const body = decisionBody.parse(request.body ?? {});
    const requestId = await decideTask({
      taskId: request.params.id,
      decision: body.decision,
      comment: body.comment,
      actorId: request.auth!.userId,
      via: 'app',
    });
    const row = await requestById(requestId);
    return (await toRequestViews([row!], request.auth!.userId, await mayConfigure(request)))[0];
  });

  /* --------------------------------------------------------------- links */

  /**
   * What an email link opens on. Signed in, and only for the person it was
   * sent to; looking does not use the link up.
   */
  app.get<{ Params: { token: string } }>('/approvals/links/:token', async (request): Promise<ApprovalLinkView> => {
    const viewerId = request.auth!.userId;
    const { task } = await resolveLink(request.params.token, viewerId);
    const row = await requestById(task.requestId);
    const [view] = await toRequestViews([row!], viewerId, false);
    return {
      request: view!,
      taskId: task.id,
      stepName: task.stepName,
      onBehalfOf: task.approverId !== viewerId ? task.approverId : undefined,
    };
  });

  /** Decides through a link: once, by its owner, permission-checked before anything is applied (BR-215). */
  app.post<{ Params: { token: string }; Body: unknown }>('/approvals/links/:token/decide', async (request) => {
    const body = decisionBody.parse(request.body ?? {});
    const requestId = await decideViaLink({
      token: request.params.token,
      viewerId: request.auth!.userId,
      decision: body.decision,
      comment: body.comment,
    });
    const row = await requestById(requestId);
    return (await toRequestViews([row!], request.auth!.userId, false))[0];
  });

  /* --------------------------------------------------------- delegations */

  app.get<{ Querystring: { all?: string } }>('/approvals/delegations', async (request) => {
    const all = request.query.all === 'true' && (await mayConfigure(request));
    return listDelegations(request.auth!.userId, all);
  });

  app.post<{ Body: ApprovalDelegationInput }>('/approvals/delegations', async (request, reply) => {
    const body = z
      .object({
        delegateId: z.string(),
        startsOn: z.string(),
        endsOn: z.string(),
        reason: z.string().optional(),
        delegatorId: z.string().optional(),
      })
      .parse(request.body ?? {});
    reply.code(201);
    return createDelegation(body, request.auth!.userId, await mayConfigure(request));
  });

  app.post<{ Params: { id: string } }>('/approvals/delegations/:id/revoke', async (request) =>
    revokeDelegation(request.params.id, request.auth!.userId, await mayConfigure(request)),
  );
};
