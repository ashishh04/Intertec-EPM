import { createHash, randomBytes } from 'node:crypto';
import type { ApprovalRequest, ApprovalTask, Prisma } from '@prisma/client';

import { runAsAutomation, runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../email/outbox.js';
import { resolveRecipient } from '../email/recipients.js';
import { referenceCache } from '../lib/cache.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import { getCatalog } from '../mapping/catalog.js';
import { listProjects, projectIdentifiers } from '../mapping/projects.js';
import { getUsers } from '../mapping/users.js';
import { idFromHref, linkId, linkTitle, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type {
  ApprovalApproverSpec,
  ApprovalChain,
  ApprovalDelegation,
  ApprovalDelegationInput,
  ApprovalRequestView,
  ApprovalStep,
  ApprovalStepView,
  ApprovalSubjectState,
  ApprovalTaskView,
} from '../types/epm.js';
import { auditRow, recordAuditQuietly, type AuditInput } from './audit.js';
import { automationConfigured, ensureAutomationMembership } from './automation-account.js';
import { activeChains, conditionHolds, describeCondition, pickChain, type SubjectFacts } from './approval-chains.js';
import { notifyPeople, sentences } from './notifications.js';
import { noteRuleEvent } from './rule-events.js';
import { customFieldFacts } from './work-package-facts.js';
import { listOf, message } from '../lib/i18n.js';

/**
 * The approval engine (BRQ-09: BR-211 to BR-215).
 *
 * A subject — today a work package, tomorrow a timesheet or an expense claim —
 * is submitted against the chain that governs it. The chain is copied onto the
 * request with each step's condition decided there and then, and every
 * approver it names is resolved to a person, so nothing that changes later can
 * change a request already in flight. Steps then run in order: a step with
 * mode `all` waits for every approver, one with `any` for the first; any
 * rejection ends the request.
 *
 * Every decision, start, breach and outcome is written to the journal in the
 * same transaction as the change it records (BR-213). The request row is
 * locked while a decision is applied, so two approvers deciding at once — or
 * one deciding in the app and from the email together — cannot both win.
 *
 * Moving the subject's status (to Pending approval, Approved, Rejected) is done
 * with the service key after the decision commits, because the approver need
 * not be someone who may edit the work package. If that fails the decision
 * stands, and the request says so.
 */

const LINK_DAYS = 14;

/* -------------------------------------------------------------------------- */
/* The subject                                                                 */
/* -------------------------------------------------------------------------- */

interface OpWorkPackage {
  id: number;
  subject: string;
  lockVersion: number;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
  [field: string]: unknown;
}

/** A work package, as the engine needs it. */
export interface LoadedSubject {
  id: string;
  key: string;
  title: string;
  projectId: string;
  projectName: string;
  typeId?: string;
  statusId?: string;
  priorityId?: string;
  facts: SubjectFacts;
}

/**
 * Reads a work package with the service key.
 *
 * Callers check first that the person asking can see it; this read is for the
 * figures a chain routes on, which must be the same whoever submits.
 */
export async function loadWorkPackage(id: string): Promise<LoadedSubject> {
  if (!/^\d+$/.test(id)) throw EpmError.notFound('That work package');

  return runAsSystem(async () => {
    const wp = await openProject.request<OpWorkPackage>(`/work_packages/${id}`).catch(() => null);
    if (!wp) throw EpmError.notFound('That work package');

    const projectId = linkId(wp._links, 'project') ?? '';
    const [identifiers, profile] = await Promise.all([
      projectIdentifiers(),
      prisma.projectProfile
        .findUnique({ where: { openProjectId: projectId }, select: { portfolioId: true } })
        .catch(() => null),
    ]);

    // Every custom field, read the way rule conditions read them too.
    const customFields: SubjectFacts['customFields'] = customFieldFacts(wp);

    const identifier = identifiers.get(projectId);
    const typeId = linkId(wp._links, 'type');
    const priorityId = linkId(wp._links, 'priority');

    return {
      id: String(wp.id),
      key: identifier ? `${identifier.slice(0, 6).toUpperCase()}-${wp.id}` : `WP-${wp.id}`,
      title: wp.subject,
      projectId,
      projectName: linkTitle(wp._links, 'project') ?? '',
      typeId,
      statusId: linkId(wp._links, 'status'),
      priorityId,
      facts: { projectId, typeId, priorityId, portfolioId: profile?.portfolioId ?? undefined, customFields },
    };
  });
}

/**
 * Moves a work package's status for the chain. A no-op when it is already
 * there.
 *
 * Made as EPM's automation account where one is configured, so the move is
 * journalled under the service principal rather than under the
 * administrator whose key EPM reads with (NFR06); with the service key
 * otherwise, or if the account cannot act here. The move is then queued for
 * the rules, so a rule can act on an approval's outcome.
 */
async function setWorkPackageStatus(id: string, statusId: string, projectId: string): Promise<void> {
  const move = async () => {
    const current = await openProject.request<OpWorkPackage>(`/work_packages/${id}`);
    if (linkId(current._links, 'status') === statusId) return undefined;
    return openProject.request<OpWorkPackage>(`/work_packages/${id}`, {
      method: 'PATCH',
      query: { notify: 'false' },
      body: { lockVersion: current.lockVersion, _links: { status: { href: `/api/v3/statuses/${statusId}` } } },
    });
  };

  let moved: OpWorkPackage | undefined;
  if (automationConfigured()) {
    try {
      await ensureAutomationMembership(projectId);
      moved = await runAsAutomation(move);
    } catch (error) {
      appLog.warn({ err: error, workPackageId: id }, 'The automation account could not move an approval status; using the service key');
      moved = await runAsSystem(move);
    }
  } else {
    moved = await runAsSystem(move);
  }

  if (moved) {
    await noteRuleEvent({
      source: 'epm',
      kind: 'work_package.updated',
      subjectType: 'work_package',
      subjectId: id,
      projectId,
      version: moved.lockVersion,
    });
  }
}

/** Custom field names for a project and type, from the instance's own schema. */
async function customFieldNames(projectId: string, typeId?: string): Promise<Map<string, string>> {
  if (!typeId) return new Map();
  return referenceCache.get(`wp-schema-names:${projectId}-${typeId}`, () =>
    runAsSystem(async () => {
      const schema = await openProject
        .request<Record<string, { name?: string } | unknown>>(`/work_packages/schemas/${projectId}-${typeId}`)
        .catch(() => ({}) as Record<string, unknown>);
      const names = new Map<string, string>();
      for (const [field, value] of Object.entries(schema)) {
        if (/^customField\d+$/.test(field) && value && typeof value === 'object' && 'name' in value) {
          names.set(field, String((value as { name?: string }).name ?? field));
        }
      }
      return names;
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Approvers                                                                   */
/* -------------------------------------------------------------------------- */

async function projectMembers(projectId: string): Promise<{ userId: string; roleIds: string[] }[]> {
  const memberships = await openProject.getAll<{ _links?: Record<string, HalLink | HalLink[] | undefined> }>(
    '/memberships',
    { filters: [{ field: 'project', operator: '=', values: [projectId] }] },
  );
  return memberships.items.flatMap((membership) => {
    const principal = membership._links?.principal;
    const href = (Array.isArray(principal) ? principal[0] : principal)?.href ?? '';
    // People only: a group or a placeholder cannot sign anything off.
    const match = /\/users\/(\d+)$/.exec(href);
    if (!match) return [];
    const roles = membership._links?.roles;
    const list = Array.isArray(roles) ? roles : roles ? [roles] : [];
    return [{ userId: match[1]!, roleIds: list.map((role) => idFromHref(role.href) ?? '').filter(Boolean) }];
  });
}

/** The people a list of approver specs names, for one project and requester. */
export async function resolveApprovers(
  specs: ApprovalApproverSpec[],
  context: { projectId: string; requesterId: string },
): Promise<string[]> {
  return runAsSystem(async () => {
    const people = new Set<string>();
    const known = new Set((await getUsers()).map((user) => user.id));
    let members: { userId: string; roleIds: string[] }[] | undefined;

    for (const spec of specs) {
      if (spec.kind === 'user') {
        if (known.has(spec.userId)) people.add(spec.userId);
      } else if (spec.kind === 'project_owner') {
        const profile = await prisma.projectProfile.findUnique({
          where: { openProjectId: context.projectId },
          select: { ownerId: true },
        });
        if (profile?.ownerId) people.add(profile.ownerId);
      } else if (spec.kind === 'project_role') {
        members ??= await projectMembers(context.projectId).catch(() => []);
        for (const member of members) if (member.roleIds.includes(spec.roleId)) people.add(member.userId);
      } else {
        const profile = await prisma.userProfile.findUnique({
          where: { openProjectId: context.requesterId },
          select: { team: { select: { leadId: true } }, departmentRef: { select: { managerId: true } } },
        });
        const manager = profile?.team?.leadId ?? profile?.departmentRef?.managerId;
        if (manager) people.add(manager);
      }
    }
    return [...people];
  });
}

/* -------------------------------------------------------------------------- */
/* Planning a request                                                          */
/* -------------------------------------------------------------------------- */

interface SnapshotStep extends ApprovalStep {
  applies: boolean;
  conditionText?: string;
  approverIds: string[];
}

/** The chain as a request carries it: frozen at submission. */
interface ChainSnapshot {
  chainId: string;
  name: string;
  subjectKey: string;
  valueField?: string;
  valueLabel?: string;
  onSubmitStatusId?: string;
  onApproveStatusId?: string;
  onRejectStatusId?: string;
  allowSelfApproval: boolean;
  steps: SnapshotStep[];
}

function snapshotOf(value: Prisma.JsonValue): ChainSnapshot {
  return value as unknown as ChainSnapshot;
}

const formatNumber = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * The chain applied to a subject: which steps apply and why.
 *
 * Shared by the preview on the subject's page and by submission, so what a
 * person is shown before submitting is exactly what then happens.
 */
async function plan(chain: ApprovalChain, subject: LoadedSubject): Promise<{ snapshot: ChainSnapshot; value: number | null }> {
  const value = chain.valueField ? subject.facts.customFields[chain.valueField]?.number ?? null : null;
  const facts: SubjectFacts = { ...subject.facts, value };

  const [names, catalog, projects, portfolios] = await Promise.all([
    customFieldNames(subject.projectId, subject.typeId),
    runAsSystem(() => getCatalog()),
    runAsSystem(() => listProjects()),
    prisma.portfolio.findMany({ select: { id: true, name: true } }).catch(() => []),
  ]);
  const valueLabel = chain.valueField ? names.get(chain.valueField) ?? 'Value' : undefined;
  const valueName = (field: string, id: string): string | undefined => {
    if (field === 'type') return catalog.typeById.get(id)?.name;
    if (field === 'priority') return catalog.priorityById.get(id)?.name;
    if (field === 'project') return projects.find((project) => String(project.id) === id)?.name;
    if (field === 'portfolio') return portfolios.find((portfolio) => portfolio.id === id)?.name;
    return undefined;
  };

  const steps: SnapshotStep[] = chain.steps.map((step) => {
    const applies = conditionHolds(step.condition, facts);
    let conditionText: string | undefined;
    if (step.condition) {
      const rule = describeCondition(step.condition, {
        valueLabel,
        field: (field) => names.get(field),
        value: valueName,
      });
      const shown =
        step.condition.field === 'value'
          ? value === null
            ? ` (no ${valueLabel ?? 'value'} is set)`
            : ` (it is ${formatNumber(value)})`
          : '';
      conditionText = `${applies ? 'Applies' : 'Skipped'}: only when ${rule}${shown}.`;
    }
    return { ...step, applies, conditionText, approverIds: [] };
  });

  return {
    value,
    snapshot: {
      chainId: chain.id,
      name: chain.name,
      subjectKey: subject.key,
      valueField: chain.valueField,
      valueLabel,
      onSubmitStatusId: chain.onSubmitStatusId,
      onApproveStatusId: chain.onApproveStatusId,
      onRejectStatusId: chain.onRejectStatusId,
      allowSelfApproval: chain.allowSelfApproval,
      steps,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Delegation (BR-212)                                                         */
/* -------------------------------------------------------------------------- */

const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
const isoOf = (date: Date) => date.toISOString().slice(0, 10);

type Db = Prisma.TransactionClient | typeof prisma;

/** The delegation in force for a person today, if any: the most recent wins. */
async function activeDelegationsFor(db: Db, delegatorIds: string[], day = todayIso()) {
  if (delegatorIds.length === 0) return [];
  return db.approvalDelegation.findMany({
    where: {
      delegatorId: { in: delegatorIds },
      revokedAt: null,
      startsOn: { lte: dateOf(day) },
      endsOn: { gte: dateOf(day) },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function delegationInForce(db: Db, delegationId: string | null, day = todayIso()): Promise<boolean> {
  if (!delegationId) return false;
  const delegation = await db.approvalDelegation.findUnique({ where: { id: delegationId } });
  return Boolean(
    delegation &&
      !delegation.revokedAt &&
      isoOf(delegation.startsOn) <= day &&
      isoOf(delegation.endsOn) >= day,
  );
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Starts a step: its tasks become pending, the SLA clock starts, and anyone
 * who has delegated today has their delegate attached.
 */
async function activateStep(
  tx: Prisma.TransactionClient,
  request: { id: string; requestedBy: string },
  snapshot: ChainSnapshot,
  stepIndex: number,
  now: Date,
): Promise<ApprovalTask[]> {
  const step = snapshot.steps[stepIndex]!;
  const tasks = await tx.approvalTask.findMany({ where: { requestId: request.id, stepIndex, status: 'waiting' } });
  const delegations = await activeDelegationsFor(tx, tasks.map((task) => task.approverId), isoOf(now));
  const dueAt = step.slaHours ? new Date(now.getTime() + step.slaHours * 3_600_000) : null;

  const activated: ApprovalTask[] = [];
  for (const task of tasks) {
    // A delegate who raised the request does not get to approve it either.
    const delegation = delegations.find(
      (candidate) =>
        candidate.delegatorId === task.approverId &&
        candidate.delegateId !== task.approverId &&
        (snapshot.allowSelfApproval || candidate.delegateId !== request.requestedBy),
    );
    activated.push(
      await tx.approvalTask.update({
        where: { id: task.id },
        data: {
          status: 'pending',
          activatedAt: now,
          dueAt,
          delegateId: delegation?.delegateId ?? null,
          delegationId: delegation?.id ?? null,
        },
      }),
    );
  }
  return activated;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

async function nameIndex(): Promise<(id: string | null | undefined) => string> {
  const users = await runAsSystem(() => getUsers()).catch(() => []);
  const byId = new Map(users.map((user) => [user.id, user.name]));
  return (id) => (id ? byId.get(id) ?? `user ${id}` : 'nobody');
}

const listNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The same, as a message argument: joined the way the reader's language joins names. */
const nameList = (names: string[]) =>
  names.length <= 2 ? listOf(names, 'and') : listOf([listOf(names.slice(0, -1)), names.at(-1)], 'and');

/* -------------------------------------------------------------------------- */
/* Submitting                                                                  */
/* -------------------------------------------------------------------------- */

type RequestWithTasks = ApprovalRequest & { tasks: ApprovalTask[] };

/**
 * Submits a work package for approval.
 *
 * Refused when it is already waiting, when no chain governs it, when no step
 * of the chain applies to it, or when a step that applies has nobody who may
 * approve it — each with a sentence saying which.
 */
export async function submitForApproval(subjectId: string, requesterId: string): Promise<string> {
  const subject = await loadWorkPackage(subjectId);

  const pending = await prisma.approvalRequest.findFirst({
    where: { subjectType: 'work_package', subjectId, status: 'pending' },
  });
  if (pending) throw EpmError.conflict('This work package is already waiting for approval.');

  const chain = pickChain(await activeChains(), subject);
  if (!chain) throw EpmError.badRequest('No approval chain applies to this work package.');

  const { snapshot, value } = await plan(chain, subject);
  const names = await nameIndex();

  for (const step of snapshot.steps) {
    if (!step.applies) continue;
    let approvers = await resolveApprovers(step.approvers, { projectId: subject.projectId, requesterId });
    if (!chain.allowSelfApproval) approvers = approvers.filter((id) => id !== requesterId);
    if (approvers.length === 0) {
      throw EpmError.validation(
        message(
          '{self, select, allowed {Nobody can approve the "{step}" step of {chain}.} other {Nobody other than you can approve the "{step}" step of {chain}.}} Ask an administrator to name an approver for it.',
          { self: chain.allowSelfApproval ? 'allowed' : 'other', step: step.name, chain: chain.name },
        ),
      );
    }
    step.approverIds = approvers;
  }

  const first = snapshot.steps.findIndex((step) => step.applies);
  if (first < 0) {
    throw EpmError.validation(
      message(
        'No step of {chain} applies to this work package, so nobody would decide it. Check its values, or ask an administrator to adjust the chain.',
        { chain: chain.name },
      ),
    );
  }

  const now = new Date();
  const appliedSteps = snapshot.steps.filter((step) => step.applies);
  const { request, activated } = await prisma.$transaction(async (tx) => {
    const request = await tx.approvalRequest.create({
      data: {
        chainId: chain.id,
        chainSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        subjectType: 'work_package',
        subjectId,
        projectId: subject.projectId,
        title: subject.title,
        value,
        statusBefore: subject.statusId ?? null,
        requestedBy: requesterId,
        currentStep: first,
      },
    });
    await tx.approvalTask.createMany({
      data: snapshot.steps.flatMap((step, stepIndex) =>
        step.applies
          ? step.approverIds.map((approverId) => ({ requestId: request.id, stepIndex, stepName: step.name, approverId }))
          : [],
      ),
    });
    const activated = await activateStep(tx, request, snapshot, first, now);

    const route = appliedSteps.map((step) => `"${step.name}" (${listNames(step.approverIds.map(names))})`).join(', then ');
    await tx.auditEvent.create({
      data: auditRow({
        actorId: requesterId,
        projectId: subject.projectId,
        entityType: 'approval-request',
        entityId: request.id,
        action: 'approval.submitted',
        summary: `${subject.key} submitted to ${chain.name}${value !== null ? ` with ${snapshot.valueLabel ?? 'value'} ${formatNumber(value)}` : ''}: ${route}.`,
        after: {
          chain: chain.name,
          value,
          steps: snapshot.steps.map((step) => ({ name: step.name, applies: step.applies, approvers: step.approverIds })),
        },
      }),
    });
    await tx.auditEvent.create({ data: auditRow(stepStarted(request, snapshot, first, activated, names)) });
    return { request, activated };
  });

  if (snapshot.onSubmitStatusId) {
    await moveSubjectStatus(request.id, subjectId, subject.projectId, snapshot.onSubmitStatusId, 'submission');
  }
  await announceTasks(request, snapshot, activated);
  return request.id;
}

function stepStarted(
  request: { id: string; projectId: string },
  snapshot: ChainSnapshot,
  stepIndex: number,
  tasks: ApprovalTask[],
  names: (id: string | null | undefined) => string,
): AuditInput {
  const step = snapshot.steps[stepIndex]!;
  const delegated = tasks.filter((task) => task.delegateId);
  return {
    actorId: null,
    projectId: request.projectId,
    entityType: 'approval-request',
    entityId: request.id,
    action: 'approval.step.started',
    summary:
      `Step ${stepIndex + 1} "${step.name}" started: ${step.mode === 'all' ? 'all of' : 'any one of'} ` +
      `${listNames(tasks.map((task) => names(task.approverId)))}` +
      `${step.slaHours ? `, within ${step.slaHours} ${step.slaHours === 1 ? 'hour' : 'hours'}` : ''}` +
      `${delegated.length ? `; delegated: ${delegated.map((task) => `${names(task.approverId)} to ${names(task.delegateId)}`).join(', ')}` : ''}.`,
    after: { stepIndex, tasks: tasks.map((task) => ({ approver: task.approverId, delegate: task.delegateId, dueAt: task.dueAt })) },
  };
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                    */
/* -------------------------------------------------------------------------- */

export type Decision = 'approve' | 'reject';

/**
 * The comment a decision is recorded with, or why it cannot be. Rejecting
 * needs a reason, because the requester is shown it and has to act on it.
 */
function decisionComment(decision: Decision, raw?: string): string | undefined {
  const comment = raw?.trim() || undefined;
  if (decision === 'reject' && (!comment || comment.length < 3)) {
    throw EpmError.validation('Say why you are rejecting it: the requester is shown your reason.');
  }
  if (comment && comment.length > 2000) throw EpmError.validation('Keep the comment under 2,000 characters.');
  return comment;
}

/**
 * Records one approver's decision and moves the request on.
 *
 * The approver the chain named may always decide; their delegate may while
 * the delegation is in force, and the decision then says on whose behalf
 * (BR-212, BRL-06). Rejecting needs a reason, because the requester is shown
 * it and has to act on it.
 */
export async function decideTask(input: {
  taskId: string;
  decision: Decision;
  comment?: string;
  actorId: string;
  via: 'app' | 'email';
}): Promise<string> {
  const comment = decisionComment(input.decision, input.comment);

  const located = await prisma.approvalTask.findUnique({ where: { id: input.taskId }, select: { requestId: true } });
  if (!located) throw EpmError.notFound('That approval');

  const names = await nameIndex();
  const now = new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    // One decision at a time per request, whichever door it came through.
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${located.requestId} FOR UPDATE`;
    const request = await tx.approvalRequest.findUniqueOrThrow({
      where: { id: located.requestId },
      include: { tasks: true },
    });
    const task = request.tasks.find((candidate) => candidate.id === input.taskId)!;
    if (request.status !== 'pending' || task.status !== 'pending') {
      throw EpmError.conflict('This approval has already been decided.');
    }

    let onBehalfOf: string | null = null;
    if (input.actorId !== task.approverId) {
      const asDelegate =
        task.delegateId === input.actorId && (await delegationInForce(tx, task.delegationId, isoOf(now)));
      if (!asDelegate) {
        throw EpmError.forbidden('Only the approver named for this step, or their delegate, can decide it.');
      }
      onBehalfOf = task.approverId;
    }

    const snapshot = snapshotOf(request.chainSnapshot);
    const step = snapshot.steps[task.stepIndex]!;
    const decided = input.decision === 'approve' ? 'approved' : 'rejected';

    await tx.approvalTask.update({
      where: { id: task.id },
      data: { status: decided, decidedAt: now, decidedBy: input.actorId, onBehalfOf, comment: comment ?? null },
    });
    await tx.auditEvent.create({
      data: auditRow({
        actorId: input.actorId,
        projectId: request.projectId,
        entityType: 'approval-request',
        entityId: request.id,
        action: 'approval.decided',
        summary:
          `${decided === 'approved' ? 'Approved' : 'Rejected'} at step ${task.stepIndex + 1} "${step.name}"` +
          `${onBehalfOf ? ` on behalf of ${names(onBehalfOf)}` : ''}${input.via === 'email' ? ', from the email' : ''}.`,
        reason: comment ?? null,
        after: { stepIndex: task.stepIndex, step: step.name, decision: decided, onBehalfOf, via: input.via },
      }),
    });

    const finish = async (status: 'approved' | 'rejected', summary: string) => {
      await tx.approvalTask.updateMany({
        where: { requestId: request.id, status: { in: ['pending', 'waiting'] } },
        data: { status: 'skipped' },
      });
      await tx.approvalRequest.update({ where: { id: request.id }, data: { status, completedAt: now } });
      await tx.auditEvent.create({
        data: auditRow({
          actorId: null,
          projectId: request.projectId,
          entityType: 'approval-request',
          entityId: request.id,
          action: 'approval.completed',
          summary,
          after: { status },
        }),
      });
      return { status, activated: [] as ApprovalTask[] };
    };

    if (decided === 'rejected') {
      return finish('rejected', `${snapshot.subjectKey} rejected at step ${task.stepIndex + 1} "${step.name}".`);
    }

    const stepTasks = request.tasks
      .filter((candidate) => candidate.stepIndex === task.stepIndex)
      .map((candidate) => (candidate.id === task.id ? { ...candidate, status: 'approved' } : candidate));
    const stepDone = step.mode === 'any' || stepTasks.every((candidate) => candidate.status === 'approved');
    if (!stepDone) return { status: 'pending' as const, activated: [] as ApprovalTask[] };

    if (step.mode === 'any') {
      await tx.approvalTask.updateMany({
        where: { requestId: request.id, stepIndex: task.stepIndex, status: 'pending' },
        data: { status: 'skipped' },
      });
    }

    const next = snapshot.steps.findIndex((candidate, index) => index > task.stepIndex && candidate.applies);
    if (next < 0) {
      return finish('approved', `${snapshot.subjectKey} approved: every step agreed.`);
    }

    await tx.approvalRequest.update({ where: { id: request.id }, data: { currentStep: next } });
    const activated = await activateStep(tx, request, snapshot, next, now);
    await tx.auditEvent.create({ data: auditRow(stepStarted(request, snapshot, next, activated, names)) });
    return { status: 'pending' as const, activated };
  });

  const request = await prisma.approvalRequest.findUniqueOrThrow({
    where: { id: located.requestId },
    include: { tasks: true },
  });
  const snapshot = snapshotOf(request.chainSnapshot);

  if (outcome.status === 'approved' || outcome.status === 'rejected') {
    const target = outcome.status === 'approved' ? snapshot.onApproveStatusId : snapshot.onRejectStatusId;
    if (target) await moveSubjectStatus(request.id, request.subjectId, request.projectId, target, outcome.status);
    else await prisma.approvalRequest.update({ where: { id: request.id }, data: { outcomeAppliedAt: new Date() } });
    await announceOutcome(request, snapshot, input.actorId, comment);
  }
  if (outcome.activated.length > 0) await announceTasks(request, snapshot, outcome.activated);

  return request.id;
}

/**
 * Moves the subject's status for a submission or an outcome, and records what
 * happened. Failure is recorded on the request, never thrown: the decision has
 * already been made and journalled.
 */
async function moveSubjectStatus(
  requestId: string,
  subjectId: string,
  projectId: string,
  statusId: string,
  why: 'submission' | 'approved' | 'rejected' | 'withdrawn',
): Promise<void> {
  const catalog = await runAsSystem(() => getCatalog()).catch(() => undefined);
  const statusName = catalog?.statusById.get(statusId)?.name ?? `status ${statusId}`;
  try {
    await setWorkPackageStatus(subjectId, statusId, projectId);
    if (why === 'approved' || why === 'rejected') {
      await prisma.approvalRequest.update({ where: { id: requestId }, data: { outcomeAppliedAt: new Date(), outcomeError: null } });
    }
    await recordAuditQuietly([
      {
        actorId: null,
        projectId,
        entityType: 'approval-request',
        entityId: requestId,
        action: 'approval.status.moved',
        summary: `Work package moved to ${statusName} (${why}).`,
        after: { statusId, why },
      },
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The status could not be changed.';
    appLog.warn({ err: error, requestId, statusId }, 'Could not move an approval subject');
    await prisma.approvalRequest
      .update({ where: { id: requestId }, data: { outcomeError: `Could not move it to ${statusName}: ${message}` } })
      .catch(() => undefined);
    await recordAuditQuietly([
      {
        actorId: null,
        projectId,
        entityType: 'approval-request',
        entityId: requestId,
        action: 'approval.status.failed',
        summary: `Could not move the work package to ${statusName} (${why}): ${message}`,
        after: { statusId, why },
      },
    ]);
  }
}

/* -------------------------------------------------------------------------- */
/* Withdrawing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Withdraws a pending request: the requester's to do, or an administrator's.
 * The work package goes back to the status it had before it was submitted.
 */
export async function cancelRequest(input: {
  requestId: string;
  actorId: string;
  mayCancelAny: boolean;
  reason?: string;
}): Promise<void> {
  const reason = input.reason?.trim() || null;
  const request = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${input.requestId} FOR UPDATE`;
    const request = await tx.approvalRequest.findUnique({ where: { id: input.requestId } });
    if (!request) throw EpmError.notFound('That approval request');
    if (request.status !== 'pending') throw EpmError.conflict('Only a request still waiting for a decision can be withdrawn.');
    if (request.requestedBy !== input.actorId && !input.mayCancelAny) {
      throw EpmError.forbidden('Only whoever submitted it, or an administrator, can withdraw this request.');
    }
    await tx.approvalTask.updateMany({
      where: { requestId: request.id, status: { in: ['pending', 'waiting'] } },
      data: { status: 'skipped' },
    });
    const updated = await tx.approvalRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    await tx.auditEvent.create({
      data: auditRow({
        actorId: input.actorId,
        projectId: request.projectId,
        entityType: 'approval-request',
        entityId: request.id,
        action: 'approval.cancelled',
        summary: `${snapshotOf(request.chainSnapshot).subjectKey} withdrawn from approval.`,
        reason,
      }),
    });
    return updated;
  });

  // Only put the status back if the work package is still where submission
  // left it: anything else is somebody's later decision, not ours to undo.
  const snapshot = snapshotOf(request.chainSnapshot);
  if (snapshot.onSubmitStatusId && request.statusBefore) {
    const subject = await loadWorkPackage(request.subjectId).catch(() => undefined);
    if (subject?.statusId === snapshot.onSubmitStatusId) {
      await moveSubjectStatus(request.id, request.subjectId, request.projectId, request.statusBefore, 'withdrawn');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Telling people                                                              */
/* -------------------------------------------------------------------------- */

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** A single-use link for one person and one task (BR-215). The token itself is never stored. */
async function issueLink(taskId: string, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma.approvalLinkToken.create({
    data: { tokenHash: hash(token), taskId, userId, expiresAt: new Date(Date.now() + LINK_DAYS * 86_400_000) },
  });
  return token;
}

async function announceTasks(
  request: ApprovalRequest,
  snapshot: ChainSnapshot,
  tasks: ApprovalTask[],
  /** Tell only this person, e.g. a delegate attached after the step began. */
  onlyTo?: string,
): Promise<void> {
  const names = await nameIndex();
  const projectName =
    (await runAsSystem(() => listProjects()).catch(() => [])).find((project) => String(project.id) === request.projectId)?.name ?? '';
  // To the cent, as it has always been shown; the email writes it in the
  // reader's own format, with the chain's label or "Value".
  const value = request.value !== null && request.value !== undefined ? Math.round(request.value * 100) / 100 : undefined;

  for (const task of tasks) {
    for (const recipientId of [task.approverId, task.delegateId].filter((id): id is string => Boolean(id))) {
      if (onlyTo && recipientId !== onlyTo) continue;
      const asDelegate = recipientId !== task.approverId;
      try {
        await notifyPeople({
          recipients: [recipientId],
          category: 'assignment',
          title: message('Approval needed: {key} {title}', { key: snapshot.subjectKey, title: request.title }),
          body: asDelegate
            ? message('{requester} needs your approval at the "{step}" step on behalf of {approver}.', {
                requester: names(request.requestedBy),
                step: task.stepName,
                approver: names(task.approverId),
              })
            : message('{requester} needs your approval at the "{step}" step.', {
                requester: names(request.requestedBy),
                step: task.stepName,
              }),
          link: `/tasks/${request.subjectId}`,
          severity: 'info',
          dedupeKey: `approval-task:${task.id}:${recipientId}`,
        });

        const recipient = await resolveRecipient(recipientId);
        if (!recipient) continue;
        const token = await issueLink(task.id, recipientId);
        const decideUrl = `${env.APP_BASE_URL}/approvals/decide/${token}`;
        await enqueueEmail({
          recipientId,
          template: 'approval-request',
          payload: {
            firstName: recipient.firstName,
            key: snapshot.subjectKey,
            title: request.title,
            projectName,
            stepName: task.stepName,
            requesterName: names(request.requestedBy),
            value,
            valueLabel: value !== undefined ? snapshot.valueLabel : undefined,
            onBehalfOfName: asDelegate ? names(task.approverId) : undefined,
            dueAt: task.dueAt?.toISOString(),
            approveUrl: `${decideUrl}?decision=approve`,
            rejectUrl: `${decideUrl}?decision=reject`,
            openUrl: `${env.APP_BASE_URL}/tasks/${request.subjectId}`,
          },
          channel: 'immediate',
          dedupeKey: `approval-link:${task.id}:${recipientId}`,
          gate: 'assigned',
        });
      } catch (error) {
        // Telling people is a side effect; the request stands without it.
        appLog.warn({ err: error, taskId: task.id, recipientId }, 'Could not announce an approval task');
      }
    }
  }
}

async function announceOutcome(
  request: RequestWithTasks,
  snapshot: ChainSnapshot,
  deciderId: string,
  comment?: string,
): Promise<void> {
  try {
    const names = await nameIndex();
    const decidingTask = [...request.tasks]
      .filter((task) => task.decidedBy === deciderId)
      .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0];
    const decidedBy = names(deciderId);
    const onBehalfOf = decidingTask?.onBehalfOf ? names(decidingTask.onBehalfOf) : undefined;
    const outcome = request.status === 'approved' ? 'approved' : 'rejected';

    await notifyPeople({
      recipients: [request.requestedBy],
      category: 'project_update',
      title: message('{outcome, select, approved {Approved} other {Rejected}}: {key} {title}', {
        outcome,
        key: snapshot.subjectKey,
        title: request.title,
      }),
      body: sentences(
        onBehalfOf
          ? message('Decided by {name} on behalf of {approver}.', { name: decidedBy, approver: onBehalfOf })
          : message('Decided by {name}.', { name: decidedBy }),
        comment ? message('“{comment}”', { comment }) : undefined,
      ),
      link: `/tasks/${request.subjectId}`,
      severity: outcome === 'approved' ? 'info' : 'warning',
      dedupeKey: `approval-outcome:${request.id}`,
    });

    const recipient = await resolveRecipient(request.requestedBy);
    if (!recipient) return;
    const projectName =
      (await runAsSystem(() => listProjects()).catch(() => [])).find((project) => String(project.id) === request.projectId)?.name ?? '';
    await enqueueEmail({
      recipientId: request.requestedBy,
      template: 'approval-decided',
      payload: {
        firstName: recipient.firstName,
        key: snapshot.subjectKey,
        title: request.title,
        projectName,
        outcome,
        decidedBy,
        onBehalfOf,
        comment,
        openUrl: `${env.APP_BASE_URL}/tasks/${request.subjectId}`,
      },
      channel: 'immediate',
      dedupeKey: `approval-decided:${request.id}`,
      gate: 'updates',
    });
  } catch (error) {
    appLog.warn({ err: error, requestId: request.id }, 'Could not announce an approval outcome');
  }
}

/* -------------------------------------------------------------------------- */
/* Decide from the email (BR-215)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Checks a link without using it.
 *
 * The person must be signed in, and must be the person the link was sent to;
 * that person must still be able to decide. Checked before anything is
 * consumed, so a link opened by the wrong person is not spent by them.
 */
export async function resolveLink(token: string, viewerId: string) {
  const row = await prisma.approvalLinkToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row) throw EpmError.notFound('That approval link');
  if (row.userId !== viewerId) throw EpmError.forbidden('This link was sent to someone else. Open the approval from your own email or from Approvals.');
  if (row.usedAt) throw EpmError.gone('This link has already been used. Each approval link works once.');
  if (row.expiresAt.getTime() < Date.now()) throw EpmError.gone('This link has expired. Open the approval from Approvals instead.');

  const task = await prisma.approvalTask.findUnique({ where: { id: row.taskId }, include: { request: true } });
  if (!task) throw EpmError.notFound('That approval');
  if (task.status !== 'pending' || task.request.status !== 'pending') {
    throw EpmError.gone('This approval has already been decided.');
  }
  const mayDecide =
    task.approverId === viewerId ||
    (task.delegateId === viewerId && (await delegationInForce(prisma, task.delegationId)));
  if (!mayDecide) throw EpmError.forbidden('You can no longer decide this approval.');

  return { row, task };
}

/** Uses a link: atomically marks it spent, then decides. */
export async function decideViaLink(input: {
  token: string;
  viewerId: string;
  decision: Decision;
  comment?: string;
}): Promise<string> {
  const { row } = await resolveLink(input.token, input.viewerId);
  // Before it is spent: a rejection with no reason is sent back to be given
  // one, not allowed to use the link up and decide nothing.
  decisionComment(input.decision, input.comment);
  // Spent only if nothing else spent it first: the update matches an unused
  // row or nothing, so of two clicks at once exactly one goes through.
  const spent = await prisma.approvalLinkToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (spent.count !== 1) throw EpmError.gone('This link has already been used. Each approval link works once.');

  return decideTask({ taskId: row.taskId, decision: input.decision, comment: input.comment, actorId: input.viewerId, via: 'email' });
}

/* -------------------------------------------------------------------------- */
/* SLA (BR-214) and delegation upkeep                                          */
/* -------------------------------------------------------------------------- */

/**
 * Raises an escalation for every step that has outlived its SLA, once.
 *
 * One escalation event per breached step, to the step's escalation contacts or
 * else the project owner, journalled, and with the approvers reminded. The
 * event is what the escalation engine acts on; claiming the breach on the task
 * rows first means two sweeps running together cannot raise it twice.
 *
 * Also keeps delegations current: one that has started since a step began is
 * attached to its pending tasks, one that has ended or been revoked detached.
 */
export async function sweepApprovals(now = new Date()): Promise<{ breached: number; attached: number; detached: number }> {
  const names = await nameIndex();
  const overdue = await prisma.approvalTask.findMany({
    where: { status: 'pending', breachedAt: null, dueAt: { lt: now }, request: { status: 'pending' } },
    include: { request: true },
  });

  const steps = new Map<string, typeof overdue>();
  for (const task of overdue) {
    const key = `${task.requestId}:${task.stepIndex}`;
    steps.set(key, [...(steps.get(key) ?? []), task]);
  }

  let breached = 0;
  for (const [key, tasks] of steps) {
    const request = tasks[0]!.request;
    const snapshot = snapshotOf(request.chainSnapshot);
    const step = snapshot.steps[tasks[0]!.stepIndex]!;

    let targets = step.escalateTo?.length
      ? await resolveApprovers(step.escalateTo, { projectId: request.projectId, requesterId: request.requestedBy }).catch(() => [])
      : [];
    if (targets.length === 0) {
      const owner = await prisma.projectProfile.findUnique({ where: { openProjectId: request.projectId }, select: { ownerId: true } });
      if (owner?.ownerId) targets = [owner.ownerId];
    }
    const waitingOn = listNames(tasks.map((task) => names(task.approverId)));

    const raised = await prisma.$transaction(async (tx) => {
      const claimed = await tx.approvalTask.updateMany({
        where: { id: { in: tasks.map((task) => task.id) }, status: 'pending', breachedAt: null },
        data: { breachedAt: now },
      });
      if (claimed.count === 0) return false;
      await tx.escalationEvent.create({
        data: {
          source: 'approval.sla',
          subjectType: 'approval-request',
          subjectId: request.id,
          projectId: request.projectId,
          level: 1,
          raisedFor: targets,
          reason: `Step "${step.name}" of ${snapshot.subjectKey} passed its ${step.slaHours}-hour SLA waiting on ${waitingOn}.`,
          dedupeKey: `approval.sla:${key}`,
          metadata: { requestId: request.id, stepIndex: tasks[0]!.stepIndex, dueAt: tasks[0]!.dueAt, taskIds: tasks.map((task) => task.id) },
        },
      });
      await tx.auditEvent.create({
        data: auditRow({
          actorId: null,
          projectId: request.projectId,
          entityType: 'approval-request',
          entityId: request.id,
          action: 'approval.sla.breached',
          summary: `Step ${tasks[0]!.stepIndex + 1} "${step.name}" passed its ${step.slaHours}-hour SLA waiting on ${waitingOn}; escalated to ${targets.length ? listNames(targets.map(names)) : 'nobody (the project has no owner)'}.`,
          after: { stepIndex: tasks[0]!.stepIndex, raisedFor: targets },
        }),
      });
      return true;
    }).catch((error: unknown) => {
      // Unique key: another sweep raised it first. Anything else is logged.
      if (!(error instanceof Error && /Unique constraint/i.test(error.message))) {
        appLog.warn({ err: error, key }, 'Could not raise an approval escalation');
      }
      return false;
    });
    if (!raised) continue;
    breached += 1;

    for (const recipient of new Set([...targets, ...tasks.flatMap((task) => [task.approverId, task.delegateId ?? ''])])) {
      if (!recipient) continue;
      await notifyPeople({
        recipients: [recipient],
        category: 'deadline',
        title: message('Approval overdue: {key} {title}', { key: snapshot.subjectKey, title: request.title }),
        body: message('The "{step}" step passed its {hours, number}-hour SLA waiting on {people}.', {
          step: step.name,
          hours: step.slaHours,
          people: nameList(tasks.map((task) => names(task.approverId))),
        }),
        link: `/tasks/${request.subjectId}`,
        severity: 'warning',
        dedupeKey: `approval-breach:${key}:${recipient}`,
      }).catch(() => undefined);
    }
  }

  // Delegation upkeep.
  const day = isoOf(now);
  let attached = 0;
  let detached = 0;
  const stale = await prisma.approvalTask.findMany({ where: { status: 'pending', delegationId: { not: null } } });
  for (const task of stale) {
    if (!(await delegationInForce(prisma, task.delegationId, day))) {
      await prisma.approvalTask.update({ where: { id: task.id }, data: { delegateId: null, delegationId: null } });
      detached += 1;
    }
  }
  const undelegated = await prisma.approvalTask.findMany({
    where: { status: 'pending', delegationId: null },
    include: { request: true },
  });
  const delegations = await activeDelegationsFor(prisma, [...new Set(undelegated.map((task) => task.approverId))], day);
  for (const { request, ...task } of undelegated) {
    const snapshot = snapshotOf(request.chainSnapshot);
    const delegation = delegations.find(
      (candidate) =>
        candidate.delegatorId === task.approverId &&
        (snapshot.allowSelfApproval || candidate.delegateId !== request.requestedBy),
    );
    if (!delegation) continue;
    // Only if it still waits: decided in the meantime, it is nobody's to take over.
    const claimed = await prisma.approvalTask.updateMany({
      where: { id: task.id, status: 'pending', delegationId: null },
      data: { delegateId: delegation.delegateId, delegationId: delegation.id },
    });
    if (claimed.count !== 1) continue;
    attached += 1;
    // The delegate is asked as an approver would have been, link and all; the
    // approver was told when the step began.
    await announceTasks(
      request,
      snapshot,
      [{ ...task, delegateId: delegation.delegateId, delegationId: delegation.id }],
      delegation.delegateId,
    );
  }

  return { breached, attached, detached };
}

/* -------------------------------------------------------------------------- */
/* Delegations                                                                 */
/* -------------------------------------------------------------------------- */

function toDelegation(row: Awaited<ReturnType<typeof prisma.approvalDelegation.findFirstOrThrow>>): ApprovalDelegation {
  const day = todayIso();
  return {
    id: row.id,
    delegatorId: row.delegatorId,
    delegateId: row.delegateId,
    startsOn: isoOf(row.startsOn),
    endsOn: isoOf(row.endsOn),
    reason: row.reason ?? undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    active: !row.revokedAt && isoOf(row.startsOn) <= day && isoOf(row.endsOn) >= day,
  };
}

export async function listDelegations(viewerId: string, all: boolean): Promise<ApprovalDelegation[]> {
  const rows = await prisma.approvalDelegation.findMany({
    where: all ? {} : { OR: [{ delegatorId: viewerId }, { delegateId: viewerId }] },
    orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { startsOn: 'desc' }],
    take: 200,
  });
  return rows.map(toDelegation);
}

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Hands a person's approvals to someone else for a period.
 *
 * Anyone may delegate their own; only an administrator may set one up for
 * somebody else, say for a colleague who left without doing it. Pending
 * approvals are handed over at once if the period has started.
 */
export async function createDelegation(
  input: ApprovalDelegationInput,
  actorId: string,
  mayActForOthers: boolean,
): Promise<ApprovalDelegation> {
  const delegatorId = input.delegatorId ?? actorId;
  if (delegatorId !== actorId && !mayActForOthers) {
    throw EpmError.forbidden('You can only delegate your own approvals.');
  }
  if (!input.delegateId || !/^\d+$/.test(input.delegateId)) throw EpmError.validation('Choose who to delegate to.');
  if (input.delegateId === delegatorId) throw EpmError.validation('A delegate has to be someone else.');
  if (!isoDay.test(input.startsOn) || !isoDay.test(input.endsOn)) throw EpmError.validation('Dates are written YYYY-MM-DD.');
  if (input.endsOn < input.startsOn) throw EpmError.validation('A delegation cannot end before it starts.');
  if (input.endsOn < todayIso()) throw EpmError.validation('That period is already over.');
  const span = (dateOf(input.endsOn).getTime() - dateOf(input.startsOn).getTime()) / 86_400_000;
  if (span > 366) throw EpmError.validation('Delegate for at most a year at a time.');
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 500) throw EpmError.validation('Keep the reason under 500 characters.');

  const names = await nameIndex();
  const known = new Set((await runAsSystem(() => getUsers())).map((user) => user.id));
  if (!known.has(input.delegateId)) throw EpmError.validation('That person does not exist.');

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.approvalDelegation.create({
      data: {
        delegatorId,
        delegateId: input.delegateId,
        startsOn: dateOf(input.startsOn),
        endsOn: dateOf(input.endsOn),
        reason,
        createdBy: actorId,
      },
    });
    await tx.auditEvent.create({
      data: auditRow({
        actorId,
        entityType: 'approval-delegation',
        entityId: created.id,
        action: 'approval.delegation.created',
        summary: `${names(delegatorId)} delegated approvals to ${names(input.delegateId)} from ${input.startsOn} to ${input.endsOn}.`,
        reason,
        after: { delegatorId, delegateId: input.delegateId, startsOn: input.startsOn, endsOn: input.endsOn },
      }),
    });
    return created;
  });

  // Hand over what is waiting now, if the period has started.
  const { attached } = await sweepApprovals();
  if (attached > 0) appLog.info({ delegationId: row.id, attached }, 'Delegation attached to pending approvals');

  await notifyPeople({
    recipients: [input.delegateId],
    category: 'assignment',
    title: message('{name} delegated their approvals to you', { name: names(delegatorId) }),
    body: sentences(message('From {start} to {end}.', { start: input.startsOn, end: input.endsOn }), reason ?? undefined),
    link: '/approvals',
    severity: 'info',
    dedupeKey: `approval-delegation:${row.id}`,
  }).catch(() => undefined);

  return toDelegation(row);
}

export async function revokeDelegation(id: string, actorId: string, mayActForOthers: boolean): Promise<ApprovalDelegation> {
  const existing = await prisma.approvalDelegation.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That delegation');
  if (existing.delegatorId !== actorId && existing.createdBy !== actorId && !mayActForOthers) {
    throw EpmError.forbidden('Only the person who delegated, or an administrator, can revoke this.');
  }
  if (existing.revokedAt) return toDelegation(existing);

  const names = await nameIndex();
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.approvalDelegation.update({
      where: { id },
      data: { revokedAt: new Date(), revokedBy: actorId },
    });
    await tx.approvalTask.updateMany({
      where: { delegationId: id, status: 'pending' },
      data: { delegateId: null, delegationId: null },
    });
    await tx.auditEvent.create({
      data: auditRow({
        actorId,
        entityType: 'approval-delegation',
        entityId: id,
        action: 'approval.delegation.revoked',
        summary: `Delegation from ${names(existing.delegatorId)} to ${names(existing.delegateId)} revoked.`,
      }),
    });
    return updated;
  });
  return toDelegation(row);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Requests as the viewer should see them, with what they may do. */
export async function toRequestViews(
  rows: RequestWithTasks[],
  viewerId: string,
  mayCancelAny: boolean,
): Promise<ApprovalRequestView[]> {
  if (rows.length === 0) return [];
  const projects = await runAsSystem(() => listProjects()).catch(() => []);
  const delegationIds = [...new Set(rows.flatMap((row) => row.tasks.map((task) => task.delegationId)).filter(Boolean))] as string[];
  const delegations = delegationIds.length
    ? await prisma.approvalDelegation.findMany({ where: { id: { in: delegationIds } } })
    : [];
  const day = todayIso();
  const inForce = new Set(
    delegations
      .filter((row) => !row.revokedAt && isoOf(row.startsOn) <= day && isoOf(row.endsOn) >= day)
      .map((row) => row.id),
  );

  return rows.map((row) => {
    const snapshot = snapshotOf(row.chainSnapshot);
    const steps: ApprovalStepView[] = snapshot.steps.map((step, index) => {
      const tasks = row.tasks.filter((task) => task.stepIndex === index);
      const taskViews: ApprovalTaskView[] = tasks.map((task) => ({
        id: task.id,
        approverId: task.approverId,
        delegateId: task.delegateId ?? undefined,
        status: task.status as ApprovalTaskView['status'],
        activatedAt: task.activatedAt?.toISOString(),
        dueAt: task.dueAt?.toISOString(),
        breachedAt: task.breachedAt?.toISOString(),
        decidedAt: task.decidedAt?.toISOString(),
        decidedBy: task.decidedBy ?? undefined,
        onBehalfOf: task.onBehalfOf ?? undefined,
        comment: task.comment ?? undefined,
        canDecide:
          row.status === 'pending' &&
          task.status === 'pending' &&
          (task.approverId === viewerId ||
            (task.delegateId === viewerId && Boolean(task.delegationId) && inForce.has(task.delegationId!))),
      }));

      let status: ApprovalStepView['status'];
      if (!step.applies) status = 'skipped';
      else if (tasks.some((task) => task.status === 'rejected')) status = 'rejected';
      else if (tasks.length > 0 && tasks.every((task) => task.status === 'approved' || task.status === 'skipped') && tasks.some((task) => task.status === 'approved')) status = 'approved';
      else if (tasks.some((task) => task.status === 'pending')) status = 'active';
      else if (tasks.every((task) => task.status === 'skipped')) status = 'skipped';
      else status = 'waiting';

      return {
        index,
        name: step.name,
        mode: step.mode,
        applies: step.applies,
        conditionText: step.conditionText,
        slaHours: step.slaHours,
        status,
        tasks: taskViews,
      };
    });

    return {
      id: row.id,
      chainId: row.chainId,
      chainName: snapshot.name,
      subjectType: 'work_package',
      subjectId: row.subjectId,
      projectId: row.projectId,
      projectName: projects.find((project) => String(project.id) === row.projectId)?.name,
      title: `${snapshot.subjectKey} ${row.title}`,
      value: row.value ?? undefined,
      valueLabel: snapshot.valueLabel,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      status: row.status as ApprovalRequestView['status'],
      currentStep: row.currentStep,
      completedAt: row.completedAt?.toISOString(),
      outcomeError: row.outcomeError ?? undefined,
      steps,
      can: { cancel: row.status === 'pending' && (row.requestedBy === viewerId || mayCancelAny) },
    };
  });
}

/** The approval state of one work package, for its page. */
export async function subjectState(input: {
  subjectId: string;
  viewerId: string;
  canEdit: boolean;
  mayCancelAny: boolean;
}): Promise<ApprovalSubjectState> {
  const [subject, rows] = await Promise.all([
    loadWorkPackage(input.subjectId),
    prisma.approvalRequest.findMany({
      where: { subjectType: 'work_package', subjectId: input.subjectId },
      include: { tasks: true },
      orderBy: { requestedAt: 'desc' },
      take: 20,
    }),
  ]);
  const views = await toRequestViews(rows, input.viewerId, input.mayCancelAny);
  const chain = pickChain(await activeChains(), subject);
  const preview = chain ? (await plan(chain, subject)).snapshot : undefined;
  const pending = rows.some((row) => row.status === 'pending');

  return {
    chain: preview
      ? {
          id: preview.chainId,
          name: preview.name,
          steps: preview.steps.map((step) => ({ name: step.name, applies: step.applies, conditionText: step.conditionText })),
        }
      : undefined,
    canSubmit: Boolean(chain) && !pending && input.canEdit,
    submitBlocked: !chain
      ? undefined
      : pending
        ? 'It is already waiting for approval.'
        : !input.canEdit
          ? 'Only someone who can edit this work package can submit it.'
          : undefined,
    current: views[0],
    history: views.slice(1),
  };
}

/** Requests waiting on the viewer, as the approver or as a delegate. */
export async function inbox(viewerId: string, mayCancelAny: boolean): Promise<ApprovalRequestView[]> {
  const tasks = await prisma.approvalTask.findMany({
    where: { status: 'pending', OR: [{ approverId: viewerId }, { delegateId: viewerId }] },
    select: { requestId: true },
  });
  const rows = await prisma.approvalRequest.findMany({
    where: { id: { in: [...new Set(tasks.map((task) => task.requestId))] }, status: 'pending' },
    include: { tasks: true },
    orderBy: { requestedAt: 'asc' },
  });
  const views = await toRequestViews(rows, viewerId, mayCancelAny);
  // A task a delegate sees under a delegation that has lapsed is not theirs to decide.
  return views.filter((view) => view.steps.some((step) => step.tasks.some((task) => task.canDecide)));
}

export async function inboxCount(viewerId: string): Promise<number> {
  return (await inbox(viewerId, false)).length;
}

/** Requests the viewer submitted, or in the given projects. */
export async function listRequests(input: {
  viewerId: string;
  mayCancelAny: boolean;
  requestedBy?: string;
  projectIds?: string[];
  status?: string;
}): Promise<ApprovalRequestView[]> {
  const rows = await prisma.approvalRequest.findMany({
    where: {
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      ...(input.projectIds ? { projectId: { in: input.projectIds } } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    include: { tasks: true },
    orderBy: { requestedAt: 'desc' },
    take: 100,
  });
  return toRequestViews(rows, input.viewerId, input.mayCancelAny);
}

export async function requestById(id: string) {
  return prisma.approvalRequest.findUnique({ where: { id }, include: { tasks: true } });
}

/* -------------------------------------------------------------------------- */
/* Guarding the statuses a chain owns                                          */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a manual status change that would go around an approval chain.
 *
 * While a work package is waiting for approval its status is the chain's to
 * move; and the statuses a chain sets — pending, approved, rejected — can only
 * be reached through it. Otherwise "Approved" would be one dropdown away for
 * anybody who can edit the work package.
 */
export async function assertStatusChangeAllowed(input: {
  workPackageId: string;
  projectId: string;
  typeId?: string;
  currentStatusId?: string;
  nextStatusId?: string;
}): Promise<void> {
  if (!input.nextStatusId || input.nextStatusId === input.currentStatusId) return;

  const pending = await prisma.approvalRequest
    .findFirst({ where: { subjectType: 'work_package', subjectId: input.workPackageId, status: 'pending' } })
    .catch(() => null);
  if (pending) {
    throw EpmError.conflict('This is waiting for approval: its status moves when the approval chain decides. Withdraw the request to change it by hand.');
  }

  const chain = pickChain(await activeChains(), { typeId: input.typeId, projectId: input.projectId });
  if (!chain) return;
  const owned = [chain.onSubmitStatusId, chain.onApproveStatusId, chain.onRejectStatusId].filter(Boolean);
  if (owned.includes(input.nextStatusId)) {
    const name = (await runAsSystem(() => getCatalog()).catch(() => undefined))?.statusById.get(input.nextStatusId)?.name;
    throw EpmError.conflict(
      message('{status} is set by the {chain} approval chain. Submit it for approval instead.', {
        status: name ?? message('That status'),
        chain: chain.name,
      }),
    );
  }
}
