import { addDays, daysBetween, startOfIsoWeek } from '../lib/dates.js';

/**
 * When a scheduled report runs, and what period it covers (BR-207).
 *
 * Pure: no clock and no database, so every rule is checked by worked examples
 * (`__checks__/reports.check.ts`). Times are wall-clock times in the
 * schedule's own time zone — "Mondays at 07:00 in Asia/Dubai" — turned into
 * instants with the zone's offset on that date, so a daylight-saving change
 * moves the instant, not the wall-clock time people expect.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface ScheduleTiming {
  frequency: Frequency;
  /** 1 Monday … 7 Sunday. */
  weekday?: number | null;
  /** 1–28, or 0 for the last day of the month. */
  dayOfMonth?: number | null;
  /** `HH:MM`. */
  timeOfDay: string;
  timeZone: string;
}

export const PERIOD_PRESETS = [
  'previous-week',
  'previous-month',
  'last-4-weeks',
  'last-12-weeks',
  'month-to-date',
  'year-to-date',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** Whether a time zone name is one this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at `at`: +240 for Asia/Dubai. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The calendar day in `timeZone` at instant `at`. */
export function localDay(timeZone: string, at: Date): string {
  return new Date(at.getTime() + zoneOffsetMinutes(timeZone, at) * 60_000).toISOString().slice(0, 10);
}

/**
 * The instant at which the wall clock in `timeZone` shows `time` on `day`.
 * In a daylight-saving gap the clock never shows it, and the instant an hour
 * later is used; in an overlap, the first of the two.
 */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60_000;
  // The offset at the wall time read as UTC is right except within a few hours
  // of a change; asking again at the result settles it.
  let instant = wall - zoneOffsetMinutes(timeZone, new Date(wall)) * 60_000;
  instant = wall - zoneOffsetMinutes(timeZone, new Date(instant)) * 60_000;
  return new Date(instant);
}

function lastDayOfMonth(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Whether `day` (in the schedule's zone) is a day the schedule runs. */
function runsOn(timing: ScheduleTiming, day: string): boolean {
  if (timing.frequency === 'daily') return true;
  if (timing.frequency === 'weekly') {
    const weekday = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    return weekday === timing.weekday;
  }
  const dayOfMonth = Number(day.slice(8, 10));
  return timing.dayOfMonth === 0 ? day === lastDayOfMonth(day) : dayOfMonth === timing.dayOfMonth;
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(timing: ScheduleTiming, after: Date): Date {
  let day = localDay(timing.timeZone, after);
  // At most a year of days to find the next one; a monthly schedule on the
  // 28th is the furthest apart any can be.
  for (let step = 0; step < 400; step += 1) {
    if (runsOn(timing, day)) {
      const instant = zonedInstant(day, timing.timeOfDay, timing.timeZone);
      if (instant.getTime() > after.getTime()) return instant;
    }
    day = addDays(day, 1);
  }
  throw new Error('This schedule has no next occurrence.');
}

/** The schedule in words: "Mondays at 07:00 (Asia/Dubai)". */
export function describeTiming(timing: ScheduleTiming): string {
  const zone = `(${timing.timeZone})`;
  if (timing.frequency === 'daily') return `Every day at ${timing.timeOfDay} ${zone}`;
  if (timing.frequency === 'weekly') {
    const name = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][(timing.weekday ?? 1) - 1];
    return `${name} at ${timing.timeOfDay} ${zone}`;
  }
  const day = timing.dayOfMonth === 0 ? 'the last day' : `day ${timing.dayOfMonth}`;
  return `Monthly on ${day} at ${timing.timeOfDay} ${zone}`;
}

/**
 * The period a report covers when it runs on `day` (in the schedule's zone).
 * "Previous" periods are complete; "to date" ones end on the day before the
 * run, so a report never shows a day that is still under way.
 */
export function periodFor(preset: PeriodPreset, day: string): { from: string; to: string } {
  const yesterday = addDays(day, -1);
  switch (preset) {
    case 'previous-week': {
      const monday = addDays(startOfIsoWeek(day), -7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'previous-month': {
      const firstThisMonth = `${day.slice(0, 7)}-01`;
      const lastPrevious = addDays(firstThisMonth, -1);
      return { from: `${lastPrevious.slice(0, 7)}-01`, to: lastPrevious };
    }
    case 'last-4-weeks':
      return { from: addDays(yesterday, -27), to: yesterday };
    case 'last-12-weeks':
      return { from: addDays(yesterday, -83), to: yesterday };
    case 'month-to-date': {
      const first = `${day.slice(0, 7)}-01`;
      return first === day ? { from: `${yesterday.slice(0, 7)}-01`, to: yesterday } : { from: first, to: yesterday };
    }
    case 'year-to-date': {
      const first = `${day.slice(0, 4)}-01-01`;
      return first === day ? { from: `${yesterday.slice(0, 4)}-01-01`, to: yesterday } : { from: first, to: yesterday };
    }
  }
}

/** How many days a preset covers, for a summary line. */
export function periodLength(period: { from: string; to: string }): number {
  return daysBetween(period.from, period.to);
}
