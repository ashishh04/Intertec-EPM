import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { addDays, daysBetween, startOfIsoWeek, today as todayIso } from '../lib/dates.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { dateOf, message, msg, type Message } from '../lib/i18n.js';
import { getCatalog } from '../mapping/catalog.js';
import { linkId, linkTitle, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type { TimeSettings, TimesheetPeriodKind } from '../types/epm.js';
import { withAudit } from './audit.js';

/**
 * The rules logged time is held to (Module 10): the timesheet period and its
 * bounds (BR-304), the time logging policies (BR-317), the receipt threshold
 * for expense claims (BR-307) — versioned settings — and the locks submitted
 * and approved timesheets put on their time.
 *
 * OpenProject itself checks only that hours are not negative, that a project
 * is set, that the work package is visible and the activity active. Everything
 * here is EPM's, and is enforced where EPM writes time: `routes/time-entries.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

const CACHE_MS = 30_000;

/**
 * Policies start switched off: switching one on changes what people may log,
 * which is an administrator's decision, not an upgrade's.
 */
export const DEFAULT_TIME_SETTINGS: TimeSettings = {
  version: 0,
  timesheets: {
    period: 'week',
    minimum: { basis: 'available', hours: null },
    maximum: { basis: 'fixed', hours: 60 },
    requireWorkPackage: true,
    reminders: false,
  },
  policies: {
    maxDailyHours: { active: false, hours: 12 },
    backdating: { active: false, days: 14 },
    mandatoryActivity: { active: false },
    closedWorkPackages: { active: false },
  },
  expenses: { receiptThreshold: 100, currency: env.EPM_CURRENCY },
};

const hours = z.number().min(0).max(1000);
const settingsSchema = z.object({
  timesheets: z.object({
    period: z.enum(['week', 'month']),
    minimum: z.object({ basis: z.enum(['available', 'fixed', 'none']), hours: hours.nullable() }),
    maximum: z.object({ basis: z.enum(['fixed', 'none']), hours: hours.nullable() }),
    requireWorkPackage: z.boolean(),
    reminders: z.boolean(),
  }),
  policies: z.object({
    maxDailyHours: z.object({ active: z.boolean(), hours: z.number().min(0.25).max(24) }),
    backdating: z.object({ active: z.boolean(), days: z.number().int().min(0).max(366) }),
    mandatoryActivity: z.object({ active: z.boolean() }),
    closedWorkPackages: z.object({ active: z.boolean() }),
  }),
  expenses: z.object({
    receiptThreshold: z.number().min(0).max(1e9),
    currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  }),
});

let settingsCache: { at: number; value: TimeSettings } | undefined;

export async function getTimeSettings(): Promise<TimeSettings> {
  if (settingsCache && Date.now() - settingsCache.at < CACHE_MS) return settingsCache.value;
  const top = await prisma.timeSettingSet.findFirst({ orderBy: { version: 'desc' } });
  const stored = (top?.settings ?? {}) as Partial<TimeSettings>;
  const value: TimeSettings = top
    ? {
        timesheets: { ...DEFAULT_TIME_SETTINGS.timesheets, ...stored.timesheets },
        policies: { ...DEFAULT_TIME_SETTINGS.policies, ...stored.policies },
        expenses: { ...DEFAULT_TIME_SETTINGS.expenses, ...stored.expenses },
        version: top.version,
        updatedAt: top.createdAt.toISOString(),
        updatedBy: top.createdBy,
      }
    : DEFAULT_TIME_SETTINGS;
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Saves a new version and journals it. */
export async function saveTimeSettings(input: unknown, actorId: string): Promise<TimeSettings> {
  const parsed = settingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The time and expense settings are not complete.', parsed.error.issues);
  const next = parsed.data;
  const { minimum, maximum } = next.timesheets;
  if (minimum.basis === 'fixed' && minimum.hours === null) throw EpmError.validation('Give the fewest hours a timesheet may have.');
  if (maximum.basis === 'fixed' && maximum.hours === null) throw EpmError.validation('Give the most hours a timesheet may have.');
  if (minimum.basis === 'fixed' && maximum.basis === 'fixed' && minimum.hours! > maximum.hours!) {
    throw EpmError.validation('The fewest hours cannot be more than the most.');
  }

  const current = await getTimeSettings();
  const comparable = (value: Omit<TimeSettings, 'version' | 'updatedAt' | 'updatedBy'>) =>
    JSON.stringify({ timesheets: value.timesheets, policies: value.policies, expenses: value.expenses });
  if (comparable(current) === comparable(next)) throw EpmError.conflict('Those are already the settings in force.');

  const saved = await withAudit(
    async (tx) => {
      const top = await tx.timeSettingSet.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      return tx.timeSettingSet.create({
        data: { version: (top?.version ?? 0) + 1, settings: next as unknown as object, createdBy: actorId },
      });
    },
    (row) => ({
      actorId,
      entityType: 'time-settings',
      entityId: String(row.version),
      action: 'time.settings.updated',
      summary: message('Time and expense settings version {version} saved.', { version: row.version }),
      before: { ...current },
      after: { version: row.version, ...next },
    }),
  );
  settingsCache = undefined;
  return { ...next, version: saved.version, updatedAt: saved.createdAt.toISOString(), updatedBy: actorId };
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                    */
/* -------------------------------------------------------------------------- */

/** The period a day falls in: Monday to Sunday, or the calendar month. */
export function periodOf(day: string, kind: TimesheetPeriodKind): { start: string; end: string } {
  if (kind === 'month') {
    const start = `${day.slice(0, 7)}-01`;
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { start, end: addDays(next.toISOString().slice(0, 10), -1) };
  }
  const start = startOfIsoWeek(day);
  return { start, end: addDays(start, 6) };
}

/** Whether a period is over: its last day is before today. */
export const periodClosed = (end: string, today = todayIso()) => end < today;

/* -------------------------------------------------------------------------- */
/* Logged time, read                                                          */
/* -------------------------------------------------------------------------- */

interface OpTimeEntry {
  id: number;
  hours: string;
  spentOn: string;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
}

export interface LoggedEntry {
  id: string;
  hours: number;
  spentOn: string;
  projectId: string;
  projectName: string;
  workPackageId?: string;
  activityId?: string;
}

/** A person's time between two days, read with the service key. */
export async function entriesOf(personId: string, from: string, to: string): Promise<LoggedEntry[]> {
  const collection = await runAsSystem(() =>
    openProject.getAll<OpTimeEntry>('/time_entries', {
      filters: [
        { field: 'user', operator: '=', values: [personId] },
        { field: 'spent_on', operator: '<>d', values: [from, to] },
      ],
      pageSize: 200,
    }),
  ).catch((error: unknown) => {
    // OpenProject's user filter takes only people who belong to some project
    // and answers anyone else with "User filter has invalid values". Such a
    // person has no time anybody can see (an administrator, whom OpenProject
    // never adds to the projects they create, is the usual one), so their
    // timesheet is empty. It was a 502 that left them no timesheet at all.
    if (error instanceof OpenProjectError && error.upstreamStatus === 400 && /user filter has invalid values/i.test(error.message)) {
      return { items: [] as OpTimeEntry[], total: 0, truncated: false };
    }
    throw error;
  });
  return collection.items.map((entry) => ({
    id: String(entry.id),
    hours: durationToHours(entry.hours) ?? 0,
    spentOn: entry.spentOn,
    projectId: linkId(entry._links ?? {}, 'project') ?? '',
    projectName: linkTitle(entry._links ?? {}, 'project') ?? '',
    workPackageId: linkId(entry._links ?? {}, 'workPackage'),
    activityId: linkId(entry._links ?? {}, 'activity'),
  }));
}

/* -------------------------------------------------------------------------- */
/* Locks (BR-304)                                                             */
/* -------------------------------------------------------------------------- */

const dayOf = (value: Date) => value.toISOString().slice(0, 10);

export interface TimesheetLock {
  timesheetId: string;
  personId: string;
  status: 'submitted' | 'approved';
  periodStart: string;
  periodEnd: string;
}

/** The submitted and approved timesheets of these people that cover any day between two days. */
export async function locksIn(personIds: string[], from: string, to: string): Promise<TimesheetLock[]> {
  if (personIds.length === 0) return [];
  const rows = await prisma.timesheet.findMany({
    where: {
      personId: { in: personIds },
      status: { in: ['submitted', 'approved'] },
      periodStart: { lte: new Date(`${to}T00:00:00Z`) },
      periodEnd: { gte: new Date(`${from}T00:00:00Z`) },
    },
    select: { id: true, personId: true, status: true, periodStart: true, periodEnd: true },
  });
  return rows.map((row) => ({
    timesheetId: row.id,
    personId: row.personId,
    status: row.status as TimesheetLock['status'],
    periodStart: dayOf(row.periodStart),
    periodEnd: dayOf(row.periodEnd),
  }));
}

export function lockOn(locks: TimesheetLock[], personId: string, day: string): TimesheetLock | undefined {
  return locks.find((lock) => lock.personId === personId && lock.periodStart <= day && lock.periodEnd >= day);
}

/**
 * Refuses a change to time on a submitted or approved timesheet (BR-304): the
 * person must withdraw it first, or have it reopened once it is approved.
 */
export async function assertUnlocked(personId: string, days: string[]): Promise<void> {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 0) return;
  const locks = await locksIn([personId], sorted[0]!, sorted.at(-1)!);
  for (const day of sorted) {
    const lock = lockOn(locks, personId, day);
    if (!lock) continue;
    throw EpmError.conflict(
      message(
        'This time is on a timesheet for {from} to {to} that has been {status, select, approved {approved} other {submitted}}, so it is locked. {status, select, approved {Ask whoever manages timesheets to reopen it.} other {Withdraw the timesheet to change it.}}',
        { from: dateOf(lock.periodStart), to: dateOf(lock.periodEnd), status: lock.status },
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Policies (BR-317)                                                          */
/* -------------------------------------------------------------------------- */

/** Each policy's name, as an entry that breaks it is told. */
export const POLICY_NAMES = {
  maxDailyHours: msg('Maximum hours in a day'),
  backdating: msg('Back-dating window'),
  mandatoryActivity: msg('Activity required'),
  closedWorkPackages: msg('No time on closed work'),
} as const;

const refused = (policy: keyof typeof POLICY_NAMES, reason: Message) =>
  EpmError.validation(message('Refused by the “{policy}” policy: {reason}', { policy: POLICY_NAMES[policy], reason }));

export interface PolicyCheck {
  personId: string;
  spentOn: string;
  hours: number;
  activityId?: string;
  workPackageId?: string;
  /** An entry being changed: its own hours do not count twice. */
  replacingId?: string;
}

/** Refuses an entry that breaks an active policy, naming the policy (BR-317). */
export async function assertPolicies(entry: PolicyCheck): Promise<void> {
  const { policies } = await getTimeSettings();
  const today = todayIso();

  if (policies.backdating.active && entry.spentOn < today && daysBetween(entry.spentOn, today) > policies.backdating.days) {
    throw refused(
      'backdating',
      message('time can be logged at most {days, plural, =0 {for today} one {# day back} other {# days back}}.', {
        days: policies.backdating.days,
      }),
    );
  }

  if (policies.mandatoryActivity.active && !entry.activityId) {
    throw refused('mandatoryActivity', message('choose the activity this time was spent on.'));
  }

  if (policies.closedWorkPackages.active && entry.workPackageId) {
    const closed = await runAsSystem(async () => {
      const work = await openProject
        .request<{ _links?: Record<string, HalLink | HalLink[] | undefined> }>(`/work_packages/${entry.workPackageId}`)
        .catch(() => null);
      const statusId = work ? linkId(work._links ?? {}, 'status') : undefined;
      return statusId ? (await getCatalog()).statusById.get(statusId)?.isClosed === true : false;
    });
    if (closed) throw refused('closedWorkPackages', message('that work package is closed.'));
  }

  if (policies.maxDailyHours.active) {
    const others = (await entriesOf(entry.personId, entry.spentOn, entry.spentOn)).filter((one) => one.id !== entry.replacingId);
    const total = Math.round((others.reduce((sum, one) => sum + one.hours, 0) + entry.hours) * 100) / 100;
    if (total > policies.maxDailyHours.hours + 1e-9) {
      throw refused(
        'maxDailyHours',
        message('{total, number} hours on {day} would be more than {limit, number}.', {
          total,
          day: dateOf(entry.spentOn),
          limit: policies.maxDailyHours.hours,
        }),
      );
    }
  }
}
