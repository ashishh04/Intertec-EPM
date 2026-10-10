import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { aggregateCache, userScopedKey } from '../lib/cache.js';
import { openProject, linkId, MAX_PAGE_SIZE } from '../openproject/client.js';
import { getProjectAggregates, getProjectOverlays, toEpmProject } from '../mapping/projects.js';
import { prisma } from '../db/prisma.js';
import { setProjectPortfolio } from '../domain/portfolios.js';
import { getUsers } from '../mapping/users.js';
import { notifyHealthChange } from '../domain/notifications.js';
import { listAudit, listAuditPage, recordAudit, withAudit } from '../domain/audit.js';
import {
  healthViews,
  parseOverrideLevels,
  recalculateNow,
  requestHealthRecalc,
  unassessedView,
} from '../domain/health.js';
import { HEALTH_CRITERIA, criterionName } from '../domain/health-rules.js';
import { allows } from '../auth/capabilities.js';
import { env } from '../config/env.js';
import type { OpMembership, OpProject, OpVersion } from '../openproject/types.js';
import type { HealthCriterion, HealthLevel, HealthOverride, Milestone, EpmProject } from '../types/epm.js';
import { noteRuleEvent } from '../domain/rule-events.js';
import { automationUserId } from '../domain/automation-account.js';
import { clauses } from '../domain/notifications.js';
import { contextLanguage, contextReader, dateOf, listOf, message, type Message } from '../lib/i18n.js';
import { forgetProjectBaselines } from '../domain/earned-value-store.js';

const listQuery = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
});

/** Project members, grouped in one pass over memberships. */
async function membersByProject(signal?: AbortSignal): Promise<Map<string, string[]>> {
  const [memberships, automationId] = await Promise.all([
    openProject
      .getAll<OpMembership>('/memberships', { pageSize: MAX_PAGE_SIZE }, { signal })
      .catch(() => ({ items: [] as OpMembership[] })),
    automationUserId().catch(() => undefined),
  ]);

  const byProject = new Map<string, string[]>();
  for (const membership of memberships.items) {
    const projectId = linkId(membership._links, 'project');
    const principalId = linkId(membership._links, 'principal');
    // The automation account is a member where a rule acts, not one of the
    // team: it would otherwise be counted in a portfolio's people and capacity.
    if (!projectId || !principalId || principalId === automationId) continue;

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
 *
 * And per language: each project's health reasons and explanation are written
 * out in the language of the request (BR-605), so a list built for one
 * language must not be served to the other.
 */
export async function loadProjects(signal: AbortSignal): Promise<EpmProject[]> {
  return aggregateCache.get(userScopedKey(`projects:${contextReader()}`), () => buildProjects(signal));
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
  const [projects, aggregates, members, overlays] = await Promise.all([
    openProject.getAll<OpProject>('/projects', { pageSize: MAX_PAGE_SIZE }, { signal }),
    getProjectAggregates(signal),
    membersByProject(signal),
    getProjectOverlays(),
  ]);

  // Stored health, one authoritative value per project, for exactly the
  // projects this caller can see.
  const health = await healthViews(projects.items);

  return projects.items.map((project) =>
    toEpmProject(project, aggregates, {
      memberIds: members.get(String(project.id)) ?? [],
      overlay: overlays.get(String(project.id)),
      // A project without a view reads as not assessed rather than vanishing
      // from the list.
      health: health.get(String(project.id)) ?? unassessedView(message('Health has not been calculated yet.')),
    }),
  );
}

const DIMENSIONS = [...HEALTH_CRITERIA, 'overall'] as const;
const LEVELS: HealthLevel[] = ['healthy', 'warning', 'critical'];

/** A reason has to say something. Ten characters rules out "ok" and "fix". */
const MIN_REASON = 10;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are written YYYY-MM-DD.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'That is not a real date.');

const planBody = z
  .object({
    plannedStart: day.nullable().optional(),
    plannedFinish: day.nullable().optional(),
    budgetTotal: z
      .number()
      .finite()
      .min(0, 'A budget cannot be negative.')
      .max(1e13, 'That budget is too large.')
      .nullable()
      .optional(),
    /** Whether time logged here is billable (BR-315); null follows the instance default. */
    billable: z.boolean().nullable().optional(),
    /** Whether the project's owner approves time logged here (BR-305); null means yes. */
    timesheetApproval: z.boolean().nullable().optional(),
  })
  .strict();

/** "30 Sep 2026" in English, in the reader's language and calendar otherwise; "none" when unset. */
function describeDay(value: Date | string | null | undefined): Message | ReturnType<typeof dateOf> {
  if (!value) return message('none');
  return dateOf(typeof value === 'string' ? value : value.toISOString().slice(0, 10));
}

/**
 * An amount as the journal has always written it, "AED 1,250.5". Passed as
 * text: the reader's currency format would write it differently in English.
 */
function describeMoney(value: number | null | undefined): string | Message {
  if (value === null || value === undefined || value === 0) return message('none');
  return `${env.EPM_CURRENCY} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * Writes a project's planned dates and budget, journalled together.
 *
 * Every field is optional and `null` clears it. The finish may not come
 * before the start once both are known — including when only one of them is
 * being changed, which is the case a per-field check would miss.
 */
async function updatePlan(projectId: string, input: z.infer<typeof planBody>): Promise<boolean> {
  const existing = await prisma.projectProfile.findUnique({
    where: { openProjectId: projectId },
    select: { plannedStart: true, plannedFinish: true, budgetTotal: true, billable: true, timesheetApproval: true },
  });

  const toDate = (value: string | null) => (value === null ? null : new Date(`${value}T00:00:00Z`));
  const next = {
    plannedStart: input.plannedStart === undefined ? existing?.plannedStart ?? null : toDate(input.plannedStart),
    plannedFinish: input.plannedFinish === undefined ? existing?.plannedFinish ?? null : toDate(input.plannedFinish),
    budgetTotal: input.budgetTotal === undefined ? existing?.budgetTotal ?? null : input.budgetTotal,
    billable: input.billable === undefined ? existing?.billable ?? null : input.billable,
    timesheetApproval: input.timesheetApproval === undefined ? existing?.timesheetApproval ?? null : input.timesheetApproval,
  };

  if (next.plannedStart && next.plannedFinish && next.plannedFinish < next.plannedStart) {
    throw EpmError.validation('The planned finish cannot be before the planned start.');
  }

  const changes: Message[] = [];
  const sameDay = (a: Date | null | undefined, b: Date | null) =>
    (a?.toISOString().slice(0, 10) ?? null) === (b?.toISOString().slice(0, 10) ?? null);
  if (!sameDay(existing?.plannedStart, next.plannedStart)) {
    changes.push(
      message('planned start {from} → {to}', { from: describeDay(existing?.plannedStart), to: describeDay(next.plannedStart) }),
    );
  }
  if (!sameDay(existing?.plannedFinish, next.plannedFinish)) {
    changes.push(
      message('planned finish {from} → {to}', { from: describeDay(existing?.plannedFinish), to: describeDay(next.plannedFinish) }),
    );
  }
  if ((existing?.budgetTotal ?? null) !== next.budgetTotal) {
    changes.push(
      message('budget {from} → {to}', { from: describeMoney(existing?.budgetTotal), to: describeMoney(next.budgetTotal) }),
    );
  }
  if ((existing?.billable ?? null) !== next.billable) {
    const describeBillable = (value: boolean | null | undefined): Message =>
      value === true ? message('billable') : value === false ? message('not billable') : message('as the default');
    changes.push(message('logged time {from} → {to}', { from: describeBillable(existing?.billable), to: describeBillable(next.billable) }));
  }
  if ((existing?.timesheetApproval ?? null) !== next.timesheetApproval) {
    const describeApproval = (value: boolean | null | undefined): Message =>
      value === false ? message('not by the owner') : message('by the owner');
    changes.push(
      message('timesheets approved {from} → {to}', {
        from: describeApproval(existing?.timesheetApproval),
        to: describeApproval(next.timesheetApproval),
      }),
    );
  }
  if (changes.length === 0) return false;

  const snapshot = (value: typeof next) => ({
    plannedStart: value.plannedStart?.toISOString().slice(0, 10) ?? null,
    plannedFinish: value.plannedFinish?.toISOString().slice(0, 10) ?? null,
    budgetTotal: value.budgetTotal,
    billable: value.billable,
    timesheetApproval: value.timesheetApproval,
  });

  await withAudit(
    (tx) =>
      tx.projectProfile.upsert({
        where: { openProjectId: projectId },
        create: { openProjectId: projectId, ...next },
        update: next,
      }),
    {
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'project.plan.updated',
      summary: message('Plan changed: {changes}.', { changes: clauses(changes) }),
      before: snapshot({
        plannedStart: existing?.plannedStart ?? null,
        plannedFinish: existing?.plannedFinish ?? null,
        budgetTotal: existing?.budgetTotal ?? null,
        billable: existing?.billable ?? null,
        timesheetApproval: existing?.timesheetApproval ?? null,
      }),
      after: snapshot(next),
    },
  );
  return true;
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

      // Spend is calculated from logged time now. Accepting a typed figure and
      // ignoring it would look like a save that worked.
      if (patch.budgetUsed !== undefined) {
        throw EpmError.badRequest(
          'Budget used is calculated from logged time and cannot be set. Set the budget itself instead.',
        );
      }

      // The budget is EPM-owned, with no OpenProject column, and goes through
      // the same journalled path as the rest of the plan.
      if (patch.budgetTotal !== undefined) {
        const plan = planBody.parse({ budgetTotal: patch.budgetTotal });
        if (await updatePlan(id, plan)) requestHealthRecalc(id);
      }

      // Legacy free text, superseded by the portfolio link; still accepted.
      if (typeof patch.portfolio === 'string') {
        await prisma.projectProfile.upsert({
          where: { openProjectId: id },
          create: { openProjectId: id, portfolio: patch.portfolio },
          update: { portfolio: patch.portfolio },
        });
      }

      invalidateProjects();
      await noteRuleEvent({
        source: 'epm',
        kind: 'project.updated',
        subjectType: 'project',
        subjectId: id,
        projectId: id,
        actorId: request.auth?.userId,
      });

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
      await noteRuleEvent({
        source: 'epm',
        kind: 'project.created',
        subjectType: 'project',
        subjectId: String(created.id),
        projectId: String(created.id),
        actorId: request.auth?.userId,
      });

      reply.code(201);
      return { id: String(created.id), name: created.name };
    },
  );

  /** Archive rather than delete: OpenProject deletion is asynchronous and final. */

  /**
   * Overrides a project's calculated health, or clears the override (BR-206).
   *
   * `levels` pins the overall and/or any criterion; `{}` clears every pin.
   * Setting or changing an override needs a reason, which is kept in the
   * journal beside who set it and when, and is shown wherever the overridden
   * value is — the calculated value stays visible next to it everywhere.
   * Clearing may say why too, but does not have to: it returns the project to
   * what the data says.
   *
   * Its own route rather than part of the project patch, which is gated on
   * `project:edit` — derived from OpenProject's `projects/update`. Health is
   * EPM's judgement, so its authority is EPM's to grant.
   */
  app.patch<{ Params: { id: string }; Body: { levels?: unknown; reason?: unknown } }>(
    '/projects/:id/health',
    async (request) => {
      const { id } = request.params;
      await guard.require(request, 'health:manage');

      const raw = request.body?.levels ?? {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw EpmError.badRequest('levels must be an object of criterion to level.');
      }

      const levels: HealthOverride = {};
      for (const [key, level] of Object.entries(raw as Record<string, unknown>)) {
        // Null and undefined clear that criterion rather than setting it.
        if (level === null || level === undefined) continue;
        if (!(DIMENSIONS as readonly string[]).includes(key)) {
          throw EpmError.badRequest(message('{key} is not a health criterion.', { key }));
        }
        if (typeof level !== 'string' || !LEVELS.includes(level as HealthLevel)) {
          throw EpmError.badRequest(message('{level} is not a health level.', { level: String(level) }));
        }
        levels[key as keyof HealthOverride] = level as HealthLevel;
      }

      const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
      const clearing = Object.keys(levels).length === 0;
      if (!clearing && reason.length < MIN_REASON) {
        throw EpmError.validation(
          message('Say why the calculated health is wrong, in at least {min} characters. The reason is kept with the override.', { min: MIN_REASON }),
        );
      }
      if (reason.length > 2000) throw EpmError.validation('Keep the reason under 2,000 characters.');

      // Confirms the project exists and that this caller can see it, so the
      // route cannot be used to discover project ids.
      const signal = requestSignal(request);
      await openProject.request<{ id: number }>(`/projects/${id}`, { signal });

      // What it was, before the pin lands. A transition needs both ends, and
      // after the write the previous value is gone.
      const before = (await loadProjects(signal)).find((candidate) => candidate.id === id);
      if (!before) throw EpmError.notFound('That project');

      const existing = await prisma.projectHealthOverride.findUnique({ where: { projectId: id } });
      if (clearing && !existing) return before;

      const pinned = Object.entries(levels).map(([key, level]) =>
        message(
          '{dimension} {level, select, healthy {green} warning {amber} other {red}} (calculated {calculated, select, healthy {green} warning {amber} critical {red} other {not assessed}})',
          {
            dimension: criterionName(key as HealthCriterion | 'overall'),
            level,
            calculated: before.healthCalculated[key as keyof typeof before.healthCalculated] ?? 'none',
          },
        ),
      );
      const action = clearing
        ? 'health.override.cleared'
        : existing
          ? 'health.override.changed'
          : 'health.override.set';
      const summary = clearing
        ? message('Health override cleared; the calculated health applies again.')
        : message('Health overridden: {pinned}.', { pinned: listOf(pinned) });

      await withAudit(
        async (tx) => {
          if (clearing) {
            await tx.projectHealthOverride.delete({ where: { projectId: id } });
            return;
          }
          const data = { levels: levels as object, reason, setBy: request.auth!.userId, setAt: new Date() };
          await tx.projectHealthOverride.upsert({
            where: { projectId: id },
            create: { projectId: id, ...data },
            update: data,
          });
        },
        {
          projectId: id,
          entityType: 'project',
          entityId: id,
          action,
          summary,
          reason: reason || null,
          before: existing ? { levels: parseOverrideLevels(existing.levels), reason: existing.reason } : null,
          after: clearing ? null : { levels, calculated: before.healthCalculated },
        },
      );

      invalidateProjects();
      const after = (await loadProjects(signal)).find((candidate) => candidate.id === id);

      // Only when the effective state actually moved. Pinning a criterion that
      // does not change the headline is not news to anyone.
      if (after && before.health.overall !== after.health.overall) {
        await notifyHealthChange({
          projectId: id,
          projectName: after.name,
          ownerId: after.ownerId || undefined,
          previous: before.health.overall,
          next: after.health.overall,
          overridden: Boolean(after.healthOverride),
          occurrence: new Date().toISOString().slice(0, 10),
          detail: clearing ? message('The override was cleared.') : message('Reason given: {reason}', { reason }),
        }).catch((error: unknown) => {
          // A notification that cannot be written must not fail the write the
          // user actually asked for.
          request.log.warn({ err: error }, 'Could not notify a health change');
        });
        // An override moves what rules see as much as a recalculation does.
        await noteRuleEvent({
          source: 'epm',
          kind: 'project.health_changed',
          subjectType: 'project',
          subjectId: id,
          projectId: id,
          actorId: request.auth?.userId,
          dedupeKey: `project:${id}:health:${after.health.overall}:${new Date().toISOString()}`,
        });
      }

      return after;
    },
  );

  /**
   * Recalculates one project's health now and answers with the result.
   *
   * Health already follows changes on its own; this is for the person who has
   * just changed something upstream and does not want to wait for the sweep.
   * Open to whoever may edit the project or manage health — it changes nothing
   * but how fresh the figure is.
   */
  app.post<{ Params: { id: string } }>('/projects/:id/health/recalculate', async (request) => {
    const { id } = request.params;
    const permissions = await guard.permissionsFor(request);
    if (!allows(permissions, 'health:manage') && !allows(permissions, 'project:edit', id)) {
      throw EpmError.forbidden("You do not have permission to recalculate this project's health.");
    }

    const signal = requestSignal(request);
    if (!(await loadProjects(signal)).some((candidate) => candidate.id === id)) {
      throw EpmError.notFound('That project');
    }

    await recalculateNow([id], 'manual');
    invalidateProjects();
    return (await loadProjects(signal)).find((candidate) => candidate.id === id);
  });

  /**
   * Sets a project's planned start, planned finish and budget.
   *
   * EPM's own fields: an OpenProject project has no dates and publishes no
   * budget. Each change is journalled with its before and after, and health is
   * recalculated before answering, so the response already shows what the new
   * plan means for schedule and budget variance.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>('/projects/:id/plan', async (request) => {
    const { id } = request.params;
    await guard.require(request, 'project:edit', id);
    const input = planBody.parse(request.body ?? {});

    const signal = requestSignal(request);
    if (!(await loadProjects(signal)).some((candidate) => candidate.id === id)) {
      throw EpmError.notFound('That project');
    }

    if (await updatePlan(id, input)) await recalculateNow([id], 'change');
    invalidateProjects();
    return (await loadProjects(signal)).find((candidate) => candidate.id === id);
  });

  /**
   * The project's own journal: what EPM recorded about it, newest first.
   *
   * Health calculations and overrides, plan and budget changes, owner and
   * portfolio changes — everything EPM owns about the project, with who and
   * why. Visible to whoever can see the project, like the project itself.
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/projects/:id/journal',
    async (request) => {
      const { id } = request.params;
      const query = z
        .object({
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
          action: z.string().max(60).optional(),
        })
        .parse(request.query);

      if (!(await loadProjects(requestSignal(request))).some((candidate) => candidate.id === id)) {
        throw EpmError.notFound('That project');
      }

      return listAudit({
        projectId: id,
        before: query.before,
        limit: query.limit,
        actionPrefix: query.action,
      });
    },
  );

  /** The same journal a page at a time, with its total, for a list a person pages through. */
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/projects/:id/journal/page',
    async (request) => {
      const { id } = request.params;
      const query = z
        .object({
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().positive().max(100).default(15),
          action: z.string().max(60).optional(),
        })
        .parse(request.query);

      if (!(await loadProjects(requestSignal(request))).some((candidate) => candidate.id === id)) {
        throw EpmError.notFound('That project');
      }

      return listAuditPage({ projectId: id, actionPrefix: query.action, page: query.page, pageSize: query.pageSize });
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

      const before = await prisma.projectProfile.findUnique({
        where: { openProjectId: id },
        select: { portfolioRef: { select: { id: true, name: true } } },
      });
      const portfolioId = await setProjectPortfolio(id, request.body?.portfolioId);

      if ((before?.portfolioRef?.id ?? null) !== portfolioId) {
        const now = portfolioId
          ? await prisma.portfolio.findUnique({ where: { id: portfolioId }, select: { id: true, name: true } })
          : null;
        await recordAudit({
          projectId: id,
          entityType: 'project',
          entityId: id,
          action: 'project.portfolio.changed',
          summary: message('Portfolio {from} → {to}.', {
            from: before?.portfolioRef?.name ?? message('none'),
            to: now?.name ?? message('none'),
          }),
          before: before?.portfolioRef ?? null,
          after: now,
        });
      }
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

      const previous = await prisma.projectProfile.findUnique({
        where: { openProjectId: id },
        select: { ownerId: true },
      });
      if ((previous?.ownerId ?? null) === ownerId) return { id, ownerId: ownerId ?? '' };

      const users = await getUsers(requestSignal(request));
      const nameOf = (userId: string | null | undefined): string | Message =>
        userId ? users.find((user) => user.id === userId)?.name ?? message('user {id}', { id: userId }) : message('nobody');

      await withAudit(
        (tx) =>
          tx.projectProfile.upsert({
            where: { openProjectId: id },
            create: { openProjectId: id, ownerId },
            update: { ownerId },
          }),
        {
          projectId: id,
          entityType: 'project',
          entityId: id,
          action: 'project.owner.changed',
          summary: message('Owner {from} → {to}.', { from: nameOf(previous?.ownerId), to: nameOf(ownerId) }),
          before: { ownerId: previous?.ownerId ?? null },
          after: { ownerId },
        },
      );

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
      .request<{ id: number; name?: string; _links?: Record<string, unknown> }>(`/projects/${id}`, {
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
    // portfolio link, budget, stored health and override go with it. Its
    // journal does not: that is the record of what happened, deletion included.
    await prisma.projectProfile.deleteMany({ where: { openProjectId: id } }).catch(() => undefined);
    await prisma.projectHealthState.deleteMany({ where: { projectId: id } }).catch(() => undefined);
    await prisma.projectHealthOverride.deleteMany({ where: { projectId: id } }).catch(() => undefined);
    await forgetProjectBaselines(Number(id)).catch(() => undefined);
    await recordAudit({
      projectId: id,
      entityType: 'project',
      entityId: id,
      action: 'project.deleted',
      summary: message('Project {name} was deleted, with its work packages.', { name: project.name ?? id }),
    }).catch((error: unknown) => request.log.warn({ err: error }, 'Could not journal a project deletion'));

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
