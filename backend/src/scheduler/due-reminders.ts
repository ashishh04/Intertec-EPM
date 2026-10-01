import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../email/outbox.js';
import { getPreferences } from '../email/preferences.js';
import { resolveRecipient } from '../email/recipients.js';
import type { DueItem } from '../email/templates/task-due.js';
import { addDays, localDayAndHour, today, weekdayOf } from '../lib/dates.js';
import { linkId, linkTitle, openProject } from '../openproject/client.js';
import type { OpWorkPackage } from '../openproject/types.js';

/**
 * The daily deadline reminder.
 *
 * One sweep for everyone rather than a query per person: the set of work that
 * is late or nearly late is small compared with the number of people who might
 * own some of it, and asking once keeps this to a single upstream read however
 * many staff there are.
 *
 * *When* each person hears about it is theirs, though. The sweep runs hourly and
 * asks, per recipient, whether this is the hour they chose, in their timezone, on
 * a weekday they chose. A single server-wide hour cannot be right for a
 * workforce spread across zones: 07:00 UTC is a reasonable prompt in London and
 * the middle of the night in Sydney. `EPM_DUE_REMINDER_HOUR_UTC` stays the
 * default for anyone who has not chosen, and is then read in their zone — so it
 * still means a sensible local morning rather than one fixed instant.
 *
 * Like the analytics scheduler, it runs **outside any request**, which is how
 * it authenticates — the OpenProject client falls back to the configured
 * service key when there is no caller context. That is what lets it see every
 * assignee's work; each person is then only ever told about their own.
 *
 * Failure is deliberately quiet: a sweep that throws is logged and forgotten,
 * the timer keeps running, and a missed day is a missed reminder rather than a
 * broken service.
 */

/** How long after startup the first sweep may run. */
const FIRST_RUN_DELAY_MS = 60_000;
/** The timer ticks hourly; each recipient is only mailed in their own hour. */
const TICK_MS = 60 * 60_000;

export interface DueReminderScheduler {
  start(): void;
  stop(): void;
  /** Runs one sweep now, ignoring the hour. Exported so a test need not wait. */
  tick(force?: boolean): Promise<number>;
  readonly started: boolean;
}

export interface DueReminderOptions {
  log: FastifyBaseLogger;
  /** Overridable so a test can supply work packages instead of calling upstream. */
  load?: (signal: AbortSignal) => Promise<OpWorkPackage[]>;
  tickMs?: number;
  firstRunDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Open work packages due on or before the horizon.
 *
 * `status: 'o'` is OpenProject's open-status operator, so anything already
 * closed is excluded upstream rather than filtered out here — a reminder about
 * finished work would be worse than no reminder.
 */
async function loadDue(signal: AbortSignal): Promise<OpWorkPackage[]> {
  const horizon = addDays(today(), env.EPM_DUE_REMINDER_DAYS);

  const result = await openProject
    .getAll<OpWorkPackage>(
      '/work_packages',
      {
        filters: [
          { field: 'status', operator: 'o', values: [] },
          { field: 'dueDate', operator: '<>d', values: ['', horizon] },
        ],
        pageSize: 200,
      },
      { signal },
    )
    .catch(() => ({ items: [] as OpWorkPackage[] }));

  return result.items;
}

function keyFor(workPackage: OpWorkPackage): string {
  const identifier = (workPackage as { _embedded?: { project?: { identifier?: string } } })._embedded
    ?.project?.identifier;
  return identifier
    ? `${identifier.slice(0, 6).toUpperCase()}-${workPackage.id}`
    : `WP-${workPackage.id}`;
}

export function createDueReminderScheduler(options: DueReminderOptions): DueReminderScheduler {
  const log = options.log;
  const load = options.load ?? loadDue;
  const tickMs = options.tickMs ?? TICK_MS;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;

  /**
   * Whether anybody at all could be due a reminder.
   *
   * The sweep is hourly now, and its upstream read is the expensive part. This
   * asks the cheap question first — one local query over the stored preference
   * rows — so an instance where everyone has turned deadline email off costs a
   * database round trip each hour instead of walking every open work package.
   *
   * It deliberately does not try to narrow by hour. Zones run from UTC-12 to
   * UTC+14, so during any given hour every possible local hour is the current
   * hour somewhere, and a filter on that would rule out nothing while looking
   * like it did.
   */
  async function anybodyExpectsAReminder(): Promise<boolean> {
    const rows = await prisma.userPreference.findMany({ select: { data: true } }).catch(() => null);

    // Unable to ask: sweep anyway. A missed reminder is worse than a wasted read.
    if (rows === null) return true;

    // Anyone with no row is on the defaults, and the defaults have reminders on.
    // An empty table therefore means everybody wants one. Only an instance where
    // every person has a row and every row opts out is quiet.
    if (rows.length === 0) return true;

    return rows.some((row) => {
      const email = (row.data as { email?: { enabled?: unknown; dueReminders?: unknown } }).email;
      return email?.enabled !== false && email?.dueReminders !== false;
    });
  }

  async function tick(force = false): Promise<number> {
    if (running) {
      log.warn('Due reminder sweep skipped: the previous one is still running');
      return 0;
    }

    if (!force && !(await anybodyExpectsAReminder())) return 0;

    running = true;
    const startedAt = Date.now();
    const day = today();

    try {
      const workPackages = await load(AbortSignal.timeout(timeoutMs));

      // Grouped by assignee: one email per person, however much they own.
      const byAssignee = new Map<string, DueItem[]>();
      for (const workPackage of workPackages) {
        const assigneeId = linkId(workPackage._links, 'assignee');
        const dueDate = (workPackage as { dueDate?: string | null }).dueDate;
        if (!assigneeId || !dueDate) continue;

        const items = byAssignee.get(assigneeId) ?? [];
        items.push({
          taskKey: keyFor(workPackage),
          subject: workPackage.subject ?? `Work package ${workPackage.id}`,
          projectName: linkTitle(workPackage._links, 'project') ?? 'Project',
          dueDate,
          url: `${env.APP_BASE_URL}/tasks/${workPackage.id}`,
        });
        byAssignee.set(assigneeId, items);
      }

      let queued = 0;
      /** Recipients whose reminder hour simply is not now. Logged, not a problem. */
      let waiting = 0;

      for (const [assigneeId, items] of byAssignee) {
        /*
         * The clock check comes first, and cheapest-first within it.
         *
         * Both of these are local reads; `resolveRecipient` below is an upstream
         * HTTP call. Since the sweep now runs every hour, all but one tick in
         * twenty-four ends here for any given person — so doing the expensive
         * lookup before the check would mean twenty-four times the upstream
         * traffic to send exactly the same mail.
         *
         * `force` skips the clock entirely, which is the manual and test path: a
         * sweep can then be exercised without waiting for the right hour.
         */
        const [preferences, zone] = await Promise.all([
          getPreferences(assigneeId).catch(() => undefined),
          timezoneOf(assigneeId),
        ]);
        if (!preferences) continue;

        const local = localDayAndHour(zone);

        if (!force) {
          if (local.hour !== preferences.email.reminderHour) {
            waiting += 1;
            continue;
          }
          if (!preferences.email.reminderDays.includes(weekdayOf(local.day))) continue;
        }

        const recipient = await resolveRecipient(assigneeId).catch(() => undefined);
        if (!recipient) continue;

        // Soonest first within each group, which is the order they need doing.
        // Overdue is judged against the server's day rather than theirs: a due
        // date is a plain calendar day on the work package, so whether it has
        // passed is a fact about the work, not about who is reading.
        const overdue = items.filter((item) => item.dueDate < day).sort(byDueDate);
        const soon = items.filter((item) => item.dueDate >= day).sort(byDueDate);
        if (overdue.length === 0 && soon.length === 0) continue;

        const outcome = await enqueueEmail({
          recipientId: assigneeId,
          template: 'task-due',
          payload: {
            firstName: recipient.firstName,
            overdue,
            soon,
            url: `${env.APP_BASE_URL}/my-work`,
          },
          channel: 'immediate',
          /*
           * Once per person per *local* day.
           *
           * Keyed on the recipient's own date rather than the server's, which is
           * what makes "once a day" mean once a day to them. With a server date,
           * somebody in Auckland would be mailed twice on the UTC day that
           * straddles two of theirs, and skipped on the next.
           */
          dedupeKey: `due:${assigneeId}:${local.day}`,
          gate: 'dueReminders',
        });

        if (outcome === 'queued') queued += 1;
      }

      log.info(
        { day, people: byAssignee.size, queued, waiting, ms: Date.now() - startedAt },
        'Due reminder sweep finished',
      );
      return queued;
    } catch (error) {
      log.error({ err: error }, 'Due reminder sweep failed');
      return 0;
    } finally {
      running = false;
    }
  }

  function byDueDate(a: DueItem, b: DueItem): number {
    return a.dueDate.localeCompare(b.dueDate);
  }

  /**
   * A person's timezone, as EPM knows it.
   *
   * OpenProject holds the authoritative value in `/users/me/preferences`, which
   * only that person can read — so it is useless to a scheduler running as the
   * service. EPM mirrors it into `UserProfile.timezone` whenever somebody saves
   * their profile, and that mirror is what this reads.
   *
   * Unknown falls back to UTC inside `localDayAndHour`, which applies the
   * configured hour as a UTC hour — exactly the old behaviour, and the right
   * answer for somebody who has never told us where they are.
   */
  async function timezoneOf(userId: string): Promise<string | undefined> {
    const profile = await prisma.userProfile
      .findUnique({ where: { openProjectId: userId }, select: { timezone: true } })
      .catch(() => null);
    return profile?.timezone ?? undefined;
  }

  return {
    start() {
      if (started) {
        log.warn('Due reminder scheduler already started');
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), firstRunDelayMs);
      timer = setInterval(() => void tick(), tickMs);
      log.info(
        {
          defaultHour: env.EPM_DUE_REMINDER_HOUR_UTC,
          horizonDays: env.EPM_DUE_REMINDER_DAYS,
          tickMs,
        },
        'Due reminder scheduler started',
      );
    },
    stop() {
      if (firstRun) clearTimeout(firstRun);
      if (timer) clearInterval(timer);
      firstRun = undefined;
      timer = undefined;
      started = false;
    },
    tick,
    get started() {
      return started;
    },
  };
}
