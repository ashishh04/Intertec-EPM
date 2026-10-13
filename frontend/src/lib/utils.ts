import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { env } from '@/config/env';
import { currentConventions, currentLanguage, formatLocalNumber, intlLocale, msg, t } from '@/lib/i18n';
import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isValid,
  parseISO,
} from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

export function toDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : parseISO(value);
  return isValid(date) ? date : null;
}

/**
 * How dates are written, and on which clock.
 *
 * A module-level value rather than a parameter on every call, because these
 * helpers are called from a few hundred places — threading a preference through
 * all of them would mean a hook in every leaf component that renders a date,
 * including the ones that are not components at all. `PreferenceEffects` sets
 * this from the person's saved settings on load and on change.
 *
 * The trade is that a change does not re-render on its own. That is handled
 * where it is set: the provider bumps a key that remounts the app's routes, so
 * the whole interface repaints once with the new format instead of each call
 * site subscribing to a preference it does not otherwise care about.
 */
type DatePattern = { short: string; long: string; weekday: string; time: string };

const DATE_PATTERNS: Record<'system' | 'iso' | 'dmy' | 'mdy', DatePattern> = {
  // `system` is the product's own house style rather than the browser's locale
  // strings: it is the format every screenshot and every piece of copy was
  // written against, and it reads the same everywhere.
  system: { short: 'MMM d', long: 'd MMM yyyy', weekday: 'EEEE, d MMMM yyyy', time: 'd MMM yyyy' },
  iso: { short: 'MM-dd', long: 'yyyy-MM-dd', weekday: 'EEEE, yyyy-MM-dd', time: 'yyyy-MM-dd' },
  dmy: { short: 'dd/MM', long: 'dd/MM/yyyy', weekday: 'EEEE, dd/MM/yyyy', time: 'dd/MM/yyyy' },
  mdy: { short: 'MM/dd', long: 'MM/dd/yyyy', weekday: 'EEEE, MM/dd/yyyy', time: 'MM/dd/yyyy' },
};

type DateFormat = keyof typeof DATE_PATTERNS;

let activeFormat: DateFormat = 'system';
let activePattern: DatePattern = DATE_PATTERNS.system;
let activeClock: '24h' | '12h' = '24h';
/**
 * The timezone a moment in time is shown in (BR-109): the person's own, from
 * their profile. Dates without a time are calendar days and never shift.
 */
let activeTimeZone: string | undefined;

/** Applies the person's format choices. Called by `PreferenceEffects`. */
export function setDateConventions(options: { dateFormat: DateFormat; timeFormat: '24h' | '12h'; timeZone?: string }): void {
  activeFormat = DATE_PATTERNS[options.dateFormat] ? options.dateFormat : 'system';
  activePattern = DATE_PATTERNS[activeFormat];
  activeClock = options.timeFormat;
  activeTimeZone = validZone(options.timeZone);
}

function validZone(zone?: string): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The zone's short name at that moment, e.g. "GST" or "GMT+4". */
function zoneName(date: Date): string {
  const parts = dateFormatter({ timeZone: activeTimeZone, timeZoneName: 'short', hour: 'numeric' }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
}

/*
 * Arabic, the Hijri calendar and Arabic-Indic digits (BR-607).
 *
 * The patterns above are date-fns's, and date-fns writes Gregorian dates with
 * Western digits only. Anything else goes through `Intl.DateTimeFormat`, which
 * has Arabic month and day names, the Umm al-Qura calendar and both digit sets
 * built in. English on the Gregorian calendar keeps the date-fns path exactly,
 * so nothing an English reader sees changes.
 */
function viaIntl(): boolean {
  const { language, calendar, numerals } = currentConventions();
  return language !== 'en' || calendar !== 'gregory' || numerals !== 'latn';
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = intlLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

/** Day, month and year in the order the chosen numeric format puts them. */
function numericDate(date: Date, withYear: boolean): string {
  const hijri = currentConventions().calendar !== 'gregory';
  const parts = dateFormatter({
    day: '2-digit',
    month: '2-digit',
    ...(withYear ? { year: 'numeric' } : {}),
    ...(withYear && hijri ? { era: 'short' } : {}),
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  const [day, month, year] = [part('day'), part('month'), part('year')];
  const written =
    activeFormat === 'iso'
      ? withYear ? `${year}-${month}-${day}` : `${month}-${day}`
      : activeFormat === 'mdy'
        ? withYear ? `${month}/${day}/${year}` : `${month}/${day}`
        : withYear ? `${day}/${month}/${year}` : `${day}/${month}`;
  // A numeric Hijri date is otherwise indistinguishable from a Gregorian one.
  return withYear && hijri && part('era') ? `${written} ${part('era')}` : written;
}

function intlDate(date: Date, style: 'short' | 'long' | 'weekday'): string {
  if (activeFormat !== 'system' && style !== 'weekday') return numericDate(date, style === 'long');
  if (style === 'short') return dateFormatter({ day: 'numeric', month: 'short' }).format(date);
  if (style === 'long') return dateFormatter({ day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  return dateFormatter({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** "Aug 30" — the default compact date used across lists and cards. */
export function formatShortDate(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return viaIntl() ? intlDate(date, 'short') : format(date, activePattern.short);
}

/** "30 Aug 2026" — used in headers and detail panels. */
export function formatLongDate(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return viaIntl() ? intlDate(date, 'long') : format(date, activePattern.long);
}

/** "Monday, 30 August 2026" — used where a single date is the subject. */
export function formatWeekdayDate(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return viaIntl() ? intlDate(date, 'weekday') : format(date, activePattern.weekday);
}

/**
 * "September 2026" — a month as a whole, as over a month grid. Always the
 * Gregorian month, because the grids it heads are laid out in Gregorian days;
 * the language and digits are still the reader's.
 */
export function formatMonthYear(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  if (!viaIntl()) return format(date, 'MMMM yyyy');
  return dateFormatter({ month: 'long', year: 'numeric', calendar: 'gregory' }).format(date);
}

/** A time of day on its own, e.g. "14:05" or "2:05 pm". */
export function formatTime(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  if (activeTimeZone) {
    const clock = dateFormatter({
      timeZone: activeTimeZone,
      ...(activeClock === '24h' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }),
    }).format(date);
    return `${clock} ${zoneName(date)}`;
  }
  if (viaIntl()) {
    return dateFormatter(
      activeClock === '24h'
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
    ).format(date);
  }
  return format(date, activeClock === '24h' ? 'HH:mm' : 'h:mm a');
}

export function formatDateTime(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  if (activeTimeZone) {
    const day = dateFormatter({ timeZone: activeTimeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
    return t('{date}, {time}', { date: day, time: formatTime(date) });
  }
  if (viaIntl()) return t('{date}, {time}', { date: intlDate(date, 'long'), time: formatTime(date) });
  return `${format(date, activePattern.time)}, ${formatTime(date)}`;
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/** "10 minutes ago" */
export function formatRelative(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  if (!viaIntl()) return `${formatDistanceToNowStrict(date)} ago`;

  // The largest unit that keeps the figure under its next step, as date-fns
  // does: "3 hours ago", not "180 minutes ago".
  let amount = (date.getTime() - Date.now()) / 1000;
  for (const [unit, step] of RELATIVE_STEPS) {
    if (Math.abs(amount) < step) {
      return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'always' }).format(Math.round(amount), unit);
    }
    amount /= step;
  }
  return formatLongDate(date);
}

/** Calendar-day delta from today. Negative means the date is in the past. */
export function daysFromToday(value?: string | Date | null): number | null {
  const date = toDate(value);
  if (!date) return null;
  return differenceInCalendarDays(date, new Date());
}

/**
 * Human due-date phrasing used in work queues.
 * Returns both the label and whether it should read as urgent.
 *
 * Completed work is never described as overdue — a closed item that missed its
 * target date is history, not something demanding attention today.
 */
export function describeDueDate(
  value?: string | Date | null,
  completed = false,
): {
  label: string;
  tone: 'overdue' | 'today' | 'soon' | 'normal' | 'none';
} {
  if (completed) {
    const date = toDate(value);
    return date
      ? { label: t('Target {date}', { date: formatShortDate(date) }), tone: 'normal' }
      : { label: t('Completed'), tone: 'normal' };
  }

  const delta = daysFromToday(value);
  if (delta === null) return { label: t('No due date'), tone: 'none' };
  if (delta < 0) {
    return {
      label: t('{days, plural, one {# day overdue} other {# days overdue}}', { days: Math.abs(delta) }),
      tone: 'overdue',
    };
  }
  if (delta === 0) return { label: t('Due today'), tone: 'today' };
  if (delta === 1) return { label: t('Due tomorrow'), tone: 'soon' };
  if (delta <= 7) return { label: t('{days, plural, one {Due in # day} other {Due in # days}}', { days: delta }), tone: 'soon' };
  return { label: t('Due {date}', { date: formatShortDate(value) }), tone: 'normal' };
}

export function isOverdue(value?: string | Date | null): boolean {
  const delta = daysFromToday(value);
  return delta !== null && delta < 0;
}

export function toISODateOnly(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/* -------------------------------------------------------------------------- */
/* Numbers and text                                                            */
/* -------------------------------------------------------------------------- */

/** Grouped digits in the reader's numerals: "12,345", or "١٢٬٣٤٥" with Arabic-Indic digits. */
export function formatNumber(value: number): string {
  return formatLocalNumber(value);
}

/**
 * A money figure in the instance's currency.
 *
 * The code is a parameter because EPM is deployed per organisation and the
 * backend reports which one it quotes rates in; hard-coding it here would
 * print dollars over dirhams. Whole units by default — a cost report reads in
 * thousands, and cents in it are noise — with `digits` for the odd place that
 * needs them.
 */
export function formatCurrency(value: number, currency = env.currency, digits = 0): string {
  return formatLocalNumber(value, {
    style: 'currency',
    currency,
    maximumFractionDigits: digits,
  });
}

/** "42%" — whole percentages; pass `digits` for finer values. Arabic writes "٤٢٪". */
export function formatPercent(value?: number | null, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (currentLanguage() !== 'en') {
    return formatLocalNumber(value / 100, { style: 'percent', maximumFractionDigits: digits });
  }
  return `${formatLocalNumber(value, { maximumFractionDigits: digits })}%`;
}

export function formatHours(value?: number): string {
  if (value === undefined || value === null) return '—';
  if (currentLanguage() === 'en' && currentConventions().numerals === 'latn') {
    return `${value % 1 === 0 ? value : value.toFixed(1)}h`;
  }
  return t('{hours}h', { hours: formatLocalNumber(value, { maximumFractionDigits: 1 }) });
}

export function formatBytes(bytes: number): string {
  const units = [msg('{size} B'), msg('{size} KB'), msg('{size} MB'), msg('{size} GB')];
  if (bytes === 0) return t(units[0]!, { size: formatLocalNumber(0) });
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, exponent);
  return t(units[exponent]!, {
    size: formatLocalNumber(size, { minimumFractionDigits: exponent === 0 ? 0 : 1, maximumFractionDigits: exponent === 0 ? 0 : 1 }),
  });
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * A caller's noun for a count. The default plural adds an "s", which is English
 * only: in another language a noun passed without its plural stays as given
 * rather than growing a Latin letter.
 */
export function pluralize(
  count: number,
  singular: string,
  plural = currentLanguage() === 'en' ? `${singular}s` : singular,
): string {
  return count === 1 ? singular : plural;
}

export function greetingForHour(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return t('Good morning');
  if (hour < 18) return t('Good afternoon');
  return t('Good evening');
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                 */
/* -------------------------------------------------------------------------- */

export function groupBy<T, K extends string | number>(
  items: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  return items.reduce(
    (acc, item) => {
      const key = keyFn(item);
      (acc[key] ||= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
