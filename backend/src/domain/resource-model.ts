/**
 * Resources and capacity (Module 6), the arithmetic: who is available when
 * (BR-312), how much work falls on them when (BR-313), and where the two do
 * not fit (BR-110, BR-314). Pure — no I/O — so every figure can be checked
 * against a worked example (`__checks__/resources.check.ts`).
 *
 * Days are day numbers (days since 1970-01-01, as `critical-path.ts` counts
 * them); weeks start on Monday. A "carrier" is whoever work falls on: a
 * person (their OpenProject id) or a placeholder (`placeholder:<id>`).
 */

/** Hours: a load within this of the hours available fits. */
export const EPSILON = 0.005;

/** Monday 0 … Sunday 6. 1970-01-01 was a Thursday. */
export const weekdayIndex = (day: number): number => (((day + 3) % 7) + 7) % 7;

/** The Monday of a day's week. */
export const weekOf = (day: number): number => day - weekdayIndex(day);

export const placeholderKey = (id: string): string => `placeholder:${id}`;

/** Seven numbers, Monday first: hours on each weekday. */
export type WeekPattern = readonly number[];

/** A work schedule in force from a day on: the pattern at full time, and the fraction employed. */
export interface ScheduleRow {
  effectiveFrom: number;
  hours: WeekPattern;
  fraction: number;
}

/** Time off from one day to another, both included: whole days, or some hours of each. */
export interface TimeOffRow {
  from: number;
  to: number;
  hoursPerDay: number | null;
}

export interface CarrierInput {
  /** Weekly hours: the whole of the model where no schedule is in force. */
  weeklyHours: number;
  /** Sorted by `effectiveFrom`. */
  schedules: ScheduleRow[];
  timeOff: TimeOffRow[];
}

export interface InstanceCalendar {
  /** The weekdays the instance works: Monday 0 … Sunday 6. */
  workingWeekdays: ReadonlySet<number>;
  /** One-off non-working days — public holidays — which no one works. */
  holidays: ReadonlySet<number>;
}

/** The instance's working week as a pattern: `hoursPerDay` on each working weekday. */
export function standardPattern(calendar: InstanceCalendar, hoursPerDay: number): number[] {
  return Array.from({ length: 7 }, (_, weekday) => (isInstanceWorkday(calendar, weekday) ? hoursPerDay : 0));
}

const isInstanceWorkday = (calendar: InstanceCalendar, weekday: number) =>
  calendar.workingWeekdays.size === 0 ? weekday < 5 : calendar.workingWeekdays.has(weekday);

/* -------------------------------------------------------------------------- */
/* Availability (BR-312)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hours each carrier is available on each day: the hours their schedule in
 * force gives that weekday, times their employment fraction — none on a public
 * holiday — less their time off. Before their first schedule, or with none,
 * their weekly hours are spread evenly over the instance's working days.
 */
export class AvailabilityModel {
  private readonly memo = new Map<string, Map<number, number>>();

  constructor(
    readonly calendar: InstanceCalendar,
    private readonly carriers: ReadonlyMap<string, CarrierInput>,
  ) {}

  has(carrier: string): boolean {
    return this.carriers.has(carrier);
  }

  keys(): string[] {
    return [...this.carriers.keys()];
  }

  /** The schedule row in force on a day, or null for the default. */
  scheduleOn(carrier: string, day: number): ScheduleRow | null {
    const input = this.carriers.get(carrier);
    if (!input) return null;
    let found: ScheduleRow | null = null;
    for (const row of input.schedules) {
      if (row.effectiveFrom <= day) found = row;
      else break;
    }
    return found;
  }

  /** Hours scheduled on a day, before time off. */
  scheduled(carrier: string, day: number): number {
    const input = this.carriers.get(carrier);
    if (!input || this.calendar.holidays.has(day)) return 0;
    const weekday = weekdayIndex(day);
    const row = this.scheduleOn(carrier, day);
    if (row) return Math.max(0, (row.hours[weekday] ?? 0) * row.fraction);
    if (!isInstanceWorkday(this.calendar, weekday)) return 0;
    const workdays = this.calendar.workingWeekdays.size || 5;
    return Math.max(0, input.weeklyHours / workdays);
  }

  /** Hours off on a day: whole days take all that was scheduled. */
  off(carrier: string, day: number): number {
    const input = this.carriers.get(carrier);
    if (!input) return 0;
    const scheduled = this.scheduled(carrier, day);
    if (scheduled === 0) return 0;
    let off = 0;
    for (const entry of input.timeOff) {
      if (entry.from <= day && day <= entry.to) off += entry.hoursPerDay === null ? scheduled : entry.hoursPerDay;
    }
    return Math.min(off, scheduled);
  }

  /** Hours available on a day. */
  available(carrier: string, day: number): number {
    let days = this.memo.get(carrier);
    if (!days) {
      days = new Map();
      this.memo.set(carrier, days);
    }
    let hours = days.get(day);
    if (hours === undefined) {
      hours = Math.max(0, this.scheduled(carrier, day) - this.off(carrier, day));
      days.set(day, hours);
    }
    return hours;
  }

  /** Hours available from one day to another, both included. */
  sum(carrier: string, from: number, to: number): number {
    let total = 0;
    for (let day = from; day <= to; day += 1) total += this.available(carrier, day);
    return total;
  }

  /** Hours scheduled from one day to another, before time off. */
  scheduledSum(carrier: string, from: number, to: number): number {
    let total = 0;
    for (let day = from; day <= to; day += 1) total += this.scheduled(carrier, day);
    return total;
  }
}

/* -------------------------------------------------------------------------- */
/* Demand (BR-313)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Something that asks for someone's time. `work`: a work package assigned to
 * someone, with the hours still to do and its dates. `allocation`: a person,
 * placeholder or role booked to a project for so many hours a week.
 */
export interface DemandItem {
  /** `wp:<id>` or `allocation:<id>`. */
  id: string;
  kind: 'work' | 'allocation';
  /** Whoever it falls on; null for a role booked with nobody named. */
  carrier: string | null;
  roleId: string | null;
  projectId: number;
  /** Work: hours still to do. Allocation: hours a week. */
  hours: number;
  start: number | null;
  due: number | null;
}

/**
 * When a demand item's hours fall, day by day, from `today` on.
 *
 * Work spreads its remaining hours over its dates from today — the days its
 * carrier is available, in proportion to their hours, so time off and part-time
 * days take less of it. Where the carrier has no hours at all in its dates the
 * work is still due then, so it is spread over the instance's working days and
 * shows against nothing. Work overdue — or due in what is left of the week,
 * when that is a weekend — falls on the next working day. Work with no dates
 * falls on no day: it is counted apart (`undated`).
 *
 * An allocation's weekly hours fall on its carrier's scheduled days of each
 * week, time off notwithstanding — a booking is a booking, and a week it
 * cannot be met in is exactly what should show. A role booked alone, or a
 * carrier with no schedule that week, takes the instance's working days.
 */
export function spread(item: DemandItem, availability: AvailabilityModel, today: number): Map<number, number> | null {
  const out = new Map<number, number>();
  if (!(item.hours > 0)) return out;
  if (item.kind === 'work') {
    if (item.start === null && item.due === null) return null;
    let first = item.start ?? item.due!;
    let last = item.due ?? item.start!;
    if (last < first) [first, last] = [last, first];
    first = Math.max(first, today);
    last = Math.max(last, first);
    const weights: [number, number][] = [];
    let total = 0;
    for (let day = first; day <= last; day += 1) {
      const weight = item.carrier ? availability.available(item.carrier, day) : workday(availability.calendar, day) ? 1 : 0;
      if (weight > 0) {
        weights.push([day, weight]);
        total += weight;
      }
    }
    if (total === 0) {
      for (let day = first; day <= last; day += 1) {
        if (workday(availability.calendar, day)) {
          weights.push([day, 1]);
          total += 1;
        }
      }
    }
    if (total === 0) {
      // Not one working day from today to its finish: the next there is.
      let next = first;
      for (let guard = 0; guard < 21 && !workday(availability.calendar, next); guard += 1) next += 1;
      out.set(next, item.hours);
      return out;
    }
    for (const [day, weight] of weights) out.set(day, (item.hours * weight) / total);
    return out;
  }

  // An allocation: hours a week, over its stretch from today.
  if (item.start === null || item.due === null) return null;
  const first = Math.max(item.start, today);
  const last = item.due;
  for (let week = weekOf(first); week <= last; week += 7) {
    const weekWeights: [number, number][] = [];
    let weekTotal = 0;
    for (let day = week; day < week + 7; day += 1) {
      const weight = item.carrier ? availability.scheduled(item.carrier, day) : 0;
      weekWeights.push([day, weight]);
      weekTotal += weight;
    }
    if (weekTotal === 0) {
      weekWeights.length = 0;
      for (let day = week; day < week + 7; day += 1) {
        const weight = workday(availability.calendar, day) ? 1 : 0;
        weekWeights.push([day, weight]);
        weekTotal += weight;
      }
    }
    if (weekTotal === 0) continue;
    for (const [day, weight] of weekWeights) {
      if (weight === 0 || day < first || day > last) continue;
      out.set(day, (out.get(day) ?? 0) + (item.hours * weight) / weekTotal);
    }
  }
  return out;
}

const workday = (calendar: InstanceCalendar, day: number) =>
  isInstanceWorkday(calendar, weekdayIndex(day)) && !calendar.holidays.has(day);

/* -------------------------------------------------------------------------- */
/* Weekly load                                                                */
/* -------------------------------------------------------------------------- */

export interface Contribution {
  itemId: string;
  hours: number;
}

/** One carrier's week: what they have, and what falls on them. */
export interface CarrierWeek {
  carrier: string;
  /** The Monday. */
  week: number;
  /** Hours available: from today in the current week. */
  available: number;
  /** Assigned work falling in the week. */
  committed: number;
  /** Planned allocations falling in the week. */
  planned: number;
  /** What makes up `committed` and `planned`, largest first. */
  contributions: Contribution[];
}

export const loadOf = (week: Pick<CarrierWeek, 'committed' | 'planned'>): number => week.committed + week.planned;

/** Over-allocated: more falls on them than they have (BR-110). */
export const isOverAllocated = (week: Pick<CarrierWeek, 'available' | 'committed' | 'planned'>): boolean =>
  loadOf(week) > week.available + EPSILON;

/**
 * Each carrier's weeks from `fromWeek` to `toWeek` (Mondays): hours available
 * and the demand that falls on them, with what it is made of. The current week
 * counts from today, both sides; earlier weeks have no demand (it is forward).
 */
export function weeklyLoads(
  items: readonly DemandItem[],
  availability: AvailabilityModel,
  carriers: Iterable<string>,
  fromWeek: number,
  toWeek: number,
  today: number,
): Map<string, Map<number, CarrierWeek>> {
  const out = new Map<string, Map<number, CarrierWeek>>();
  for (const carrier of carriers) {
    const weeks = new Map<number, CarrierWeek>();
    for (let week = fromWeek; week <= toWeek; week += 7) {
      const first = week <= today && today <= week + 6 ? today : week;
      weeks.set(week, {
        carrier,
        week,
        available: availability.sum(carrier, first, week + 6),
        committed: 0,
        planned: 0,
        contributions: [],
      });
    }
    out.set(carrier, weeks);
  }
  const contributions = new Map<CarrierWeek, Map<string, number>>();
  for (const item of items) {
    if (!item.carrier) continue;
    const weeks = out.get(item.carrier);
    if (!weeks) continue;
    const days = spread(item, availability, today);
    if (!days) continue;
    for (const [day, hours] of days) {
      const cell = weeks.get(weekOf(day));
      if (!cell) continue;
      if (item.kind === 'work') cell.committed += hours;
      else cell.planned += hours;
      let parts = contributions.get(cell);
      if (!parts) {
        parts = new Map();
        contributions.set(cell, parts);
      }
      parts.set(item.id, (parts.get(item.id) ?? 0) + hours);
    }
  }
  for (const [cell, parts] of contributions) {
    cell.contributions = [...parts.entries()]
      .map(([itemId, hours]) => ({ itemId, hours }))
      .sort((a, b) => b.hours - a.hours || a.itemId.localeCompare(b.itemId));
  }
  return out;
}

/** Every over-allocated week of every carrier, earliest first (BR-110). */
export function overAllocated(loads: Map<string, Map<number, CarrierWeek>>): CarrierWeek[] {
  const out: CarrierWeek[] = [];
  for (const weeks of loads.values()) for (const week of weeks.values()) if (isOverAllocated(week)) out.push(week);
  return out.sort((a, b) => a.week - b.week || a.carrier.localeCompare(b.carrier));
}

/* -------------------------------------------------------------------------- */
/* Heatmap bands (BR-314)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Percentages of available hours. Below `under`: spare capacity. From `under`
 * to `full`: healthy. Above `full` up to `over`: full. Above `over`: over.
 */
export interface Thresholds {
  under: number;
  full: number;
  over: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { under: 60, full: 90, over: 100 };

export type Band = 'none' | 'under' | 'healthy' | 'full' | 'over';

/** A percentage of available hours; null where nothing is available and nothing asked. */
export function ratioOf(load: number, available: number): number | null {
  if (available > EPSILON) return (load / available) * 100;
  return load > EPSILON ? Number.POSITIVE_INFINITY : null;
}

export function bandOf(ratio: number | null, thresholds: Thresholds): Band {
  if (ratio === null) return 'none';
  if (ratio > thresholds.over) return 'over';
  if (ratio > thresholds.full) return 'full';
  if (ratio >= thresholds.under) return 'healthy';
  return 'under';
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The instance calendar from the analytics model's non-working days. */
export function instanceCalendarOf(
  nonWorking: ReadonlySet<number>,
  workingWeekdays: ReadonlySet<number>,
): InstanceCalendar {
  const holidays = new Set<number>();
  for (const day of nonWorking) if (isInstanceWorkday({ workingWeekdays, holidays }, weekdayIndex(day))) holidays.add(day);
  return { workingWeekdays, holidays };
}
