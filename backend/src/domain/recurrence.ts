import { dateOf, listOf, message, msg, type Message, type ParamValue } from '../lib/i18n.js';
import type { NonWorkingDayPolicy, RecurrenceFrequency, RecurrenceRule } from '../types/epm.js';
import { DayCounter, dayOf, isoOf, type WorkingCalendar } from './critical-path.js';

/**
 * Recurrence rules (BR-105): the days a series' work falls on.
 *
 * A rule repeats daily, weekly on chosen weekdays, monthly or quarterly on a
 * day of the month (or its last day), or every so many days; every `interval`
 * of those; from a start date; until an end date, or for a number of
 * occurrences, or for good. Optionally it keeps to the working calendar — the
 * one Module 5 schedules in (`calendarOf` in `schedule.ts`): an occurrence on a
 * non-working day is either left out or moved to the next working day.
 *
 * Calendar days only, as day numbers in UTC: no time of day, no time zone and
 * so no daylight saving to get wrong. A month that lacks the chosen day (31
 * April, 30 February) has the occurrence on its last day. A count is counted
 * from the rule's own start, so a window anywhere in the series sees the same
 * dates. Pure: no database and no OpenProject.
 */

export const FREQUENCIES: readonly RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'custom'];
export const NON_WORKING_POLICIES: readonly NonWorkingDayPolicy[] = ['keep', 'skip', 'next'];

/** The most occurrences a rule may be counted to. */
export const MAX_COUNT = 1000;
/** The longest step each frequency may take. */
export const MAX_INTERVAL: Readonly<Record<RecurrenceFrequency, number>> = {
  daily: 365,
  custom: 365,
  weekly: 52,
  monthly: 24,
  quarterly: 8,
};
/** A series starts in this range… */
export const EARLIEST_START = '2000-01-01';
export const LATEST_START = '2100-12-31';
/** …and has no occurrence after this day. */
export const LAST_DAY = '2200-12-31';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT = dayOf(LAST_DAY);

/** 1 Monday … 7 Sunday. 1970-01-01, day 0, was a Thursday. */
export const weekdayOf = (day: number): number => ((((day + 3) % 7) + 7) % 7) + 1;

/** A real calendar date written `YYYY-MM-DD`, or undefined. */
export function parseDay(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return undefined;
  const day = dayOf(value);
  // 2026-02-30 parses as 2 March; only a date that reads back the same is one.
  return Number.isFinite(day) && isoOf(day) === value ? day : undefined;
}

export const addDays = (iso: string, days: number): string => isoOf(dayOf(iso) + days);

/** Today as a UTC calendar day. */
export const todayOf = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type RuleCheck = { ok: true; rule: RecurrenceRule } | { ok: false; problem: Message };

const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : undefined;

/**
 * A rule as given, checked and written out the one way it is stored: only the
 * fields its frequency uses, each defaulted where it can be — a weekly rule
 * with no weekdays repeats on its start date's, a monthly one on its start
 * date's day. With a calendar, a rule that keeps to working days is also
 * checked to have a working day to fall on.
 */
export function validateRule(input: unknown, calendar?: WorkingCalendar): RuleCheck {
  const fail = (problem: Message): RuleCheck => ({ ok: false, problem });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(message('Choose how often it repeats.'));
  const given = input as Record<string, unknown>;

  const frequency = given.frequency as RecurrenceFrequency;
  if (!FREQUENCIES.includes(frequency)) {
    return fail(message('Choose how often it repeats: daily, weekly, monthly, quarterly or every so many days.'));
  }

  const interval = given.interval === undefined || given.interval === null || given.interval === '' ? 1 : integer(given.interval);
  const most = MAX_INTERVAL[frequency];
  if (interval === undefined || interval < 1 || interval > most) {
    return fail(
      message('Repeat every 1 to {max, number} {frequency, select, weekly {weeks} monthly {months} quarterly {quarters} other {days}}.', {
        max: most,
        frequency,
      }),
    );
  }

  if (given.startDate === undefined || given.startDate === null || given.startDate === '') return fail(message('Choose a start date.'));
  const start = parseDay(given.startDate);
  if (start === undefined) return fail(message('The start date is not a valid date.'));
  const startDate = isoOf(start);
  if (startDate < EARLIEST_START || startDate > LATEST_START) {
    return fail(message('The start date must be between {earliest} and {latest}.', { earliest: dateOf(EARLIEST_START), latest: dateOf(LATEST_START) }));
  }

  const rule: RecurrenceRule = { frequency, interval, startDate };

  if (frequency === 'weekly') {
    const raw = given.weekdays === undefined || given.weekdays === null ? [weekdayOf(start)] : given.weekdays;
    if (!Array.isArray(raw) || raw.length === 0) return fail(message('Choose at least one day of the week.'));
    const days = raw.map(integer);
    if (days.some((day) => day === undefined || day < 1 || day > 7)) {
      return fail(message('Days of the week are numbered 1 (Monday) to 7 (Sunday).'));
    }
    rule.weekdays = [...new Set(days as number[])].sort((a, b) => a - b);
  }

  if (frequency === 'monthly' || frequency === 'quarterly') {
    const raw = given.dayOfMonth === undefined || given.dayOfMonth === null || given.dayOfMonth === '' ? Number(startDate.slice(8)) : given.dayOfMonth;
    if (raw === 'last') {
      rule.dayOfMonth = 'last';
    } else {
      const day = integer(raw);
      if (day === undefined || day < 1 || day > 31) return fail(message('The day of the month is 1 to 31, or the last day.'));
      rule.dayOfMonth = day;
    }
  }

  const hasEnd = given.endDate !== undefined && given.endDate !== null && given.endDate !== '';
  const hasCount = given.count !== undefined && given.count !== null && given.count !== '';
  if (hasEnd && hasCount) return fail(message('Choose an end date or a number of occurrences, not both.'));
  if (hasEnd) {
    const end = parseDay(given.endDate);
    if (end === undefined) return fail(message('The end date is not a valid date.'));
    if (end < start) return fail(message('The end date cannot be before the start date.'));
    if (end > LIMIT) return fail(message('The end date cannot be after {latest}.', { latest: dateOf(LAST_DAY) }));
    rule.endDate = isoOf(end);
  }
  if (hasCount) {
    const count = integer(given.count);
    if (count === undefined || count < 1 || count > MAX_COUNT) {
      return fail(message('The number of occurrences is 1 to {max, number}.', { max: MAX_COUNT }));
    }
    rule.count = count;
  }

  const policy = (given.nonWorkingDays ?? 'keep') as NonWorkingDayPolicy;
  if (!NON_WORKING_POLICIES.includes(policy)) {
    return fail(message('Choose what happens on a non-working day: keep it, leave it out, or move it to the next working day.'));
  }
  rule.nonWorkingDays = policy;

  // What the rule produces can only be known by running it, and then only
  // with the calendar when it keeps to working days.
  if (policy === 'keep' || calendar) {
    let produced = 0;
    try {
      produced = [...emitted(rule, calendar, LIMIT, rule.count ?? 1)].length;
    } catch {
      // A calendar with no working day for years on end: nowhere to move to.
      return fail(message('That rule never falls on a working day.'));
    }
    if (produced === 0) {
      return fail(
        policy === 'keep'
          ? message('That rule has no occurrences: its end date comes before its first day.')
          : message('That rule never falls on a working day.'),
      );
    }
    if (rule.count !== undefined && produced < rule.count) {
      return fail(message('That rule does not reach {count, number} occurrences before {latest}.', { count: rule.count, latest: dateOf(LAST_DAY) }));
    }
  }
  return { ok: true, rule };
}

/* -------------------------------------------------------------------------- */
/* Expansion                                                                   */
/* -------------------------------------------------------------------------- */

/** The rule's days before the working calendar is applied, in order, from its start. */
function* raw(rule: RecurrenceRule): Generator<number> {
  const start = dayOf(rule.startDate);
  switch (rule.frequency) {
    case 'daily':
    case 'custom':
      for (let day = start; day <= LIMIT; day += rule.interval) yield day;
      return;
    case 'weekly': {
      const weekdays = rule.weekdays?.length ? rule.weekdays : [weekdayOf(start)];
      // Weeks are counted from the one the series starts in, Monday first.
      for (let monday = start - (weekdayOf(start) - 1); monday <= LIMIT; monday += 7 * rule.interval) {
        for (const weekday of weekdays) {
          const day = monday + weekday - 1;
          if (day >= start && day <= LIMIT) yield day;
        }
      }
      return;
    }
    case 'monthly':
    case 'quarterly': {
      const step = rule.frequency === 'monthly' ? rule.interval : rule.interval * 3;
      const chosen = rule.dayOfMonth ?? Number(rule.startDate.slice(8));
      for (let index = Number(rule.startDate.slice(0, 4)) * 12 + Number(rule.startDate.slice(5, 7)) - 1; ; index += step) {
        const year = Math.floor(index / 12);
        const month = (index % 12) + 1;
        const last = daysInMonth(year, month);
        const day = Math.round(Date.UTC(year, month - 1, chosen === 'last' ? last : Math.min(chosen, last)) / 86_400_000);
        if (day > LIMIT) return;
        if (day >= start) yield day;
      }
    }
  }
}

/**
 * The rule's occurrences, in order: its days with the working calendar
 * applied, ended by its end date or count. Stops once past `until` or after
 * `most` occurrences, whichever is first.
 */
function* emitted(rule: RecurrenceRule, calendar: WorkingCalendar | undefined, until = LIMIT, most = Infinity): Generator<number> {
  const policy = rule.nonWorkingDays ?? 'keep';
  if (policy !== 'keep' && !calendar) throw new Error('A rule that keeps to working days needs the working calendar.');
  const working = policy === 'keep' ? undefined : new DayCounter(calendar!, false);
  const end = Math.min(rule.endDate ? dayOf(rule.endDate) : LIMIT, until);
  const total = Math.min(rule.count ?? Infinity, most);
  let produced = 0;
  let last = -Infinity;
  for (const candidate of raw(rule)) {
    // Moving only ever goes forward, so past the end is past it for good.
    if (candidate > end || produced >= total) return;
    let day = candidate;
    if (working && !working.isWorking(day)) {
      if (policy === 'skip') continue;
      day = working.onOrAfter(day);
      if (day > end) return;
    }
    // Two days moved onto the same working day are one occurrence.
    if (day === last) continue;
    last = day;
    produced += 1;
    yield day;
  }
}

/**
 * The occurrences from `from` to `to`, both inclusive, as `YYYY-MM-DD`. For a
 * rule `validateRule` accepted; `calendar` when it keeps to working days.
 */
export function occurrences(rule: RecurrenceRule, from: string, to: string, calendar?: WorkingCalendar): string[] {
  const low = dayOf(from);
  const high = dayOf(to);
  const out: string[] = [];
  if (!(high >= low)) return out;
  for (const day of emitted(rule, calendar, high)) {
    if (day >= low) out.push(isoOf(day));
  }
  return out;
}

/** The first `limit` occurrences on or after `from`. */
export function nextOccurrences(rule: RecurrenceRule, from: string, limit: number, calendar?: WorkingCalendar): string[] {
  const low = dayOf(from);
  const out: string[] = [];
  if (limit <= 0) return out;
  for (const day of emitted(rule, calendar)) {
    if (day < low) continue;
    out.push(isoOf(day));
    if (out.length >= limit) break;
  }
  return out;
}

/** How many occurrences the rule has in all; null when it does not end. */
export function occurrenceTotal(rule: RecurrenceRule, calendar?: WorkingCalendar): number | null {
  if (rule.count === undefined && rule.endDate === undefined) return null;
  let total = 0;
  for (const _day of emitted(rule, calendar)) total += 1;
  return total;
}

/** The last occurrence; null when the rule does not end. */
export function lastOccurrence(rule: RecurrenceRule, calendar?: WorkingCalendar): string | null {
  if (rule.count === undefined && rule.endDate === undefined) return null;
  let last: number | undefined;
  for (const day of emitted(rule, calendar)) last = day;
  return last === undefined ? null : isoOf(last);
}

/* -------------------------------------------------------------------------- */
/* In words                                                                    */
/* -------------------------------------------------------------------------- */

const WEEKDAY_NAMES: Readonly<Record<number, string>> = {
  1: msg('Monday'),
  2: msg('Tuesday'),
  3: msg('Wednesday'),
  4: msg('Thursday'),
  5: msg('Friday'),
  6: msg('Saturday'),
  7: msg('Sunday'),
};

/** "Monday", "Monday and Thursday", "Monday, Wednesday and Friday" — joined as the reader's language joins them. */
const dayList = (names: ParamValue[]) =>
  names.length <= 2 ? listOf(names, 'and') : listOf([listOf(names.slice(0, -1)), names.at(-1)], 'and');

/** How often, without when it starts or ends: "Every 2 weeks on Monday and Thursday". */
function cadence(rule: RecurrenceRule): Message {
  const interval = rule.interval;
  const day = rule.dayOfMonth === 'last' ? 'last' : (rule.dayOfMonth ?? Number(rule.startDate.slice(8)));
  switch (rule.frequency) {
    case 'daily':
    case 'custom':
      return message('{interval, plural, one {Every day} other {Every # days}}', { interval });
    case 'weekly':
      return message('{interval, plural, one {Every week} other {Every # weeks}} on {days}', {
        interval,
        days: dayList((rule.weekdays?.length ? rule.weekdays : [weekdayOf(dayOf(rule.startDate))]).map((one) => WEEKDAY_NAMES[one]!)),
      });
    case 'monthly':
      return message('{interval, plural, one {Every month} other {Every # months}} on {day, select, last {the last day} other {day {day, number}}}', {
        interval,
        day,
      });
    case 'quarterly':
      return message(
        '{interval, plural, one {Every quarter} other {Every # quarters}} on {day, select, last {the last day of the month} other {day {day, number} of the month}}',
        { interval, day },
      );
  }
}

/**
 * The rule in words, as a message each reader sees in their own language:
 * "Every 2 weeks on Monday and Thursday, from 19 Oct 2026, 10 times".
 */
export function describeRule(rule: RecurrenceRule): Message {
  return message(
    '{cadence}, from {start}{end, select, count {, {count, plural, one {# time} other {# times}}} date {, until {until}} other {}}{days, select, skip {, on working days only} next {, moved to the next working day when it falls on a day off} other {}}',
    {
      cadence: cadence(rule),
      start: dateOf(rule.startDate),
      end: rule.count !== undefined ? 'count' : rule.endDate ? 'date' : 'none',
      count: rule.count,
      until: rule.endDate ? dateOf(rule.endDate) : undefined,
      days: rule.nonWorkingDays ?? 'keep',
    },
  );
}
