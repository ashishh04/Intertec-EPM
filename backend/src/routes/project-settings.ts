import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { assertIdentifierAllowed } from '../domain/reserved-identifiers.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import { idFromHref, linkId, linkTitle, openProject } from '../openproject/client.js';
import type { OpVersion } from '../openproject/types.js';
import type {
  ProjectAbilities,
  ProjectAttributes,
  ProjectAttributeSection,
  ProjectCopyJob,
  ProjectModules,
  ProjectPhases,
  RoadmapVersion,
} from '../types/epm.js';
import { invalidateProjects } from './projects.js';

/**
 * A project's settings that the delivery system keeps behind HTML forms:
 * modules, which attributes it shows, whether it is a template, and its life
 * cycle; and copying a project, which its API does have but only with an email
 * of its own when the copy finishes.
 *
 * All of it goes through the EPM add-on (`zzz_epm_project.rb`) as the
 * signed-in person, so the delivery system's own permissions decide each
 * change and its own reasons come back when one is refused.
 */

const projectId = z.object({ id: z.string().regex(/^\d+$/) });

/** Turns an upstream refusal into EPM's own error, message intact. */
function rethrow(error: unknown): never {
  if (error instanceof OpenProjectError) {
    if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
    if (error.upstreamStatus === 404) throw EpmError.notFound('That project');
    if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
  }
  throw error;
}

const addOn = <T>(request: FastifyRequest, path: string, method = 'GET', body?: unknown) =>
  openProject
    .request<T>(`/epm_project${path}`, { root: true, method: method as 'GET', ...(body !== undefined ? { body } : {}), signal: requestSignal(request) })
    .catch(rethrow);

/** A custom field's value on a project, as text, whatever its format. */
function attributeValue(project: Record<string, unknown>, id: string): string | undefined {
  const key = `customField${id}`;
  const value = project[key];
  if (value !== undefined && value !== null) {
    if (typeof value === 'object' && 'raw' in (value as object)) return String((value as { raw?: string }).raw ?? '') || undefined;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value) || undefined;
  }
  const link = (project._links as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(link)) {
    const titles = link.map((item) => (item as { title?: string }).title).filter(Boolean);
    return titles.length ? titles.join(', ') : undefined;
  }
  const title = (link as { title?: string; href?: string | null } | undefined)?.href ? (link as { title?: string }).title : undefined;
  return title || undefined;
}

const copyBody = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(255),
  identifier: z.string().trim().max(100).optional(),
  parentId: z.string().regex(/^\d+$/).nullable().optional(),
  copy: z
    .object({
      members: z.boolean().optional(),
      versions: z.boolean().optional(),
      categories: z.boolean().optional(),
      workPackages: z.boolean().optional(),
      workPackageAttachments: z.boolean().optional(),
      wiki: z.boolean().optional(),
      queries: z.boolean().optional(),
      boards: z.boolean().optional(),
      overview: z.boolean().optional(),
      phases: z.boolean().optional(),
    })
    .optional(),
});

/** The delivery system's names for the parts of a project a copy brings, from EPM's own. */
const COPY_PARTS: Record<string, string> = {
  members: 'members',
  versions: 'versions',
  categories: 'categories',
  workPackages: 'work_packages',
  workPackageAttachments: 'work_package_attachments',
  wiki: 'wiki',
  queries: 'queries',
  boards: 'boards',
  overview: 'overview',
  phases: 'phases',
};

/** What a copy brings when the caller does not say: the dialog's own defaults. */
const DEFAULT_COPY: Record<string, boolean> = {
  members: true,
  versions: true,
  categories: true,
  workPackages: true,
  workPackageAttachments: false,
  wiki: true,
  queries: true,
  boards: true,
  overview: true,
  phases: true,
};

type OpJobStatus = {
  jobId?: string;
  status?: ProjectCopyJob['status'];
  message?: string;
  payload?: { redirect?: string; title?: string; errors?: string[] };
  _links?: Record<string, { href?: string | null }>;
};

function toCopyJob(job: OpJobStatus, fallbackId?: string): ProjectCopyJob {
  const jobId = job.jobId ?? idFromHref(job._links?.self?.href ?? '') ?? fallbackId ?? '';
  // The new project's address, e.g. /projects/new-identifier or /projects/123.
  const redirect = job.payload?.redirect ?? '';
  const match = /\/projects\/([^/?#]+)/.exec(redirect);
  return {
    jobId,
    status: job.status ?? 'in_queue',
    ...(match ? { projectId: match[1] } : {}),
    ...(job.message || job.payload?.errors?.length ? { message: [job.message, ...(job.payload?.errors ?? [])].filter(Boolean).join(' ') } : {}),
  };
}

export const projectSettingRoutes: FastifyPluginAsync = async (app) => {
  /* ----------------------------------------------------------- abilities */

  /**
   * What the reader may do in the project, for a screen that offers an action
   * before it is tried (creating a board, running the life cycle): answered by
   * the project's own roles and modules, as each action itself would be.
   */
  app.get('/projects/:id/abilities', async (request): Promise<ProjectAbilities> => {
    const { id } = projectId.parse(request.params);
    return addOn<ProjectAbilities>(request, `/projects/${id}/abilities`);
  });

  /* ------------------------------------------------------------- modules */

  app.get('/projects/:id/modules', async (request): Promise<ProjectModules> => {
    const { id } = projectId.parse(request.params);
    return addOn<ProjectModules>(request, `/projects/${id}/modules`);
  });

  app.patch<{ Body: unknown }>('/projects/:id/modules', async (request): Promise<ProjectModules> => {
    const { id } = projectId.parse(request.params);
    const { enabled } = z.object({ enabled: z.array(z.string().max(64)).max(64) }).parse(request.body ?? {});
    const result = await addOn<ProjectModules>(request, `/projects/${id}/modules`, 'PATCH', { enabled });
    invalidateProjects();
    return result;
  });

  /* ---------------------------------------------------------- attributes */

  /** The project's attributes by section, with the value of each shown here. */
  app.get('/projects/:id/attributes', async (request): Promise<ProjectAttributes> => {
    const { id } = projectId.parse(request.params);
    const [settings, project, mayEdit] = await Promise.all([
      addOn<{ sections: ProjectAttributeSection[]; canEdit: boolean }>(request, `/projects/${id}/attributes`),
      openProject.request<Record<string, unknown>>(`/projects/${id}`, { signal: requestSignal(request) }).catch(rethrow),
      guard.holds(request, 'project:edit', id),
    ]);
    return {
      sections: settings.sections.map((section) => ({
        id: String(section.id),
        name: section.name,
        fields: section.fields.map((field) => {
          const value = field.enabled ? attributeValue(project, String(field.id)) : undefined;
          return { ...field, id: String(field.id), ...(value ? { value } : {}) };
        }),
      })),
      canSelect: settings.canEdit,
      canEdit: mayEdit,
    };
  });

  /** Shows or hides one attribute in this project. */
  app.patch<{ Body: unknown }>('/projects/:id/attributes/enabled', async (request) => {
    const { id } = projectId.parse(request.params);
    const body = z.object({ customFieldId: z.string().regex(/^\d+$/), enabled: z.boolean() }).parse(request.body ?? {});
    // One shown in every project has no per-project switch; upstream's own
    // refusal reads as though something were being deleted.
    if (!body.enabled) {
      const settings = await addOn<{ sections: ProjectAttributeSection[] }>(request, `/projects/${id}/attributes`);
      const field = settings.sections.flatMap((section) => section.fields).find((one) => String(one.id) === body.customFieldId);
      if (field?.forAll) {
        throw EpmError.validation('That attribute is shown in every project, so it cannot be hidden in one.');
      }
    }
    await addOn(request, `/projects/${id}/attributes`, 'PATCH', { customFieldId: Number(body.customFieldId), enabled: body.enabled });
    invalidateProjects();
    return { ok: true };
  });

  /* ------------------------------------------------------------ template */

  app.patch<{ Body: unknown }>('/projects/:id/template', async (request) => {
    const { id } = projectId.parse(request.params);
    const { templated } = z.object({ templated: z.boolean() }).parse(request.body ?? {});
    const result = await addOn<{ templated: boolean }>(request, `/projects/${id}/template`, 'PATCH', { templated });
    invalidateProjects();
    return result;
  });

  /**
   * Starts a copy of a project (a template, usually) as a new one. The copy
   * runs in the background; its job is followed with the route below.
   */
  app.post<{ Body: unknown }>('/projects/:id/copy', async (request, reply): Promise<ProjectCopyJob> => {
    const { id } = projectId.parse(request.params);
    const input = copyBody.parse(request.body ?? {});
    await guard.require(request, 'project:create');
    await assertIdentifierAllowed(input.identifier, await guard.holds(request, 'users:manage'));
    // Said here, in the reader's language, rather than as the delivery
    // system's own validation text.
    if (input.identifier) {
      const wanted = input.identifier.toLowerCase();
      const identifiers = await projectIdentifiers(requestSignal(request));
      if ([...identifiers.values()].some((identifier) => identifier.toLowerCase() === wanted)) {
        throw EpmError.validation('Another project already uses that identifier.');
      }
    }

    // Only what is chosen comes across: a part left unsaid stays behind.
    const chosen = { ...DEFAULT_COPY, ...input.copy };
    const only = Object.entries(chosen)
      .filter(([key, on]) => on && COPY_PARTS[key])
      .map(([key]) => COPY_PARTS[key]!);
    // Through the add-on, so the copy runs without the delivery system's own
    // "project copied" email; the job is followed exactly as before.
    const started = await addOn<{ jobId: string }>(request, `/projects/${id}/copy`, 'POST', {
      name: input.name,
      ...(input.identifier ? { identifier: input.identifier } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      only,
    });
    reply.code(202);
    return { jobId: started.jobId, status: 'in_queue' };
  });

  /** Where a copy has got to; once it succeeds, the new project's id. */
  app.get('/projects/copy-jobs/:jobId', async (request): Promise<ProjectCopyJob> => {
    const { jobId } = z.object({ jobId: z.string().regex(/^[A-Za-z0-9-]+$/) }).parse(request.params);
    const job = await openProject
      .request<OpJobStatus>(`/job_statuses/${jobId}`, { signal: requestSignal(request) })
      .catch(rethrow);
    const result = toCopyJob(job, jobId);
    // The address may name the identifier: answer with the id.
    if (result.projectId && !/^\d+$/.test(result.projectId)) {
      const byIdentifier = [...(await projectIdentifiers(requestSignal(request))).entries()].find(([, identifier]) => identifier === result.projectId);
      result.projectId = byIdentifier?.[0];
    }
    if (result.status === 'success') invalidateProjects();
    return result;
  });

  /* ---------------------------------------------------------- life cycle */

  app.get('/projects/:id/phases', async (request): Promise<ProjectPhases> => {
    const { id } = projectId.parse(request.params);
    const result = await addOn<ProjectPhases & { phases: Array<ProjectPhases['phases'][number] & { definitionId: number | string }> }>(
      request,
      `/projects/${id}/phases`,
    );
    return { ...result, phases: result.phases.map((phase) => ({ ...phase, definitionId: String(phase.definitionId) })) };
  });

  app.patch<{ Body: unknown }>('/projects/:id/phases/:definitionId', async (request): Promise<ProjectPhases> => {
    const { id, definitionId } = z
      .object({ id: z.string().regex(/^\d+$/), definitionId: z.string().regex(/^\d+$/) })
      .parse(request.params);
    const body = z
      .object({
        active: z.boolean().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        finishDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .parse(request.body ?? {});
    if (Object.keys(body).length === 0) throw EpmError.badRequest('Nothing to change.');
    if (body.startDate && body.finishDate && body.finishDate < body.startDate) {
      throw EpmError.validation('A phase cannot finish before it starts.');
    }
    const result = await addOn<ProjectPhases>(request, `/projects/${id}/phases/${definitionId}`, 'PATCH', body);
    return { ...result, phases: result.phases.map((phase) => ({ ...phase, definitionId: String(phase.definitionId) })) };
  });

  /* ------------------------------------------------------------- roadmap */

  /**
   * The project's versions, soonest first, each with the work planned into it
   * and how much of it is done: the roadmap.
   */
  app.get('/projects/:id/roadmap', async (request): Promise<RoadmapVersion[]> => {
    const { id } = projectId.parse(request.params);
    const signal = requestSignal(request);
    const [versions, work, catalog, identifiers] = await Promise.all([
      openProject.getAll<OpVersion>(`/projects/${id}/versions`, { pageSize: 200 }, { signal }).catch(rethrow),
      openProject
        .getAll<WorkPackageWithPoints>(
          '/work_packages',
          {
            filters: [
              { field: 'project', operator: '=', values: [id] },
              { field: 'version', operator: '*', values: [] },
            ],
            sortBy: [['id', 'asc']],
            pageSize: 200,
          },
          { signal, maxPages: 10 },
        )
        .catch(() => ({ items: [] as WorkPackageWithPoints[] })),
      getCatalog(signal),
      projectIdentifiers(signal),
    ]);
    const tasks = work.items.map((item) => toEpmTask(item, catalog, identifiers));
    return versions.items
      .map((version): RoadmapVersion => {
        const items = tasks.filter((task) => task.sprintId === String(version.id));
        const closed = items.filter((task) => task.status.isClosed);
        const points = (list: typeof items) => list.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
        const definingProjectId = linkId(version._links, 'definingProject');
        return {
          id: String(version.id),
          name: version.name,
          ...(version.description?.raw ? { description: version.description.raw } : {}),
          status: version.status,
          ...(version.startDate ? { startDate: version.startDate } : {}),
          ...(version.endDate ? { endDate: version.endDate } : {}),
          ...(definingProjectId && definingProjectId !== id
            ? { definingProjectId, definingProjectName: linkTitle(version._links, 'definingProject') }
            : {}),
          total: items.length,
          closed: closed.length,
          pointsTotal: points(items),
          pointsDone: points(closed),
          items,
        };
      })
      .sort(
        (a, b) =>
          Number(a.status === 'closed') - Number(b.status === 'closed') ||
          (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999') ||
          a.name.localeCompare(b.name),
      );
  });
};
