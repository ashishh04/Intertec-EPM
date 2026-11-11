import { addDays } from '../lib/dates.js';
import { localDay, zonedInstant, zoneOffsetMinutes } from './report-schedule.js';

/**
 * When a repeating meeting's occurrences fall.
 *
 * Pure: no clock and no database. Each occurrence keeps the first one's
 * wall-clock time in the series' own time zone ("Tuesdays at 10:00 in
 * Asia/Dubai"), so a daylight-saving change moves the instant, not the time
 * people expect.
 */

export const MEETING_FREQUENCIES = ['daily', 'workdays', 'weekly', 'fortnightly', 'monthly'] as const;
export type MeetingFrequency = (typeof MEETING_FREQUENCIES)[number];

/** How far ahead a series with no end is scheduled. */
export const HORIZON_DAYS = 182;
/** The most occurrences one series makes, whatever its end. */
export const MAX_OCCURRENCES = 260;

export interface SeriesRule {
  frequency: MeetingFrequency;
  firstStartsAt: Date;
  timeZone: string;
  /** The last calendar day an occurrence may fall on, inclusive. */
  until?: string | null;
}

/** `HH:MM` on the wall clock in `timeZone` at `at`. */
export function localTime(timeZone: string, at: Date): string {
  const local = new Date(at.getTime() + zoneOffsetMinutes(timeZone, at) * 60_000);
  return local.toISOString().slice(11, 16);
}

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The same day of the month `months` later, or that month's last day when it is shorter. */
function addMonthsKeepingDay(first: string, months: number): string {
  const [year, month, day] = first.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth() + 1;
  const d = Math.min(day, lastDayOfMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The calendar days occurrences fall on, from the first, while on or before
 * `through` (and the series' own end), at most MAX_OCCURRENCES.
 */
export function occurrenceDays(rule: SeriesRule, through: string): string[] {
  const first = localDay(rule.timeZone, rule.firstStartsAt);
  const end = rule.until && rule.until < through ? rule.until : through;
  const days: string[] = [];
  for (let index = 0; days.length < MAX_OCCURRENCES; index += 1) {
    let day: string;
    switch (rule.frequency) {
      case 'daily':
        day = addDays(first, index);
        break;
      case 'workdays':
        // Monday to Friday: walk on from the last one, skipping the weekend.
        day = index === 0 ? first : addDays(days[days.length - 1] ?? first, 1);
        while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addDays(day, 1);
        break;
      case 'weekly':
        day = addDays(first, index * 7);
        break;
      case 'fortnightly':
        day = addDays(first, index * 14);
        break;
      default:
        day = addMonthsKeepingDay(first, index);
    }
    if (day > end) break;
    // A first meeting set on a weekend for a weekday series still happens.
    if (days.length === 0 || day > days[days.length - 1]!) days.push(day);
  }
  return days;
}

/** The instants of the occurrences on or before `through`, each at the first one's wall-clock time. */
export function occurrences(rule: SeriesRule, through: string): Date[] {
  const time = localTime(rule.timeZone, rule.firstStartsAt);
  return occurrenceDays(rule, through).map((day) => zonedInstant(day, time, rule.timeZone));
}

/** Words for the pattern, in English, as the journal and logs keep it. */
export function describeFrequency(frequency: MeetingFrequency): string {
  switch (frequency) {
    case 'daily':
      return 'every day';
    case 'workdays':
      return 'every weekday';
    case 'weekly':
      return 'every week';
    case 'fortnightly':
      return 'every two weeks';
    default:
      return 'every month';
  }
}
