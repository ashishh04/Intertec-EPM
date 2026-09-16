import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { enqueueEmail } from '../email/outbox.js';
import { resolveRecipient } from '../email/recipients.js';
import type { DueItem } from '../email/templates/task-due.js';
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
/** The timer ticks hourly; the sweep itself only acts in its configured hour. */
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
  /** The day a sweep last completed, so an hourly tick acts once. */
  let lastSweptDay = '';

  async function tick(force = false): Promise<number> {
    const day = today();

    if (!force) {
      if (new Date().getUTCHours() !== env.EPM_DUE_REMINDER_HOUR_UTC) return 0;
      if (lastSweptDay === day) return 0;
    }

    if (running) {
      log.warn('Due reminder sweep skipped: the previous one is still running');
      return 0;
    }

    running = true;
    const startedAt = Date.now();

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
      for (const [assigneeId, items] of byAssignee) {
        const recipient = await resolveRecipient(assigneeId).catch(() => undefined);
        if (!recipient) continue;

        // Soonest first within each group, which is the order they need doing.
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
          // Once a day per person. A second sweep on the same day is a no-op
          // rather than a second email.
          dedupeKey: `due:${assigneeId}:${day}`,
          gate: 'dueReminders',
        });

        if (outcome === 'queued') queued += 1;
      }

      lastSweptDay = day;
      log.info(
        { day, people: byAssignee.size, queued, ms: Date.now() - startedAt },
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
        { hourUtc: env.EPM_DUE_REMINDER_HOUR_UTC, days: env.EPM_DUE_REMINDER_DAYS },
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
