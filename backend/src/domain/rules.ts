import { randomUUID } from 'node:crypto';

import type { AutomationRule as RuleRow, Prisma, RuleEvent, RuleFiring } from '@prisma/client';

import { runAsAutomation, runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { durationToHours, hoursToDuration } from '../lib/duration.js';
import { EpmError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import { endpointProblem, postJson } from '../lib/outbound.js';
import { getCatalog, type Catalog } from '../mapping/catalog.js';
import { listProjects, projectIdentifiers } from '../mapping/projects.js';
import { getUsers } from '../mapping/users.js';
import { linkId, linkTitle, openProject, type OpFilter } from '../openproject/client.js';
import type { HalLink, OpProject } from '../openproject/types.js';
import type {
  AutomationRule,
  AutomationRuleInput,
  PersonSpec,
  RuleAction,
  RuleActionOutcome,
  RuleConditionGroup,
  RuleDryRunItem,
  RuleDryRunResult,
  RuleEventKind,
  RuleFiringView,
  RuleSubjectType,
} from '../types/epm.js';
import { assertStatusChangeAllowed } from './approvals.js';
import { recordAuditQuietly, withAudit } from './audit.js';
import { automationConfigured, automationIdentity, ensureAutomationMembership } from './automation-account.js';
import { healthViews } from './health.js';
import { notifyPeople } from './notifications.js';
import { resolvePeople, type PersonContext } from './people.js';
import { markSelfCaused, unmarkSelfCaused } from './rule-events.js';
import { PERSON_WORDS, renderTemplate, resolveDate, ruleMatches, validateRule, type RuleFacts } from './rule-model.js';
import { customFieldFacts } from './work-package-facts.js';

/**
 * Automation rules (BRQ-10: BR-216, BR-217, BR-219).
 *
 * A rule watches work package or project events, tests the item against its
 * conditions, and when they hold runs its actions. Changes to OpenProject —
 * assigning, moving the status, setting a field, creating a linked work
 * package — are made as EPM's automation account, so OpenProject journals them
 * under that account; EPM's own journal records each firing the same way.
 * Notifications and outbound calls are EPM's own.
 *
 * An `enter` rule fires as an item starts to match and not again until it has
 * stopped matching; an `every` rule fires on every matching event. Rules do
 * not trigger rules: a change a rule makes is not an event for the others,
 * which is what keeps two rules from chasing each other for ever. A rule that
 * fires five times on one item in ten minutes anyway is held back and the
 * firing is logged as skipped.
 */

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60_000;
/** Actions that change OpenProject, and so need the automation account. */
const WRITES = new Set<RuleAction['type']>(['assign', 'set_status', 'set_field', 'create_work_package']);

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

function toRule(row: RuleRow, stats?: { count: number; last?: Date | null }): AutomationRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    active: row.active,
    subjectType: row.subjectType === 'project' ? 'project' : 'work_package',
    events: row.events as RuleEventKind[],
    projectIds: row.projectIds,
    conditions: row.conditions as unknown as RuleConditionGroup,
    fireMode: row.fireMode === 'every' ? 'every' : 'enter',
    actions: row.actions as unknown as RuleAction[],
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    firingCount: stats?.count ?? 0,
    lastFiredAt: stats?.last?.toISOString(),
  };
}

function parse(input: unknown): AutomationRuleInput {
  const result = validateRule(input);
  if (!result.ok) throw EpmError.validation(result.problem);
  for (const action of result.rule.actions) {
    if (action.type !== 'call_endpoint') continue;
    const problem = endpointProblem(action.url);
    if (problem) throw EpmError.validation(problem);
  }
  return result.rule;
}

function toData(rule: AutomationRuleInput) {
  return {
    name: rule.name,
    description: rule.description ?? null,
    active: rule.active,
    subjectType: rule.subjectType,
    events: rule.events,
    projectIds: rule.projectIds,
    conditions: rule.conditions as unknown as Prisma.InputJsonValue,
    fireMode: rule.fireMode,
    actions: rule.actions as unknown as Prisma.InputJsonValue,
  };
}

let cache: { at: number; rules: AutomationRule[] } | undefined;

function forgetRules(): void {
  cache = undefined;
}

async function activeRules(): Promise<AutomationRule[]> {
  if (cache && Date.now() - cache.at < 10_000) return cache.rules;
  const rows = await prisma.automationRule.findMany({ where: { active: true } });
  cache = { at: Date.now(), rules: rows.map((row) => toRule(row)) };
  return cache.rules;
}

export async function listRules(): Promise<AutomationRule[]> {
  const [rows, stats] = await Promise.all([
    prisma.automationRule.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    prisma.ruleFiring.groupBy({ by: ['ruleId'], _count: { _all: true }, _max: { firedAt: true } }),
  ]);
  const byRule = new Map(stats.map((one) => [one.ruleId, { count: one._count._all, last: one._max.firedAt }]));
  return rows.map((row) => toRule(row, byRule.get(row.id)));
}

export async function getRule(id: string): Promise<AutomationRule> {
  const row = await prisma.automationRule.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That rule');
  return toRule(row);
}

export async function createRule(input: unknown, actorId: string): Promise<AutomationRule> {
  const rule = parse(input);
  const row = await withAudit(
    (tx) => tx.automationRule.create({ data: { ...toData(rule), createdBy: actorId } }),
    (created) => ({
      actorId,
      entityType: 'automation-rule',
      entityId: created.id,
      action: 'automation.rule.created',
      summary: `Rule "${created.name}" created${created.active ? '' : ', switched off'}.`,
      after: rule,
    }),
  );
  forgetRules();
  return toRule(row);
}

export async function updateRule(id: string, input: unknown, actorId: string): Promise<AutomationRule> {
  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That rule');
  const rule = parse(input);
  const before = toRule(existing);
  const onlySwitched =
    JSON.stringify({ ...toData(rule), active: true }) === JSON.stringify({ ...toData(before), active: true }) &&
    rule.active !== existing.active;

  const row = await withAudit(
    // A switch on or off is not a new rule; anything else is a new version,
    // which also makes every item's "already matched" state start afresh.
    (tx) =>
      tx.automationRule.update({
        where: { id },
        data: { ...toData(rule), ...(onlySwitched ? {} : { version: { increment: 1 } }) },
      }),
    (updated) => ({
      actorId,
      entityType: 'automation-rule',
      entityId: id,
      action: onlySwitched ? (updated.active ? 'automation.rule.enabled' : 'automation.rule.disabled') : 'automation.rule.updated',
      summary: onlySwitched
        ? `Rule "${updated.name}" switched ${updated.active ? 'on' : 'off'}.`
        : `Rule "${updated.name}" changed (now version ${updated.version}).`,
      before: onlySwitched ? { active: existing.active } : before,
      after: onlySwitched ? { active: updated.active } : rule,
    }),
  );
  forgetRules();
  return toRule(row);
}

export async function deleteRule(id: string, actorId: string): Promise<void> {
  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That rule');
  const fired = await prisma.ruleFiring.count({ where: { ruleId: id } });
  if (fired > 0) {
    throw EpmError.conflict(
      `"${existing.name}" has fired ${fired} ${fired === 1 ? 'time' : 'times'}, and its log is the record of what it did. Switch it off instead.`,
    );
  }
  await withAudit(
    async (tx) => {
      await tx.ruleItemState.deleteMany({ where: { ruleId: id } });
      await tx.automationRule.delete({ where: { id } });
    },
    {
      actorId,
      entityType: 'automation-rule',
      entityId: id,
      action: 'automation.rule.deleted',
      summary: `Rule "${existing.name}" deleted.`,
      before: toRule(existing),
    },
  );
  forgetRules();
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

interface WorkPackageHal {
  id: number;
  subject: string;
  lockVersion: number;
  startDate?: string | null;
  dueDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  estimatedTime?: string | null;
  percentageDone?: number | null;
  storyPoints?: number | null;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
  [field: string]: unknown;
}

/** An item a rule considers, with what its text and its actions need. */
interface Subject {
  type: RuleSubjectType;
  id: string;
  /** `PROJ-12 Fix the export`, or the project's name. */
  title: string;
  projectId: string;
  projectName: string;
  /** Where it opens in EPM. */
  link: string;
  facts: RuleFacts;
  people: PersonContext;
  statusId?: string;
  typeId?: string;
  placeholders: Record<string, string | undefined>;
}

function workPackageSubject(
  wp: WorkPackageHal,
  catalog: Catalog,
  identifiers: Map<string, string>,
  portfolioOf: (projectId: string) => string | undefined,
): Subject {
  const projectId = linkId(wp._links, 'project') ?? '';
  const statusId = linkId(wp._links, 'status');
  const typeId = linkId(wp._links, 'type');
  const identifier = identifiers.get(projectId);
  const key = identifier ? `${identifier.slice(0, 6).toUpperCase()}-${wp.id}` : `WP-${wp.id}`;
  const projectName = linkTitle(wp._links, 'project') ?? '';
  const assigneeId = linkId(wp._links, 'assignee');

  return {
    type: 'work_package',
    id: String(wp.id),
    title: `${key} ${wp.subject}`,
    projectId,
    projectName,
    link: `/tasks/${wp.id}`,
    statusId,
    typeId,
    facts: {
      subjectType: 'work_package',
      id: String(wp.id),
      projectId,
      values: {
        type: typeId,
        status: statusId,
        status_category: statusId && catalog.statusById.get(statusId)?.isClosed ? 'closed' : 'open',
        priority: linkId(wp._links, 'priority'),
        project: projectId,
        portfolio: portfolioOf(projectId),
        version: linkId(wp._links, 'version'),
        assignee: assigneeId,
        responsible: linkId(wp._links, 'responsible'),
        author: linkId(wp._links, 'author'),
        parent: linkId(wp._links, 'parent'),
        subject: wp.subject,
        startDate: wp.startDate ?? undefined,
        dueDate: wp.dueDate ?? undefined,
        createdAt: wp.createdAt,
        updatedAt: wp.updatedAt,
        estimatedHours: durationToHours(wp.estimatedTime),
        percentageDone: wp.percentageDone ?? undefined,
        storyPoints: typeof wp.storyPoints === 'number' ? wp.storyPoints : undefined,
      },
      customFields: customFieldFacts(wp),
    },
    people: {
      projectId,
      assigneeId,
      responsibleId: linkId(wp._links, 'responsible'),
      authorId: linkId(wp._links, 'author'),
    },
    placeholders: {
      key,
      subject: wp.subject,
      project: projectName,
      status: linkTitle(wp._links, 'status'),
      priority: linkTitle(wp._links, 'priority'),
      type: linkTitle(wp._links, 'type'),
      assignee: linkTitle(wp._links, 'assignee') ?? 'nobody',
      dueDate: wp.dueDate ?? 'no due date',
      url: `${env.APP_BASE_URL}/tasks/${wp.id}`,
    },
  };
}

async function loadWorkPackageSubject(id: string): Promise<Subject | null> {
  if (!/^\d+$/.test(id)) return null;
  return runAsSystem(async () => {
    const wp = await openProject.request<WorkPackageHal>(`/work_packages/${id}`).catch((error: unknown) => {
      if (error instanceof EpmError && error.status === 404) return null;
      throw error;
    });
    if (!wp) return null;
    const [catalog, identifiers] = await Promise.all([getCatalog(), projectIdentifiers()]);
    const projectId = linkId(wp._links, 'project') ?? '';
    const profile = await prisma.projectProfile
      .findUnique({ where: { openProjectId: projectId }, select: { portfolioId: true } })
      .catch(() => null);
    return workPackageSubject(wp, catalog, identifiers, () => profile?.portfolioId ?? undefined);
  });
}

const HEALTH_WORDS = { healthy: 'healthy', warning: 'at risk', critical: 'critical' } as const;

async function projectSubjects(projects: OpProject[]): Promise<Subject[]> {
  const ids = projects.map((project) => String(project.id));
  const [profiles, views] = await Promise.all([
    prisma.projectProfile
      .findMany({ where: { openProjectId: { in: ids } }, select: { openProjectId: true, portfolioId: true } })
      .catch(() => []),
    healthViews(projects.map((project) => ({ id: project.id, active: project.active }))).catch(
      () => new Map<string, never>(),
    ),
  ]);
  const portfolio = new Map(profiles.map((profile) => [profile.openProjectId, profile.portfolioId ?? undefined]));

  return projects.map((project) => {
    const id = String(project.id);
    const health = views.get(id)?.effective.overall;
    return {
      type: 'project',
      id,
      title: project.name,
      projectId: id,
      projectName: project.name,
      link: `/projects/${id}`,
      facts: {
        subjectType: 'project',
        id,
        projectId: id,
        values: {
          project: id,
          portfolio: portfolio.get(id),
          name: project.name,
          health,
          status: linkId(project._links, 'status'),
          active: project.active,
        },
        customFields: {},
      },
      people: { projectId: id },
      placeholders: {
        key: project.identifier,
        subject: project.name,
        project: project.name,
        status: linkTitle(project._links, 'status'),
        health: health ? HEALTH_WORDS[health] : 'not assessed',
        url: `${env.APP_BASE_URL}/projects/${id}`,
      },
    } satisfies Subject;
  });
}

async function loadProjectSubject(id: string): Promise<Subject | null> {
  return runAsSystem(async () => {
    const project = (await listProjects()).find((candidate) => String(candidate.id) === id);
    if (!project) return null;
    return (await projectSubjects([project]))[0] ?? null;
  });
}

/* -------------------------------------------------------------------------- */
/* Firing                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Considers one queued event against every active rule that watches it.
 * Throws only when the item could not be read, so the event is retried; a
 * failing rule is logged and the others still run.
 */
export async function processRuleEvent(event: RuleEvent): Promise<void> {
  const subjectType: RuleSubjectType = event.subjectType === 'project' ? 'project' : 'work_package';
  const rules = (await activeRules()).filter(
    (rule) => rule.subjectType === subjectType && rule.events.includes(event.kind as RuleEventKind),
  );
  if (rules.length === 0) return;

  // Rules do not trigger rules.
  const automationId = (await automationIdentity())?.id;
  if (automationId && event.actorId === automationId) return;

  const subject = subjectType === 'project' ? await loadProjectSubject(event.subjectId) : await loadWorkPackageSubject(event.subjectId);
  if (!subject) return;

  const now = new Date();
  for (const rule of rules) {
    if (rule.projectIds.length > 0 && !rule.projectIds.includes(subject.projectId)) continue;
    try {
      const matched = ruleMatches(rule.conditions, subject.facts, now);
      const fires = rule.fireMode === 'every' ? matched : await startsToMatch(rule, subject, matched);
      if (fires) await fireRule(rule, subject, { trigger: event.kind, eventId: event.id });
    } catch (error) {
      appLog.warn({ err: error, ruleId: rule.id, subjectId: subject.id }, 'A rule failed on an event');
    }
  }
}

/**
 * For an `enter` rule: whether this is the item starting to match. Claimed with
 * a conditional update, so two servers considering the same item at once
 * cannot both decide it is.
 */
async function startsToMatch(rule: AutomationRule, subject: Subject, matched: boolean): Promise<boolean> {
  const key = { ruleId: rule.id, subjectType: subject.type, subjectId: subject.id };
  if (!matched) {
    await prisma.ruleItemState.upsert({
      where: { ruleId_subjectType_subjectId: key },
      create: { ...key, matched: false, ruleVersion: rule.version },
      update: { matched: false, ruleVersion: rule.version },
    });
    return false;
  }
  const claimed = await prisma.ruleItemState.updateMany({
    where: { ...key, OR: [{ matched: false }, { ruleVersion: { not: rule.version } }] },
    data: { matched: true, ruleVersion: rule.version },
  });
  if (claimed.count === 1) return true;
  if (await prisma.ruleItemState.findUnique({ where: { ruleId_subjectType_subjectId: key } })) return false;
  return prisma.ruleItemState
    .create({ data: { ...key, matched: true, ruleVersion: rule.version } })
    .then(() => true)
    .catch(() => false);
}

/** After a rule changed an item, whether it still matches — so an `enter` rule fires again only after it stops. */
async function refreshMatch(rule: AutomationRule, subject: Subject): Promise<void> {
  if (rule.fireMode !== 'enter' || subject.type !== 'work_package') return;
  const fresh = await loadWorkPackageSubject(subject.id).catch(() => null);
  if (!fresh) return;
  const matched = ruleMatches(rule.conditions, fresh.facts, new Date());
  await prisma.ruleItemState
    .update({
      where: { ruleId_subjectType_subjectId: { ruleId: rule.id, subjectType: subject.type, subjectId: subject.id } },
      data: { matched, ruleVersion: rule.version },
    })
    .catch(() => undefined);
}

class NotConfigured extends Error {}

interface ActionContext {
  rule: AutomationRule;
  subject: Subject;
  firingId: string;
  index: number;
  automationId?: string;
  placeholders: Record<string, string | undefined>;
  trigger: string;
  names: Names;
}

/** Names for ids, for summaries a person reads. */
interface Names {
  user: (id?: string | null) => string;
  status: (id?: string) => string;
  priority: (id?: string) => string;
  type: (id?: string) => string;
}

async function loadNames(): Promise<Names> {
  const [users, catalog] = await Promise.all([runAsSystem(() => getUsers()).catch(() => []), runAsSystem(() => getCatalog())]);
  const byId = new Map(users.map((user) => [user.id, user.name]));
  return {
    user: (id) => (id ? byId.get(id) ?? `user ${id}` : 'nobody'),
    status: (id) => (id ? catalog.statusById.get(id)?.name ?? `status ${id}` : 'none'),
    priority: (id) => (id ? catalog.priorityById.get(id)?.name ?? `priority ${id}` : 'none'),
    type: (id) => (id ? catalog.typeById.get(id)?.name ?? `type ${id}` : 'work package'),
  };
}

const listNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Writes to a work package as the automation account. The change it is about
 * to make is marked as the rule's own first, so its echo is not an event.
 */
async function writeWorkPackage(context: ActionContext, body: Record<string, unknown>): Promise<void> {
  if (!context.automationId) throw new NotConfigured();
  await ensureAutomationMembership(context.subject.projectId);
  await runAsAutomation(async () => {
    const current = await openProject.request<WorkPackageHal>(`/work_packages/${context.subject.id}`);
    const marker = await markSelfCaused(context.subject.id, current.lockVersion + 1, context.automationId);
    try {
      await openProject.request(`/work_packages/${context.subject.id}`, {
        method: 'PATCH',
        query: { notify: 'false' },
        body: { lockVersion: current.lockVersion, ...body },
      });
    } catch (error) {
      await unmarkSelfCaused(marker);
      throw error;
    }
  });
}

const DATE_LABEL: Record<string, string> = { startDate: 'Start date', dueDate: 'Due date' };

const FIELD_LABEL: Record<string, string> = {
  priority: 'priority',
  dueDate: 'due date',
  startDate: 'start date',
  responsible: 'accountable',
  version: 'version',
  percentageDone: '% complete',
  estimatedHours: 'estimate',
};

/** `customField3` reads as "custom field 3": the rule does not carry the field's name. */
const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field.replace(/^customField(\d+)$/, 'custom field $1');

async function runAction(action: RuleAction, context: ActionContext): Promise<RuleActionOutcome> {
  const { subject, names, placeholders } = context;
  const done = (summary: string): RuleActionOutcome => ({ type: action.type, outcome: 'done', summary });
  const skipped = (summary: string): RuleActionOutcome => ({ type: action.type, outcome: 'skipped', summary });

  switch (action.type) {
    case 'notify': {
      const recipients = await resolvePeople(action.recipients, subject.people);
      if (recipients.length === 0) return skipped('Notified nobody: the people named are not set on this item');
      await notifyPeople({
        recipients,
        category: 'project_update',
        title: renderTemplate(action.title, placeholders).slice(0, 200),
        body: renderTemplate(action.message, placeholders).slice(0, 2000),
        link: subject.link,
        severity: action.severity ?? 'info',
        dedupeKey: `rule:${context.firingId}:${context.index}`,
      });
      return done(`Notified ${listNames(recipients.map(names.user))}`);
    }

    case 'assign': {
      const target = action.to.kind === 'nobody' ? null : (await resolvePeople([action.to as PersonSpec], subject.people))[0];
      if (action.to.kind !== 'nobody' && !target) {
        return skipped(`Assigned nobody: ${PERSON_WORDS[(action.to as PersonSpec).kind]} is not set`);
      }
      if ((subject.people.assigneeId ?? null) === (target ?? null)) {
        return skipped(target ? `Already assigned to ${names.user(target)}` : 'Already unassigned');
      }
      await writeWorkPackage(context, { _links: { assignee: { href: target ? `/api/v3/users/${target}` : null } } });
      // The actions after this one see the item as this one left it: "assign,
      // then notify the assignee" tells the new assignee.
      subject.people.assigneeId = target ?? undefined;
      subject.facts.values.assignee = target ?? undefined;
      placeholders.assignee = target ? names.user(target) : 'nobody';
      if (target) {
        await notifyPeople({
          recipients: [target],
          category: 'assignment',
          title: `Assigned to you: ${subject.title}`,
          body: `By the rule "${context.rule.name}".`,
          link: subject.link,
          severity: 'info',
          dedupeKey: `rule:${context.firingId}:assigned`,
        });
      }
      return done(target ? `Assigned to ${names.user(target)}` : 'Unassigned');
    }

    case 'set_status': {
      if (subject.statusId === action.statusId) return skipped(`Status already ${names.status(action.statusId)}`);
      // The statuses an approval chain owns are reached through it, by rules too.
      await assertStatusChangeAllowed({
        workPackageId: subject.id,
        projectId: subject.projectId,
        typeId: subject.typeId,
        currentStatusId: subject.statusId,
        nextStatusId: action.statusId,
      });
      await writeWorkPackage(context, { _links: { status: { href: `/api/v3/statuses/${action.statusId}` } } });
      subject.statusId = action.statusId;
      subject.facts.values.status = action.statusId;
      placeholders.status = names.status(action.statusId);
      return done(`Status set to ${names.status(action.statusId)}`);
    }

    case 'set_field': {
      const { field, value } = action;
      let body: Record<string, unknown>;
      let shown: string;
      if (field === 'priority') {
        body = { _links: { priority: { href: `/api/v3/priorities/${value}` } } };
        shown = `Priority set to ${names.priority(String(value))}`;
      } else if (field === 'responsible' || field === 'version') {
        const href = value ? `/api/v3/${field === 'responsible' ? 'users' : 'versions'}/${value}` : null;
        body = { _links: { [field]: { href } } };
        shown =
          field === 'responsible'
            ? value
              ? `Accountable set to ${names.user(String(value))}`
              : 'Accountable cleared'
            : value
              ? `Version set to ${value}`
              : 'Version cleared';
      } else if (field === 'startDate' || field === 'dueDate') {
        const date = resolveDate(value, subject.facts, new Date());
        if (date === undefined) return skipped(`${DATE_LABEL[field]} not set: the date it counts from is empty`);
        body = { [field]: date };
        shown = date ? `${DATE_LABEL[field]} set to ${date}` : `${DATE_LABEL[field]} cleared`;
      } else if (field === 'percentageDone') {
        body = { percentageDone: value };
        shown = `% complete set to ${value}`;
      } else if (field === 'estimatedHours') {
        body = { estimatedTime: hoursToDuration(typeof value === 'number' ? value : Number(value)) ?? null };
        shown = `Estimate set to ${value} h`;
      } else {
        body = { [field]: value };
        shown = value === null ? `Cleared ${fieldLabel(field)}` : `Set ${fieldLabel(field)} to ${String(value)}`;
      }
      await writeWorkPackage(context, body);
      if (field === 'priority') {
        subject.facts.values.priority = String(value);
        placeholders.priority = names.priority(String(value));
      } else if (field === 'responsible') {
        subject.people.responsibleId = value ? String(value) : undefined;
        subject.facts.values.responsible = value ? String(value) : undefined;
      } else if (field === 'startDate' || field === 'dueDate') {
        const date = body[field] as string | null;
        subject.facts.values[field] = date ?? undefined;
        if (field === 'dueDate') placeholders.dueDate = date ?? 'no due date';
      } else if (field === 'percentageDone' || field === 'estimatedHours') {
        subject.facts.values[field] = typeof value === 'number' ? value : Number(value);
      }
      return done(shown);
    }

    case 'create_work_package': {
      if (!context.automationId) throw new NotConfigured();
      await ensureAutomationMembership(subject.projectId);
      const assignee = action.assignee ? (await resolvePeople([action.assignee], subject.people))[0] : undefined;
      const due =
        action.dueInDays !== undefined
          ? new Date(Date.now() + action.dueInDays * 86_400_000).toISOString().slice(0, 10)
          : undefined;
      const links: Record<string, { href: string }> = { type: { href: `/api/v3/types/${action.typeId}` } };
      if (assignee) links.assignee = { href: `/api/v3/users/${assignee}` };
      if (action.relation === 'child' && subject.type === 'work_package') {
        links.parent = { href: `/api/v3/work_packages/${subject.id}` };
      }
      const title = renderTemplate(action.subject, placeholders).slice(0, 255) || 'Created by a rule';

      const created = await runAsAutomation(() =>
        openProject.request<WorkPackageHal>(`/projects/${subject.projectId}/work_packages`, {
          method: 'POST',
          query: { notify: 'false' },
          body: {
            subject: title,
            ...(action.description
              ? { description: { format: 'markdown', raw: renderTemplate(action.description, placeholders) } }
              : {}),
            ...(due ? { dueDate: due } : {}),
            _links: links,
          },
        }),
      );
      // Its creation is the rule's own change, not an event for the others.
      await markSelfCaused(String(created.id), created.lockVersion, context.automationId);

      const related = subject.type === 'work_package' && !['none', 'child'].includes(action.relation);
      if (related) {
        await runAsAutomation(() =>
          openProject.request(`/work_packages/${subject.id}/relations`, {
            method: 'POST',
            body: { _links: { to: { href: `/api/v3/work_packages/${created.id}` } }, type: action.relation },
          }),
        );
      }
      const how = action.relation === 'child' ? ' as a child' : related ? ` (${action.relation})` : '';
      return done(`Created ${names.type(action.typeId)} #${created.id} "${title}"${how}${assignee ? `, assigned to ${names.user(assignee)}` : ''}`);
    }

    case 'call_endpoint': {
      const result = await postJson(action.url, {
        event: context.trigger,
        firedAt: new Date().toISOString(),
        rule: { id: context.rule.id, name: context.rule.name, version: context.rule.version },
        subject: {
          type: subject.type,
          id: subject.id,
          title: subject.title,
          project: { id: subject.projectId, name: subject.projectName },
          url: `${env.APP_BASE_URL}${subject.link}`,
          status: placeholders.status,
          priority: placeholders.priority,
          assignee: placeholders.assignee,
          dueDate: subject.facts.values.dueDate ?? undefined,
          health: placeholders.health,
        },
      });
      const where = (() => {
        try {
          const url = new URL(action.url);
          return `${url.host}${url.pathname}`;
        } catch {
          return action.url;
        }
      })();
      if (!result.ok) {
        return { type: action.type, outcome: 'failed', summary: `Called ${where}`, error: result.error ?? 'The call failed.' };
      }
      return done(`Called ${where} (${result.status})`);
    }
  }
}

function outcomeOf(outcomes: RuleActionOutcome[]): RuleFiringView['outcome'] {
  const done = outcomes.filter((one) => one.outcome === 'done').length;
  const failed = outcomes.filter((one) => one.outcome === 'failed').length;
  if (done === outcomes.length) return 'succeeded';
  if (done === 0) return failed > 0 ? 'failed' : 'skipped';
  return 'partial';
}

function toFiring(row: RuleFiring): RuleFiringView {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    ruleVersion: row.ruleVersion,
    trigger: row.trigger,
    subjectType: row.subjectType === 'project' ? 'project' : 'work_package',
    subjectId: row.subjectId,
    subjectTitle: row.subjectTitle ?? undefined,
    projectId: row.projectId ?? undefined,
    outcome: row.outcome as RuleFiringView['outcome'],
    actions: row.actions as unknown as RuleActionOutcome[],
    firedAt: row.firedAt.toISOString(),
    durationMs: row.durationMs ?? undefined,
  };
}

async function fireRule(
  rule: AutomationRule,
  subject: Subject,
  context: { trigger: string; eventId?: string },
): Promise<RuleFiringView> {
  const firingId = randomUUID();
  const started = Date.now();
  const automationId = (await automationIdentity())?.id;

  const recent = await prisma.ruleFiring.count({
    where: {
      ruleId: rule.id,
      subjectType: subject.type,
      subjectId: subject.id,
      outcome: { not: 'skipped' },
      firedAt: { gte: new Date(started - RATE_WINDOW_MS) },
    },
  });

  const outcomes: RuleActionOutcome[] = [];
  let outcome: RuleFiringView['outcome'];
  if (recent >= RATE_LIMIT) {
    // Something is changing this item as fast as the rule acts on it; holding
    // back is safer than joining in. Logged, so the loop can be found.
    outcome = 'skipped';
  } else {
    const names = await loadNames();
    const placeholders = { ...subject.placeholders, rule: rule.name };
    for (const [index, action] of rule.actions.entries()) {
      const actionContext: ActionContext = {
        rule,
        subject,
        firingId,
        index,
        automationId,
        placeholders,
        trigger: context.trigger,
        names,
      };
      outcomes.push(
        await runAction(action, actionContext).catch((error: unknown): RuleActionOutcome => {
          if (error instanceof NotConfigured) {
            return {
              type: action.type,
              outcome: 'skipped',
              summary: 'Not done: no automation account is configured, so rules change nothing in OpenProject',
            };
          }
          return {
            type: action.type,
            outcome: 'failed',
            summary: `${action.type.replace('_', ' ')} failed`,
            error: error instanceof Error ? error.message : String(error),
          };
        }),
      );
    }
    outcome = outcomeOf(outcomes);
    if (outcomes.some((one) => one.outcome === 'done' && WRITES.has(one.type))) await refreshMatch(rule, subject);
  }

  const row = await prisma.ruleFiring.create({
    data: {
      id: firingId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleName: rule.name,
      eventId: context.eventId ?? null,
      trigger: context.trigger,
      subjectType: subject.type,
      subjectId: subject.id,
      subjectTitle: subject.title,
      projectId: subject.projectId || null,
      outcome,
      actions: outcomes as unknown as Prisma.InputJsonValue,
      durationMs: Date.now() - started,
    },
  });

  if (outcome !== 'skipped') {
    await recordAuditQuietly([
      {
        // The firing is the automation account's doing, as its changes are
        // in OpenProject's journal (BR-217).
        actorId: automationId ?? null,
        actorKind: automationId ? 'service' : 'system',
        projectId: subject.projectId || null,
        entityType: subject.type === 'project' ? 'project' : 'work-package',
        entityId: subject.id,
        action: 'automation.rule.fired',
        summary: `Rule "${rule.name}" acted on ${subject.title}: ${outcomes
          .map((one) => (one.outcome === 'failed' ? `${one.summary} (${one.error ?? 'failed'})` : one.summary))
          .join('; ')}.`,
        metadata: { ruleId: rule.id, ruleVersion: rule.version, firingId, outcome, trigger: context.trigger },
      },
    ]);
  }

  return toFiring(row);
}

/* -------------------------------------------------------------------------- */
/* The log and the dry run (BR-219)                                            */
/* -------------------------------------------------------------------------- */

export async function listFirings(query: {
  ruleId?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}): Promise<RuleFiringView[]> {
  const rows = await prisma.ruleFiring.findMany({
    where: {
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
    },
    orderBy: { firedAt: 'desc' },
    take: Math.min(Math.max(query.limit ?? 50, 1), 200),
  });
  return rows.map(toFiring);
}

/** What an action would do to one item, in words — nothing resolved that needs a write. */
function describeAction(action: RuleAction, subject: Subject, names: Names): string {
  const person = (spec: PersonSpec) => {
    if (spec.kind === 'user') return names.user(spec.userId);
    if (spec.kind === 'assignee') return subject.people.assigneeId ? names.user(subject.people.assigneeId) : 'the assignee (nobody)';
    if (spec.kind === 'responsible') return subject.people.responsibleId ? names.user(subject.people.responsibleId) : 'the accountable person (nobody)';
    if (spec.kind === 'author') return subject.people.authorId ? names.user(subject.people.authorId) : 'the author';
    return PERSON_WORDS[spec.kind];
  };
  switch (action.type) {
    case 'notify':
      return `Notify ${listNames(action.recipients.map(person))}: "${renderTemplate(action.title, subject.placeholders)}"`;
    case 'assign':
      return action.to.kind === 'nobody' ? 'Unassign' : `Assign to ${person(action.to as PersonSpec)}`;
    case 'set_status':
      return `Set the status to ${names.status(action.statusId)}`;
    case 'set_field': {
      const { field, value } = action;
      if (value === null) return `Clear the ${fieldLabel(field)}`;
      if (typeof value === 'object') {
        const from = value.from === 'startDate' ? 'its start date' : value.from === 'dueDate' ? 'its due date' : 'today';
        return `Set the ${fieldLabel(field)} to ${value.relativeDays} days from ${from}`;
      }
      const shown = field === 'priority' ? names.priority(String(value)) : field === 'responsible' ? names.user(String(value)) : String(value);
      return `Set the ${fieldLabel(field)} to ${shown}`;
    }
    case 'create_work_package':
      return `Create a ${names.type(action.typeId)} "${renderTemplate(action.subject, subject.placeholders)}"${action.relation === 'none' ? '' : action.relation === 'child' ? ' as a child' : ` (${action.relation})`}`;
    case 'call_endpoint':
      return `Call ${action.url}`;
  }
}

/**
 * What a rule would have done over the last `windowDays` days, with nothing
 * changed (BR-219): the items in its scope changed in that window, tested in
 * their state now, and the actions each would have had. No firing is logged,
 * no state remembered, nothing sent and nothing written.
 */
export async function dryRunRule(input: unknown, windowDays: number): Promise<RuleDryRunResult> {
  const rule = parse(input);
  const days = Math.min(Math.max(Math.round(Number.isFinite(windowDays) ? windowDays : 7), 1), 90);
  const now = new Date();
  const notes: string[] = [];

  const subjects = await runAsSystem(async (): Promise<{ list: Subject[]; truncated: boolean }> => {
    if (rule.subjectType === 'project') {
      const projects = (await listProjects()).filter(
        (project) => project.active && (rule.projectIds.length === 0 || rule.projectIds.includes(String(project.id))),
      );
      notes.push('Projects are tested as they are now; project events are not replayed.');
      return { list: await projectSubjects(projects), truncated: false };
    }

    const onlyCreated = rule.events.length === 1 && rule.events[0] === 'work_package.created';
    const filters: OpFilter[] = [
      { field: onlyCreated ? 'createdAt' : 'updatedAt', operator: '>t-', values: [String(days)] },
    ];
    if (rule.projectIds.length > 0) filters.push({ field: 'project', operator: '=', values: rule.projectIds });
    const { items, truncated } = await openProject.getAll<WorkPackageHal>(
      '/work_packages',
      { filters, pageSize: 200 },
      { maxPages: 10 },
    );
    const [catalog, identifiers, profiles] = await Promise.all([
      getCatalog(),
      projectIdentifiers(),
      prisma.projectProfile.findMany({ select: { openProjectId: true, portfolioId: true } }).catch(() => []),
    ]);
    const portfolio = new Map(profiles.map((profile) => [profile.openProjectId, profile.portfolioId ?? undefined]));
    notes.push(`Work packages ${onlyCreated ? 'created' : 'changed'} in the last ${days} ${days === 1 ? 'day' : 'days'}, tested as they are now.`);
    return {
      list: items.map((wp) => workPackageSubject(wp, catalog, identifiers, (id) => portfolio.get(id))),
      truncated,
    };
  });

  const matched = subjects.list.filter((subject) => ruleMatches(rule.conditions, subject.facts, now));
  if (rule.fireMode === 'enter') notes.push('As written, the rule acts on each item once as it starts to match.');
  if (!automationConfigured() && rule.actions.some((action) => WRITES.has(action.type))) {
    notes.push('No automation account is configured: changes to OpenProject would be skipped.');
  }
  notes.push('Nothing was changed, sent or logged.');

  const names = await loadNames();
  const items: RuleDryRunItem[] = matched.slice(0, 200).map((subject) => ({
    subjectType: subject.type,
    subjectId: subject.id,
    title: subject.title,
    projectId: subject.projectId,
    projectName: subject.projectName,
    actions: rule.actions.map((action) => describeAction(action, subject, names)),
  }));

  return {
    windowDays: days,
    evaluated: subjects.list.length,
    matched: matched.length,
    items,
    truncated: subjects.truncated || matched.length > items.length,
    notes,
  };
}
