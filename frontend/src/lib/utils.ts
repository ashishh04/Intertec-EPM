import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
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

let activePattern: DatePattern = DATE_PATTERNS.system;
let activeClock: '24h' | '12h' = '24h';

/** Applies the person's format choices. Called by `PreferenceEffects`. */
export function setDateConventions(options: {
  dateFormat: keyof typeof DATE_PATTERNS;
  timeFormat: '24h' | '12h';
}): void {
  activePattern = DATE_PATTERNS[options.dateFormat] ?? DATE_PATTERNS.system;
  activeClock = options.timeFormat;
}

/** "Aug 30" — the default compact date used across lists and cards. */
export function formatShortDate(value?: string | Date | null): string {
  const date = toDate(value);
  return date ? format(date, activePattern.short) : '—';
}

/** "30 Aug 2026" — used in headers and detail panels. */
export function formatLongDate(value?: string | Date | null): string {
  const date = toDate(value);
  return date ? format(date, activePattern.long) : '—';
}

/** "Monday, 30 August 2026" — used where a single date is the subject. */
export function formatWeekdayDate(value?: string | Date | null): string {
  const date = toDate(value);
  return date ? format(date, activePattern.weekday) : '—';
}

/** A time of day on its own, e.g. "14:05" or "2:05 pm". */
export function formatTime(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return format(date, activeClock === '24h' ? 'HH:mm' : 'h:mm a');
}

export function formatDateTime(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${format(date, activePattern.time)}, ${formatTime(date)}`;
}

/** "10 minutes ago" */
export function formatRelative(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${formatDistanceToNowStrict(date)} ago`;
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
      ? { label: `Target ${formatShortDate(date)}`, tone: 'normal' }
      : { label: 'Completed', tone: 'normal' };
  }

  const delta = daysFromToday(value);
  if (delta === null) return { label: 'No due date', tone: 'none' };
  if (delta < 0) {
    const days = Math.abs(delta);
    return { label: days === 1 ? '1 day overdue' : `${days} days overdue`, tone: 'overdue' };
  }
  if (delta === 0) return { label: 'Due today', tone: 'today' };
  if (delta === 1) return { label: 'Due tomorrow', tone: 'soon' };
  if (delta <= 7) return { label: `Due in ${delta} days`, tone: 'soon' };
  return { label: `Due ${formatShortDate(value)}`, tone: 'normal' };
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

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
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
export function formatCurrency(value: number, currency = 'USD', digits = 0): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: digits,
  }).format(value);
}

/** "42%" — whole percentages; pass `digits` for finer values. */
export function formatPercent(value?: number | null, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)}%`;
}

export function formatHours(value?: number): string {
  if (value === undefined || value === null) return '—';
  return `${value % 1 === 0 ? value : value.toFixed(1)}h`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, exponent);
  return `${size.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function greetingForHour(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
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
