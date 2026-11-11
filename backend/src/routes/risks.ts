import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { requestHealthRecalc } from '../domain/health.js';
import { getHealthRules, resolveRiskSelection } from '../domain/health-rules.js';
import {
  PRIORITY_OF_RATING,
  assessmentsOf,
  ratingOf,
  saveAssessment,
  scoreAfter,
  toRiskEntry,
  validateAssessment,
} from '../domain/risks.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import { idFromHref, openProject, type OpFilter } from '../openproject/client.js';
import type { MilestoneEntry, RiskAssessmentInput, RiskEntry, RiskRegister } from '../types/epm.js';

/**
 * The risk register, and milestones across projects.
 *
 * Both read work packages as the signed-in person, so each lists only what
 * that person may see: risks and milestones in projects they cannot read are
 * not there, and are not counted.
 *
 * A risk is created and edited as the work package it is (Tasks: title, owner,
 * status, dates); the register adds its assessment, which needs the right to
 * edit that work package.
 */

const today = () => new Date().toISOString().slice(0, 10);

const registerQuery = z.object({
  projectId: z.string().regex(/^\d+$/).optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
});

const milestoneQuery = z.object({
  projectId: z.string().regex(/^\d+$/).optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
});

/** A work package's project id, from its link. */
const projectOf = (workPackage: WorkPackageWithPoints): string | undefined => {
  const href = (workPackage._links as { project?: { href?: string | null } } | undefined)?.project?.href;
  return href ? (idFromHref(href) ?? undefined) : undefined;
};

export const riskRoutes: FastifyPluginAsync = async (app) => {
  /** Every risk the reader may see, each with its assessment, score and stage. */
  app.get('/risks', async (request): Promise<RiskRegister> => {
    const query = registerQuery.parse(request.query);
    const signal = requestSignal(request);

    const { typeIds } = await resolveRiskSelection(await getHealthRules(), signal);
    if (typeIds.length === 0) return { configured: false, typeIds: [], items: [], truncated: false };

    const filters: OpFilter[] = [{ field: 'type', operator: '=', values: typeIds }];
    if (query.projectId) filters.push({ field: 'project', operator: '=', values: [query.projectId] });
    const state = query.state ?? 'all';
    if (state === 'open') filters.push({ field: 'status', operator: 'o', values: [] });
    if (state === 'closed') filters.push({ field: 'status', operator: 'c', values: [] });

    const [catalog, identifiers, found] = await Promise.all([
      getCatalog(signal),
      projectIdentifiers(signal),
      openProject.getAll<WorkPackageWithPoints>(
        '/work_packages',
        { filters, sortBy: [['updatedAt', 'desc']], pageSize: 200 },
        { signal, maxPages: 5 },
      ),
    ]);

    const assessments = await assessmentsOf(found.items.map((item) => Number(item.id)));
    const day = today();
    const items: RiskEntry[] = found.items.map((workPackage) =>
      toRiskEntry(toEpmTask(workPackage, catalog, identifiers), assessments.get(Number(workPackage.id)), day),
    );

    return { configured: true, typeIds, items, truncated: found.truncated };
  });

  /**
   * Saves a risk's assessment: probability, impact, category, response, the
   * plans and the review date. Only what is sent changes.
   *
   * The rating it leaves sets the work package's priority, so health and the
   * risk measures count the risk at the severity the register gives it.
   */
  app.put<{ Params: { workPackageId: string }; Body: RiskAssessmentInput }>(
    '/risks/:workPackageId/assessment',
    async (request): Promise<RiskEntry> => {
      const { workPackageId } = z.object({ workPackageId: z.string().regex(/^\d+$/) }).parse(request.params);
      const signal = requestSignal(request);
      const data = validateAssessment(request.body);

      // Read as the caller: a work package they cannot see is not found.
      const workPackage = await openProject
        .request<WorkPackageWithPoints>(`/work_packages/${workPackageId}`, { signal })
        .catch(() => null);
      const projectId = workPackage ? projectOf(workPackage) : undefined;
      if (!workPackage || !projectId) throw EpmError.notFound(message('Work package {id}', { id: workPackageId }));

      await guard.require(request, 'task:edit', projectId);

      const { typeIds } = await resolveRiskSelection(await getHealthRules(), signal);
      const typeId = idFromHref((workPackage._links as { type?: { href?: string | null } } | undefined)?.type?.href ?? '');
      if (!typeId || !typeIds.includes(typeId)) throw EpmError.badRequest('That work package is not a risk.');

      const existing = (await assessmentsOf([Number(workPackageId)])).get(Number(workPackageId));
      const catalog = await getCatalog(signal);

      // The severity follows the rating. Written first: if the work package
      // refuses it, nothing is saved and the reason is shown.
      let current = workPackage;
      const rating = ratingOf(scoreAfter(existing, data));
      if (rating) {
        const wanted = PRIORITY_OF_RATING[rating];
        const priorityId = idFromHref((workPackage._links as { priority?: { href?: string | null } } | undefined)?.priority?.href ?? '');
        const has = priorityId ? catalog.priorityById.get(priorityId)?.epm : undefined;
        const target = catalog.priorityIdsByEpm.get(wanted)?.[0];
        if (target && has !== wanted) {
          current = await openProject.request<WorkPackageWithPoints>(`/work_packages/${workPackageId}`, {
            method: 'PATCH',
            query: { notify: 'false' },
            body: { lockVersion: workPackage.lockVersion, _links: { priority: { href: `/api/v3/priorities/${target}` } } },
            signal,
          });
          requestHealthRecalc(projectId);
        }
      }

      const saved = await saveAssessment({
        workPackageId: Number(workPackageId),
        projectId: Number(projectId),
        subject: workPackage.subject,
        actorId: request.auth!.userId,
        data,
        existing,
      });

      const identifiers = await projectIdentifiers(signal);
      return toRiskEntry(toEpmTask(current, catalog, identifiers), saved, today());
    },
  );

  /**
   * Milestones in every project the reader may see: the work packages of a
   * milestone type, soonest first, with whether each is closed or overdue.
   */
  app.get('/milestones', async (request): Promise<MilestoneEntry[]> => {
    const query = milestoneQuery.parse(request.query);
    const signal = requestSignal(request);

    // The same milestone types a project's own milestones are read with.
    const catalog = await getCatalog(signal);
    const typeIds = catalog.typeIdsByEpm.get('milestone') ?? [];
    if (typeIds.length === 0) return [];

    const filters: OpFilter[] = [{ field: 'type', operator: '=', values: typeIds }];
    if (query.projectId) filters.push({ field: 'project', operator: '=', values: [query.projectId] });
    const state = query.state ?? 'all';
    if (state === 'open') filters.push({ field: 'status', operator: 'o', values: [] });
    if (state === 'closed') filters.push({ field: 'status', operator: 'c', values: [] });

    const found = await openProject.getAll<WorkPackageWithPoints & { date?: string | null }>(
      '/work_packages',
      { filters, sortBy: [['id', 'asc']], pageSize: 200 },
      { signal, maxPages: 10 },
    );

    const day = today();
    return found.items
      .map((workPackage): MilestoneEntry | null => {
        const projectId = projectOf(workPackage);
        if (!projectId) return null;
        const links = workPackage._links as Record<string, { href?: string | null; title?: string } | undefined> | undefined;
        const statusId = idFromHref(links?.status?.href ?? '');
        const status = statusId ? catalog.statusById.get(statusId) : undefined;
        const closed = status?.isClosed ?? false;
        // A milestone's one date is `date`; a type turned into a milestone
        // later may still carry the finish or start it had.
        const date = workPackage.date ?? workPackage.dueDate ?? workPackage.startDate ?? undefined;
        const assigneeId = idFromHref(links?.assignee?.href ?? '') ?? undefined;
        return {
          id: String(workPackage.id),
          projectId,
          name: workPackage.subject,
          date: date ?? undefined,
          statusName: status?.name ?? links?.status?.title ?? '',
          closed,
          overdue: !closed && date !== undefined && date !== null && date < day,
          assigneeId,
        };
      })
      .filter((entry): entry is MilestoneEntry => entry !== null)
      .sort((a, b) => (a.date ?? '9999-12-31').localeCompare(b.date ?? '9999-12-31') || a.name.localeCompare(b.name));
  });
};
