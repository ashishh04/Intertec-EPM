/**
 * OpenProject reports durations as ISO-8601 (`PT7H30M`, `P1D`); the EPM
 * contract uses plain hours.
 */

const PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** An OpenProject "day" of effort is a working day, not 24 hours. */
const HOURS_PER_DAY = 8;

export function durationToHours(value: string | null | undefined): number | undefined {
  if (!value) return undefined;

  const match = PATTERN.exec(value);
  if (!match) return undefined;

  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const num = (part: string | undefined) => (part ? Number(part) : 0);

  const total =
    num(years) * 365 * HOURS_PER_DAY +
    num(months) * 30 * HOURS_PER_DAY +
    num(weeks) * 5 * HOURS_PER_DAY +
    num(days) * HOURS_PER_DAY +
    num(hours) +
    num(minutes) / 60 +
    num(seconds) / 3600;

  return total > 0 ? Math.round(total * 100) / 100 : undefined;
}

export function hoursToDuration(hours: number | null | undefined): string | undefined {
  if (hours === null || hours === undefined || Number.isNaN(hours) || hours <= 0) return undefined;
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return minutes > 0 ? `PT${whole}H${minutes}M` : `PT${whole}H`;
}
