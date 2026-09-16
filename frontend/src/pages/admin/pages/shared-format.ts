import { ApiError } from '@/services/api/client';

/**
 * Formatting shared by the live administration pages.
 *
 * Small on purpose: anything used by more than one page lives here so the
 * pages agree on how a configuration value or an upstream refusal reads.
 * Dates and byte counts come from `@/lib/utils`, like everywhere else.
 */

/** Week day names in OpenProject's numbering: 1 = Monday, 7 = Sunday. */
export const WEEK_DAY_NAMES: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export function weekDayName(day: number | null | undefined): string | null {
  return typeof day === 'number' ? (WEEK_DAY_NAMES[day] ?? null) : null;
}

/** A list joined for display, or a fallback when there is nothing to join. */
export function joinOrFallback(values: readonly (string | number)[] | null | undefined, fallback = 'Not set'): string {
  return values && values.length > 0 ? values.join(', ') : fallback;
}

/** A value or a fallback when the configuration leaves it unset. */
export function valueOr(value: string | number | null | undefined, fallback: string): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

/** The message a failed mutation should show. Prefers the server's wording. */
export function describeError(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * True when the delivery system refused a write because its version does not
 * offer it through the API (HTTP 501). The pages keep their editing controls,
 * because a newer instance accepts the same request, but tell the
 * administrator that this one does not accept the change.
 */
export function isNotImplementedUpstream(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501;
}

/** ISO calendar date, the only shape the non-working day endpoints accept. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
