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

/** "Aug 30" — the default compact date used across lists and cards. */
export function formatShortDate(value?: string | Date | null): string {
  const date = toDate(value);
  return date ? format(date, 'MMM d') : '—';
}

/** "30 Aug 2026" — used in headers and detail panels. */
export function formatLongDate(value?: string | Date | null): string {
  const date = toDate(value);
  return date ? format(date, 'd MMM yyyy') : '—';
}

export function formatDateTime(value?: string | Date | null): string {
  const date = toDate(value);
  return date ? format(date, 'd MMM yyyy, HH:mm') : '—';
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

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatPercent(value: number, fractionDigits = 0): string {
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
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

export function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
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

export function uniqueBy<T, K>(items: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Stable pseudo-random generator so mock data stays identical between reloads. */
export function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}
