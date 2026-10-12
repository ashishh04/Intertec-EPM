import { randomUUID } from 'node:crypto';

import { Prisma, type TaskSeries as SeriesRow } from '@prisma/client';

import { runAsAutomation, runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import {
  contextConventions,
  contextLanguage,
  dateOf,
  listOf,
  message,
  render,
  renderStored,
  type Message,
} from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { linkId, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type {
  RecurrencePreview,
  RecurrenceRule,
  SeriesGenerationResult,
  TaskSeries,
  TaskSeriesDetail,
  TaskSeriesInstance,
  TaskSeriesInstanceTask,
  TaskSeriesState,
  WorkPackageSeriesLink,
} from '../types/epm.js';
import { readCalendar } from './analytics-extract.js';
import { withAudit, recordAuditQuietly } from './audit.js';
import { automationConfigured, automationIdentity, ensureAutomationMembership } from './automation-account.js';
import { DayCounter, dayOf, type WorkingCalendar } from './critical-path.js';
import { requestHealthRecalc } from './health.js';
import { INSTANCE_ID, withLease } from './job-lease.js';
import { addDays, describeRule, lastOccurrence, nextOccurrences, occurrenceTotal, occurrences, todayOf, validateRule } from './recurrence.js';
import { markSelfCaused } from './rule-events.js';
import { calendarOf, requestScheduleRecalc } from './schedule.js';
import { calculatedCustomFieldKeys, requestCalculatedRecalc } from './calculated-fields.js';

/**
 * Recurring tasks (BRQ-02: BR-105 to BR-107).
 *
 * A series is a template work package and a rule (`recurrence.ts`). For each
 * occurrence, once its lead time has come, EPM makes a work package in
 * OpenProject copied from the template — type, subject with the occurrence's
 * date, description (checklists live there as Markdown task lists, and start
 * unticked), priority, assignee, accountable, category, version, estimate and
 * custom field values — starting on the occurrence and due `durationDays`
 * later, with a `relates` relation back to the template. It is made as EPM's
 * automation account (Module 9's service principal), so OpenProject's journal
 * names that account, and EPM's journal records the run the same way.
 *
 * Generation is idempotent and safe on several servers: each occurrence is
 * claimed by inserting its row first — only while the series is active at the
 * version being worked — then its work package is made and the row filled in.
 * A claim still empty minutes later is a crashed attempt; the next run takes
 * it over and adopts the work package if it was made after all.
 *
 * Lifecycle: pause, resume (occurrences missed while paused are not made) and
 * cancel, which is final — generation stops, and every task already made stays
 * and stays linked. Changing the rule, lead time or duration makes a new
 * version; tasks already made are left as they are.
 */

/** A late occurrence is still made up to this many days after its date. */
const CATCH_UP_DAYS = 7;
/** Tasks one series makes in one run; the rest wait for the next. */
const MAX_PER_SERIES = 50;
/** Tasks one tick makes across every series. */
const MAX_PER_TICK = 200;
/** A claim left empty this long is a crashed attempt. */
const STALE_CLAIM_SECONDS = 5 * 60;
/** Instances a series' view lists, newest first. */
const LISTED_INSTANCES = 200;
/** Occurrences still to come that a view lists. */
const UPCOMING = 5;
/** How long the working calendar is reused for. */
const CALENDAR_TTL_MS = 5 * 60_000;

/** The custom fields Module 5 writes float into: worked out for each task, never copied. */
const SCHEDULE_FIELD_NAMES = new Set(['Total float (days)', 'Free float (days)', 'On critical path']);
/** Links a task copies from its template as they are. */
const COPIED_LINKS = ['type', 'priority', 'assignee', 'responsible', 'category', 'version'] as const;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const latest = (...days: string[]): string => days.reduce((a, b) => (a > b ? a : b));
const ruleOf = (row: Pick<SeriesRow, 'rule'>): RecurrenceRule => row.rule as unknown as RecurrenceRule;
const needsCalendar = (rule: RecurrenceRule) => (rule.nonWorkingDays ?? 'keep') !== 'keep';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** JSON with every object's keys in order: `jsonb` keeps them in its own order, not the writer's. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

/** The subject of the task made for `occurrence`: the template's, with the date. */
export function instanceSubject(subject: string, occurrence: string): string {
  const suffix = ` (${occurrence})`;
  return `${subject.slice(0, 255 - suffix.length)}${suffix}`;
}

/** A checklist starts unticked on every task: `- [x] item` becomes `- [ ] item`. */
export function freshChecklist(markdown: string): string {
  return markdown.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[xX]\]/gm, '$1[ ]');
}

let calendarCache: { at: number; value: Promise<WorkingCalendar> } | undefined;

/** The instance's working calendar, as Module 5 schedules in it. */
export function workingCalendar(): Promise<WorkingCalendar> {
  if (calendarCache && Date.now() - calendarCache.at < CALENDAR_TTL_MS) return calendarCache.value;
  const value = readCalendar().then((row) =>
    calendarOf({ calendar: { workingDays: row.workingWeekdays, nonWorkingDays: row.nonWorkingDays } }),
  );
  calendarCache = { at: Date.now(), value };
  value.catch(() => {
    calendarCache = undefined;
  });
  return value;
}

const calendarFor = (rule: RecurrenceRule) => (needsCalendar(rule) ? workingCalendar() : Promise.resolve(undefined));

/**
 * Who works out custom fields EPM computes itself (Module 4's calculated
 * fields, for one). Each returns `customFieldN` keys a task must not copy from
 * its template: they are computed for it instead.
 */
type FieldKeys = Promise<Iterable<string>>;
type ComputedFieldSource = () => FieldKeys;
const computedFieldSources: ComputedFieldSource[] = [];
export function registerComputedFields(source: ComputedFieldSource): void {
  computedFieldSources.push(source);
}
// Module 4's calculated fields: each task's values come from the next pass.
registerComputedFields(calculatedCustomFieldKeys);

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

interface SeriesDefinition {
  rule: RecurrenceRule;
  leadDays: number;
  durationDays?: number;
}

const wholeDays = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : undefined;

/** A series' definition as sent, checked; refused with the reason in words. */
async function parseDefinition(input: unknown): Promise<SeriesDefinition> {
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const ruleInput = given.rule;
  const policy = (ruleInput as { nonWorkingDays?: unknown } | undefined)?.nonWorkingDays;
  const calendar = policy === 'skip' || policy === 'next' ? await workingCalendar() : undefined;
  const checked = validateRule(ruleInput, calendar);
  if (!checked.ok) throw EpmError.validation(checked.problem);

  const leadDays = given.leadDays === undefined || given.leadDays === null || given.leadDays === '' ? 0 : wholeDays(given.leadDays);
  if (leadDays === undefined || leadDays < 0 || leadDays > 365) {
    throw EpmError.validation(message('Make each task 0 to 365 days ahead of its date.'));
  }
  let durationDays: number | undefined;
  if (given.durationDays !== undefined && given.durationDays !== null && given.durationDays !== '') {
    durationDays = wholeDays(given.durationDays);
    if (durationDays === undefined || durationDays < 0 || durationDays > 365) {
      throw EpmError.validation(message('A task runs 0 to 365 days from its start to its due date.'));
    }
  }
  return { rule: checked.rule, leadDays, durationDays };
}

/* -------------------------------------------------------------------------- */
/* OpenProject                                                                */
/* -------------------------------------------------------------------------- */

interface WorkPackageHal {
  id: number;
  subject: string;
  lockVersion: number;
  startDate?: string | null;
  dueDate?: string | null;
  /** A milestone's one date. */
  date?: string | null;
  description?: { format?: string; raw?: string | null } | null;
  estimatedTime?: string | null;
  ignoreNonWorkingDays?: boolean;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
  [field: string]: unknown;
}

/** The template as the service key reads it; null once it is gone. */
async function readTemplate(id: number): Promise<WorkPackageHal | null> {
  return runAsSystem(() =>
    openProject.request<WorkPackageHal>(`/work_packages/${id}`).catch((error: unknown) => {
      if (error instanceof EpmError && error.status === 404) return null;
      throw error;
    }),
  );
}

const startOf = (wp: WorkPackageHal) => wp.startDate ?? wp.date ?? null;
const dueOf = (wp: WorkPackageHal) => wp.dueDate ?? wp.date ?? null;

/** Days from the template's start to its due date: what each task runs for unless told otherwise. */
function templateDuration(template: WorkPackageHal, milestone: boolean): number {
  const start = startOf(template);
  const due = dueOf(template);
  if (milestone || !start || !due) return 0;
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return Math.min(Math.max(days, 0), 365);
}

async function isMilestone(template: WorkPackageHal): Promise<boolean> {
  const typeId = linkId(template._links, 'type');
  if (!typeId) return false;
  const catalog = await runAsSystem(() => getCatalog());
  return catalog.typeById.get(typeId)?.epm === 'milestone';
}

const fieldCache = new Map<string, { at: number; fields: Promise<Set<string>> }>();

/**
 * The custom fields a task copies: those its project and type hold that can be
 * written, less the ones EPM computes itself.
 */
function copyableFields(projectId: string, typeId: string): Promise<Set<string>> {
  const key = `${projectId}-${typeId}`;
  const cached = fieldCache.get(key);
  if (cached && Date.now() - cached.at < CALENDAR_TTL_MS) return cached.fields;
  const fields = (async () => {
    const schema = await runAsSystem(() =>
      openProject.request<Record<string, { name?: string; writable?: boolean } | unknown>>(`/work_packages/schemas/${key}`),
    );
    const computed = new Set<string>();
    for (const source of computedFieldSources) {
      for (const field of await source().catch(() => [] as string[])) computed.add(field);
    }
    const copyable = new Set<string>();
    for (const [field, spec] of Object.entries(schema)) {
      if (!/^customField\d+$/.test(field) || !spec || typeof spec !== 'object') continue;
      const { name, writable } = spec as { name?: string; writable?: boolean };
      if (writable === false || SCHEDULE_FIELD_NAMES.has(name ?? '') || computed.has(field)) continue;
      copyable.add(field);
    }
    return copyable;
  })();
  fieldCache.set(key, { at: Date.now(), fields });
  fields.catch(() => fieldCache.delete(key));
  return fields;
}

/** What the task for `occurrence` is made with: the template's attributes and the occurrence's dates. */
export function instanceBody(
  template: WorkPackageHal,
  occurrence: string,
  durationDays: number,
  copyable: ReadonlySet<string>,
  milestone: boolean,
  calendar?: WorkingCalendar,
): Record<string, unknown> {
  const links: Record<string, unknown> = {};
  for (const key of COPIED_LINKS) {
    const link = template._links?.[key];
    if (link && !Array.isArray(link) && link.href) links[key] = { href: link.href };
  }
  const body: Record<string, unknown> = {
    subject: instanceSubject(template.subject, occurrence),
    description: { format: 'markdown', raw: freshChecklist(template.description?.raw ?? '') },
  };
  if (template.estimatedTime) body.estimatedTime = template.estimatedTime;
  if (milestone) {
    body.date = occurrence;
  } else {
    body.startDate = occurrence;
    body.dueDate = addDays(occurrence, durationDays);
  }
  // OpenProject moves a date on a day off to the next working day unless the
  // work package ignores non-working days. The series said which day, so a task
  // whose dates fall on one is made to keep them; otherwise it keeps the
  // template's choice.
  const working = calendar ? new DayCounter(calendar, false) : undefined;
  const offDay = (day: string) => Boolean(working && !working.isWorking(dayOf(day)));
  const dates = milestone ? [occurrence] : [occurrence, String(body.dueDate)];
  if (template.ignoreNonWorkingDays || dates.some(offDay)) body.ignoreNonWorkingDays = true;

  // Custom fields: plain values are properties, list, user and version values links.
  for (const [field, value] of Object.entries(template)) {
    if (!copyable.has(field) || value === null || value === undefined) continue;
    body[field] = typeof value === 'object' && 'raw' in (value as object) ? { raw: (value as { raw?: string | null }).raw ?? '' } : value;
  }
  for (const [field, link] of Object.entries(template._links ?? {})) {
    if (!copyable.has(field) || !link) continue;
    const hrefs = (Array.isArray(link) ? link : [link]).map((one) => one.href).filter((href): href is string => Boolean(href));
    if (Array.isArray(link)) links[field] = hrefs.map((href) => ({ href }));
    else if (hrefs[0]) links[field] = { href: hrefs[0] };
  }
  body._links = links;
  return body;
}

/**
 * A task this series' automation account already made for an occurrence:
 * after a crash between making it and recording it, the retry adopts it
 * rather than making a second.
 */
async function findMade(projectId: string, subject: string, occurrence: string, authorId: string): Promise<WorkPackageHal | null> {
  const found = await runAsSystem(() =>
    openProject.getCollection<WorkPackageHal>('/work_packages', {
      filters: [
        { field: 'project', operator: '=', values: [projectId] },
        { field: 'subject', operator: '~', values: [subject] },
        { field: 'createdAt', operator: '>t-', values: ['2'] },
      ],
      pageSize: 50,
    }),
  ).catch(() => null);
  const candidates = (found?._embedded?.elements ?? []).filter(
    (wp) => wp.subject === subject && startOf(wp) === occurrence && linkId(wp._links, 'author') === authorId,
  );
  if (candidates.length === 0) return null;
  // One another occurrence's record already holds is not this one's.
  const taken = new Set(
    (
      await prisma.taskSeriesInstance
        .findMany({ where: { workPackageId: { in: candidates.map((wp) => wp.id) } }, select: { workPackageId: true } })
        .catch(() => [])
    ).map((row) => row.workPackageId),
  );
  return (
    candidates.find(
      (wp) => !taken.has(wp.id),
    ) ?? null
  );
}

/** Relates a task to its template; a clash with a relation being made at the same moment is retried. */
async function relate(instanceId: number, templateId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runAsAutomation(() =>
        openProject.request(`/work_packages/${instanceId}/relations`, {
          method: 'POST',
          body: { _links: { to: { href: `/api/v3/work_packages/${templateId}` } }, type: 'relates' },
        }),
      );
      return true;
    } catch (error) {
      const status = error instanceof EpmError ? error.status : 0;
      if (status === 409 && attempt < 2) {
        await pause(400 * (attempt + 1));
        continue;
      }
      // A retried request whose first attempt landed answers that it exists.
      const existing = await runAsSystem(() =>
        openProject.request<{ _embedded?: { elements?: { _links?: Record<string, HalLink> }[] } }>(`/work_packages/${instanceId}/relations`),
      ).catch(() => null);
      const linked = (existing?._embedded?.elements ?? []).some((relation) =>
        [relation._links?.to?.href, relation._links?.from?.href].includes(`/api/v3/work_packages/${templateId}`),
      );
      if (!linked) appLog.warn({ err: error, instanceId, templateId }, 'A recurring task could not be related to its template');
      return linked;
    }
  }
  return false;
}

const joining = new Map<string, Promise<void>>();

/**
 * The automation account as a member of the project, once however many runs
 * ask at the same moment: one attempt per project in this process, and one
 * retry after a clash with another server's, which then finds the membership.
 */
function ensureMember(projectId: string): Promise<void> {
  let pending = joining.get(projectId);
  if (!pending) {
    pending = ensureAutomationMembership(projectId)
      .catch(async (error: unknown) => {
        await pause(500);
        await ensureAutomationMembership(projectId).catch(() => {
          throw error;
        });
      })
      .finally(() => joining.delete(projectId));
    joining.set(projectId, pending);
  }
  return pending;
}

/* -------------------------------------------------------------------------- */
/* Claims                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Claims an occurrence for this server: a new row, or an empty one a crashed
 * attempt left long enough ago. Only while the series is active at `version`,
 * so a pause, a cancel or a change of rule stops what was about to be made.
 */
async function claim(seriesId: string, version: number, occurrence: string): Promise<{ id: string; takeover: boolean } | null> {
  const id = randomUUID();
  const inserted = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO task_series_instances (id, "seriesId", occurrence, "seriesVersion", "claimedBy", "claimedAt")
    SELECT ${id}, ${seriesId}, ${occurrence}::date, ${version}, ${INSTANCE_ID}, now()
     WHERE EXISTS (SELECT 1 FROM task_series WHERE id = ${seriesId} AND state = 'active' AND version = ${version})
    ON CONFLICT ("seriesId", occurrence) DO NOTHING
    RETURNING id`;
  if (inserted.length === 1) return { id, takeover: false };
  const taken = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE task_series_instances
       SET "claimedBy" = ${INSTANCE_ID}, "claimedAt" = now(), "seriesVersion" = ${version}
     WHERE "seriesId" = ${seriesId} AND occurrence = ${occurrence}::date AND "workPackageId" IS NULL
       AND "claimedAt" < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
       AND EXISTS (SELECT 1 FROM task_series WHERE id = ${seriesId} AND state = 'active' AND version = ${version})
    RETURNING id`;
  return taken.length === 1 ? { id: taken[0]!.id, takeover: true } : null;
}

/** Lets an occurrence go again after a failure, for the next run to retry. */
async function release(claimId: string): Promise<void> {
  await prisma.taskSeriesInstance
    .deleteMany({ where: { id: claimId, workPackageId: null, claimedBy: INSTANCE_ID } })
    .catch((error: unknown) => appLog.warn({ err: error, claimId }, 'A recurring task claim could not be released'));
}

/* -------------------------------------------------------------------------- */
/* Where a series stands                                                      */
/* -------------------------------------------------------------------------- */

/** The first day generation looks at: missed days before it are not made. */
function windowStart(row: Pick<SeriesRow, 'generateFrom' | 'state'>, rule: RecurrenceRule, today: string): string {
  return row.state === 'paused'
    ? latest(today, rule.startDate)
    : latest(iso(row.generateFrom), addDays(today, -CATCH_UP_DAYS), rule.startDate);
}

async function madeSince(seriesId: string, from: string): Promise<Set<string>> {
  const rows = await prisma.taskSeriesInstance.findMany({
    where: { seriesId, occurrence: { gte: asDate(from) }, workPackageId: { not: null } },
    select: { occurrence: true },
  });
  return new Set(rows.map((row) => iso(row.occurrence)));
}

/** The occurrences still to come with no task, soonest first. */
async function upcoming(row: SeriesRow, today: string, limit: number, calendar?: WorkingCalendar): Promise<string[]> {
  if (row.state === 'cancelled') return [];
  const rule = ruleOf(row);
  const from = windowStart(row, rule, today);
  const made = await madeSince(row.id, from);
  return nextOccurrences(rule, from, made.size + limit, calendar)
    .filter((day) => !made.has(day))
    .slice(0, limit);
}

/** Recomputes and stores the next occurrence with no task. */
async function refreshNext(row: SeriesRow, today: string, calendar?: WorkingCalendar): Promise<string | null> {
  const next = (await upcoming(row, today, 1, calendar))[0] ?? null;
  const stored = row.nextOccurrence ? iso(row.nextOccurrence) : null;
  if (next !== stored) {
    await prisma.taskSeries.update({ where: { id: row.id }, data: { nextOccurrence: next ? asDate(next) : null } }).catch(() => undefined);
  }
  return next;
}

/** Records why generation made nothing, once: the same problem again changes nothing. */
async function recordProblem(row: SeriesRow, problem: Message | null): Promise<void> {
  const english = problem ? render('en', problem) : null;
  if (english === row.lastError) return;
  await prisma.taskSeries
    .update({
      where: { id: row.id },
      data: {
        lastError: english,
        lastErrorMessage: problem ? (JSON.parse(JSON.stringify(problem)) as Prisma.InputJsonValue) : Prisma.DbNull,
        lastErrorAt: problem ? new Date() : null,
      },
    })
    .catch(() => undefined);
  if (problem) appLog.warn({ seriesId: row.id, problem: english }, 'A recurring task series made nothing');
}

/* -------------------------------------------------------------------------- */
/* Generation (BR-106)                                                        */
/* -------------------------------------------------------------------------- */

export interface SeriesRun {
  series: string;
  generated: { occurrence: string; workPackageId: number }[];
  failed: number;
  /** Why it made nothing, or stopped part-way. */
  problem?: Message;
}

/** Whether the timer makes tasks on this server. "Generate now" works either way. */
export const generationEnabled = (): boolean => env.EPM_RECURRENCE_ENABLED;

/**
 * Makes the tasks of one series that are due: every occurrence from the
 * window's start to today plus the lead time with no task yet, oldest first,
 * as the automation account. Safe to run anywhere, any number of times at once.
 */
export async function generateSeries(seriesId: string, now = new Date(), budget = MAX_PER_SERIES): Promise<SeriesRun> {
  const outcome: SeriesRun = { series: seriesId, generated: [], failed: 0 };
  const row = await prisma.taskSeries.findUnique({ where: { id: seriesId } });
  if (!row) return outcome;
  if (row.state !== 'active') {
    outcome.problem = row.state === 'paused' ? message('The series is paused, so nothing was made.') : message('The series is cancelled, so nothing was made.');
    return outcome;
  }

  const rule = ruleOf(row);
  const today = todayOf(now);
  // Wanted even by a rule that keeps every day: a task dated on a day off has to say so.
  let calendar: WorkingCalendar | undefined;
  try {
    calendar = await workingCalendar();
  } catch (error) {
    if (needsCalendar(rule)) {
      outcome.problem = message('The working calendar could not be read, so no task was made: {reason}', {
        reason: error instanceof Error ? error.message : String(error),
      });
      await recordProblem(row, outcome.problem);
      return outcome;
    }
  }
  const from = windowStart(row, rule, today);
  const made = await madeSince(row.id, from);
  const due = occurrences(rule, from, addDays(today, row.leadDays), calendar)
    .filter((day) => !made.has(day))
    .slice(0, Math.max(0, Math.min(budget, MAX_PER_SERIES)));
  if (due.length === 0) {
    await refreshNext(row, today, calendar);
    if (row.lastError) await recordProblem(row, null);
    return outcome;
  }

  if (!automationConfigured()) {
    outcome.problem = message('No automation account is configured, so no task was made. Its key is set on the server.');
    await recordProblem(row, outcome.problem);
    await refreshNext(row, today, calendar);
    return outcome;
  }
  const me = await automationIdentity();
  if (!me) {
    outcome.problem = message('The automation account’s key did not work, so no task was made.');
    await recordProblem(row, outcome.problem);
    return outcome;
  }

  const template = await readTemplate(row.templateWorkPackageId);
  if (!template) {
    await cancelForGoodReason(row);
    outcome.problem = message('Its template work package no longer exists, so the series was cancelled.');
    return outcome;
  }
  const projectId = linkId(template._links, 'project') ?? String(row.projectId);
  if (projectId !== String(row.projectId)) {
    // The template moved: the series and its new tasks go with it.
    await prisma.taskSeries.update({ where: { id: row.id }, data: { projectId: Number(projectId) } }).catch(() => undefined);
  }

  try {
    const milestone = await isMilestone(template);
    const typeId = linkId(template._links, 'type') ?? '';
    const copyable = typeId ? await copyableFields(projectId, typeId) : new Set<string>();
    await ensureMember(projectId);

    for (const occurrence of due) {
      const claimed = await claim(row.id, row.version, occurrence);
      if (!claimed) continue;
      try {
        const body = instanceBody(template, occurrence, row.durationDays, copyable, milestone, calendar);
        const adopted = claimed.takeover ? await findMade(projectId, String(body.subject), occurrence, me.id) : null;
        const created =
          adopted ??
          (await runAsAutomation(() =>
            openProject.request<WorkPackageHal>(`/projects/${projectId}/work_packages`, {
              method: 'POST',
              query: { notify: 'false' },
              body,
              // Long enough that a slow instance is not asked twice.
              timeoutMs: 60_000,
            }),
          ));
        // Its creation is the automation's own change, not an event for rules.
        if (!adopted) await markSelfCaused(String(created.id), created.lockVersion, me.id).catch(() => undefined);
        await prisma.taskSeriesInstance.update({ where: { id: claimed.id }, data: { workPackageId: created.id, generatedAt: new Date() } });
        await relate(created.id, row.templateWorkPackageId);
        outcome.generated.push({ occurrence, workPackageId: created.id });
      } catch (error) {
        await release(claimed.id);
        outcome.failed += 1;
        outcome.problem = message('The task for {date} could not be made: {reason}', {
          date: dateOf(occurrence),
          reason: error instanceof Error ? error.message : String(error),
        });
        appLog.warn({ err: error, seriesId: row.id, occurrence }, 'A recurring task could not be made');
        // The rest would most likely fail the same way; the next run tries again.
        break;
      }
    }
  } catch (error) {
    outcome.failed += 1;
    outcome.problem = message('No task could be made: {reason}', { reason: error instanceof Error ? error.message : String(error) });
    appLog.warn({ err: error, seriesId: row.id }, 'A recurring task series could not generate');
  }

  const fresh = await prisma.taskSeries.findUnique({ where: { id: row.id } });
  if (fresh) {
    if (outcome.generated.length > 0) {
      await prisma.taskSeries.update({ where: { id: row.id }, data: { lastGeneratedAt: new Date() } }).catch(() => undefined);
    }
    await recordProblem(fresh, outcome.problem ?? null);
    await refreshNext(fresh, today, calendar);
  }

  if (outcome.generated.length > 0) {
    const days = outcome.generated.map((one) => one.occurrence);
    await recordAuditQuietly([
      {
        // The automation account's doing, as the work packages are in OpenProject's journal (BR-217).
        actorId: me.id,
        actorKind: 'service',
        projectId,
        entityType: 'task_series',
        entityId: row.id,
        action: 'task_series.generated',
        summary: message('{count, plural, one {# task} other {# tasks}} made for the series of "{task}": {dates}.', {
          count: days.length,
          task: template.subject,
          dates: listOf(days.slice(0, 20).map((day) => dateOf(day))),
        }),
        metadata: { version: row.version, workPackageIds: outcome.generated.map((one) => one.workPackageId), occurrences: days },
      },
    ]);
    // New work moves the project's counts and perhaps its forecast finish.
    requestHealthRecalc(projectId);
    requestScheduleRecalc();
    // And gets its calculated values (and its parent's roll-ups) now, not at the next check.
    requestCalculatedRecalc();
  }
  return outcome;
}

/** A series whose template is gone can never make a task again. */
async function cancelForGoodReason(row: SeriesRow): Promise<void> {
  await withAudit(
    (tx) =>
      tx.taskSeries.updateMany({
        where: { id: row.id, state: { not: 'cancelled' } },
        data: { state: 'cancelled', cancelledAt: new Date(), nextOccurrence: null },
      }),
    {
      actorId: null,
      projectId: String(row.projectId),
      entityType: 'task_series',
      entityId: row.id,
      action: 'task_series.cancelled',
      summary: message('A series was cancelled: its template work package no longer exists. The tasks it made stay as they are.'),
      metadata: { templateWorkPackageId: row.templateWorkPackageId },
    },
  ).catch((error: unknown) => appLog.warn({ err: error, seriesId: row.id }, 'A series with no template could not be cancelled'));
}

/**
 * Every active series whose next task is due, as one run — the timer's, behind
 * a lease so one server makes them. Bounded per tick; what is left waits.
 */
export async function generateDueSeries(now = new Date()): Promise<{ series: number; generated: number; failed: number; problems: Message[] }> {
  const today = todayOf(now);
  const rows = await prisma.taskSeries.findMany({
    where: { state: 'active', nextOccurrence: { not: null } },
    select: { id: true, leadDays: true, nextOccurrence: true },
    orderBy: { nextOccurrence: 'asc' },
  });
  const due = rows.filter((row) => today >= addDays(iso(row.nextOccurrence!), -row.leadDays));
  const result = { series: 0, generated: 0, failed: 0, problems: [] as Message[] };
  for (const row of due) {
    const left = MAX_PER_TICK - result.generated;
    if (left <= 0) break;
    const run = await generateSeries(row.id, now, left).catch((error: unknown): SeriesRun => {
      appLog.warn({ err: error, seriesId: row.id }, 'A recurring task series could not generate');
      return { series: row.id, generated: [], failed: 1, problem: message('No task could be made: {reason}', { reason: String(error) }) };
    });
    result.series += 1;
    result.generated += run.generated.length;
    result.failed += run.failed;
    if (run.problem) result.problems.push(run.problem);
  }
  return result;
}

/** The timer's run, behind its lease. */
export function generateDueSeriesLeased(now = new Date()) {
  return withLease('task-series-generation', 15 * 60_000, () => generateDueSeries(now));
}

/** "Generate due tasks now", for every series: what it did, in the reader's words. */
export async function generateAllNow(): Promise<SeriesGenerationResult> {
  const language = contextLanguage();
  const conventions = contextConventions();
  const outcome = await runAsSystem(() => generateDueSeriesLeased());
  if (!outcome.ran) {
    return { ran: false, series: 0, generated: 0, failed: 0, notes: [render(language, message('Another server is making tasks now; try again in a moment.'), conventions)] };
  }
  const { series, generated, failed, problems } = outcome.result;
  return {
    ran: true,
    series,
    generated,
    failed,
    notes: [...new Set(problems.map((problem) => render(language, problem, conventions)))],
  };
}

/** "Generate due tasks now", for one series. */
export async function generateOneNow(seriesId: string): Promise<SeriesGenerationResult> {
  const language = contextLanguage();
  const conventions = contextConventions();
  const run = await runAsSystem(() => generateSeries(seriesId));
  return {
    ran: true,
    series: 1,
    generated: run.generated.length,
    failed: run.failed,
    notes: run.problem ? [render(language, run.problem, conventions)] : [],
  };
}

/** Soon after a series is made, resumed or changed, rather than at the next tick. */
const queued = new Set<string>();
function queueGeneration(seriesId: string): void {
  if (!generationEnabled() || queued.has(seriesId)) return;
  queued.add(seriesId);
  // Out of the request that asked, so its token cannot travel with the timer.
  const timer = runAsSystem(() =>
    setTimeout(() => {
      queued.delete(seriesId);
      void generateSeries(seriesId).catch((error: unknown) =>
        appLog.warn({ err: error, seriesId }, 'A recurring task series could not generate'),
      );
    }, 1_000),
  );
  timer.unref();
}

/* -------------------------------------------------------------------------- */
/* Lifecycle (BR-105, BR-107)                                                 */
/* -------------------------------------------------------------------------- */

async function seriesRow(id: string): Promise<SeriesRow> {
  const row = await prisma.taskSeries.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That series');
  return row;
}

/** The series a work package is the template of, or the one it was made by. */
export async function seriesOfWorkPackage(workPackageId: number): Promise<{ row: SeriesRow; occurrence?: string } | null> {
  const asTemplate = await prisma.taskSeries.findUnique({ where: { templateWorkPackageId: workPackageId } });
  if (asTemplate) return { row: asTemplate };
  const asInstance = await prisma.taskSeriesInstance.findUnique({ where: { workPackageId }, include: { series: true } });
  return asInstance ? { row: asInstance.series, occurrence: iso(asInstance.occurrence) } : null;
}

/**
 * A project deleted with its work takes its series with it: their templates
 * and tasks are gone, and the journal keeps the record of them. For the
 * project deletion route, beside the other overlays it clears.
 */
export async function forgetProjectSeries(projectId: string | number): Promise<number> {
  const { count } = await prisma.taskSeries.deleteMany({ where: { projectId: Number(projectId) } });
  return count;
}

/** For a route: the series and the project its permissions are asked in. */
export async function seriesProject(id: string): Promise<{ row: SeriesRow; projectId: string }> {
  const row = await seriesRow(id);
  return { row, projectId: String(row.projectId) };
}

/** Makes a work package the template of a new series (BR-105). */
export async function createSeries(templateWorkPackageId: string, input: unknown, actorId: string): Promise<SeriesRow> {
  const id = Number(templateWorkPackageId);
  const definition = await parseDefinition(input);
  const existing = await seriesOfWorkPackage(id);
  if (existing && !existing.occurrence) throw EpmError.conflict(message('This task already repeats. Change its series instead.'));
  if (existing) throw EpmError.conflict(message('This task was made by a series, so it cannot be the template of another. Change the series on its template instead.'));

  const template = await readTemplate(id);
  if (!template) throw EpmError.notFound(message('Work package {id}', { id: templateWorkPackageId }));
  const projectId = linkId(template._links, 'project');
  if (!projectId) throw EpmError.notFound(message('Work package {id}', { id: templateWorkPackageId }));
  const milestone = await isMilestone(template);
  const durationDays = milestone ? 0 : (definition.durationDays ?? templateDuration(template, milestone));
  const today = todayOf();

  const row = await withAudit(
    (tx) =>
      tx.taskSeries.create({
        data: {
          templateWorkPackageId: id,
          projectId: Number(projectId),
          rule: definition.rule as unknown as Prisma.InputJsonValue,
          leadDays: definition.leadDays,
          durationDays,
          generateFrom: asDate(today),
          createdBy: actorId,
        },
      }),
    (created) => ({
      actorId,
      projectId,
      entityType: 'task_series',
      entityId: created.id,
      action: 'task_series.created',
      summary: message('"{task}" made recurring: {rule}; each task made {lead, plural, =0 {on its day} one {# day ahead} other {# days ahead}}.', {
        task: template.subject,
        rule: describeRule(definition.rule),
        lead: definition.leadDays,
      }),
      after: { templateWorkPackageId: id, ...definition, durationDays },
    }),
  ).catch((error: unknown) => {
    // Two people making the same task recurring at once: the second is told.
    if ((error as { code?: string }).code === 'P2002') throw EpmError.conflict(message('This task already repeats. Change its series instead.'));
    throw error;
  });

  await refreshNext(row, today, await calendarFor(definition.rule));
  queueGeneration(row.id);
  return seriesRow(row.id);
}

/** A new rule, lead time or duration: a new version; tasks already made stay as they are. */
export async function updateSeries(id: string, input: unknown, actorId: string): Promise<SeriesRow> {
  const row = await seriesRow(id);
  if (row.state === 'cancelled') throw EpmError.conflict(message('This series was cancelled, and a cancelled series cannot be changed.'));
  const definition = await parseDefinition(input);
  const durationDays = definition.durationDays ?? row.durationDays;
  const unchanged =
    canonical(definition.rule) === canonical(ruleOf(row)) && definition.leadDays === row.leadDays && durationDays === row.durationDays;
  if (unchanged) return row;

  const today = todayOf();
  const template = await readTemplate(row.templateWorkPackageId).catch(() => null);
  const updated = await withAudit(
    async (tx) => {
      const changed = await tx.taskSeries.updateMany({
        where: { id, state: { not: 'cancelled' }, version: row.version },
        data: {
          rule: definition.rule as unknown as Prisma.InputJsonValue,
          leadDays: definition.leadDays,
          durationDays,
          version: { increment: 1 },
          generateFrom: asDate(today),
          lastError: null,
          lastErrorMessage: Prisma.DbNull,
          lastErrorAt: null,
        },
      });
      if (changed.count !== 1) throw EpmError.conflict(message('The series changed while you were editing it. Reload it and try again.'));
      return tx.taskSeries.findUniqueOrThrow({ where: { id } });
    },
    (after) => ({
      actorId,
      projectId: String(row.projectId),
      entityType: 'task_series',
      entityId: id,
      action: 'task_series.changed',
      summary: message('The series of "{task}" changed, now version {version}: {rule}.', {
        task: template?.subject ?? `#${row.templateWorkPackageId}`,
        version: after.version,
        rule: describeRule(definition.rule),
      }),
      before: { rule: ruleOf(row), leadDays: row.leadDays, durationDays: row.durationDays, version: row.version },
      after: { rule: definition.rule, leadDays: definition.leadDays, durationDays, version: after.version },
    }),
  );
  await refreshNext(updated, today, await calendarFor(definition.rule));
  if (updated.state === 'active') queueGeneration(id);
  return seriesRow(id);
}

type Move = 'pause' | 'resume' | 'cancel';

/** Pause, resume or cancel (BR-107). Asking for the state it is already in changes nothing. */
export async function changeState(id: string, move: Move, actorId: string): Promise<SeriesRow> {
  const row = await seriesRow(id);
  if (row.state === 'cancelled') {
    throw EpmError.conflict(move === 'cancel' ? message('This series is already cancelled.') : message('This series was cancelled, and a cancelled series cannot be changed.'));
  }
  const target: TaskSeriesState = move === 'pause' ? 'paused' : move === 'resume' ? 'active' : 'cancelled';
  if (row.state === target) return row;

  const today = todayOf();
  const [template, made] = await Promise.all([
    readTemplate(row.templateWorkPackageId).catch(() => null),
    prisma.taskSeriesInstance.count({ where: { seriesId: id, workPackageId: { not: null } } }),
  ]);
  const task = template?.subject ?? `#${row.templateWorkPackageId}`;
  const data: Prisma.TaskSeriesUpdateManyMutationInput =
    move === 'cancel'
      ? { state: 'cancelled', cancelledAt: new Date(), cancelledBy: actorId, nextOccurrence: null }
      : move === 'resume'
        ? { state: 'active', generateFrom: asDate(today) }
        : { state: 'paused' };

  const updated = await withAudit(
    async (tx) => {
      const changed = await tx.taskSeries.updateMany({ where: { id, state: row.state }, data });
      if (changed.count !== 1) throw EpmError.conflict(message('The series changed while you were editing it. Reload it and try again.'));
      return tx.taskSeries.findUniqueOrThrow({ where: { id } });
    },
    {
      actorId,
      projectId: String(row.projectId),
      entityType: 'task_series',
      entityId: id,
      action: move === 'cancel' ? 'task_series.cancelled' : move === 'resume' ? 'task_series.resumed' : 'task_series.paused',
      summary:
        move === 'cancel'
          ? message('The series of "{task}" cancelled. The {count, plural, one {# task} other {# tasks}} it made stay, linked to it.', { task, count: made })
          : move === 'resume'
            ? message('The series of "{task}" resumed. Occurrences missed while it was paused are not made.', { task })
            : message('The series of "{task}" paused.', { task }),
      before: { state: row.state },
      after: { state: target },
    },
  );
  if (target !== 'cancelled') await refreshNext(updated, today, await calendarFor(ruleOf(updated)));
  if (target === 'active') queueGeneration(id);
  return seriesRow(id);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** A series as its reader sees it, the rule in their words. */
function toView(row: SeriesRow, extras: { templateSubject?: string; instanceCount: number }): TaskSeries {
  const rule = ruleOf(row);
  const next = row.state !== 'cancelled' && row.nextOccurrence ? iso(row.nextOccurrence) : null;
  return {
    id: row.id,
    templateWorkPackageId: String(row.templateWorkPackageId),
    templateSubject: extras.templateSubject,
    projectId: String(row.projectId),
    rule,
    ruleText: render(contextLanguage(), describeRule(rule), contextConventions()),
    leadDays: row.leadDays,
    durationDays: row.durationDays,
    state: row.state as TaskSeriesState,
    version: row.version,
    nextOccurrence: next,
    // A lead time that has already come means the task is made at the next run: today.
    nextGenerationOn: next && row.state === 'active' ? latest(addDays(next, -row.leadDays), todayOf()) : null,
    instanceCount: extras.instanceCount,
    lastGeneratedAt: row.lastGeneratedAt?.toISOString(),
    problem: row.lastError && row.state === 'active' ? renderStored(row.lastError, row.lastErrorMessage) : undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cancelledBy: row.cancelledBy ?? undefined,
    cancelledAt: row.cancelledAt?.toISOString(),
  };
}

/** Work packages by id, as the reader may see them; those they may not are left out. */
async function visibleWorkPackages(ids: number[]): Promise<Map<number, WorkPackageHal>> {
  const unique = [...new Set(ids)];
  const found = new Map<number, WorkPackageHal>();
  for (let at = 0; at < unique.length; at += 200) {
    const slice = unique.slice(at, at + 200);
    const page = await openProject
      .getCollection<WorkPackageHal>('/work_packages', {
        filters: [{ field: 'id', operator: '=', values: slice.map(String) }],
        pageSize: slice.length,
      })
      .catch(() => null);
    for (const wp of page?._embedded?.elements ?? []) found.set(wp.id, wp);
  }
  return found;
}

const instanceCounts = async (ids: string[]) =>
  new Map(
    (
      await prisma.taskSeriesInstance.groupBy({
        by: ['seriesId'],
        where: { seriesId: { in: ids }, workPackageId: { not: null } },
        _count: { _all: true },
      })
    ).map((row) => [row.seriesId, row._count._all]),
  );

/** A project's series, active first (BR-107: the series as a set). */
export async function listProjectSeries(projectId: string): Promise<TaskSeries[]> {
  const rows = await prisma.taskSeries.findMany({ where: { projectId: Number(projectId) }, orderBy: [{ createdAt: 'desc' }] });
  const [counts, templates] = await Promise.all([
    instanceCounts(rows.map((row) => row.id)),
    visibleWorkPackages(rows.map((row) => row.templateWorkPackageId)),
  ]);
  const order: Record<string, number> = { active: 0, paused: 1, cancelled: 2 };
  return rows
    .map((row) => toView(row, { templateSubject: templates.get(row.templateWorkPackageId)?.subject, instanceCount: counts.get(row.id) ?? 0 }))
    .sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3));
}

/** One series with its tasks, newest first, and the occurrences still to come. */
export async function seriesDetail(row: SeriesRow, canEdit: boolean): Promise<TaskSeriesDetail> {
  const [instances, count, calendar] = await Promise.all([
    prisma.taskSeriesInstance.findMany({ where: { seriesId: row.id }, orderBy: { occurrence: 'desc' }, take: LISTED_INSTANCES }),
    prisma.taskSeriesInstance.count({ where: { seriesId: row.id, workPackageId: { not: null } } }),
    calendarFor(ruleOf(row)).catch(() => undefined),
  ]);
  const ids = instances.flatMap((one) => (one.workPackageId ? [one.workPackageId] : []));
  const [visible, catalog, identifiers] = await Promise.all([
    visibleWorkPackages([...ids, row.templateWorkPackageId]),
    getCatalog(),
    projectIdentifiers(),
  ]);
  const keyOf = (wp: WorkPackageHal) => {
    const identifier = identifiers.get(linkId(wp._links, 'project') ?? '');
    return identifier ? `${identifier.slice(0, 6).toUpperCase()}-${wp.id}` : `WP-${wp.id}`;
  };
  const taskOf = (wp: WorkPackageHal | undefined): TaskSeriesInstanceTask | undefined => {
    if (!wp) return undefined;
    const statusId = linkId(wp._links, 'status');
    const status = statusId ? catalog.statusById.get(statusId) : undefined;
    return {
      id: String(wp.id),
      key: keyOf(wp),
      subject: wp.subject,
      status: status?.name ?? (wp._links?.status as HalLink | undefined)?.title ?? '',
      closed: status?.isClosed ?? false,
      startDate: startOf(wp) ?? undefined,
      dueDate: dueOf(wp) ?? undefined,
      assigneeId: linkId(wp._links, 'assignee'),
    };
  };
  const listed: TaskSeriesInstance[] = instances.map((one) => ({
    occurrence: iso(one.occurrence),
    workPackageId: one.workPackageId ? String(one.workPackageId) : undefined,
    seriesVersion: one.seriesVersion,
    createdAt: one.generatedAt?.toISOString(),
    task: one.workPackageId ? taskOf(visible.get(one.workPackageId)) : undefined,
  }));
  return {
    ...toView(row, { templateSubject: visible.get(row.templateWorkPackageId)?.subject, instanceCount: count }),
    instances: listed,
    upcoming: await upcoming(row, todayOf(), UPCOMING, calendar).catch(() => []),
    canEdit,
  };
}

/** What a work package is to a series, for its task page. */
export async function workPackageSeriesLink(workPackageId: number, canEdit: boolean): Promise<WorkPackageSeriesLink> {
  const found = await seriesOfWorkPackage(workPackageId);
  if (!found) return { role: 'none' };
  const series = await seriesDetail(found.row, canEdit);
  return found.occurrence ? { role: 'instance', occurrence: found.occurrence, series } : { role: 'template', series };
}

/** A rule's next dates and its words, with nothing saved; a rule that is not valid says why. */
export async function previewRule(input: unknown, limit = 10): Promise<RecurrencePreview> {
  const language = contextLanguage();
  const conventions = contextConventions();
  const policy = (input as { nonWorkingDays?: unknown } | undefined)?.nonWorkingDays;
  const calendar = policy === 'skip' || policy === 'next' ? await workingCalendar() : undefined;
  const checked = validateRule(input, calendar);
  if (!checked.ok) return { dates: [], ruleText: '', total: null, last: null, problem: render(language, checked.problem, conventions) };
  const rule = checked.rule;
  const from = latest(todayOf(), rule.startDate);
  return {
    dates: nextOccurrences(rule, from, Math.min(Math.max(Math.round(limit) || 10, 1), 50), calendar),
    ruleText: render(language, describeRule(rule), conventions),
    total: occurrenceTotal(rule, calendar),
    last: lastOccurrence(rule, calendar),
  };
}
