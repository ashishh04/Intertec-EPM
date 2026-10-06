/**
 * OpenProject reports durations as ISO-8601 (`PT7H30M`, `P1DT16H`); the EPM
 * contract uses plain hours.
 *
 * A day in these strings is twenty-four hours, not a working day. OpenProject
 * 15.5.1 writes effort as `Duration.new(seconds: hours * 3600).iso8601` and
 * reads it back as total seconds over 3600 (`API::V3::Utilities::
 * DateTimeFormatter`), so 40 hours arrives as `P1DT16H` and 120 as `P5D`.
 * Reading a day as eight hours — as this once did — reported a 120-hour
 * estimate as 40, and a form saved from that wrote 40 back.
 */

const PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** The hours in each unit as OpenProject counts them: calendar time, not working time. */
const HOURS_PER_DAY = 24;

export function durationToHours(value: string | null | undefined): number | undefined {
  if (!value) return undefined;

  const match = PATTERN.exec(value);
  if (!match) return undefined;

  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const num = (part: string | undefined) => (part ? Number(part) : 0);

  const total =
    num(years) * 365 * HOURS_PER_DAY +
    num(months) * 30 * HOURS_PER_DAY +
    num(weeks) * 7 * HOURS_PER_DAY +
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
