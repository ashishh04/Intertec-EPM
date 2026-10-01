/**
 * ISO-8601 durations, as OpenProject's schemas use them.
 *
 * Two different quantities share the `Duration` field type upstream and they
 * are not interchangeable:
 *
 * - **days** — a work package's `duration`, the span it occupies on the
 *   schedule. OpenProject stores it as `P3D` and reads only the day part, so a
 *   time-of-day value like `PT1H30M` truncates to zero and is refused with
 *   "Duration must be greater than 0".
 * - **hours** — `estimatedTime`, `remainingTime`, `spentTime`: effort, written
 *   `PT7H30M`.
 *
 * Asking a planner to type either by hand is a developer's idea of a form, so
 * the UI collects a number and this does the translation.
 */

/** Work package attributes measured in days rather than hours. */
const DAY_VALUED = new Set(['duration']);

export type DurationUnit = 'days' | 'hours';

export function durationUnitFor(attribute: string): DurationUnit {
  return DAY_VALUED.has(attribute) ? 'days' : 'hours';
}

const PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** An OpenProject "day" of effort is a working day, not twenty-four hours. */
const HOURS_PER_DAY = 8;

interface Parts {
  days: number;
  hours: number;
}

function parse(value: string): Parts | undefined {
  const match = PATTERN.exec(value.trim());
  if (!match) return undefined;

  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const num = (part?: string) => (part ? Number(part) : 0);

  return {
    days: num(years) * 365 + num(months) * 30 + num(weeks) * 7 + num(days),
    hours: num(hours) + num(minutes) / 60 + num(seconds) / 3600,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** An ISO duration as a number in `unit`, or undefined when it is not one. */
export function durationToNumber(
  value: unknown,
  unit: DurationUnit,
): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const parts = parse(value);
  if (!parts) return undefined;

  const total =
    unit === 'days'
      ? parts.days + parts.hours / HOURS_PER_DAY
      : parts.days * HOURS_PER_DAY + parts.hours;

  return total > 0 ? round(total) : undefined;
}

/**
 * A number in `unit` as the ISO string OpenProject stores.
 *
 * Days are emitted whole: OpenProject schedules in working days and rejects a
 * fractional one. Hours carry their minutes, so 1.5 becomes `PT1H30M`.
 */
export function numberToDuration(
  value: number | null | undefined,
  unit: DurationUnit,
): string | undefined {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) {
    return undefined;
  }

  if (unit === 'days') return `P${Math.max(1, Math.round(value))}D`;

  const whole = Math.floor(value);
  const minutes = Math.round((value - whole) * 60);
  if (whole === 0) return `PT${minutes}M`;
  return minutes > 0 ? `PT${whole}H${minutes}M` : `PT${whole}H`;
}
