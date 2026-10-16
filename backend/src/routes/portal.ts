import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { decideTask, inbox } from '../domain/approvals.js';
import { withAudit } from '../domain/audit.js';
import { isExternal, requireScope, scopeOf, type ProjectScope } from '../domain/external-access.js';
import { healthFor } from '../domain/health.js';
import { assertPolicies, assertUnlocked } from '../domain/time-rules.js';
import { OVERDUE_DUE_FILTER } from '../domain/work-definitions.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { contentDispositionFor, maxUploadBytes } from '../lib/uploads.js';
import { getCatalog } from '../mapping/catalog.js';
import { linkId, openProject, type OpFilter } from '../openproject/client.js';
import type { HalLink, OpAttachment } from '../openproject/types.js';
import type {
  ExternalPermission,
  PortalApproval,
  PortalComment,
  PortalDocument,
  PortalHome,
  PortalMilestone,
  PortalProjectView,
  PortalTaskRow,
  PortalTaskView,
} from '../types/epm.js';

/**
 * The external portal (Module 17: BR-611 to BR-613): the only API an external
 * user can reach (`auth/hook.ts` refuses them everything else). Each endpoint
 * checks their role on the project — the permission matrix — and reads and
 * writes with their own account, so OpenProject's permissions apply too and
 * every contribution is theirs, in its journal and in EPM's.
 */

type Links = Record<string, HalLink | HalLink[] | undefined>;
interface OpWork {
  id: number;
  subject: string;
  lockVersion: number;
  startDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  percentageDone?: number | null;
  description?: { raw?: string | null } | null;
  _links: Links;
}

const title = (links: Links, key: string) => {
  const link = links[key];
  return (Array.isArray(link) ? link[0]?.title : link?.title) ?? null;
};

async function externalOf(request: FastifyRequest): Promise<string> {
  const userId = request.auth!.userId;
  if (!(await isExternal(userId))) throw EpmError.forbidden('The portal is for external users.');
  return userId;
}

const projectIdOf = (raw: string) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw EpmError.notFound('That project');
  return id;
};

async function rowOf(work: OpWork, userId: string): Promise<PortalTaskRow> {
  const catalog = await getCatalog();
  const statusId = linkId(work._links, 'status');
  const milestone = work.date !== undefined && work.startDate === undefined && work.dueDate === undefined;
  return {
    id: String(work.id),
    subject: work.subject,
    type: title(work._links, 'type') ?? '',
    status: title(work._links, 'status') ?? '',
    closed: statusId ? (catalog.statusById.get(statusId)?.isClosed ?? false) : false,
    assignee: title(work._links, 'assignee'),
    assignedToMe: linkId(work._links, 'assignee') === userId,
    startDate: (milestone ? work.date : work.startDate) ?? null,
    dueDate: (milestone ? work.date : work.dueDate) ?? null,
    percentDone: work.percentageDone ?? null,
  };
}

/** A task the external user may see: in a granted project, and theirs if their role sees only their own. */
async function visibleTask(request: FastifyRequest, userId: string, id: string): Promise<{ work: OpWork; projectId: number; scope: ProjectScope }> {
  if (!/^\d+$/.test(id)) throw EpmError.notFound('That task');
  const work = await openProject.request<OpWork>(`/work_packages/${id}`, { signal: requestSignal(request) }).catch(() => null);
  if (!work) throw EpmError.notFound('That task');
  const projectId = Number(linkId(work._links, 'project'));
  const scope = (await scopeOf(userId)).get(projectId);
  if (!scope) throw EpmError.notFound('That task');
  const mine = linkId(work._links, 'assignee') === userId;
  if (!scope.permissions.has('tasks.all') && !(scope.permissions.has('tasks.assigned') && mine)) throw EpmError.notFound('That task');
  return { work, projectId, scope };
}

const audit = (userId: string, projectId: number, action: string, summary: ReturnType<typeof message>, after?: Record<string, unknown>) =>
  withAudit(async () => null, { actorId: userId, projectId: String(projectId), entityType: 'portal', entityId: String(projectId), action, summary, ...(after ? { after } : {}) });

export const portalRoutes: FastifyPluginAsync = async (app) => {
  /* ---------------------------------------------------------------- home */

  app.get('/portal/home', async (request): Promise<PortalHome> => {
    const userId = await externalOf(request);
    const scope = await scopeOf(userId);
    const [me, approvals] = await Promise.all([
      openProject.request<{ name: string }>('/users/me', { signal: requestSignal(request) }).catch(() => ({ name: '' })),
      portalApprovals(userId, scope),
    ]);
    const projects = [];
    for (const [projectId, entry] of scope) {
      const project = await openProject.request<{ name: string }>(`/projects/${projectId}`, { signal: requestSignal(request) }).catch(() => null);
      if (project) projects.push({ id: String(projectId), name: project.name, roleName: entry.roleName, permissions: [...entry.permissions] });
    }
    return { userName: me.name, projects: projects.sort((a, b) => a.name.localeCompare(b.name)), approvals: approvals.length };
  });

  /* ------------------------------------------------------------- project */

  app.get<{ Params: { id: string } }>('/portal/projects/:id', async (request): Promise<PortalProjectView> => {
    const userId = await externalOf(request);
    const projectId = projectIdOf(request.params.id);
    const scope = await requireScope(userId, projectId);
    const signal = requestSignal(request);
    const can = (permission: ExternalPermission) => scope.permissions.has(permission);
    const [project, profile, catalog] = await Promise.all([
      openProject.request<{ name: string; description?: { raw?: string | null } | null }>(`/projects/${projectId}`, { signal }),
      prisma.projectProfile.findUnique({ where: { openProjectId: String(projectId) }, select: { plannedStart: true, plannedFinish: true } }),
      getCatalog(),
    ]);
    let health: string | null = null;
    if (can('status')) health = (await healthFor([String(projectId)]).catch(() => new Map())).get(String(projectId))?.calculated.overall ?? null;
    let milestones: PortalMilestone[] | null = null;
    if (can('milestones')) {
      const ids = catalog.typeIdsByEpm.get('milestone') ?? [];
      const rows =
        ids.length === 0
          ? []
          : (
              await openProject.getAll<OpWork>(
                '/work_packages',
                {
                  filters: [
                    { field: 'project', operator: '=', values: [String(projectId)] },
                    { field: 'type', operator: '=', values: ids },
                    { field: 'status', operator: '*', values: [] },
                  ],
                  pageSize: 200,
                },
                { signal },
              )
            ).items;
      milestones = rows
        .map((work) => {
          const statusId = linkId(work._links, 'status');
          return {
            id: String(work.id),
            subject: work.subject,
            date: work.date ?? work.dueDate ?? null,
            status: title(work._links, 'status') ?? '',
            closed: statusId ? (catalog.statusById.get(statusId)?.isClosed ?? false) : false,
          };
        })
        .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
    }
    let summary: PortalProjectView['summary'] = null;
    if (can('reports')) {
      const count = async (filters: OpFilter[]) =>
        (
          await openProject.getCollection<unknown>(
            '/work_packages',
            { filters: [{ field: 'project', operator: '=', values: [String(projectId)] }, ...filters], pageSize: 1 },
            signal,
          )
        ).total ?? 0;
      const [total, closed, overdue] = await Promise.all([
        count([{ field: 'status', operator: '*', values: [] }]),
        count([{ field: 'status', operator: 'c', values: [] }]),
        count([{ field: 'status', operator: 'o', values: [] }, OVERDUE_DUE_FILTER]),
      ]);
      summary = { total, closed, overdue, percentDone: total > 0 ? Math.round((closed / total) * 100) : 0 };
    }
    const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
    return {
      id: String(projectId),
      name: project.name,
      roleName: scope.roleName,
      permissions: [...scope.permissions],
      description: can('status') ? (project.description?.raw ?? null) : null,
      plannedStart: can('status') ? iso(profile?.plannedStart) : null,
      plannedFinish: can('status') ? iso(profile?.plannedFinish) : null,
      health,
      milestones,
      summary,
    };
  });

  app.get<{ Params: { id: string } }>('/portal/projects/:id/tasks', async (request): Promise<PortalTaskRow[]> => {
    const userId = await externalOf(request);
    const projectId = projectIdOf(request.params.id);
    const scope = await requireScope(userId, projectId, ['tasks.all', 'tasks.assigned']);
    const onlyMine = !scope.permissions.has('tasks.all');
    const work = await openProject.getAll<OpWork>(
      '/work_packages',
      {
        filters: [
          { field: 'project', operator: '=', values: [String(projectId)] },
          { field: 'status', operator: '*', values: [] },
          ...(onlyMine ? [{ field: 'assignee', operator: '=', values: [userId] } as OpFilter] : []),
        ],
        sortBy: [['id', 'asc']],
        pageSize: 500,
      },
      { signal: requestSignal(request) },
    );
    return Promise.all(work.items.slice(0, 2000).map((item) => rowOf(item, userId)));
  });

  /* ---------------------------------------------------------------- task */

  app.get<{ Params: { id: string } }>('/portal/tasks/:id', async (request): Promise<PortalTaskView> => {
    const userId = await externalOf(request);
    const { work, projectId, scope } = await visibleTask(request, userId, request.params.id);
    const signal = requestSignal(request);
    const [row, activities, project, catalog] = await Promise.all([
      rowOf(work, userId),
      openProject.getAll<{ id: number; createdAt: string; comment?: { raw?: string | null }; _links: Links }>(`/work_packages/${work.id}/activities`, { pageSize: 200 }, { signal }),
      openProject.request<{ name: string }>(`/projects/${projectId}`, { signal }),
      getCatalog(),
    ]);
    const comments: PortalComment[] = activities.items
      .filter((activity) => activity.comment?.raw?.trim())
      .map((activity) => ({ id: String(activity.id), author: title(activity._links, 'user') ?? '', createdAt: activity.createdAt, text: activity.comment!.raw! }));
    const changeStatus = scope.permissions.has('status.own') && row.assignedToMe;
    return {
      ...row,
      projectId: String(projectId),
      projectName: project.name,
      description: work.description?.raw ?? null,
      comments,
      statuses: changeStatus ? [...catalog.statusById.values()].map((status) => ({ id: status.id, name: status.name })) : [],
      can: { comment: scope.permissions.has('comment'), changeStatus, logTime: scope.permissions.has('time.own') && row.assignedToMe },
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/portal/tasks/:id/comments', async (request, reply) => {
    const userId = await externalOf(request);
    const { work, projectId, scope } = await visibleTask(request, userId, request.params.id);
    if (!scope.permissions.has('comment')) throw EpmError.forbidden('Your access to this project does not include commenting.');
    const { text } = z.object({ text: z.string().trim().min(1).max(10_000) }).parse(request.body ?? {});
    await openProject.request(`/work_packages/${work.id}/activities`, { method: 'POST', body: { comment: { raw: text } }, query: { notify: 'true' } });
    await audit(userId, projectId, 'portal.comment.added', message('Comment added to #{task} from the portal.', { task: work.id }), { workPackageId: work.id });
    reply.code(201);
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/portal/tasks/:id/status', async (request) => {
    const userId = await externalOf(request);
    const { work, projectId, scope } = await visibleTask(request, userId, request.params.id);
    if (!scope.permissions.has('status.own') || linkId(work._links, 'assignee') !== userId) {
      throw EpmError.forbidden('You can change the status of your own tasks only.');
    }
    const { statusId } = z.object({ statusId: z.string().regex(/^\d+$/) }).parse(request.body ?? {});
    const before = title(work._links, 'status');
    await openProject
      .request(`/work_packages/${work.id}`, { method: 'PATCH', body: { lockVersion: work.lockVersion, _links: { status: { href: `/api/v3/statuses/${statusId}` } } } })
      .catch((error: unknown) => {
        if (error instanceof OpenProjectError && error.upstreamStatus === 422) throw EpmError.validation(error.message);
        throw error;
      });
    await audit(userId, projectId, 'portal.status.changed', message('Status of #{task} changed from the portal.', { task: work.id }), { workPackageId: work.id, from: before, statusId });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/portal/tasks/:id/time', async (request, reply) => {
    const userId = await externalOf(request);
    const { work, projectId, scope } = await visibleTask(request, userId, request.params.id);
    if (!scope.permissions.has('time.own') || linkId(work._links, 'assignee') !== userId) {
      throw EpmError.forbidden('You can log time on your own tasks only.');
    }
    const body = z
      .object({ hours: z.number().positive().max(24), spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), comment: z.string().max(1000).optional() })
      .parse(request.body ?? {});
    // The same locks and time logging policies as anywhere else (BR-304, BR-317).
    await assertUnlocked(userId, [body.spentOn]);
    await assertPolicies({ personId: userId, spentOn: body.spentOn, hours: body.hours, workPackageId: String(work.id) });
    await openProject.request('/time_entries', {
      method: 'POST',
      body: {
        hours: `PT${body.hours}H`,
        spentOn: body.spentOn,
        ...(body.comment ? { comment: { raw: body.comment } } : {}),
        _links: { workPackage: { href: `/api/v3/work_packages/${work.id}` }, project: { href: `/api/v3/projects/${projectId}` } },
      },
    });
    await audit(userId, projectId, 'portal.time.logged', message('{hours} hours logged on #{task} from the portal.', { hours: body.hours, task: work.id }), { workPackageId: work.id, ...body });
    reply.code(201);
    return { ok: true };
  });

  /* ----------------------------------------------------------- documents */

  app.get<{ Params: { id: string } }>('/portal/projects/:id/documents', async (request): Promise<PortalDocument[]> => {
    const userId = await externalOf(request);
    const projectId = projectIdOf(request.params.id);
    await requireScope(userId, projectId, 'documents.view');
    const rows = await prisma.documentMeta.findMany({ where: { projectId: String(projectId) }, take: 500 });
    const out: PortalDocument[] = [];
    for (const row of rows) {
      const attachment = await openProject.request<OpAttachment>(`/attachments/${row.openProjectId}`, { signal: requestSignal(request) }).catch(() => null);
      if (!attachment) continue;
      out.push({
        id: row.openProjectId,
        name: attachment.fileName,
        sizeBytes: attachment.fileSize,
        uploadedAt: attachment.createdAt,
        uploadedBy: (attachment._links as Links | undefined)?.author ? (title(attachment._links as Links, 'author') ?? '') : '',
      });
    }
    return out.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  });

  app.get<{ Params: { id: string } }>('/portal/documents/:id/content', async (request, reply) => {
    const userId = await externalOf(request);
    const { id } = request.params;
    const row = /^\d+$/.test(id) ? await prisma.documentMeta.findUnique({ where: { openProjectId: id } }) : null;
    if (!row?.projectId) throw EpmError.notFound('That document');
    await requireScope(userId, Number(row.projectId), 'documents.view');
    const attachment = await openProject.request<OpAttachment>(`/attachments/${id}`, { signal: requestSignal(request) }).catch(() => null);
    if (!attachment) throw EpmError.notFound('That document');
    const upstream = await openProject.stream(`/attachments/${id}/content`, requestSignal(request));
    if (!upstream.ok || !upstream.body) throw EpmError.notFound('That document');
    return reply
      .header('Content-Type', attachment.contentType || 'application/octet-stream')
      .header('Content-Disposition', contentDispositionFor(attachment.fileName))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(upstream.body);
  });

  app.post<{ Params: { id: string } }>('/portal/projects/:id/documents', async (request, reply) => {
    const userId = await externalOf(request);
    const projectId = projectIdOf(request.params.id);
    await requireScope(userId, projectId, 'documents.upload');
    const limit = await maxUploadBytes(requestSignal(request));
    const uploaded = await request.file({ limits: { fileSize: limit, files: 1 } }).catch(() => {
      throw EpmError.badRequest('Send the file as multipart/form-data.');
    });
    if (!uploaded) throw EpmError.badRequest('No file was uploaded.');
    const buffer = await uploaded.toBuffer();
    if (uploaded.file.truncated) throw EpmError.badRequest(message('That file is larger than the {limit} MB limit.', { limit: Math.floor(limit / 1024 / 1024) }));
    const fileName = uploaded.filename?.trim();
    if (!fileName) throw EpmError.badRequest('The file has no name.');
    const form = new FormData();
    form.append('metadata', JSON.stringify({ fileName }));
    form.append('file', new Blob([buffer]), fileName);
    const created = await openProject.request<OpAttachment>('/attachments', { method: 'POST', body: form, once: true });
    await prisma.documentMeta.upsert({
      where: { openProjectId: String(created.id) },
      create: { openProjectId: String(created.id), kind: 'other', shared: false, projectId: String(projectId) },
      update: { projectId: String(projectId) },
    });
    await audit(userId, projectId, 'portal.document.uploaded', message('{file} uploaded from the portal.', { file: created.fileName }), { attachmentId: created.id });
    reply.code(201);
    return { id: String(created.id), name: created.fileName };
  });

  /* ----------------------------------------------------------- approvals */

  app.get('/portal/approvals', async (request): Promise<PortalApproval[]> => {
    const userId = await externalOf(request);
    return portalApprovals(userId, await scopeOf(userId));
  });

  app.post<{ Params: { taskId: string }; Body: unknown }>('/portal/approvals/:taskId/decide', async (request) => {
    const userId = await externalOf(request);
    const mine = await portalApprovals(userId, await scopeOf(userId));
    const item = mine.find((entry) => entry.taskId === request.params.taskId);
    if (!item) throw EpmError.notFound('That approval');
    const body = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional() }).parse(request.body ?? {});
    await decideTask({ taskId: item.taskId, decision: body.decision, comment: body.comment, actorId: userId, via: 'app' });
    return { ok: true };
  });
};

/** Approval tasks waiting on the external user, on projects where their role answers approvals. */
async function portalApprovals(userId: string, scope: Map<number, ProjectScope>): Promise<PortalApproval[]> {
  const allowed = new Set([...scope].filter(([, entry]) => entry.permissions.has('approvals')).map(([projectId]) => String(projectId)));
  if (allowed.size === 0) return [];
  const requests = await inbox(userId, false).catch(() => []);
  const out: PortalApproval[] = [];
  for (const request of requests) {
    if (!allowed.has(String(request.projectId))) continue;
    for (const step of request.steps ?? []) {
      for (const task of step.tasks ?? []) {
        if (task.status === 'pending' && task.approverId === userId) {
          out.push({ taskId: task.id, requestId: request.id, title: request.title ?? '', projectName: request.projectName ?? '', stepName: step.name, requestedAt: request.requestedAt });
        }
      }
    }
  }
  return out;
}

