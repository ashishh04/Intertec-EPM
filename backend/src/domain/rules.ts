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
import { clauses, notifyPeople } from './notifications.js';
import { resolvePeople, type PersonContext } from './people.js';
import { markSelfCaused, unmarkSelfCaused } from './rule-events.js';
import { PERSON_WORDS, renderTemplate, resolveDate, ruleMatches, validateRule, type RuleFacts } from './rule-model.js';
import { customFieldFacts } from './work-package-facts.js';
import { contextLanguage, listOf, message, msg, render, renderStored, translator, type Message } from '../lib/i18n.js';

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
      summary: message('Rule "{name}" created{active, select, no {, switched off} other {}}.', {
        name: created.name,
        active: created.active ? 'yes' : 'no',
      }),
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
        ? message('Rule "{name}" switched {active, select, yes {on} other {off}}.', {
            name: updated.name,
            active: updated.active ? 'yes' : 'no',
          })
        : message('Rule "{name}" changed (now version {version}).', { name: updated.name, version: updated.version }),
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
      message('"{name}" has fired {count, plural, one {# time} other {# times}}, and its log is the record of what it did. Switch it off instead.', {
        name: existing.name,
        count: fired,
      }),
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
      summary: message('Rule "{name}" deleted.', { name: existing.name }),
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

/** A name from the instance, or — for an id it no longer has, or none — a phrase in the reader's language. */
type Name = string | Message;

/** Names for ids, for summaries a person reads. */
interface Names {
  user: (id?: string | null) => Name;
  status: (id?: string) => Name;
  priority: (id?: string) => Name;
  type: (id?: string) => Name;
}

async function loadNames(): Promise<Names> {
  const [users, catalog] = await Promise.all([runAsSystem(() => getUsers()).catch(() => []), runAsSystem(() => getCatalog())]);
  const byId = new Map(users.map((user) => [user.id, user.name]));
  return {
    user: (id) => (id ? byId.get(id) ?? message('user {id}', { id }) : message('nobody')),
    status: (id) => (id ? catalog.statusById.get(id)?.name ?? message('status {id}', { id }) : message('none')),
    priority: (id) => (id ? catalog.priorityById.get(id)?.name ?? message('priority {id}', { id }) : message('none')),
    type: (id) => (id ? catalog.typeById.get(id)?.name ?? message('type {id}', { id }) : message('work package')),
  };
}

/** A name as English text: for a rule's own wording, which is filled in as written. */
const asText = (name: Name): string => (typeof name === 'string' ? name : render('en', name));

/** Names as one message argument — "A, B and C" — joined the way the reader's language joins them. */
const nameList = (names: Name[]) =>
  names.length <= 2 ? listOf(names, 'and') : listOf([listOf(names.slice(0, -1)), names.at(-1)], 'and');

/**
 * What an action did, as a firing keeps it: the summary in English, which is
 * the record, and the message it was written from, so the log reads in each
 * reader's language (BR-605). The message never leaves the server.
 */
interface RecordedOutcome extends RuleActionOutcome {
  summaryMessage: Message;
  errorMessage?: Message;
}

function recordOutcome(
  type: RuleAction['type'],
  outcome: RuleActionOutcome['outcome'],
  summary: Message,
  error?: string | Message,
): RecordedOutcome {
  return {
    type,
    outcome,
    summary: render('en', summary),
    summaryMessage: summary,
    // An error in EPM's own words keeps its message too; anyone else's is data.
    ...(error === undefined ? {} : typeof error === 'string' ? { error } : { error: render('en', error), errorMessage: error }),
  };
}

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

const FIELD_LABEL: Record<string, string> = {
  priority: msg('priority'),
  dueDate: msg('due date'),
  startDate: msg('start date'),
  responsible: msg('accountable'),
  version: msg('version'),
  percentageDone: msg('% complete'),
  estimatedHours: msg('estimate'),
};

/** `customField3` reads as "custom field 3": the rule does not carry the field's name. */
const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field.replace(/^customField(\d+)$/, 'custom field $1');

/**
 * A field a rule sets that has no wording of its own — a custom field — as a
 * message argument. Every other field a rule may set has its own summary.
 */
function fieldName(field: string): Name {
  const custom = /^customField(\d+)$/.exec(field);
  return custom ? message('custom field {number}', { number: custom[1] }) : fieldLabel(field);
}

async function runAction(action: RuleAction, context: ActionContext): Promise<RecordedOutcome> {
  const { subject, names, placeholders } = context;
  const done = (summary: Message) => recordOutcome(action.type, 'done', summary);
  const skipped = (summary: Message) => recordOutcome(action.type, 'skipped', summary);

  switch (action.type) {
    case 'notify': {
      const recipients = await resolvePeople(action.recipients, subject.people);
      if (recipients.length === 0) return skipped(message('Notified nobody: the people named are not set on this item'));
      await notifyPeople({
        recipients,
        category: 'project_update',
        title: renderTemplate(action.title, placeholders).slice(0, 200),
        body: renderTemplate(action.message, placeholders).slice(0, 2000),
        link: subject.link,
        severity: action.severity ?? 'info',
        dedupeKey: `rule:${context.firingId}:${context.index}`,
      });
      return done(message('Notified {people}', { people: nameList(recipients.map((id) => names.user(id))) }));
    }

    case 'assign': {
      const target = action.to.kind === 'nobody' ? null : (await resolvePeople([action.to as PersonSpec], subject.people))[0];
      if (action.to.kind !== 'nobody' && !target) {
        // The words are PERSON_WORDS', so the summary reads as it always has.
        return skipped(
          message(
            "Assigned nobody: {who, select, user {a named person} assignee {the assignee} responsible {the accountable person} author {the author} project_owner {the project owner} team_lead {the assignee's team lead} department_manager {the assignee's department manager} project_role {everyone in a project role} other {the approvers}} is not set",
            { who: (action.to as PersonSpec).kind },
          ),
        );
      }
      if ((subject.people.assigneeId ?? null) === (target ?? null)) {
        return skipped(target ? message('Already assigned to {name}', { name: names.user(target) }) : message('Already unassigned'));
      }
      await writeWorkPackage(context, { _links: { assignee: { href: target ? `/api/v3/users/${target}` : null } } });
      // The actions after this one see the item as this one left it: "assign,
      // then notify the assignee" tells the new assignee.
      subject.people.assigneeId = target ?? undefined;
      subject.facts.values.assignee = target ?? undefined;
      placeholders.assignee = target ? asText(names.user(target)) : 'nobody';
      if (target) {
        await notifyPeople({
          recipients: [target],
          category: 'assignment',
          title: message('Assigned to you: {title}', { title: subject.title }),
          body: message('By the rule "{rule}".', { rule: context.rule.name }),
          link: subject.link,
          severity: 'info',
          dedupeKey: `rule:${context.firingId}:assigned`,
        });
      }
      return done(target ? message('Assigned to {name}', { name: names.user(target) }) : message('Unassigned'));
    }

    case 'set_status': {
      if (subject.statusId === action.statusId) {
        return skipped(message('Status already {status}', { status: names.status(action.statusId) }));
      }
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
      placeholders.status = asText(names.status(action.statusId));
      return done(message('Status set to {status}', { status: names.status(action.statusId) }));
    }

    case 'set_field': {
      const { field, value } = action;
      let body: Record<string, unknown>;
      let shown: Message;
      if (field === 'priority') {
        body = { _links: { priority: { href: `/api/v3/priorities/${value}` } } };
        shown = message('Priority set to {priority}', { priority: names.priority(String(value)) });
      } else if (field === 'responsible' || field === 'version') {
        const href = value ? `/api/v3/${field === 'responsible' ? 'users' : 'versions'}/${value}` : null;
        body = { _links: { [field]: { href } } };
        shown =
          field === 'responsible'
            ? value
              ? message('Accountable set to {name}', { name: names.user(String(value)) })
              : message('Accountable cleared')
            : value
              ? message('Version set to {version}', { version: String(value) })
              : message('Version cleared');
      } else if (field === 'startDate' || field === 'dueDate') {
        const date = resolveDate(value, subject.facts, new Date());
        if (date === undefined) {
          return skipped(
            message('{field, select, startDate {Start date} other {Due date}} not set: the date it counts from is empty', { field }),
          );
        }
        body = { [field]: date };
        // The day as written to the item, YYYY-MM-DD.
        shown = date
          ? message('{field, select, startDate {Start date} other {Due date}} set to {date}', { field, date })
          : message('{field, select, startDate {Start date} other {Due date}} cleared', { field });
      } else if (field === 'percentageDone') {
        body = { percentageDone: value };
        shown = message('% complete set to {value}', { value: String(value) });
      } else if (field === 'estimatedHours') {
        body = { estimatedTime: hoursToDuration(typeof value === 'number' ? value : Number(value)) ?? null };
        shown = message('Estimate set to {value} h', { value: String(value) });
      } else {
        body = { [field]: value };
        shown =
          value === null
            ? message('Cleared {field}', { field: fieldName(field) })
            : message('Set {field} to {value}', { field: fieldName(field), value: String(value) });
      }
      await writeWorkPackage(context, body);
      if (field === 'priority') {
        subject.facts.values.priority = String(value);
        placeholders.priority = asText(names.priority(String(value)));
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
      return done(
        message(
          'Created {type} #{id} "{title}"{how, select, child { as a child} relates { (relates)} blocks { (blocks)} blocked { (blocked)} follows { (follows)} precedes { (precedes)} other {}}{assigned, select, yes {, assigned to {assignee}} other {}}',
          {
            type: names.type(action.typeId),
            id: created.id,
            title,
            how: action.relation === 'child' ? 'child' : related ? action.relation : 'none',
            assigned: assignee ? 'yes' : 'no',
            assignee: assignee ? names.user(assignee) : undefined,
          },
        ),
      );
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
        return recordOutcome(
          action.type,
          'failed',
          message('Called {where}', { where }),
          result.errorMessage ?? result.error ?? msg('The call failed.'),
        );
      }
      return done(message('Called {where} ({status})', { where, status: String(result.status) }));
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

/** A firing as a reader sees it: what each action did, in the language of the request. */
function toFiring(row: RuleFiring): RuleFiringView {
  const stored = (Array.isArray(row.actions) ? row.actions : []) as unknown as (RuleActionOutcome & {
    summaryMessage?: unknown;
    errorMessage?: unknown;
  })[];
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
    // A firing logged before summaries were kept as messages reads as stored.
    actions: stored.map(({ summaryMessage, errorMessage, ...outcome }) => ({
      ...outcome,
      summary: renderStored(outcome.summary, summaryMessage),
      ...(outcome.error === undefined ? {} : { error: renderStored(outcome.error, errorMessage) }),
    })),
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

  const outcomes: RecordedOutcome[] = [];
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
        await runAction(action, actionContext).catch((error: unknown): RecordedOutcome => {
          if (error instanceof NotConfigured) {
            return recordOutcome(
              action.type,
              'skipped',
              message('Not done: no automation account is configured, so rules change no work'),
            );
          }
          // "set status failed" — the action's type with its first underscore a space, as it always read.
          return recordOutcome(
            action.type,
            'failed',
            message(
              '{action, select, notify {notify} assign {assign} set_status {set status} set_field {set field} create_work_package {create work_package} other {call endpoint}} failed',
              { action: action.type },
            ),
            error instanceof Error ? error.message : String(error),
          );
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
        summary: message('Rule "{rule}" acted on {subject}: {actions}.', {
          rule: rule.name,
          subject: subject.title,
          // The error's own words are data, inserted as they came.
          actions: outcomes.length
            ? clauses(
                outcomes.map((one) =>
                  one.outcome === 'failed'
                    ? message('{action} ({error})', { action: one.summaryMessage, error: one.errorMessage ?? one.error ?? message('failed') })
                    : one.summaryMessage,
                ),
              )
            : '',
        }),
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
function describeAction(action: RuleAction, subject: Subject, names: Names): Message {
  const person = (spec: PersonSpec): Name => {
    if (spec.kind === 'user') return names.user(spec.userId);
    if (spec.kind === 'assignee') return subject.people.assigneeId ? names.user(subject.people.assigneeId) : msg('the assignee (nobody)');
    if (spec.kind === 'responsible') {
      return subject.people.responsibleId ? names.user(subject.people.responsibleId) : msg('the accountable person (nobody)');
    }
    if (spec.kind === 'author') return subject.people.authorId ? names.user(subject.people.authorId) : msg('the author');
    return PERSON_WORDS[spec.kind];
  };
  switch (action.type) {
    case 'notify':
      return message('Notify {people}: "{title}"', {
        people: nameList(action.recipients.map(person)),
        title: renderTemplate(action.title, subject.placeholders),
      });
    case 'assign':
      return action.to.kind === 'nobody' ? message('Unassign') : message('Assign to {person}', { person: person(action.to as PersonSpec) });
    case 'set_status':
      return message('Set the status to {status}', { status: names.status(action.statusId) });
    case 'set_field': {
      const { field, value } = action;
      if (value === null) return message('Clear the {field}', { field: fieldName(field) });
      if (typeof value === 'object') {
        return message(
          'Set the {field} to {days} days from {from, select, startDate {its start date} dueDate {its due date} other {today}}',
          { field: fieldName(field), days: value.relativeDays, from: value.from ?? 'today' },
        );
      }
      const shown: Name =
        field === 'priority'
          ? names.priority(String(value))
          : field === 'responsible'
            ? names.user(String(value))
            : String(value);
      return message('Set the {field} to {value}', { field: fieldName(field), value: shown });
    }
    case 'create_work_package':
      return message('Create a {type} "{subject}"{relation, select, none {} child { as a child} other { ({relation})}}', {
        type: names.type(action.typeId),
        subject: renderTemplate(action.subject, subject.placeholders),
        relation: action.relation,
      });
    case 'call_endpoint':
      return message('Call {url}', { url: action.url });
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
  // Written for the person running it, in their language (BR-605).
  const language = contextLanguage();
  const tr = translator(language);
  const notes: string[] = [];

  const subjects = await runAsSystem(async (): Promise<{ list: Subject[]; truncated: boolean }> => {
    if (rule.subjectType === 'project') {
      const projects = (await listProjects()).filter(
        (project) => project.active && (rule.projectIds.length === 0 || rule.projectIds.includes(String(project.id))),
      );
      notes.push(tr('Projects are tested as they are now; project events are not replayed.'));
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
    notes.push(
      tr(
        'Work packages {kind, select, created {created} other {changed}} in the last {days, plural, one {# day} other {# days}}, tested as they are now.',
        { kind: onlyCreated ? 'created' : 'changed', days },
      ),
    );
    return {
      list: items.map((wp) => workPackageSubject(wp, catalog, identifiers, (id) => portfolio.get(id))),
      truncated,
    };
  });

  const matched = subjects.list.filter((subject) => ruleMatches(rule.conditions, subject.facts, now));
  if (rule.fireMode === 'enter') notes.push(tr('As written, the rule acts on each item once as it starts to match.'));
  if (!automationConfigured() && rule.actions.some((action) => WRITES.has(action.type))) {
    notes.push(tr('No automation account is configured: changes to work would be skipped.'));
  }
  notes.push(tr('Nothing was changed, sent or logged.'));

  const names = await loadNames();
  const items: RuleDryRunItem[] = matched.slice(0, 200).map((subject) => ({
    subjectType: subject.type,
    subjectId: subject.id,
    title: subject.title,
    projectId: subject.projectId,
    projectName: subject.projectName,
    actions: rule.actions.map((action) => render(language, describeAction(action, subject, names))),
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
