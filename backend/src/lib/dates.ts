/**
 * Calendar-day arithmetic on `YYYY-MM-DD` strings.
 *
 * Everything OpenProject calls a date — `startDate`, `dueDate`, `spent_on` —
 * is a plain day with no zone, and the filters that read them take the same
 * shape. Working in UTC keeps a day a day: constructing a local `Date` from
 * `2026-09-19` and adding to it shifts the result by a day either side of
 * midnight for anyone east or west of the server.
 */

/** Today as OpenProject writes it. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `day` shifted by `days`, which may be negative. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** How many days from `from` to `to`, inclusive of both ends. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * The Monday of `day`'s ISO week.
 *
 * ISO weeks start on Monday regardless of what a person's own week starts on:
 * this labels a bucket in a report, and a bucket boundary that moved per
 * viewer would make two people's totals disagree about the same hours.
 */
export function startOfIsoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  // getUTCDay is 0 for Sunday, so Sunday is six days into its week.
  const shift = (date.getUTCDay() + 6) % 7;
  return addDays(day, -shift);
}

/** The ISO week label for `day`, e.g. `2026-W40`. */
export function isoWeekLabel(day: string): string {
  const monday = new Date(`${startOfIsoWeek(day)}T00:00:00Z`);
  // The ISO week-numbering year is the year of that week's Thursday.
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(firstThursday);
  firstMonday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7));
  const week = Math.round((monday.getTime() - firstMonday.getTime()) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Weekday keys, indexed by `Date.getUTCDay()` — Sunday is 0. */
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** The weekday key for a `YYYY-MM-DD` day. */
export function weekdayOf(day: string): WeekdayKey {
  const date = new Date(`${day}T00:00:00Z`);
  return WEEKDAY_KEYS[date.getUTCDay()]!;
}

/**
 * The wall-clock date and hour in `timeZone` at instant `at`.
 *
 * Built from `Intl.DateTimeFormat` rather than by adding an offset, because an
 * offset is not a property of a zone: Asia/Kolkata is +05:30, Europe/Berlin is
 * +01:00 or +02:00 depending on the date, and hard-coding either is how a
 * reminder ends up an hour late for half the year.
 *
 * An unknown or malformed zone falls back to UTC. That is the honest failure:
 * the reminder goes out at the server's hour rather than not at all.
 */
export function localDayAndHour(timeZone: string | undefined, at = new Date()): {
  day: string;
  hour: number;
} {
  if (!timeZone) return { day: at.toISOString().slice(0, 10), hour: at.getUTCHours() };

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const day = `${value('year')}-${value('month')}-${value('day')}`;
    // `hour12: false` yields 24 rather than 0 for midnight in some runtimes.
    const hour = Number(value('hour')) % 24;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(hour)) throw new Error('unparsable');
    return { day, hour };
  } catch {
    return { day: at.toISOString().slice(0, 10), hour: at.getUTCHours() };
  }
}
