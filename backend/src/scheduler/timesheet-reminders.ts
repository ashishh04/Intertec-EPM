import type { FastifyBaseLogger } from 'fastify';

import { withLease } from '../domain/job-lease.js';
import { notifyPeople } from '../domain/notifications.js';
import { getTimeSettings, periodOf } from '../domain/time-rules.js';
import { timesheetOverview } from '../domain/timesheets-store.js';
import { addDays, today as todayIso } from '../lib/dates.js';
import { dateOf, message } from '../lib/i18n.js';

/**
 * Reminders for outstanding timesheets (BR-306).
 *
 * Once a period has ended, everyone expected to submit for it who has not —
 * the outstanding list of the timesheet overview — is reminded once, in the
 * app and by email as their preferences say. Only while the time and expense
 * settings have reminders switched on, which they are not until an
 * administrator does so. Checked hourly; one server at a time.
 */

const TICK_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;

/** Reminds whoever is outstanding for the last period that has ended; returns who was reminded. */
export async function sendTimesheetReminders(today = todayIso()): Promise<{ periodStart: string; reminded: string[] }> {
  const settings = await getTimeSettings();
  const current = periodOf(today, settings.timesheets.period);
  const last = periodOf(addDays(current.start, -1), settings.timesheets.period);
  if (!settings.timesheets.reminders) return { periodStart: last.start, reminded: [] };

  const overview = await timesheetOverview({ day: last.start, status: 'outstanding' }, 'all');
  const reminded: string[] = [];
  for (const row of overview.rows) {
    const sent = await notifyPeople({
      recipients: [row.personId],
      category: 'deadline',
      title: message('Your timesheet for {from} to {to} is not in', { from: dateOf(last.start), to: dateOf(last.end) }),
      body: message('Submit it so it can be approved: {hours, number} hours are logged of the {available, number} you were available.', {
        hours: row.hours,
        available: row.available,
      }),
      link: `/my-time?day=${last.start}`,
      severity: 'warning',
      dedupeKey: `timesheet-reminder:${row.personId}:${last.start}`,
    }).catch(() => 0);
    if (sent > 0) reminded.push(row.personId);
  }
  return { periodStart: last.start, reminded };
}

export function createTimesheetReminders(options: { log: FastifyBaseLogger }) {
  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const outcome = await withLease('timesheet-reminders', 10 * 60_000, () => sendTimesheetReminders()).catch((error: unknown) => {
      options.log.warn({ err: error }, 'Timesheet reminders failed');
      return { ran: false as const };
    });
    if (outcome.ran && outcome.result.reminded.length > 0) {
      options.log.info({ periodStart: outcome.result.periodStart, reminded: outcome.result.reminded.length }, 'Timesheet reminders sent');
    }
  }

  return {
    start() {
      firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (firstRun) clearTimeout(firstRun);
      if (timer) clearInterval(timer);
      firstRun = undefined;
      timer = undefined;
    },
  };
}
