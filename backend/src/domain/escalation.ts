import { Prisma, type EscalationEvent, type EscalationPolicy as PolicyRow } from '@prisma/client';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import { listProjects, projectIdentifiers } from '../mapping/projects.js';
import { getUsers } from '../mapping/users.js';
import { linkId, linkTitle, openProject, type OpFilter } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type {
  EscalationDryRunResult,
  EscalationLevel,
  EscalationPolicy,
  EscalationPolicyInput,
  EscalationTrigger,
  EscalationView,
  PersonSpec,
} from '../types/epm.js';
import { recordAuditQuietly, withAudit } from './audit.js';
import { notifyPeople, sentences } from './notifications.js';
import { resolvePeople, type PersonContext } from './people.js';
import { personSpecSchema } from './rule-model.js';
import { message, type Message } from '../lib/i18n.js';

/**
 * Escalation policies (BRQ-10: BR-218).
 *
 * A policy names a condition — work untouched for so many days, overdue by so
 * many, or an approval step so many hours past its SLA — and a path of levels:
 * after this long tell these people, after longer tell the next. A scheduled
 * sweep finds the items in that state and raises each to the highest level it
 * has reached, one escalation event per level, journalled and announced.
 *
 * Each stretch of the condition is an episode, named by when it began: work
 * touched again, rescheduled or closed, or an approval decided, ends it — its
 * escalations are resolved — and a later stretch starts at level one. Levels
 * are never raised twice in an episode, however often the sweep runs or on
 * however many servers: the event's key makes a repeat a no-op.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PREVIEW_LIMIT = 100;

/* -------------------------------------------------------------------------- */
/* Policies                                                                    */
/* -------------------------------------------------------------------------- */

const digits = z.string().regex(/^\d+$/, 'An id is digits.');

/** People an approval escalation can mean: an approval has no assignee, author or accountable. */
const APPROVAL_PEOPLE = new Set<PersonSpec['kind']>(['user', 'approvers', 'team_lead', 'department_manager', 'project_owner', 'project_role']);

const policySchema = z
  .object({
    name: z.string().trim().min(1, 'A policy needs a name.').max(120),
    description: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((value) => value || undefined),
    active: z.boolean().default(true),
    trigger: z.enum(['untouched', 'overdue', 'approval_sla']),
    projectIds: z.array(digits).max(500).default([]),
    typeIds: z.array(digits).max(50).default([]),
    priorityIds: z.array(digits).max(20).default([]),
    levels: z
      .array(
        z.object({
          after: z.number().finite(),
          notify: z.array(personSpecSchema).min(1, 'Every level tells someone.').max(10),
        }),
      )
      .min(1, 'A policy needs at least one level.')
      .max(5, 'At most five levels.'),
  })
  .superRefine((policy, context) => {
    const approvals = policy.trigger === 'approval_sla';
    policy.levels.forEach((level, index) => {
      const valid = approvals
        ? level.after >= 0 && level.after <= 24 * 90
        : Number.isInteger(level.after) && level.after >= 1 && level.after <= 365;
      if (!valid) {
        context.addIssue({
          code: 'custom',
          message: `Level ${index + 1}: ${approvals ? 'hours past the SLA, from 0 to 2160' : 'whole days, from 1 to 365'}.`,
        });
      }
      const previous = policy.levels[index - 1];
      if (previous && level.after <= previous.after) {
        context.addIssue({ code: 'custom', message: `Level ${index + 1} has to come later than level ${index}.` });
      }
      for (const person of level.notify) {
        if (approvals ? !APPROVAL_PEOPLE.has(person.kind) : person.kind === 'approvers') {
          context.addIssue({
            code: 'custom',
            message: approvals
              ? 'An approval has no assignee, author or accountable person: name the approvers, their managers, the owner or people.'
              : '"The approvers" applies to approval policies only.',
          });
        }
      }
    });
    if (approvals && (policy.typeIds.length > 0 || policy.priorityIds.length > 0)) {
      context.addIssue({ code: 'custom', message: 'An approval policy is scoped by project only.' });
    }
  });

function parse(input: unknown): EscalationPolicyInput {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) throw EpmError.validation(parsed.error.issues[0]?.message ?? 'That policy is not valid.');
  return parsed.data as EscalationPolicyInput;
}

function toPolicy(row: PolicyRow, openCount = 0): EscalationPolicy {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    active: row.active,
    trigger: row.trigger as EscalationTrigger,
    projectIds: row.projectIds,
    typeIds: row.typeIds,
    priorityIds: row.priorityIds,
    levels: row.levels as unknown as EscalationLevel[],
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    openCount,
  };
}

function toData(policy: EscalationPolicyInput) {
  return {
    name: policy.name,
    description: policy.description ?? null,
    active: policy.active,
    trigger: policy.trigger,
    projectIds: policy.projectIds,
    typeIds: policy.typeIds,
    priorityIds: policy.priorityIds,
    levels: policy.levels as unknown as Prisma.InputJsonValue,
  };
}

export async function listPolicies(): Promise<EscalationPolicy[]> {
  const [rows, open] = await Promise.all([
    prisma.escalationPolicy.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    prisma.escalationEvent.groupBy({ by: ['policyId'], where: { resolvedAt: null, policyId: { not: null } }, _count: { _all: true } }),
  ]);
  const counts = new Map(open.map((one) => [one.policyId, one._count._all]));
  return rows.map((row) => toPolicy(row, counts.get(row.id) ?? 0));
}

export async function createPolicy(input: unknown, actorId: string): Promise<EscalationPolicy> {
  const policy = parse(input);
  const row = await withAudit(
    (tx) => tx.escalationPolicy.create({ data: { ...toData(policy), createdBy: actorId } }),
    (created) => ({
      actorId,
      entityType: 'escalation-policy',
      entityId: created.id,
      action: 'escalation.policy.created',
      summary: `Escalation policy "${created.name}" created.`,
      after: policy,
    }),
  );
  return toPolicy(row);
}

export async function updatePolicy(id: string, input: unknown, actorId: string): Promise<EscalationPolicy> {
  const existing = await prisma.escalationPolicy.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That escalation policy');
  const policy = parse(input);
  const row = await withAudit(
    (tx) => tx.escalationPolicy.update({ where: { id }, data: { ...toData(policy), version: { increment: 1 } } }),
    (updated) => ({
      actorId,
      entityType: 'escalation-policy',
      entityId: id,
      action: 'escalation.policy.updated',
      summary: `Escalation policy "${updated.name}" changed${updated.active === existing.active ? '' : updated.active ? ' and switched on' : ' and switched off'}.`,
      before: toPolicy(existing),
      after: policy,
    }),
  );
  return toPolicy(row);
}

export async function deletePolicy(id: string, actorId: string): Promise<void> {
  const existing = await prisma.escalationPolicy.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That escalation policy');
  const raised = await prisma.escalationEvent.count({ where: { policyId: id } });
  if (raised > 0) {
    throw EpmError.conflict(
      message('"{name}" has raised {count, plural, one {# escalation} other {# escalations}}, which are on record. Switch it off instead.', {
        name: existing.name,
        count: raised,
      }),
    );
  }
  await withAudit((tx) => tx.escalationPolicy.delete({ where: { id } }), {
    actorId,
    entityType: 'escalation-policy',
    entityId: id,
    action: 'escalation.policy.deleted',
    summary: `Escalation policy "${existing.name}" deleted.`,
    before: toPolicy(existing),
  });
}

/* -------------------------------------------------------------------------- */
/* What is escalating                                                          */
/* -------------------------------------------------------------------------- */

/** How many of the levels `elapsed` has reached: 0 when none. Levels are in order. */
export function levelFor(levels: EscalationLevel[], elapsed: number): number {
  let reached = 0;
  for (const level of levels) {
    if (elapsed >= level.after) reached += 1;
    else break;
  }
  return reached;
}

interface Candidate {
  subjectType: 'work_package' | 'approval-request';
  subjectId: string;
  title: string;
  link: string;
  projectId: string;
  projectName?: string;
  /** One stretch of the condition, named by when it began. */
  episode: string;
  since: Date;
  /** Days for work, hours for approvals. */
  elapsed: number;
  people: PersonContext;
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

interface WorkPackageHal {
  id: number;
  subject: string;
  updatedAt: string;
  dueDate?: string | null;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
}

async function workCandidates(policy: EscalationPolicy, now: Date): Promise<{ items: Candidate[]; truncated: boolean }> {
  const first = policy.levels[0]!.after;
  const today = dayOf(now);
  // Coarse, by day, on the server, and a day wide: OpenProject reads the
  // end of an open "between" as the start of that day, which would leave out
  // work last touched on the boundary day itself. Exact, below.
  const filters: OpFilter[] = [
    { field: 'status', operator: 'o', values: [] },
    policy.trigger === 'untouched'
      ? { field: 'updatedAt', operator: '<>d', values: ['', addDays(today, -first + 1)] }
      : { field: 'dueDate', operator: '<>d', values: ['', addDays(today, -first + 1)] },
  ];
  if (policy.projectIds.length > 0) filters.push({ field: 'project', operator: '=', values: policy.projectIds });
  if (policy.typeIds.length > 0) filters.push({ field: 'type', operator: '=', values: policy.typeIds });
  if (policy.priorityIds.length > 0) filters.push({ field: 'priority', operator: '=', values: policy.priorityIds });

  return runAsSystem(async () => {
    const [{ items, truncated }, identifiers] = await Promise.all([
      openProject.getAll<WorkPackageHal>('/work_packages', { filters, pageSize: 200 }, { maxPages: 10 }),
      projectIdentifiers(),
    ]);
    const candidates: Candidate[] = [];
    for (const wp of items) {
      const projectId = linkId(wp._links, 'project') ?? '';
      const identifier = identifiers.get(projectId);
      const key = identifier ? `${identifier.slice(0, 6).toUpperCase()}-${wp.id}` : `WP-${wp.id}`;
      let since: Date;
      let elapsed: number;
      let episode: string;
      if (policy.trigger === 'untouched') {
        since = new Date(wp.updatedAt);
        elapsed = (now.getTime() - since.getTime()) / DAY_MS;
        episode = `updated:${wp.updatedAt}`;
      } else {
        if (!wp.dueDate) continue;
        since = new Date(`${wp.dueDate}T00:00:00Z`);
        elapsed = Math.round((Date.parse(`${today}T00:00:00Z`) - since.getTime()) / DAY_MS);
        episode = `due:${wp.dueDate}`;
      }
      if (elapsed < first) continue;
      candidates.push({
        subjectType: 'work_package',
        subjectId: String(wp.id),
        title: `${key} ${wp.subject}`,
        link: `/tasks/${wp.id}`,
        projectId,
        projectName: linkTitle(wp._links, 'project'),
        episode,
        since,
        elapsed,
        people: {
          projectId,
          assigneeId: linkId(wp._links, 'assignee'),
          responsibleId: linkId(wp._links, 'responsible'),
          authorId: linkId(wp._links, 'author'),
        },
      });
    }
    return { items: candidates, truncated };
  });
}

async function approvalCandidates(policy: EscalationPolicy, now: Date): Promise<{ items: Candidate[]; truncated: boolean }> {
  const cutoff = new Date(now.getTime() - policy.levels[0]!.after * HOUR_MS);
  const tasks = await prisma.approvalTask.findMany({
    where: {
      status: 'pending',
      dueAt: { not: null, lte: cutoff },
      request: { status: 'pending', ...(policy.projectIds.length > 0 ? { projectId: { in: policy.projectIds } } : {}) },
    },
    include: { request: { select: { id: true, title: true, subjectId: true, projectId: true } } },
  });

  const steps = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const key = `${task.requestId}:${task.stepIndex}`;
    steps.set(key, [...(steps.get(key) ?? []), task]);
  }
  const items: Candidate[] = [];
  for (const group of steps.values()) {
    const first = group[0]!;
    const since = new Date(Math.min(...group.map((task) => task.dueAt!.getTime())));
    items.push({
      subjectType: 'approval-request',
      subjectId: first.requestId,
      title: first.request.title,
      link: `/tasks/${first.request.subjectId}`,
      projectId: first.request.projectId,
      episode: `step${first.stepIndex}:${since.toISOString()}`,
      since,
      elapsed: (now.getTime() - since.getTime()) / HOUR_MS,
      people: {
        projectId: first.request.projectId,
        approverIds: [...new Set(group.flatMap((task) => [task.approverId, ...(task.delegateId ? [task.delegateId] : [])]))],
      },
    });
  }
  return { items, truncated: false };
}

function candidatesFor(policy: EscalationPolicy, now: Date) {
  return policy.trigger === 'approval_sla' ? approvalCandidates(policy, now) : workCandidates(policy, now);
}

const keyOf = (subjectType: string, subjectId: string, episode: string | null) => `${subjectType}:${subjectId}:${episode ?? ''}`;

function phrase(trigger: EscalationTrigger, elapsed: number): string {
  if (trigger === 'approval_sla') {
    const hours = Math.floor(elapsed);
    return `waiting ${hours} ${hours === 1 ? 'hour' : 'hours'} past its approval SLA`;
  }
  const days = Math.floor(elapsed);
  return trigger === 'untouched' ? `untouched for ${days} ${days === 1 ? 'day' : 'days'}` : `overdue by ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The same reason as a message, for the people told, who read it in their own
 * language; the event and the journal keep the English above.
 */
function reasonMessage(trigger: EscalationTrigger, title: string, elapsed: number): Message {
  if (trigger === 'approval_sla') {
    return message('{title} has been waiting {hours, plural, one {# hour} other {# hours}} past its approval SLA.', {
      title,
      hours: Math.floor(elapsed),
    });
  }
  const days = Math.floor(elapsed);
  return trigger === 'untouched'
    ? message('{title} has been untouched for {days, plural, one {# day} other {# days}}.', { title, days })
    : message('{title} has been overdue by {days, plural, one {# day} other {# days}}.', { title, days });
}

/** The people a level tells — the project owner when nobody it names is set. */
async function recipientsFor(level: EscalationLevel, people: PersonContext): Promise<{ ids: string[]; fellBack: boolean }> {
  const ids = await resolvePeople(level.notify, people);
  if (ids.length > 0) return { ids, fellBack: false };
  return { ids: await resolvePeople([{ kind: 'project_owner' }], people), fellBack: true };
}

async function raise(policy: EscalationPolicy, candidate: Candidate, level: number, now: Date): Promise<boolean> {
  const definition = policy.levels[level - 1]!;
  const { ids, fellBack } = await recipientsFor(definition, candidate.people);
  const reason = `${candidate.title} has been ${phrase(policy.trigger, candidate.elapsed)}.`;
  const dedupeKey = `policy:${policy.id}:${candidate.subjectType}:${candidate.subjectId}:${candidate.episode}:L${level}`;

  let event: EscalationEvent;
  try {
    event = await prisma.escalationEvent.create({
      data: {
        source: `policy.${policy.trigger}`,
        policyId: policy.id,
        episode: candidate.episode,
        subjectType: candidate.subjectType,
        subjectId: candidate.subjectId,
        projectId: candidate.projectId || null,
        level,
        raisedFor: ids,
        reason,
        dedupeKey,
        raisedAt: now,
        metadata: {
          policyVersion: policy.version,
          title: candidate.title,
          link: candidate.link,
          since: candidate.since.toISOString(),
          elapsed: candidate.elapsed,
          fellBack,
        },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }

  const names = new Map((await runAsSystem(() => getUsers()).catch(() => [])).map((user) => [user.id, user.name]));
  const who = ids.map((id) => names.get(id) ?? `user ${id}`).join(', ') || 'nobody (the project has no owner)';
  await recordAuditQuietly([
    {
      actorId: null,
      projectId: candidate.projectId || null,
      entityType: candidate.subjectType === 'work_package' ? 'work-package' : 'approval-request',
      entityId: candidate.subjectId,
      action: 'escalation.raised',
      summary: `Escalated to level ${level} of "${policy.name}", to ${who}: ${reason}`,
      metadata: { policyId: policy.id, eventId: event.id, level },
    },
  ]);
  await notifyPeople({
    recipients: ids,
    category: 'deadline',
    title: message('Escalated, level {level, number}: {title}', { level, title: candidate.title }),
    body: sentences(
      reasonMessage(policy.trigger, candidate.title, candidate.elapsed),
      fellBack ? message('Nobody this level names is set for it, so the project owner is told.') : undefined,
    ),
    link: candidate.link,
    severity: level >= 2 ? 'critical' : 'warning',
    dedupeKey: `escalation:${event.id}`,
    email: 'immediate',
  }).catch((error: unknown) => appLog.warn({ err: error, eventId: event.id }, 'Could not announce an escalation'));
  return true;
}

let lastSweepAt: Date | undefined;

export function lastEscalationSweep(): string | undefined {
  return lastSweepAt?.toISOString();
}

/**
 * Raises what has reached a new level and resolves what no longer qualifies.
 * `now` is a parameter so the tests can stand a day or two in the future —
 * and `policyIds` so that, standing there, they touch only their own policy.
 */
export async function sweepEscalations(
  now = new Date(),
  options: { policyIds?: string[] } = {},
): Promise<{ raised: number; resolved: number }> {
  const policies = (
    await prisma.escalationPolicy.findMany({
      where: { active: true, ...(options.policyIds ? { id: { in: options.policyIds } } : {}) },
    })
  ).map((row) => toPolicy(row));
  let raised = 0;
  let resolved = 0;

  for (const policy of policies) {
    try {
      const { items, truncated } = await candidatesFor(policy, now);
      const open = await prisma.escalationEvent.findMany({ where: { policyId: policy.id, resolvedAt: null } });
      const highest = new Map<string, number>();
      for (const event of open) {
        const key = keyOf(event.subjectType, event.subjectId, event.episode);
        highest.set(key, Math.max(highest.get(key) ?? 0, event.level));
      }

      const current = new Set<string>();
      for (const candidate of items) {
        const level = levelFor(policy.levels, candidate.elapsed);
        if (level === 0) continue;
        const key = keyOf(candidate.subjectType, candidate.subjectId, candidate.episode);
        current.add(key);
        // The next level only: a sweep that was off for a week does not send
        // levels one, two and three at once, it sends the one reached.
        if (level > (highest.get(key) ?? 0) && (await raise(policy, candidate, level, now))) raised += 1;
      }

      // An incomplete read cannot say what stopped qualifying.
      if (truncated) {
        appLog.warn({ policyId: policy.id }, 'Escalation sweep read an incomplete list; nothing resolved this time');
        continue;
      }
      const ended = open.filter((event) => !current.has(keyOf(event.subjectType, event.subjectId, event.episode)));
      if (ended.length > 0) {
        const done = await prisma.escalationEvent.updateMany({
          where: { id: { in: ended.map((event) => event.id) }, resolvedAt: null },
          data: { resolvedAt: now },
        });
        resolved += done.count;
      }
    } catch (error) {
      appLog.warn({ err: error, policyId: policy.id }, 'An escalation policy could not be evaluated');
    }
  }

  if (!options.policyIds) lastSweepAt = new Date();
  return { raised, resolved };
}

/** What a policy, saved or not, would raise now — with nothing raised, sent or written. */
export async function dryRunPolicy(input: unknown, now = new Date()): Promise<EscalationDryRunResult> {
  const parsed = parse(input);
  const policyId = typeof (input as { id?: unknown })?.id === 'string' ? (input as { id: string }).id : undefined;
  const policy: EscalationPolicy = {
    ...parsed,
    id: policyId ?? 'draft',
    version: 0,
    createdBy: '',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    openCount: 0,
  };
  const { items, truncated } = await candidatesFor(policy, now);
  const open = policyId
    ? await prisma.escalationEvent.findMany({ where: { policyId, resolvedAt: null }, select: { subjectType: true, subjectId: true, episode: true, level: true } })
    : [];
  const highest = new Map<string, number>();
  for (const event of open) {
    const key = keyOf(event.subjectType, event.subjectId, event.episode);
    highest.set(key, Math.max(highest.get(key) ?? 0, event.level));
  }
  const projectNames = new Map(
    (await runAsSystem(() => listProjects()).catch(() => [])).map((project) => [String(project.id), project.name]),
  );

  const preview: EscalationDryRunResult['items'] = [];
  for (const candidate of items) {
    const level = levelFor(policy.levels, candidate.elapsed);
    if (level === 0) continue;
    if (preview.length >= PREVIEW_LIMIT) break;
    const { ids } = await recipientsFor(policy.levels[level - 1]!, candidate.people);
    preview.push({
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      title: candidate.title,
      projectName: candidate.projectName ?? projectNames.get(candidate.projectId),
      level,
      since: candidate.since.toISOString(),
      recipients: ids,
      alreadyRaised: level <= (highest.get(keyOf(candidate.subjectType, candidate.subjectId, candidate.episode)) ?? 0),
    });
  }
  return { evaluated: items.length, items: preview, truncated: truncated || preview.length >= PREVIEW_LIMIT };
}

/** Escalations raised, newest first: by approval SLAs and by policies. */
export async function listEscalations(query: {
  state?: 'open' | 'resolved' | 'all';
  policyId?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}): Promise<EscalationView[]> {
  const rows = await prisma.escalationEvent.findMany({
    where: {
      ...(query.state === 'open' ? { resolvedAt: null } : query.state === 'resolved' ? { resolvedAt: { not: null } } : {}),
      ...(query.policyId ? { policyId: query.policyId } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
    },
    orderBy: { raisedAt: 'desc' },
    take: Math.min(Math.max(query.limit ?? 100, 1), 300),
  });
  if (rows.length === 0) return [];

  const [policies, projects, requests] = await Promise.all([
    prisma.escalationPolicy.findMany({ select: { id: true, name: true } }),
    runAsSystem(() => listProjects()).catch(() => []),
    prisma.approvalRequest.findMany({
      where: { id: { in: rows.filter((row) => row.subjectType === 'approval-request').map((row) => row.subjectId) } },
      select: { id: true, title: true, subjectId: true },
    }),
  ]);
  const policyName = new Map(policies.map((policy) => [policy.id, policy.name]));
  const projectName = new Map(projects.map((project) => [String(project.id), project.name]));
  const request = new Map(requests.map((one) => [one.id, one]));

  return rows.map((row) => {
    const metadata = (row.metadata ?? {}) as { title?: string; link?: string };
    const approval = row.subjectType === 'approval-request' ? request.get(row.subjectId) : undefined;
    return {
      id: row.id,
      source: row.source,
      policyId: row.policyId ?? undefined,
      policyName: row.policyId ? policyName.get(row.policyId) : undefined,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectTitle: metadata.title ?? approval?.title,
      link: metadata.link ?? (approval ? `/tasks/${approval.subjectId}` : row.subjectType === 'work_package' ? `/tasks/${row.subjectId}` : undefined),
      projectId: row.projectId ?? undefined,
      projectName: row.projectId ? projectName.get(row.projectId) : undefined,
      level: row.level,
      raisedFor: row.raisedFor,
      reason: row.reason,
      raisedAt: row.raisedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString(),
    };
  });
}
