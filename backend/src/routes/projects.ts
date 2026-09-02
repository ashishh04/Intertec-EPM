import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, linkId } from '../openproject/client.js';
import { getProjectAggregates, getProjectOverlays, toEpmProject } from '../mapping/projects.js';
import { prisma, optional } from '../db/prisma.js';
import type { OpMembership, OpProject, OpVersion } from '../openproject/types.js';
import type { Milestone, EpmProject } from '../types/epm.js';

const listQuery = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
});

/** Project members, grouped in one pass over memberships. */
async function membersByProject(signal?: AbortSignal): Promise<Map<string, string[]>> {
  const memberships = await openProject
    .getAll<OpMembership>('/memberships', { pageSize: 100 }, { signal })
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

async function loadProjects(signal: AbortSignal): Promise<EpmProject[]> {
  const today = new Date().toISOString().slice(0, 10);

  const [projects, aggregates, members, overlays] = await Promise.all([
    openProject.getAll<OpProject>('/projects', { pageSize: 100 }, { signal }),
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

      const created = await openProject.request<{ id: number; name: string }>('/projects', {
        method: 'POST',
        body: payload,
        signal: requestSignal(request),
      });

      reply.code(201);
      return { id: String(created.id), name: created.name };
    },
  );

  /** Archive rather than delete: OpenProject deletion is asynchronous and final. */
  app.patch<{ Params: { id: string } }>('/projects/:id/archive', async (request) => {
    const updated = await openProject.request<{ id: number; name: string; active: boolean }>(
      `/projects/${request.params.id}`,
      { method: 'PATCH', body: { active: false }, signal: requestSignal(request) },
    );
    return { id: String(updated.id), name: updated.name, active: updated.active };
  });

};
async function milestoneTypeIds(signal: AbortSignal): Promise<string[]> {
  const { getCatalog } = await import('../mapping/catalog.js');
  const catalog = await getCatalog(signal);
  return catalog.typeIdsByEpm.get('milestone') ?? [];
}
