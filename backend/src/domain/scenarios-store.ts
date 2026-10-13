import type { ApprovalRequest } from '@prisma/client';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError } from '../lib/errors.js';
import { message, msg } from '../lib/i18n.js';
import { linkId, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type { ScenarioProjectView, ScenarioStatus, ScenarioSummary, ScenarioView } from '../types/epm.js';
import { registerSubjectAdapter, submitSubject, type LoadedSubject } from './approvals.js';
import { withAudit } from './audit.js';
import { modelFacts } from './measure-facts.js';
import { scenarioProfile, shiftDate, type ScenarioProjectInput, type ScenarioWorkInput } from './scenarios.js';

/**
 * Portfolio scenarios (Module 7: BR-220 to BR-222).
 *
 * OpenProject has no scenarios, so they are EPM's. A scenario copies, at the
 * moment it is made, a portfolio's projects — EPM's plan dates and budget —
 * and their open work as OpenProject holds it then: remaining hours, dates,
 * milestones. Adjusting it changes only the copy. Submitted, it goes through
 * the approval engine (the "Scenarios" chain: the owners of the projects it
 * changes); approved, it is applied to live data — the projects' plan dates
 * and budgets, and the dates of work unchanged since the copy was taken —
 * and the decision is recorded on it and in the journal.
 */

const isoDay = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
const keyOf = (id: string) => `SC-${id.slice(-6).toUpperCase()}`;

interface OpWork {
  id: number;
  subject: string;
  lockVersion: number;
  startDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  estimatedTime?: string | null;
  remainingTime?: string | null;
  percentageDone?: number | null;
  _links: Record<string, HalLink | HalLink[] | undefined>;
}

/** A work package's dates as its JSON has them: a milestone renders only `date`. */
const datesOf = (work: OpWork) => {
  const milestone = work.date !== undefined && work.startDate === undefined && work.dueDate === undefined;
  return { milestone, start: (milestone ? work.date : work.startDate) ?? null, due: (milestone ? work.date : work.dueDate) ?? null };
};

const remainingOf = (work: OpWork): number => {
  const remaining = durationToHours(work.remainingTime);
  if (remaining !== undefined) return Math.max(0, remaining);
  const estimate = durationToHours(work.estimatedTime) ?? 0;
  return Math.max(0, estimate * (1 - Math.min(100, Math.max(0, work.percentageDone ?? 0)) / 100));
};

/** Open work of some projects, read from OpenProject now. */
async function openWork(projectIds: number[]): Promise<OpWork[]> {
  if (projectIds.length === 0) return [];
  const collection = await runAsSystem(() =>
    openProject.getAll<OpWork>('/work_packages', {
      filters: [
        { field: 'project', operator: '=', values: projectIds.map(String) },
        { field: 'status', operator: 'o', values: [] },
      ],
      pageSize: 200,
    }),
  );
  return collection.items;
}

/* -------------------------------------------------------------------------- */
/* Capture (BR-220)                                                           */
/* -------------------------------------------------------------------------- */

const captureSchema = z.object({
  name: z.string().trim().min(1, msg('Name the scenario.')).max(120),
  portfolioId: z.string().max(64).optional(),
  projectIds: z.array(z.union([z.string(), z.number()]).transform(Number)).max(200).optional(),
});

/** Copies the projects (a portfolio's, or those named) the caller can see, as they are now. */
export async function captureScenario(input: unknown, actorId: string, visible: Set<number>): Promise<ScenarioView> {
  const parsed = captureSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation(parsed.error.issues[0]?.message ?? 'The scenario is not complete.');
  const { name, portfolioId } = parsed.data;
  const facts = await modelFacts();
  const profiles = await prisma.projectProfile.findMany({
    where: portfolioId ? { portfolioId } : { openProjectId: { in: (parsed.data.projectIds ?? []).map(String) } },
  });
  const projectIds = profiles.map((row) => Number(row.openProjectId)).filter((id) => visible.has(id));
  if (projectIds.length === 0) throw EpmError.validation('Choose a portfolio, or projects, you can see.');
  const work = await openWork(projectIds);
  const created = await withAudit(
    async (tx) => {
      const scenario = await tx.scenario.create({ data: { name, portfolioId: portfolioId ?? null, createdBy: actorId } });
      await tx.scenarioProject.createMany({
        data: profiles
          .filter((row) => projectIds.includes(Number(row.openProjectId)))
          .map((row) => ({
            scenarioId: scenario.id,
            projectId: Number(row.openProjectId),
            name: facts.projects.get(Number(row.openProjectId))?.name ?? `#${row.openProjectId}`,
            budget: row.budgetTotal,
            capturedStart: row.plannedStart,
            capturedFinish: row.plannedFinish,
            capturedBudget: row.budgetTotal,
          })),
      });
      const rows = work
        .map((item) => {
          const dates = datesOf(item);
          return {
            scenarioId: scenario.id,
            workPackageId: item.id,
            projectId: Number(linkId(item._links, 'project')),
            subject: item.subject.slice(0, 500),
            remainingHours: remainingOf(item),
            startDate: dates.start ? new Date(dates.start) : null,
            dueDate: dates.due ? new Date(dates.due) : null,
            isMilestone: dates.milestone,
          };
        })
        .filter((row) => row.isMilestone || row.remainingHours > 0);
      if (rows.length > 0) await tx.scenarioWork.createMany({ data: rows });
      return { scenario, items: rows.length };
    },
    ({ scenario, items }) => ({
      actorId,
      entityType: 'scenario',
      entityId: scenario.id,
      action: 'scenario.created',
      summary: message('Scenario {name} copied from {projects, plural, one {# project} other {# projects}} and {items} open work packages.', {
        name,
        projects: projectIds.length,
        items,
      }),
      after: { name, portfolioId: portfolioId ?? null, projectIds },
    }),
  );
  return scenarioView(created.scenario.id);
}

/* -------------------------------------------------------------------------- */
/* Views and figures (BR-221, BR-222)                                         */
/* -------------------------------------------------------------------------- */

async function load(id: string) {
  const scenario = await prisma.scenario.findUnique({ where: { id }, include: { projects: { orderBy: { name: 'asc' } }, work: true } });
  if (!scenario) throw EpmError.notFound('That scenario');
  return scenario;
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** The weekly hours of everyone on the scenario's projects: the capacity it is measured against. */
async function weeklyCapacity(projectIds: number[]): Promise<number> {
  const facts = await modelFacts();
  const people = new Set<number>();
  for (const projectId of projectIds) for (const person of facts.members.get(projectId) ?? []) people.add(person);
  let hours = 0;
  for (const person of people) {
    const fact = facts.people.get(person);
    if (fact && fact.status === 'active') hours += fact.weeklyCapacityHours;
  }
  return hours;
}

function inputs(scenario: Loaded, asCaptured: boolean): { projects: ScenarioProjectInput[]; work: ScenarioWorkInput[] } {
  return {
    projects: scenario.projects.map((project) => ({
      projectId: project.projectId,
      included: asCaptured ? true : project.included,
      priority: project.priority,
      shiftMonths: asCaptured ? 0 : project.shiftMonths,
      shiftDays: asCaptured ? 0 : project.shiftDays,
      budget: asCaptured ? project.capturedBudget : project.budget,
      start: isoDay(project.capturedStart),
      finish: isoDay(project.capturedFinish),
    })),
    work: scenario.work.map((item) => ({
      workPackageId: item.workPackageId,
      projectId: item.projectId,
      subject: item.subject,
      remainingHours: item.remainingHours,
      start: isoDay(item.startDate),
      due: isoDay(item.dueDate),
      isMilestone: item.isMilestone,
    })),
  };
}

export async function scenarioView(id: string): Promise<ScenarioView> {
  const scenario = await load(id);
  const capacity = await weeklyCapacity(scenario.projects.map((project) => project.projectId));
  const adjusted = inputs(scenario, false);
  const captured = inputs(scenario, true);
  const counts = new Map<number, number>();
  for (const item of scenario.work) counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  return {
    id: scenario.id,
    name: scenario.name,
    portfolioId: scenario.portfolioId,
    status: scenario.status as ScenarioStatus,
    capturedAt: scenario.capturedAt.toISOString(),
    createdBy: scenario.createdBy,
    requestId: scenario.requestId,
    decidedAt: scenario.decidedAt?.toISOString() ?? null,
    decidedBy: scenario.decidedBy,
    decision: (scenario.decision as ScenarioView['decision']) ?? null,
    projects: scenario.projects.map(
      (project): ScenarioProjectView => ({
        projectId: String(project.projectId),
        name: project.name,
        included: project.included,
        priority: project.priority,
        shiftMonths: project.shiftMonths,
        shiftDays: project.shiftDays,
        budget: project.budget,
        capturedStart: isoDay(project.capturedStart),
        capturedFinish: isoDay(project.capturedFinish),
        capturedBudget: project.capturedBudget,
        plannedStart: project.capturedStart ? shiftDate(isoDay(project.capturedStart)!, project.shiftMonths, project.shiftDays) : null,
        plannedFinish: project.capturedFinish ? shiftDate(isoDay(project.capturedFinish)!, project.shiftMonths, project.shiftDays) : null,
        workItems: counts.get(project.projectId) ?? 0,
      }),
    ),
    profile: scenarioProfile(adjusted.projects, adjusted.work, capacity),
    captured: scenarioProfile(captured.projects, captured.work, capacity),
  };
}

export async function listScenarios(): Promise<ScenarioSummary[]> {
  const rows = await prisma.scenario.findMany({ orderBy: { capturedAt: 'desc' }, include: { _count: { select: { projects: true } } }, take: 100 });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    portfolioId: row.portfolioId,
    status: row.status as ScenarioStatus,
    capturedAt: row.capturedAt.toISOString(),
    projects: row._count.projects,
  }));
}

/* -------------------------------------------------------------------------- */
/* Adjusting (BR-221)                                                         */
/* -------------------------------------------------------------------------- */

const adjustSchema = z.object({
  included: z.boolean().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  shiftMonths: z.number().int().min(-36).max(36).optional(),
  shiftDays: z.number().int().min(-366).max(366).optional(),
  budget: z.number().min(0).max(1e13).nullable().optional(),
});

/** Changes one project in a draft scenario; live data is not touched. */
export async function adjustScenario(id: string, projectId: number, input: unknown, actorId: string): Promise<ScenarioView> {
  const parsed = adjustSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('That adjustment is not valid.', parsed.error.issues);
  const scenario = await load(id);
  if (!['draft', 'rejected'].includes(scenario.status)) throw EpmError.conflict('Only a draft scenario can be changed.');
  const before = scenario.projects.find((project) => project.projectId === projectId);
  if (!before) throw EpmError.notFound('That project in the scenario');
  await withAudit(
    async (tx) => {
      await tx.scenarioProject.update({ where: { scenarioId_projectId: { scenarioId: id, projectId } }, data: parsed.data });
      if (scenario.status === 'rejected') await tx.scenario.update({ where: { id }, data: { status: 'draft' } });
    },
    () => ({
      actorId,
      entityType: 'scenario',
      entityId: id,
      action: 'scenario.adjusted',
      summary: message('Scenario {name}: {project} adjusted.', { name: scenario.name, project: before.name }),
      before: { included: before.included, priority: before.priority, shiftMonths: before.shiftMonths, shiftDays: before.shiftDays, budget: before.budget },
      after: parsed.data,
    }),
  );
  return scenarioView(id);
}

export async function deleteScenario(id: string, actorId: string): Promise<void> {
  const scenario = await load(id);
  if (scenario.status === 'submitted') throw EpmError.conflict('A scenario waiting for approval cannot be removed: withdraw it first.');
  await withAudit(
    (tx) => tx.scenario.delete({ where: { id } }),
    () => ({ actorId, entityType: 'scenario', entityId: id, action: 'scenario.deleted', summary: message('Scenario {name} removed.', { name: scenario.name }) }),
  );
}

/* -------------------------------------------------------------------------- */
/* Promotion (BR-222)                                                         */
/* -------------------------------------------------------------------------- */

const changed = (project: Loaded['projects'][number]) =>
  !project.included || project.shiftMonths !== 0 || project.shiftDays !== 0 || (project.budget ?? null) !== (project.capturedBudget ?? null);

/** Sends a draft scenario for approval: the owners of the projects it changes. */
export async function submitScenario(id: string, actorId: string): Promise<ScenarioView> {
  const scenario = await load(id);
  if (!['draft', 'rejected'].includes(scenario.status)) throw EpmError.conflict('This scenario has already been submitted.');
  if (!scenario.projects.some(changed)) throw EpmError.validation('The scenario changes nothing yet: adjust a project first.');
  const requestId = await submitSubject('scenario', id, actorId);
  await withAudit(
    (tx) => tx.scenario.update({ where: { id }, data: { status: 'submitted', requestId } }),
    () => ({ actorId, entityType: 'scenario', entityId: id, action: 'scenario.submitted', summary: message('Scenario {name} submitted to be applied.', { name: scenario.name }) }),
  );
  return scenarioView(id);
}

async function loadScenario(id: string): Promise<LoadedSubject> {
  const scenario = await load(id);
  const touched = scenario.projects.filter(changed);
  return {
    id,
    key: keyOf(id),
    title: scenario.name,
    projectId: '',
    projectName: '',
    facts: { projectId: '', portfolioId: scenario.portfolioId ?? undefined, customFields: {} },
    projectIds: touched.map((project) => String(project.projectId)),
  };
}

/** Applies an approved scenario to live data and records what was done. */
async function promote(scenario: Loaded, deciderId: string | null, comment: string | undefined): Promise<void> {
  const applied: { projects: string[]; workMoved: number; skipped: { workPackageId: number; reason: string }[]; excluded: string[] } = {
    projects: [],
    workMoved: 0,
    skipped: [],
    excluded: [],
  };
  for (const project of scenario.projects.filter(changed)) {
    if (!project.included) {
      // Left out of the plan, not deleted: a project is closed through its own lifecycle.
      applied.excluded.push(project.name);
      continue;
    }
    const start = project.capturedStart ? new Date(shiftDate(isoDay(project.capturedStart)!, project.shiftMonths, project.shiftDays)) : null;
    const finish = project.capturedFinish ? new Date(shiftDate(isoDay(project.capturedFinish)!, project.shiftMonths, project.shiftDays)) : null;
    await prisma.projectProfile.upsert({
      where: { openProjectId: String(project.projectId) },
      create: { openProjectId: String(project.projectId), plannedStart: start, plannedFinish: finish, budgetTotal: project.budget },
      update: { plannedStart: start, plannedFinish: finish, budgetTotal: project.budget },
    });
    applied.projects.push(project.name);
    if (project.shiftMonths === 0 && project.shiftDays === 0) continue;
    for (const item of scenario.work.filter((work) => work.projectId === project.projectId)) {
      const live = await runAsSystem(() => openProject.request<OpWork>(`/work_packages/${item.workPackageId}`)).catch(() => null);
      if (!live) {
        applied.skipped.push({ workPackageId: item.workPackageId, reason: 'gone' });
        continue;
      }
      const now = datesOf(live);
      if (now.start !== isoDay(item.startDate) || now.due !== isoDay(item.dueDate)) {
        // Re-planned since the copy was taken: the live plan wins.
        applied.skipped.push({ workPackageId: item.workPackageId, reason: 'changed since the scenario was made' });
        continue;
      }
      const move = (day: Date | null) => (day ? shiftDate(isoDay(day)!, project.shiftMonths, project.shiftDays) : undefined);
      const body = item.isMilestone
        ? { lockVersion: live.lockVersion, date: move(item.dueDate ?? item.startDate) }
        : { lockVersion: live.lockVersion, ...(item.startDate ? { startDate: move(item.startDate) } : {}), ...(item.dueDate ? { dueDate: move(item.dueDate) } : {}) };
      const done = await runAsSystem(() =>
        openProject.request(`/work_packages/${item.workPackageId}`, { method: 'PATCH', body, query: { notify: 'false' } }),
      ).then(
        () => true,
        () => false,
      );
      if (done) applied.workMoved += 1;
      else applied.skipped.push({ workPackageId: item.workPackageId, reason: 'refused' });
    }
  }
  await withAudit(
    (tx) =>
      tx.scenario.update({
        where: { id: scenario.id },
        data: { status: 'promoted', decidedAt: new Date(), decidedBy: deciderId, decision: { comment: comment ?? null, applied } },
      }),
    () => ({
      actorId: deciderId,
      entityType: 'scenario',
      entityId: scenario.id,
      action: 'scenario.promoted',
      summary: message('Scenario {name} approved and applied: {projects, plural, one {# project} other {# projects}}, {moved} work packages moved.', {
        name: scenario.name,
        projects: applied.projects.length,
        moved: applied.workMoved,
      }),
      after: { comment: comment ?? null, applied },
    }),
  );
}

async function onOutcome(outcome: 'approved' | 'rejected' | 'withdrawn', request: ApprovalRequest, detail: { actorId: string | null; comment?: string }): Promise<void> {
  const scenario = await prisma.scenario.findUnique({ where: { id: request.subjectId }, include: { projects: true, work: true } });
  if (!scenario || scenario.requestId !== request.id || scenario.status !== 'submitted') return;
  if (outcome === 'approved') {
    await promote(scenario, detail.actorId, detail.comment);
    return;
  }
  await withAudit(
    (tx) =>
      tx.scenario.update({
        where: { id: scenario.id },
        data:
          outcome === 'rejected'
            ? { status: 'rejected', decidedAt: new Date(), decidedBy: detail.actorId, decision: { comment: detail.comment ?? null } }
            : { status: 'draft' },
      }),
    () => ({
      actorId: detail.actorId,
      entityType: 'scenario',
      entityId: scenario.id,
      action: outcome === 'rejected' ? 'scenario.rejected' : 'scenario.withdrawn',
      summary:
        outcome === 'rejected'
          ? message('Scenario {name} rejected: nothing was applied.', { name: scenario.name })
          : message('Scenario {name} withdrawn.', { name: scenario.name }),
      after: { comment: detail.comment ?? null },
    }),
  );
}

registerSubjectAdapter({ type: 'scenario', load: loadScenario, link: (id) => `/scenarios/${id}`, onOutcome });
