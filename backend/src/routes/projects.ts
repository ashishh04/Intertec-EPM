import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { aggregateCache, userScopedKey } from '../lib/cache.js';
import { openProject, linkId, MAX_PAGE_SIZE } from '../openproject/client.js';
import {
  HEALTH_DIMENSIONS,
  HEALTH_LEVELS,
  getProjectAggregates,
  getProjectOverlays,
  toEpmProject,
} from '../mapping/projects.js';
import { prisma, optional } from '../db/prisma.js';
import { setProjectPortfolio } from '../domain/portfolios.js';
import { getUsers } from '../mapping/users.js';
import { notifyHealthChange } from '../domain/notifications.js';
import { Prisma } from '@prisma/client';
import type { OpMembership, OpProject, OpVersion } from '../openproject/types.js';
import type { Milestone, EpmProject } from '../types/epm.js';

const listQuery = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
});

/** Project members, grouped in one pass over memberships. */
async function membersByProject(signal?: AbortSignal): Promise<Map<string, string[]>> {
  const memberships = await openProject
    .getAll<OpMembership>('/memberships', { pageSize: MAX_PAGE_SIZE }, { signal })
    .catch(() => ({ items: [] as OpMembership[] }));

  const byProject = new Map<string, string[]>();
  for (const membership of memberships.items) {
    const projectId = linkId(membership._links, 'project');
    const principalId = linkId(membership._links, 'principal');
    if (!projectId || !principalId) continue;

    const existing = byProject.get(projectId) ?? [];
    if (!existing.includes(principalId)) existing.push(principalId);
    byProject.set(projectId, existing);
  }
  return byProject;
}

/**
 * Every project this caller can see, already normalized.
 *
 * Exported so the portfolio rollups can reuse it rather than reading the
 * association table directly — that way a portfolio can never report a project
 * the caller is not allowed to know about, and a project removed upstream
 * simply stops appearing.
 */
export async function loadProjectsFor(
  request: Parameters<typeof requestSignal>[0],
): Promise<EpmProject[]> {
  return loadProjects(requestSignal(request));
}

/**
 * Cached per user on the short aggregate TTL — the project list is read on
 * almost every page and fans out to several upstream calls. Invalidated on any
 * project write, so a project you create is usable straight away.
 */
export async function loadProjects(signal: AbortSignal): Promise<EpmProject[]> {
  return aggregateCache.get(userScopedKey('projects'), () => buildProjects(signal));
}

/**
 * Drops the cached project list for every caller.
 *
 * Every write below has to call this before it re-reads, or it returns the
 * snapshot taken up to 20 seconds *before* the change and the UI — which seeds
 * its cache from the response — shows the edit as having silently failed.
 *
 * Not scoped to the caller: a project's name, parent or portfolio is the same
 * for everyone who can see it, so one person's edit staleness is everyone's.
 */
function invalidateProjects() {
  aggregateCache.invalidatePrefix('projects');
  aggregateCache.invalidatePrefix('project-aggregates');
}

async function buildProjects(signal: AbortSignal): Promise<EpmProject[]> {
  const today = new Date().toISOString().slice(0, 10);

  const [projects, aggregates, members, overlays] = await Promise.all([
    openProject.getAll<OpProject>('/projects', { pageSize: MAX_PAGE_SIZE }, { signal }),
    getProjectAggregates(signal),
    membersByProject(signal),
    getProjectOverlays(),
  ]);

  return projects.items.map((project) =>
    toEpmProject(project, aggregates, {
      memberIds: members.get(String(project.id)) ?? [],
      overlay: overlays.get(String(project.id)),
      today,
    }),
  );
}

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get('/projects', async (request) => {
    const { search, status } = listQuery.parse(request.query);
    const signal = requestSignal(request);

    let projects = await loadProjects(signal);

    if (search) {
      const needle = search.toLowerCase();
      projects = projects.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) ||
          project.identifier.toLowerCase().includes(needle),
      );
    }

    if (status) {
      const wanted = new Set(status.split(',').map((value) => value.trim()).filter(Boolean));
      if (wanted.size > 0) projects = projects.filter((project) => wanted.has(project.status));
    }

    return projects;
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (request) => {
    const projects = await loadProjects(requestSignal(request));
    const project = projects.find((candidate) => candidate.id === request.params.id);
    if (!project) throw EpmError.notFound('That project');
    return project;
  });

  /**
   * Milestones are work packages of a milestone type. OpenProject versions
   * would be the other candidate, but this instance has none.
   */
  app.get<{ Params: { id: string } }>('/projects/:id/milestones', async (request) => {
    const signal = requestSignal(request);
    const projectId = request.params.id;

    const milestones = await openProject.getAll<{
      id: number;
      subject: string;
      date?: string | null;
      startDate?: string | null;
      dueDate?: string | null;
      _links?: Record<string, { href: string | null; title?: string }>;
    }>(
      '/work_packages',
      {
        filters: [
          { field: 'project', operator: '=', values: [projectId] },
          { field: 'type', operator: '=', values: await milestoneTypeIds(signal) },
        ],
        pageSize: 100,
      },
      { signal },
    ).catch(() => ({ items: [] }));

    const today = new Date().toISOString().slice(0, 10);

    return milestones.items.map((workPackage): Milestone => {
      const date = workPackage.date ?? workPackage.dueDate ?? workPackage.startDate ?? today;
      const statusLink = workPackage._links?.status;
      const closed = statusLink?.title?.toLowerCase().includes('closed') ?? false;

      return {
        id: String(workPackage.id),
        projectId,
        name: workPackage.subject,
        date,
        status: closed ? 'completed' : date < today ? 'in_progress' : 'upcoming',
      };
    });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/projects/:id',
    async (request) => {
      const { id } = request.params;
      const patch = request.body ?? {};

      // Editing a project's upstream fields or its EPM overlay are both project
      // edits, so both need the permission in that project.
      await guard.require(request, 'project:edit', id);

      // `payload` carries an OpenProject payload verbatim, so a form rendered
      // from OpenProject's schema can write every field the instance defines.
      // The overlay keys below stay supported for the curated screens.
      const payload = patch.payload;
      if (payload && typeof payload === 'object') {
        await openProject.request<{ id: number }>(`/projects/${id}`, {
          method: 'PATCH',
          body: payload,
          signal: requestSignal(request),
        });
      }

      // Portfolio and budget are EPM-owned; they have no OpenProject column,
      // so they are persisted in the overlay rather than pushed upstream.
      const overlay: Record<string, unknown> = {};
      if (typeof patch.portfolio === 'string') overlay.portfolio = patch.portfolio;
      if (typeof patch.budgetTotal === 'number') overlay.budgetTotal = patch.budgetTotal;
      if (typeof patch.budgetUsed === 'number') overlay.budgetUsed = patch.budgetUsed;

      if (Object.keys(overlay).length > 0) {
        await optional(
          () =>
            prisma.projectProfile.upsert({
              where: { openProjectId: id },
              create: { openProjectId: id, ...overlay },
              update: overlay,
            }),
          null,
        );
      }

      invalidateProjects();

      const projects = await loadProjects(requestSignal(request));
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) throw EpmError.notFound('That project');
      return project;
    },
  );
  /**
   * Create a project from a raw OpenProject payload.
   *
   * Takes the payload verbatim so a form rendered from OpenProject's own schema
   * can write every field the instance defines, custom fields included, without
   * the EPM project model having to grow a column for each.
   */
  app.post<{ Body: { payload?: Record<string, unknown> } }>(
    '/projects',
    async (request, reply) => {
      const payload = request.body?.payload;
      if (!payload || typeof payload !== 'object') {
        throw EpmError.badRequest('payload is required.');
      }

      // Project creation is a global capability in OpenProject.
      await guard.require(request, 'project:create');

      const created = await openProject.request<{ id: number; name: string }>('/projects', {
        method: 'POST',
        body: payload,
        signal: requestSignal(request),
      });

      invalidateProjects();

      reply.code(201);
      return { id: String(created.id), name: created.name };
    },
  );

  /** Archive rather than delete: OpenProject deletion is asynchronous and final. */

  /**
   * Pins one or more health dimensions.
   *
   * Its own route rather than part of the overlay patch above, which is gated
   * on `project:edit` — derived from OpenProject's `projects/update`. Health is
   * EPM's judgement, so its authority is EPM's to grant; sharing that handler
   * would mean sharing that permission.
   *
   * The body is the whole override. An omitted or null dimension is cleared,
   * and `{}` clears every pin, so there is no separate delete.
   */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/projects/:id/health',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'health:manage');

      const body = request.body ?? {};
      const override: Record<string, string> = {};

      for (const [key, level] of Object.entries(body)) {
        // Null and undefined clear that dimension rather than setting it.
        if (level === null || level === undefined) continue;

        if (!HEALTH_DIMENSIONS.includes(key as never)) {
          throw EpmError.badRequest(`${key} is not a health dimension.`);
        }
        if (typeof level !== 'string' || !HEALTH_LEVELS.includes(level as never)) {
          throw EpmError.badRequest(`${String(level)} is not a health level.`);
        }
        override[key] = level;
      }

      // Confirms the project exists and that this caller can see it, so the
      // route cannot be used to discover project ids.
      await openProject.request<{ id: number }>(`/projects/${id}`, {
        signal: requestSignal(request),
      });

      const stored = Object.keys(override).length > 0 ? override : Prisma.DbNull;

      // What it was, before the pin lands. A transition needs both ends, and
      // after the write the previous value is gone.
      const projectsBefore = await loadProjects(requestSignal(request));
      const before = projectsBefore.find((candidate) => candidate.id === id);

      await prisma.projectProfile.upsert({
        where: { openProjectId: id },
        create: { openProjectId: id, healthOverride: stored },
        update: { healthOverride: stored },
      });

      // Re-read through the normal path, so the response is the same shape
      // every other project read returns, with the pin already applied.
      const projects = await loadProjects(requestSignal(request));
      const after = projects.find((candidate) => candidate.id === id);

      // Only when the effective state actually moved. Pinning a dimension that
      // does not change the headline is not news to anyone.
      if (after && before && before.health.overall !== after.health.overall) {
        await notifyHealthChange({
          projectId: id,
          projectName: after.name,
          ownerId: after.ownerId || undefined,
          previous: before.health.overall,
          next: after.health.overall,
          overridden: Boolean(after.healthOverride),
        }).catch((error: unknown) => {
          // A notification that cannot be written must not fail the write the
          // user actually asked for.
          request.log.warn({ err: error }, 'Could not notify a health change');
        });
      }

      return after;
    },
  );


  /**
   * Associates a project with a portfolio, or clears it.
   *
   * Its own route rather than part of the overlay patch above, which is gated
   * on `project:edit` — derived from OpenProject's `projects/update`. A
   * portfolio is EPM's concept, so deciding which one a project belongs to is
   * EPM's to grant. Sending null or omitting the id clears the association.
   */
  app.patch<{ Params: { id: string }; Body: { portfolioId?: unknown } }>(
    '/projects/:id/portfolio',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'portfolios:manage');

      // Confirms the project exists and that this caller can see it, so the
      // route cannot be used to discover project ids.
      await openProject.request<{ id: number }>(`/projects/${id}`, {
        signal: requestSignal(request),
      });

      await setProjectPortfolio(id, request.body?.portfolioId);
      invalidateProjects();

      const projects = await loadProjects(requestSignal(request));
      return projects.find((candidate) => candidate.id === id);
    },
  );

  /**
   * Moves a project under another, or promotes it to the top level.
   *
   * The hierarchy is OpenProject's own — this writes the `parent` link rather
   * than an EPM overlay, so a structure built directly in the instance and one
   * built here are the same structure.
   *
   * Gated on `project:edit` for the project being moved, matching the upstream
   * permission that governs the write. Sending null, an empty string or no id
   * at all detaches it.
   */
  app.patch<{ Params: { id: string }; Body: { parentId?: unknown } }>(
    '/projects/:id/parent',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'project:edit', id);

      const raw = request.body?.parentId;
      const parentId =
        raw === undefined || raw === null || raw === '' ? null : String(raw);

      // Upstream rejects a cycle, but its message names the system behind EPM.
      // Catching the obvious case here keeps the common mistake readable.
      if (parentId === id) {
        throw EpmError.badRequest('A project cannot be its own parent.');
      }

      if (parentId !== null && !/^\d+$/.test(parentId)) {
        throw EpmError.badRequest('That parent project does not exist.');
      }

      if (parentId !== null) {
        // Confirms the caller can see the parent, so this cannot be used to
        // discover project ids, and fails before the write rather than after.
        const parent = await openProject
          .request<{ id: number }>(`/projects/${parentId}`, { signal: requestSignal(request) })
          .catch(() => null);

        if (!parent) throw EpmError.badRequest('That parent project does not exist.');

        // A project cannot move under its own descendant. Upstream enforces
        // this too; checking here turns a 422 into a sentence that says why.
        const descendants = await subtreeIds(id, requestSignal(request));
        if (descendants.has(parentId)) {
          throw EpmError.badRequest(
            'That project is already below this one, so it cannot also be its parent.',
          );
        }
      }

      await openProject.request<{ id: number }>(`/projects/${id}`, {
        method: 'PATCH',
        body: { _links: { parent: { href: parentId ? `/api/v3/projects/${parentId}` : null } } },
        signal: requestSignal(request),
      });

      invalidateProjects();

      const projects = await loadProjects(requestSignal(request));
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) throw EpmError.notFound('That project');
      return project;
    },
  );

  /**
   * The projects directly beneath this one.
   *
   * Read from the live project list rather than queried upstream, so a child
   * the caller cannot see simply does not appear.
   */
  app.get<{ Params: { id: string } }>('/projects/:id/children', async (request) => {
    const { id } = request.params;

    const projects = await loadProjects(requestSignal(request));
    if (!projects.some((candidate) => candidate.id === id)) {
      throw EpmError.notFound('That project');
    }

    return projects.filter((candidate) => candidate.parentId === id);
  });

  app.patch<{ Params: { id: string } }>('/projects/:id/archive', async (request) => {
    await guard.require(request, 'project:archive', request.params.id);

    const updated = await openProject.request<{ id: number; name: string; active: boolean }>(
      `/projects/${request.params.id}`,
      { method: 'PATCH', body: { active: false }, signal: requestSignal(request) },
    );
    invalidateProjects();
    return { id: String(updated.id), name: updated.name, active: updated.active };
  });

  /**
   * Sets who is accountable for a project, or clears it.
   *
   * EPM's own field. OpenProject has no project owner — no schema attribute and
   * no `responsible` link — so this is stored here and the person is still an
   * OpenProject user id, never a record EPM minted.
   *
   * Behind `project:edit` in that project: deciding who owns it is the same
   * kind of decision as editing it, and it is not a portfolio-wide right.
   */
  app.patch<{ Params: { id: string }; Body: { ownerId?: unknown } }>(
    '/projects/:id/owner',
    async (request) => {
      const { id } = request.params;
      await guard.require(request, 'project:edit', id);

      const raw = request.body?.ownerId;
      const ownerId = raw === null || raw === undefined || raw === '' ? null : String(raw).trim();

      if (ownerId !== null) {
        // Must be somebody who exists, or the project reports an owner nobody
        // can resolve and the health notifications go nowhere.
        const users = await getUsers(requestSignal(request));
        if (!users.some((user) => user.id === ownerId)) {
          throw EpmError.badRequest('That person does not exist.');
        }
      }

      await prisma.projectProfile.upsert({
        where: { openProjectId: id },
        create: { openProjectId: id, ownerId },
        update: { ownerId },
      });

      invalidateProjects();
      return { id, ownerId: ownerId ?? '' };
    },
  );

  /**
   * Puts an archived project back.
   *
   * The counterpart archiving always needed: every other archivable thing in
   * EPM — departments, teams, portfolios — can be restored, and a project that
   * could only be archived was a one-way door with deletion as the only way out.
   *
   * Deliberately **not** guarded on `project:archive`. That permission comes
   * from the per-project `projects/update` capability, and an archived project
   * reports **no capabilities at all** — so the very act of archiving removed
   * the permission needed to undo it. Restoring was impossible for everyone,
   * including an instance administrator.
   *
   * The gate is the `delete` affordance instead: it is the only link upstream
   * still publishes on an archived project, and it is a strictly stronger
   * right. Anyone permitted to destroy the project permanently is certainly
   * permitted to un-archive it.
   */
  app.patch<{ Params: { id: string } }>('/projects/:id/restore', async (request) => {
    const { id } = request.params;

    if (!/^\d+$/.test(id)) throw EpmError.notFound('That project');

    const project = await openProject
      .request<{ _links?: Record<string, unknown> }>(`/projects/${id}`, {
        signal: requestSignal(request),
      })
      .catch(() => null);

    if (!project) throw EpmError.notFound('That project');

    if (!project._links || !Object.hasOwn(project._links, 'delete')) {
      throw EpmError.forbidden('You do not have permission to restore this project.');
    }

    const updated = await openProject.request<{ id: number; name: string; active: boolean }>(
      `/projects/${id}`,
      { method: 'PATCH', body: { active: true }, signal: requestSignal(request) },
    );
    invalidateProjects();
    return { id: String(updated.id), name: updated.name, active: updated.active };
  });

  /**
   * Deletes a project permanently.
   *
   * Gated on the `delete` affordance the project itself publishes, which is the
   * only signal upstream offers — no capability reports it. Nothing about
   * archiving implies it: archiving is reversible and deletion takes every work
   * package, comment and time entry in the project with it.
   *
   * Upstream queues the work, so the project is briefly still readable. This
   * waits for it to be gone before answering, because the alternative is a
   * caller who refreshes and sees what they just deleted.
   */
  app.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const { id } = request.params;

    if (!/^\d+$/.test(id)) throw EpmError.notFound('That project');

    const project = await openProject
      .request<{ id: number; _links?: Record<string, unknown> }>(`/projects/${id}`, {
        signal: requestSignal(request),
      })
      .catch(() => null);

    if (!project) throw EpmError.notFound('That project');

    if (!project._links || !Object.hasOwn(project._links, 'delete')) {
      throw EpmError.forbidden('You do not have permission to delete this project.');
    }

    await openProject.request<void>(`/projects/${id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });

    // The EPM overlay is keyed on a project that will no longer exist. Its
    // portfolio link, budget and health pin go with it.
    await prisma.projectProfile.deleteMany({ where: { openProjectId: id } }).catch(() => undefined);

    const deadline = Date.now() + 8_000;
    let gone = false;

    while (!gone && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const still = await openProject
        .request<unknown>(`/projects/${id}`, { signal: requestSignal(request) })
        .catch(() => null);
      gone = still === null;
    }

    invalidateProjects();

    // 202 while it is still running, rather than a 204 that claims otherwise.
    reply.code(gone ? 204 : 202);
  });

};
/**
 * Every project at or below `rootId`, by id.
 *
 * Used to refuse a move that would put a project under its own descendant,
 * which would detach that whole branch from the tree.
 */
async function subtreeIds(rootId: string, signal: AbortSignal): Promise<Set<string>> {
  const projects = await loadProjects(signal);

  const childrenOf = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentId) continue;
    const siblings = childrenOf.get(project.parentId) ?? [];
    siblings.push(project.id);
    childrenOf.set(project.parentId, siblings);
  }

  const seen = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.pop() as string) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }

  return seen;
}

async function milestoneTypeIds(signal: AbortSignal): Promise<string[]> {
  const { getCatalog } = await import('../mapping/catalog.js');
  const catalog = await getCatalog(signal);
  return catalog.typeIdsByEpm.get('milestone') ?? [];
}
