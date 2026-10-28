/**
 * Delivery forecasting (BR-509, BR-510): pure — facts in, forecasts out.
 *
 * The model is the organisation's own history. From every closed work package
 * that had a due date it learns how late (or early) work finishes, in working
 * days, and from those with an estimate how the hours actually spent compare
 * with it — each by kind of work and size, falling back to everything where a
 * group is too small to trust. Nothing is assumed about how work behaves.
 *
 * A project's forecast simulates its open work many times: each work package
 * finishes at its due date moved by a slip drawn from its group's history
 * (work already late can only finish later still), and the project finishes
 * when its last one does. The share of runs finishing by the project's planned
 * finish is its completion probability; the 10th, 50th and 90th percentiles are
 * its range. Effort and cost at completion come the same way, from the
 * estimate multipliers. The random draws are seeded from the inputs, so a
 * forecast is reproduced exactly from what was stored (BR-510).
 */

export interface Calendar {
  /** Instance non-working days (days since 1970-01-01). */
  nonWorking: ReadonlySet<number>;
  /** Monday 0 … Sunday 6. */
  workingWeekdays: ReadonlySet<number>;
}

export interface HistoryItem {
  id: number;
  group: string;
  /** Due and actual finish, as day numbers. */
  due: number;
  finished: number;
  estimatedHours: number | null;
  spentHours: number;
}

export interface OpenItem {
  id: number;
  subject: string;
  group: string;
  /** Due, as a day number; null where it has none (it then does not bound the finish). */
  due: number | null;
  estimatedHours: number | null;
  spentHours: number;
}

export interface GroupStats {
  group: string;
  /** Working-day slips (finish − due), sorted. */
  slips: number[];
  /** Spent ÷ estimated, sorted. */
  effortRatios: number[];
}

export interface ForecastModel {
  version: string;
  trainedOn: { items: number; withEstimates: number; from: number | null; to: number | null };
  groups: Record<string, GroupStats>;
  overall: GroupStats;
  minGroupSize: number;
}

export interface ProjectInput {
  projectId: number;
  name: string;
  today: number;
  plannedFinish: number | null;
  budget: number | null;
  spentCost: number;
  /** Hours spent on all of its work so far, closed work included. */
  spentHours: number;
  /** Average labour cost per hour so far, for remaining hours; null without any. */
  costPerHour: number | null;
  open: OpenItem[];
}

export interface Factor {
  workPackageId: number;
  subject: string;
  /** Share of runs in which this item finished last. */
  drivesFinish: number;
  group: string;
  medianSlipDays: number;
  remainingHours: number | null;
}

export interface ProjectForecast {
  projectId: number;
  name: string;
  modelVersion: string;
  runs: number;
  plannedFinish: number | null;
  /** Share of runs finishing by the planned finish; null without a planned finish. */
  probabilityOnTime: number | null;
  finish: { p10: number; p50: number; p90: number } | null;
  effort: { spentHours: number; remainingP50: number; remainingP80: number; atCompletionP50: number; atCompletionP80: number };
  cost: { spent: number; atCompletionP50: number | null; atCompletionP80: number | null; budget: number | null; overrunP50: number | null; probabilityOverBudget: number | null };
  factors: Factor[];
}

export const MIN_GROUP = 10;
export const RUNS = 2000;

/* ------------------------------------------------------------------ calendar */

const weekday = (day: number) => (((day + 3) % 7) + 7) % 7;
export const isWorking = (calendar: Calendar, day: number) => calendar.workingWeekdays.has(weekday(day)) && !calendar.nonWorking.has(day);

/** Working days from a to b: positive when b is later. */
export function workingDaysBetween(calendar: Calendar, a: number, b: number): number {
  if (a === b) return 0;
  const sign = b > a ? 1 : -1;
  let count = 0;
  for (let day = Math.min(a, b) + 1; day <= Math.max(a, b); day += 1) if (isWorking(calendar, day)) count += 1;
  return sign * count;
}

/** The day `n` working days after `from` (before, for negative n). */
export function addWorkingDays(calendar: Calendar, from: number, n: number): number {
  let day = from;
  let left = Math.abs(Math.round(n));
  const step = n >= 0 ? 1 : -1;
  for (let guard = 0; left > 0 && guard < 20_000; guard += 1) {
    day += step;
    if (isWorking(calendar, day)) left -= 1;
  }
  return day;
}

/* --------------------------------------------------------------------- model */

/** Kind and size: the grouping slips and effort are learnt by. */
export function groupOf(typeCategory: string, estimatedHours: number | null): string {
  const size = estimatedHours === null || estimatedHours <= 0 ? 'unsized' : estimatedHours < 8 ? 'small' : estimatedHours <= 40 ? 'medium' : 'large';
  return `${typeCategory || 'task'}:${size}`;
}

/** JSON with every object's keys in order: the same value, the same text, however it was stored. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A short, stable hash of anything JSON can hold — the same whatever order its keys were stored in. */
export function hashOf(value: unknown): string {
  const text = canonical(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function trainModel(history: HistoryItem[], calendar: Calendar, minGroupSize = MIN_GROUP): ForecastModel {
  const groups: Record<string, GroupStats> = {};
  const overall: GroupStats = { group: '*', slips: [], effortRatios: [] };
  let withEstimates = 0;
  for (const item of [...history].sort((a, b) => a.id - b.id)) {
    const slip = workingDaysBetween(calendar, item.due, item.finished);
    const stats = (groups[item.group] ??= { group: item.group, slips: [], effortRatios: [] });
    stats.slips.push(slip);
    overall.slips.push(slip);
    if (item.estimatedHours && item.estimatedHours > 0 && item.spentHours > 0) {
      const ratio = item.spentHours / item.estimatedHours;
      stats.effortRatios.push(ratio);
      overall.effortRatios.push(ratio);
      withEstimates += 1;
    }
  }
  for (const stats of [...Object.values(groups), overall]) {
    stats.slips.sort((a, b) => a - b);
    stats.effortRatios.sort((a, b) => a - b);
  }
  // reduce, not Math.min(...): past about 120,000 finished work packages the
  // spread exceeds the arguments a call may take, and training would throw.
  const trainedOn = {
    items: history.length,
    withEstimates,
    from: history.length ? history.reduce((first, item) => Math.min(first, item.finished), Infinity) : null,
    to: history.length ? history.reduce((last, item) => Math.max(last, item.finished), -Infinity) : null,
  };
  const body = { groups, overall, minGroupSize };
  return { version: hashOf(body), trainedOn, ...body };
}

const statsFor = (model: ForecastModel, group: string): GroupStats => {
  const own = model.groups[group];
  return own && own.slips.length >= model.minGroupSize ? own : model.overall;
};
const effortFor = (model: ForecastModel, group: string): number[] => {
  const own = model.groups[group];
  return own && own.effortRatios.length >= model.minGroupSize ? own.effortRatios : model.overall.effortRatios;
};

/* ------------------------------------------------------------------ forecast */

/** A small seeded generator (mulberry32): the same seed, the same draws. */
function rng(seed: string): () => number {
  let a = parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};
const median = (sorted: readonly number[]) => percentile(sorted, 50);
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

export function forecastProject(input: ProjectInput, model: ForecastModel, calendar: Calendar, runs = RUNS): ProjectForecast {
  const random = rng(hashOf({ input, model: model.version, runs }));
  const finishes: number[] = [];
  const remaining: number[] = [];
  const drivers = new Map<number, number>();
  const dated = input.open.filter((item) => item.due !== null);

  // What does not change from run to run is worked out once per work package —
  // how late it already is, the slips it may draw, its effort ratios — and the
  // day each slip lands on once per due date. Draws are made in the same order
  // as before, so a stored forecast still reproduces exactly; a large history
  // no longer costs its full length on every run of every work package.
  const landings = new Map<number, Map<number, number>>();
  const plans = input.open.map((item) => {
    if (item.due === null) return { item, lateBy: 0, pool: [] as number[], landsOn: null };
    // Work already late can only finish later still: draw among the slips
    // at least as late as it already is.
    const lateBy = Math.max(0, workingDaysBetween(calendar, item.due, input.today));
    const slips = statsFor(model, item.group).slips;
    let landsOn = landings.get(item.due);
    if (!landsOn) landings.set(item.due, (landsOn = new Map()));
    return { item, lateBy, pool: lateBy > 0 ? slips.filter((slip) => slip >= lateBy) : slips, landsOn };
  });

  for (let run = 0; run < runs; run += 1) {
    let last = input.today;
    let lastId: number | null = null;
    let hours = 0;
    for (const { item, lateBy, pool, landsOn } of plans) {
      if (item.due !== null) {
        const slip = pool.length ? pool[Math.floor(random() * pool.length)]! : lateBy + 1;
        let landed = landsOn!.get(slip);
        if (landed === undefined) landsOn!.set(slip, (landed = addWorkingDays(calendar, item.due, slip)));
        const finish = Math.max(input.today, landed);
        if (finish > last || lastId === null) {
          last = finish;
          lastId = item.id;
        }
      }
      if (item.estimatedHours && item.estimatedHours > 0) {
        const ratios = effortFor(model, item.group);
        const ratio = ratios.length ? ratios[Math.floor(random() * ratios.length)]! : 1;
        hours += Math.max(0, item.estimatedHours * ratio - item.spentHours);
      }
    }
    finishes.push(last);
    remaining.push(hours);
    if (lastId !== null) drivers.set(lastId, (drivers.get(lastId) ?? 0) + 1);
  }
  finishes.sort((a, b) => a - b);
  remaining.sort((a, b) => a - b);

  const spentHours = round(input.spentHours);
  const remainingP50 = round(percentile(remaining, 50));
  const remainingP80 = round(percentile(remaining, 80));
  const costAt = (hours: number) => (input.costPerHour === null ? null : Math.round(input.spentCost + hours * input.costPerHour));
  const costP50 = costAt(remainingP50);
  const costP80 = costAt(remainingP80);
  const overBudget =
    input.budget !== null && input.costPerHour !== null ? remaining.filter((hours) => input.spentCost + hours * input.costPerHour! > input.budget!).length / runs : null;

  const factors: Factor[] = [...drivers.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 5)
    .map(([id, count]) => {
      const item = input.open.find((open) => open.id === id)!;
      const ratios = effortFor(model, item.group);
      return {
        workPackageId: id,
        subject: item.subject,
        drivesFinish: round(count / runs, 3),
        group: item.group,
        medianSlipDays: median(statsFor(model, item.group).slips),
        remainingHours: item.estimatedHours ? round(Math.max(0, item.estimatedHours * (ratios.length ? median(ratios) : 1) - item.spentHours)) : null,
      };
    });

  return {
    projectId: input.projectId,
    name: input.name,
    modelVersion: model.version,
    runs,
    plannedFinish: input.plannedFinish,
    probabilityOnTime: input.plannedFinish === null || dated.length === 0 ? null : round(finishes.filter((day) => day <= input.plannedFinish!).length / runs, 3),
    finish: dated.length ? { p10: percentile(finishes, 10), p50: percentile(finishes, 50), p90: percentile(finishes, 90) } : null,
    effort: { spentHours, remainingP50, remainingP80, atCompletionP50: round(spentHours + remainingP50), atCompletionP80: round(spentHours + remainingP80) },
    cost: {
      spent: Math.round(input.spentCost),
      atCompletionP50: costP50,
      atCompletionP80: costP80,
      budget: input.budget,
      overrunP50: costP50 !== null && input.budget !== null ? costP50 - input.budget : null,
      probabilityOverBudget: overBudget === null ? null : round(overBudget, 3),
    },
    factors,
  };
}

/* --------------------------------------------------------------- back-test */

export interface BacktestCase {
  /** What was predicted at the cut-off, and what happened. */
  probability: number;
  onTime: boolean;
}

export interface Calibration {
  cases: number;
  /** Mean squared error of the probabilities: 0 is perfect, 0.25 is a coin. */
  brier: number | null;
  /** Expected calibration error over five bins: how far stated probabilities sit from observed frequencies. */
  calibrationError: number | null;
  bins: { from: number; to: number; cases: number; meanPredicted: number; observed: number }[];
}

export function calibrate(cases: BacktestCase[]): Calibration {
  if (cases.length === 0) return { cases: 0, brier: null, calibrationError: null, bins: [] };
  const brier = cases.reduce((sum, c) => sum + (c.probability - (c.onTime ? 1 : 0)) ** 2, 0) / cases.length;
  const bins = [0, 0.2, 0.4, 0.6, 0.8].map((from, index) => {
    const to = index === 4 ? 1.0001 : from + 0.2;
    const inBin = cases.filter((c) => c.probability >= from && c.probability < to);
    return {
      from,
      to: Math.min(1, to),
      cases: inBin.length,
      meanPredicted: inBin.length ? round(inBin.reduce((s, c) => s + c.probability, 0) / inBin.length, 3) : 0,
      observed: inBin.length ? round(inBin.filter((c) => c.onTime).length / inBin.length, 3) : 0,
    };
  });
  const ece = bins.reduce((sum, bin) => sum + (bin.cases / cases.length) * Math.abs(bin.meanPredicted - bin.observed), 0);
  return { cases: cases.length, brier: round(brier, 4), calibrationError: round(ece, 4), bins };
}
