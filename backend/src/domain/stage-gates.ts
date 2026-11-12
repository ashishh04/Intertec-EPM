import type { ApprovalRequest, StageGateReview as StageGateReviewRow } from '@prisma/client';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { listProjects } from '../mapping/projects.js';
import type { ProjectGate, ProjectPhases, StageGateReview, StageGateReviewStatus } from '../types/epm.js';
import { cancelRequest, registerSubjectAdapter, requestsFor, submitSubject, type LoadedSubject } from './approvals.js';
import { withAudit } from './audit.js';
import { namesFor } from './collaboration.js';

/**
 * Stage gates: the gates between the phases of a project's life cycle
 * (Initiating, Planning, Executing, Closing), each passed through an approval
 * chain. The delivery system keeps the phases and names their gates but
 * decides nothing about them; a gate review here is that decision, recorded
 * with who asked, why, and who approved or rejected it. Passing a gate does
 * not start the next phase by itself: the project manager does, in Settings.
 */

const keyOf = (id: string) => `SG-${id.slice(-6).toUpperCase()}`;

export interface GateViewer {
  id: string;
  /** May withdraw anyone's review: an administrator of approvals. */
  manage: boolean;
}

async function projectName(projectId: string): Promise<string | undefined> {
  const projects = await runAsSystem(() => listProjects()).catch(() => []);
  return projects.find((project) => String(project.id) === projectId)?.name;
}

export async function reviewView(row: StageGateReviewRow, viewer: GateViewer): Promise<StageGateReview> {
  const [names, name, requests] = await Promise.all([
    namesFor([row.requestedBy, row.decidedBy ?? '']),
    projectName(row.projectId),
    row.requestId ? requestsFor('stage_gate', row.id, viewer.id, viewer.manage) : [],
  ]);
  return {
    id: row.id,
    key: keyOf(row.id),
    projectId: row.projectId,
    ...(name ? { projectName: name } : {}),
    definitionId: row.definitionId,
    gate: row.gate === 'finish' ? 'finish' : 'start',
    gateName: row.gateName,
    phaseName: row.phaseName,
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status as StageGateReviewStatus,
    ...(row.requestId ? { requestId: row.requestId } : {}),
    requestedBy: row.requestedBy,
    requestedByName: names.get(row.requestedBy),
    createdAt: row.createdAt.toISOString(),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.decidedBy ? { decidedByName: names.get(row.decidedBy) } : {}),
    ...(row.decisionNote ? { decisionNote: row.decisionNote } : {}),
    ...(requests[0] ? { request: requests.find((one) => one.id === row.requestId) ?? requests[0] } : {}),
    canWithdraw: row.status === 'submitted' && (row.requestedBy === viewer.id || viewer.manage),
  };
}

/** Every gate of the project's life cycle, from its phases, each with its latest review. */
export async function projectGates(phases: ProjectPhases, projectId: string, viewer: GateViewer, mayRequest: boolean): Promise<ProjectGate[]> {
  const rows = await prisma.stageGateReview.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  const latest = new Map<string, StageGateReviewRow>();
  for (const row of rows) {
    const key = `${row.definitionId}:${row.gate}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const gates: ProjectGate[] = [];
  for (const phase of phases.phases) {
    for (const gate of ['start', 'finish'] as const) {
      const has = gate === 'start' ? phase.startGate : phase.finishGate;
      const name = gate === 'start' ? phase.startGateName : phase.finishGateName;
      if (!has || !name) continue;
      const row = latest.get(`${phase.definitionId}:${gate}`);
      gates.push({
        definitionId: String(phase.definitionId),
        phaseName: phase.name,
        phaseActive: phase.active,
        gate,
        gateName: name,
        ...(row ? { review: await reviewView(row, viewer) } : {}),
        canRequest: mayRequest && row?.status !== 'submitted' && row?.status !== 'approved',
      });
    }
  }
  return gates;
}

/** Asks for a gate to be reviewed. Refused while one is waiting, or once it has passed. */
export async function requestReview(
  phases: ProjectPhases,
  input: { projectId: string; definitionId: string; gate: 'start' | 'finish'; notes?: string },
  viewer: GateViewer,
): Promise<StageGateReview> {
  const phase = phases.phases.find((one) => String(one.definitionId) === input.definitionId);
  const name = phase ? (input.gate === 'start' ? phase.startGateName : phase.finishGateName) : undefined;
  if (!phase || !name || !(input.gate === 'start' ? phase.startGate : phase.finishGate)) {
    throw EpmError.notFound('That gate');
  }
  const current = await prisma.stageGateReview.findFirst({
    where: { projectId: input.projectId, definitionId: input.definitionId, gate: input.gate, status: { in: ['submitted', 'approved'] } },
  });
  if (current?.status === 'submitted') throw EpmError.conflict('That gate is already waiting for a decision.');
  if (current?.status === 'approved') throw EpmError.conflict('That gate has been passed already.');

  const row = await prisma.stageGateReview.create({
    data: {
      projectId: input.projectId,
      definitionId: input.definitionId,
      gate: input.gate,
      gateName: name,
      phaseName: phase.name,
      notes: input.notes?.trim() || null,
      requestedBy: viewer.id,
    },
  });
  let requestId: string;
  try {
    requestId = await submitSubject('stage_gate', row.id, viewer.id);
  } catch (error) {
    // Nobody would decide it, or it could not be sent: no review is left behind.
    await prisma.stageGateReview.delete({ where: { id: row.id } }).catch(() => undefined);
    throw error;
  }
  const updated = await withAudit(
    (tx) => tx.stageGateReview.update({ where: { id: row.id }, data: { requestId } }),
    () => ({
      actorId: viewer.id,
      projectId: input.projectId,
      entityType: 'stage-gate',
      entityId: row.id,
      action: 'stage-gate.submitted',
      summary: message('Gate {gate} ({phase}) submitted for approval.', { gate: name, phase: phase.name }),
    }),
  );
  return reviewView(updated, viewer);
}

export async function getReview(id: string): Promise<StageGateReviewRow> {
  const row = await prisma.stageGateReview.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That gate review');
  return row;
}

export async function withdrawReview(id: string, viewer: GateViewer): Promise<StageGateReview> {
  const row = await getReview(id);
  if (row.status !== 'submitted' || !row.requestId) throw EpmError.conflict('Only a review still waiting for a decision can be withdrawn.');
  await cancelRequest({ requestId: row.requestId, actorId: viewer.id, mayCancelAny: viewer.manage });
  return reviewView(await getReview(id), viewer);
}

/* --------------------------------------------------------------- approval */

async function loadForApproval(id: string): Promise<LoadedSubject> {
  const row = await getReview(id);
  const [name, profile] = await Promise.all([
    projectName(row.projectId),
    prisma.projectProfile.findUnique({ where: { openProjectId: row.projectId }, select: { portfolioId: true } }),
  ]);
  return {
    id,
    key: keyOf(id),
    title: `${row.gateName} · ${row.phaseName}`,
    projectId: row.projectId,
    projectName: name ?? '',
    facts: { projectId: row.projectId, ...(profile?.portfolioId ? { portfolioId: profile.portfolioId } : {}), customFields: {} },
  };
}

async function onOutcome(
  outcome: 'approved' | 'rejected' | 'withdrawn',
  request: ApprovalRequest,
  detail: { actorId: string | null; comment?: string },
): Promise<void> {
  const row = await prisma.stageGateReview.findUnique({ where: { id: request.subjectId } });
  if (!row || row.requestId !== request.id || row.status !== 'submitted') return;
  await withAudit(
    (tx) =>
      tx.stageGateReview.update({
        where: { id: row.id },
        data: { status: outcome, decidedAt: new Date(), decidedBy: detail.actorId, decisionNote: detail.comment ?? null },
      }),
    () => ({
      actorId: detail.actorId,
      projectId: row.projectId,
      entityType: 'stage-gate',
      entityId: row.id,
      action: `stage-gate.${outcome}`,
      summary:
        outcome === 'approved'
          ? message('Gate {gate} ({phase}) passed.', { gate: row.gateName, phase: row.phaseName })
          : outcome === 'rejected'
            ? message('Gate {gate} ({phase}) not passed.', { gate: row.gateName, phase: row.phaseName })
            : message('Gate {gate} ({phase}) review withdrawn.', { gate: row.gateName, phase: row.phaseName }),
      after: { comment: detail.comment ?? null },
    }),
  );
}

registerSubjectAdapter({ type: 'stage_gate', load: loadForApproval, link: (id) => `/stage-gate-reviews/${id}`, onOutcome });
