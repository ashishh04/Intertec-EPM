import type { ApprovalRequest, ProjectRequest as ProjectRequestRow } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { listProjects } from '../mapping/projects.js';
import type { ProjectRequest, ProjectRequestInput, ProjectRequestStatus } from '../types/epm.js';
import { cancelRequest, registerSubjectAdapter, requestsFor, submitSubject, type LoadedSubject } from './approvals.js';
import { recordAudit, withAudit } from './audit.js';
import { namesFor } from './collaboration.js';
import { setProjectPortfolio } from './portfolios.js';

/**
 * Project requests: someone proposes a project — what it is for, why, what it
 * would cost, who sponsors it — and an approval chain decides. An approved
 * request is turned into a project by someone who may create projects, from
 * the template it names or blank, with its portfolio, program, budget and
 * dates set. Owned by EPM; the delivery system has a creation wizard only in
 * its paid editions.
 */

const keyOf = (id: string) => `PR-${id.slice(-6).toUpperCase()}`;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31.')
  .nullable()
  .optional();

export const requestInput = z
  .object({
    title: z.string().trim().min(1, 'A name is required.').max(255),
    identifier: z
      .string()
      .trim()
      .max(100)
      .regex(/^$|^[a-z][a-z0-9_-]*$/, 'The identifier can hold lower-case letters, numbers, dashes and underscores, starting with a letter.')
      .optional(),
    description: z.string().trim().max(20_000).optional(),
    businessCase: z.string().trim().max(20_000).optional(),
    sponsorId: z.string().regex(/^\d+$/).nullable().optional(),
    portfolioId: z.string().max(64).nullable().optional(),
    programId: z.string().max(64).nullable().optional(),
    templateId: z.string().regex(/^\d+$/).nullable().optional(),
    budget: z.number().min(0).max(1e12).nullable().optional(),
    startDate: day,
    finishDate: day,
  })
  .refine((input) => !input.startDate || !input.finishDate || input.finishDate >= input.startDate, {
    message: 'The finish cannot be before the start.',
    path: ['finishDate'],
  });

const toDate = (value?: string | null) => (value ? new Date(`${value}T00:00:00Z`) : null);
const isoDay = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : undefined);

function columns(input: z.infer<typeof requestInput>) {
  return {
    title: input.title,
    identifier: input.identifier || null,
    description: input.description || null,
    businessCase: input.businessCase || null,
    sponsorId: input.sponsorId ?? null,
    portfolioId: input.portfolioId ?? null,
    programId: input.programId ?? null,
    templateId: input.templateId ?? null,
    budget: input.budget ?? null,
    startDate: toDate(input.startDate),
    finishDate: toDate(input.finishDate),
  };
}

export interface RequestViewer {
  id: string;
  /** Tidies every request (deletes one that is not theirs): whoever manages portfolios. */
  manage: boolean;
  /** Sees every request, the intake a PMO reviews: requests:review, or manage. */
  review: boolean;
  /** May turn an approved request into a project. */
  createProjects: boolean;
}

async function load(id: string): Promise<ProjectRequestRow> {
  const row = await prisma.projectRequest.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That project request');
  return row;
}

/** A request as its reader sees it, with names, its approval and what they may do. */
export async function requestView(row: ProjectRequestRow, viewer: RequestViewer): Promise<ProjectRequest> {
  if (row.requestedBy !== viewer.id && !viewer.review) {
    // An approver reads it through the approval, which links here: let them.
    const asked = row.requestId
      ? await prisma.approvalTask.count({
          where: { requestId: row.requestId, OR: [{ approverId: viewer.id }, { delegateId: viewer.id }] },
        })
      : 0;
    if (asked === 0) throw EpmError.notFound('That project request');
  }
  const [names, portfolio, program, projects, requests] = await Promise.all([
    namesFor([row.requestedBy, row.sponsorId ?? '', row.decidedBy ?? '']),
    row.portfolioId ? prisma.portfolio.findUnique({ where: { id: row.portfolioId }, select: { name: true } }) : null,
    row.programId ? prisma.program.findUnique({ where: { id: row.programId }, select: { name: true } }) : null,
    row.templateId ? listProjects().catch(() => []) : [],
    row.requestId ? requestsFor('project_request', row.id, viewer.id, viewer.manage) : [],
  ]);
  const template = row.templateId ? projects.find((project) => String(project.id) === row.templateId) : undefined;
  const mine = row.requestedBy === viewer.id;
  const editable = row.status === 'draft' || row.status === 'rejected';
  return {
    id: row.id,
    key: keyOf(row.id),
    title: row.title,
    ...(row.identifier ? { identifier: row.identifier } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.businessCase ? { businessCase: row.businessCase } : {}),
    ...(row.sponsorId ? { sponsorId: row.sponsorId, sponsorName: names.get(row.sponsorId) } : {}),
    ...(row.portfolioId ? { portfolioId: row.portfolioId, portfolioName: portfolio?.name } : {}),
    ...(row.programId ? { programId: row.programId, programName: program?.name } : {}),
    ...(row.templateId ? { templateId: row.templateId, templateName: template?.name } : {}),
    ...(row.budget !== null ? { budget: row.budget } : {}),
    ...(row.startDate ? { startDate: isoDay(row.startDate) } : {}),
    ...(row.finishDate ? { finishDate: isoDay(row.finishDate) } : {}),
    status: row.status as ProjectRequestStatus,
    ...(row.requestId ? { requestId: row.requestId } : {}),
    requestedBy: row.requestedBy,
    requestedByName: names.get(row.requestedBy),
    ...(row.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.decidedBy ? { decidedByName: names.get(row.decidedBy) } : {}),
    ...(row.decisionNote ? { decisionNote: row.decisionNote } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(requests[0] ? { request: requests.find((one) => one.id === row.requestId) ?? requests[0] } : {}),
    can: {
      edit: mine && editable,
      submit: mine && editable,
      withdraw: mine && row.status === 'submitted',
      remove: (mine && editable) || (viewer.manage && row.status !== 'created'),
      createProject: row.status === 'approved' && viewer.createProjects,
    },
  };
}

export async function listRequests(viewer: RequestViewer, scope: 'mine' | 'all'): Promise<ProjectRequest[]> {
  const rows = await prisma.projectRequest.findMany({
    where: scope === 'all' && viewer.review ? {} : { requestedBy: viewer.id },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return Promise.all(rows.map((row) => requestView(row, viewer)));
}

export async function getRequest(id: string, viewer: RequestViewer): Promise<ProjectRequest> {
  return requestView(await load(id), viewer);
}

/** Checks the portfolio and program named are real and open. */
async function assertPlacement(input: { portfolioId?: string | null; programId?: string | null }) {
  if (input.portfolioId) {
    const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId }, select: { active: true } });
    if (!portfolio) throw EpmError.badRequest('That portfolio does not exist.');
    if (!portfolio.active) throw EpmError.badRequest('That portfolio is archived, so a project cannot be moved into it.');
  }
  if (input.programId) {
    const program = await prisma.program.findUnique({ where: { id: input.programId }, select: { active: true } });
    if (!program) throw EpmError.badRequest('That program does not exist.');
    if (!program.active) throw EpmError.badRequest('That program is archived, so a project cannot be moved into it.');
  }
}

export async function createRequest(body: unknown, viewer: RequestViewer): Promise<ProjectRequest> {
  const input = requestInput.parse(body ?? {});
  await assertPlacement(input);
  const row = await withAudit(
    (tx) => tx.projectRequest.create({ data: { ...columns(input), requestedBy: viewer.id } }),
    (created) => ({
      actorId: viewer.id,
      entityType: 'project-request',
      entityId: created.id,
      action: 'project-request.created',
      summary: message('Project request {name} drafted.', { name: created.title }),
    }),
  );
  return requestView(row, viewer);
}

export async function updateRequest(id: string, body: unknown, viewer: RequestViewer): Promise<ProjectRequest> {
  const row = await load(id);
  if (row.requestedBy !== viewer.id) throw EpmError.forbidden('Only whoever made the request can change it.');
  if (row.status !== 'draft' && row.status !== 'rejected') throw EpmError.conflict('A request cannot be changed while it is waiting for a decision or after it was approved.');
  const input = requestInput.parse(body ?? {});
  await assertPlacement(input);
  const updated = await withAudit(
    (tx) => tx.projectRequest.update({ where: { id }, data: { ...columns(input), status: 'draft' } }),
    () => ({
      actorId: viewer.id,
      entityType: 'project-request',
      entityId: id,
      action: 'project-request.changed',
      summary: message('Project request {name} changed.', { name: input.title }),
    }),
  );
  return requestView(updated, viewer);
}

export async function deleteRequest(id: string, viewer: RequestViewer): Promise<void> {
  const row = await load(id);
  const mine = row.requestedBy === viewer.id && (row.status === 'draft' || row.status === 'rejected');
  if (!mine && !(viewer.manage && row.status !== 'created')) {
    throw EpmError.forbidden('Only whoever made a draft or rejected request can delete it.');
  }
  if (row.status === 'submitted' && row.requestId) {
    await cancelRequest({ requestId: row.requestId, actorId: viewer.id, mayCancelAny: viewer.manage }).catch(() => undefined);
  }
  await withAudit(
    (tx) => tx.projectRequest.delete({ where: { id } }),
    () => ({
      actorId: viewer.id,
      entityType: 'project-request',
      entityId: id,
      action: 'project-request.deleted',
      summary: message('Project request {name} deleted.', { name: row.title }),
    }),
  );
}

export async function submitRequest(id: string, viewer: RequestViewer): Promise<ProjectRequest> {
  const row = await load(id);
  if (row.requestedBy !== viewer.id) throw EpmError.forbidden('Only whoever made the request can submit it.');
  if (row.status !== 'draft' && row.status !== 'rejected') throw EpmError.conflict('This request has already been submitted.');
  const requestId = await submitSubject('project_request', id, viewer.id);
  const updated = await withAudit(
    (tx) =>
      tx.projectRequest.update({
        where: { id },
        data: { status: 'submitted', requestId, submittedAt: new Date(), decidedAt: null, decidedBy: null, decisionNote: null },
      }),
    () => ({
      actorId: viewer.id,
      entityType: 'project-request',
      entityId: id,
      action: 'project-request.submitted',
      summary: message('Project request {name} submitted for approval.', { name: row.title }),
    }),
  );
  return requestView(updated, viewer);
}

export async function withdrawRequest(id: string, viewer: RequestViewer): Promise<ProjectRequest> {
  const row = await load(id);
  if (row.status !== 'submitted' || !row.requestId) throw EpmError.conflict('Only a request still waiting for a decision can be withdrawn.');
  await cancelRequest({ requestId: row.requestId, actorId: viewer.id, mayCancelAny: viewer.manage });
  return requestView(await load(id), viewer);
}

/** The approved request, ready to become a project: refused otherwise. */
export async function approvedRequest(id: string): Promise<ProjectRequestRow> {
  const row = await load(id);
  if (row.status === 'created') throw EpmError.conflict('This request has already been turned into a project.');
  if (row.status !== 'approved') throw EpmError.conflict('Only an approved request can be turned into a project.');
  return row;
}

/**
 * Records the project an approved request became, and gives the project what
 * the request asked for: its portfolio, program, budget and dates.
 */
export async function completeRequest(row: ProjectRequestRow, projectId: string, actorId: string): Promise<void> {
  if (row.portfolioId) await setProjectPortfolio(projectId, row.portfolioId).catch(() => undefined);
  const program = row.programId ? await prisma.program.findUnique({ where: { id: row.programId }, select: { active: true } }) : null;
  const overlay = {
    ...(program?.active ? { programId: row.programId } : {}),
    ...(row.budget !== null ? { budgetTotal: row.budget } : {}),
    ...(row.startDate ? { plannedStart: row.startDate } : {}),
    ...(row.finishDate ? { plannedFinish: row.finishDate } : {}),
  };
  if (Object.keys(overlay).length > 0) {
    await prisma.projectProfile.upsert({
      where: { openProjectId: projectId },
      create: { openProjectId: projectId, ...overlay },
      update: overlay,
    });
  }
  await prisma.projectRequest.update({ where: { id: row.id }, data: { status: 'created', projectId } });
  await recordAudit({
    actorId,
    projectId,
    entityType: 'project-request',
    entityId: row.id,
    action: 'project-request.created-project',
    summary: message('Project created from request {name}.', { name: row.title }),
  });
}

/* --------------------------------------------------------------- approval */

async function loadForApproval(id: string): Promise<LoadedSubject> {
  const row = await load(id);
  return {
    id,
    key: keyOf(id),
    title: row.title,
    projectId: '',
    projectName: '',
    facts: { projectId: '', ...(row.portfolioId ? { portfolioId: row.portfolioId } : {}), customFields: {} },
    value: row.budget,
    valueLabel: 'Budget',
  };
}

async function onOutcome(
  outcome: 'approved' | 'rejected' | 'withdrawn',
  request: ApprovalRequest,
  detail: { actorId: string | null; comment?: string },
): Promise<void> {
  const row = await prisma.projectRequest.findUnique({ where: { id: request.subjectId } });
  if (!row || row.requestId !== request.id || row.status !== 'submitted') return;
  const status = outcome === 'withdrawn' ? 'draft' : outcome;
  await withAudit(
    (tx) =>
      tx.projectRequest.update({
        where: { id: row.id },
        data:
          outcome === 'withdrawn'
            ? { status }
            : { status, decidedAt: new Date(), decidedBy: detail.actorId, decisionNote: detail.comment ?? null },
      }),
    () => ({
      actorId: detail.actorId,
      entityType: 'project-request',
      entityId: row.id,
      action: `project-request.${outcome}`,
      summary:
        outcome === 'approved'
          ? message('Project request {name} approved.', { name: row.title })
          : outcome === 'rejected'
            ? message('Project request {name} rejected.', { name: row.title })
            : message('Project request {name} withdrawn.', { name: row.title }),
      after: { comment: detail.comment ?? null },
    }),
  );
}

registerSubjectAdapter({ type: 'project_request', load: loadForApproval, link: (id) => `/project-requests/${id}`, onOutcome });
