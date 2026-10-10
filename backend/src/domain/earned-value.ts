import { dayOf } from './critical-path.js';
import { msg, t, type Language } from '../lib/i18n.js';
import { roundMoney } from '../lib/money.js';

/**
 * Earned value (BR-301, BR-302): planned value, earned value and actual cost,
 * and what they say about schedule and cost — for a work package, a project or
 * a portfolio, as at any reporting date.
 *
 * - Budget at completion (BAC): each work package's own estimated hours at an
 *   hourly rate, as the plan being measured against priced them — the same
 *   rule actual cost is priced by. Parents' figures are their own, never their
 *   children's added again, so every hour is counted once.
 * - Planned value (PV): its budget spread evenly over the working days from its
 *   planned start to its planned finish, as far as the reporting date. A
 *   milestone, or anything planned for a single day, is planned all at once on
 *   that day.
 * - Earned value (EV): its budget times the share its type's earning rule
 *   credits it with (`EARNING_METHODS`). Delivered work has earned all of it,
 *   whatever the rule.
 * - Actual cost (AC): labour logged up to the reporting date, priced at the
 *   hourly rate of whoever logged it (`costs.ts`). At project level, every hour
 *   on the project — work outside the plan included.
 * - Then: schedule variance SV = EV − PV, cost variance CV = EV − AC, schedule
 *   performance index SPI = EV / PV, cost performance index CPI = EV / AC,
 *   estimate at completion EAC = BAC / CPI, estimate to complete ETC = EAC − AC,
 *   variance at completion VAC = BAC − EAC, and the to-complete performance
 *   index TCPI = (BAC − EV) / (BAC − AC): the efficiency the remaining work
 *   needs to finish on budget.
 *
 * Pure: no database and no OpenProject. `earned-value-data.ts` supplies the
 * plan, the progress and the labour, and the measures report what this returns.
 */

export type EarningMethod = 'percent_complete' | 'zero_hundred' | 'fifty_fifty' | 'milestone_weighted' | 'level_of_effort';

export const DEFAULT_METHOD: EarningMethod = 'percent_complete';

/**
 * In English, as the journal and the BI tables keep them; each is a catalogue
 * entry, written out in the reader's language where it is shown
 * (`earningMethodsIn`, and the Earned value dashboard's "Earns by" column).
 */
export const EARNING_METHODS: Record<EarningMethod, { label: string; describe: string }> = {
  percent_complete: {
    label: msg('% complete'),
    describe: msg('Earns its % complete of its budget.'),
  },
  zero_hundred: {
    label: msg('0/100'),
    describe: msg('Earns nothing until it is delivered, then all of its budget.'),
  },
  fifty_fifty: {
    label: msg('50/50'),
    describe: msg('Earns half its budget when work starts on it, the rest when it is delivered.'),
  },
  milestone_weighted: {
    label: msg('Milestone weighted'),
    describe: msg(
      'Earns as the milestones under it are reached, each worth its estimated hours (or an equal share where none are set). With no milestones under it, all when delivered.',
    ),
  },
  level_of_effort: {
    label: msg('Level of effort'),
    describe: msg('Earns with the passage of time, exactly as planned: its earned value is its planned value.'),
  },
};

/** The earning rules, with their words in `language`. */
export function earningMethodsIn(language: Language): { id: EarningMethod; label: string; describe: string }[] {
  return (Object.entries(EARNING_METHODS) as [EarningMethod, { label: string; describe: string }][]).map(([id, method]) => ({
    id,
    label: t(language, method.label),
    describe: t(language, method.describe),
  }));
}

export const isEarningMethod = (value: unknown): value is EarningMethod =>
  typeof value === 'string' && Object.hasOwn(EARNING_METHODS, value);

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** A work package as the plan being measured against has it. */
export interface PlannedItem {
  workPackageId: number;
  projectId: number;
  parentId: number | null;
  typeId: number;
  isMilestone: boolean;
  estimatedHours: number | null;
  /** The hourly rate its budget is priced at; null when nobody's rate applies. */
  rate: number | null;
  /** Estimated hours × rate; null when it has hours but no rate to price them. */
  bac: number | null;
  plannedStart: string | null;
  plannedFinish: string | null;
}

/** A work package as it stood at the reporting date. */
export interface ProgressState {
  workPackageId: number;
  parentId: number | null;
  isMilestone: boolean;
  /** % complete, 0–100. */
  doneRatio: number | null;
  /** Closed in a done status: the work was delivered. */
  delivered: boolean;
  /** Under way: in progress, in review or done, or with any progress recorded. */
  started: boolean;
  estimatedHours: number | null;
}

/** An hour of labour logged, as the model prices it. */
export interface LabourEntry {
  projectId: number | null;
  workPackageId: number | null;
  spentOn: string;
  hours: number;
  /** Null when whoever logged it has no hourly rate: not costed, rather than free. */
  cost: number | null;
}

/** Working days, as the instance's calendar has them. */
export interface WorkingCalendar {
  isWorking(day: number): boolean;
}

/* -------------------------------------------------------------------------- */
/* Days                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Counts working days quickly: a running total over the range asked about,
 * built once and extended as wider ranges are asked for.
 */
export class WorkingDayCounter {
  private from = 0;
  private totals: number[] = [];

  constructor(private readonly calendar: WorkingCalendar) {}

  private cover(low: number, high: number): void {
    const to = this.from + this.totals.length - 1;
    if (this.totals.length > 0 && low >= this.from && high <= to) return;
    const start = this.totals.length > 0 ? Math.min(low, this.from) : low;
    const end = this.totals.length > 0 ? Math.max(high, to) : high;
    const totals: number[] = new Array(end - start + 1);
    let running = 0;
    for (let day = start; day <= end; day += 1) {
      if (this.calendar.isWorking(day)) running += 1;
      totals[day - start] = running;
    }
    this.from = start;
    this.totals = totals;
  }

  /** Working days from `first` to `last`, both counted. */
  between(first: number, last: number): number {
    if (last < first) return 0;
    this.cover(first - 1, last);
    return this.totals[last - this.from]! - this.totals[first - 1 - this.from]!;
  }
}

/**
 * How much of a work package's budget is planned to be spent by the end of
 * `at`: the working days of its planned span gone by, of all of them. Before
 * it starts nothing, from its finish all. Null without planned dates.
 */
export function plannedShare(start: string | null, finish: string | null, at: string, days: WorkingDayCounter): number | null {
  if (!start || !finish) return null;
  const first = dayOf(start <= finish ? start : finish);
  const last = dayOf(start <= finish ? finish : start);
  const now = dayOf(at);
  if (now < first) return 0;
  if (now >= last) return 1;
  const total = days.between(first, last);
  // A span with no working day in it: spread over its calendar days instead.
  if (total === 0) return (now - first + 1) / (last - first + 1);
  return days.between(first, now) / total;
}

/* -------------------------------------------------------------------------- */
/* Earning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The share of its budget a work package has earned at the reporting date,
 * under its method. Work that did not exist yet has earned nothing; delivered
 * work has earned all of it.
 */
export function earnedShare(
  method: EarningMethod,
  state: ProgressState | undefined,
  milestonesUnder: ProgressState[],
  planned: number | null,
): number {
  if (!state) return 0;
  if (state.delivered) return 1;
  switch (method) {
    case 'percent_complete':
      return Math.min(1, Math.max(0, (state.doneRatio ?? 0) / 100));
    case 'zero_hundred':
      return 0;
    case 'fifty_fifty':
      return state.started ? 0.5 : 0;
    case 'milestone_weighted': {
      if (milestonesUnder.length === 0) return 0;
      const weight = (milestone: ProgressState) => (milestone.estimatedHours && milestone.estimatedHours > 0 ? milestone.estimatedHours : 1);
      const all = milestonesUnder.reduce((sum, milestone) => sum + weight(milestone), 0);
      const reached = milestonesUnder.filter((milestone) => milestone.delivered).reduce((sum, milestone) => sum + weight(milestone), 0);
      return all > 0 ? reached / all : 0;
    }
    case 'level_of_effort':
      return planned ?? 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Figures                                                                    */
/* -------------------------------------------------------------------------- */

export interface Indices {
  /** Schedule variance, EV − PV. */
  sv: number | null;
  /** Cost variance, EV − AC. */
  cv: number | null;
  /** Schedule performance index, EV / PV. */
  spi: number | null;
  /** Cost performance index, EV / AC. */
  cpi: number | null;
}

export interface ItemFigures extends Indices {
  workPackageId: number;
  projectId: number;
  method: EarningMethod;
  bac: number | null;
  /** Share of the budget planned by the reporting date; null without planned dates. */
  plannedShare: number | null;
  /** Share of the budget earned. */
  earnedShare: number;
  pv: number | null;
  ev: number | null;
  /** Labour logged on it up to the reporting date. */
  ac: number;
}

export interface Totals extends Indices {
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  /** Estimate at completion, BAC / CPI; BAC itself while nothing is spent. */
  eac: number | null;
  /** Estimate to complete, EAC − AC. */
  etc: number | null;
  /** Variance at completion, BAC − EAC. */
  vac: number | null;
  /** To-complete performance index, (BAC − EV) / (BAC − AC). */
  tcpi: number | null;
  counts: {
    /** Work packages in the plan. */
    planned: number;
    /** With hours to price but no rate to price them at: left out of the figures. */
    unpriced: number;
    /** With a budget but no planned dates: counted in BAC, planned for no date. */
    undated: number;
  };
  /** Of AC, what was logged on work the plan does not have. */
  acOutsidePlan: number;
  /** Hours logged by people with no rate: in no figure. */
  uncostedHours: number;
}

export interface EvaluationInput {
  /** The reporting date, inclusive: `YYYY-MM-DD`. */
  at: string;
  /** The plan being measured against. */
  items: PlannedItem[];
  /** Work as it stood at the reporting date, by id — the plan's and anything under it. */
  progress: Map<number, ProgressState>;
  methodOf(typeId: number): EarningMethod;
  days: WorkingDayCounter;
  /** The labour of the projects being measured, any date: those after `at` are left out here. */
  labour: LabourEntry[];
}

export interface Evaluation {
  items: ItemFigures[];
  totals: Totals;
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;

/** SV, CV, SPI and CPI from the three figures. */
export function indices(pv: number | null, ev: number | null, ac: number): Indices {
  if (pv === null || ev === null) return { sv: null, cv: null, spi: null, cpi: null };
  return {
    sv: roundMoney(ev - pv),
    cv: roundMoney(ev - ac),
    spi: ratio(ev, pv),
    cpi: ratio(ev, ac),
  };
}

/** The forecasts from the totals. */
export function forecasts(bac: number, ev: number, ac: number): Pick<Totals, 'eac' | 'etc' | 'vac' | 'tcpi'> {
  const cpi = ac > 0 ? ev / ac : null;
  // Nothing spent yet: no evidence of efficiency, so the plan stands.
  // Spent but nothing earned: no finite estimate.
  const eac = cpi === null ? bac : cpi > 0 ? roundMoney(bac / cpi) : null;
  return {
    eac,
    etc: eac === null ? null : roundMoney(eac - ac),
    vac: eac === null ? null : roundMoney(bac - eac),
    tcpi: bac - ac > 0 ? ratio(bac - ev, bac - ac) : null,
  };
}

/** Earned value for one plan, as at one reporting date. */
export function evaluateEarnedValue(input: EvaluationInput): Evaluation {
  const { at, items, progress, days } = input;
  const labour = input.labour.filter((entry) => entry.spentOn <= at);

  const acByItem = new Map<number, number>();
  let ac = 0;
  let uncostedHours = 0;
  for (const entry of labour) {
    if (entry.cost === null) {
      uncostedHours += entry.hours;
      continue;
    }
    ac += entry.cost;
    if (entry.workPackageId !== null) acByItem.set(entry.workPackageId, (acByItem.get(entry.workPackageId) ?? 0) + entry.cost);
  }

  const milestonesUnder = new Map<number, ProgressState[]>();
  for (const state of progress.values()) {
    if (!state.isMilestone || state.parentId === null) continue;
    milestonesUnder.set(state.parentId, [...(milestonesUnder.get(state.parentId) ?? []), state]);
  }

  const results: ItemFigures[] = [];
  let bac = 0;
  let pv = 0;
  let ev = 0;
  let unpriced = 0;
  let undated = 0;
  const inPlan = new Set<number>();
  for (const item of items) {
    inPlan.add(item.workPackageId);
    const method = input.methodOf(item.typeId);
    const share = plannedShare(item.plannedStart, item.plannedFinish, at, days);
    const earned = earnedShare(method, progress.get(item.workPackageId), milestonesUnder.get(item.workPackageId) ?? [], share);
    const itemAc = roundMoney(acByItem.get(item.workPackageId) ?? 0);
    if (item.bac === null) {
      unpriced += 1;
      results.push({ workPackageId: item.workPackageId, projectId: item.projectId, method, bac: null, plannedShare: share, earnedShare: earned, pv: null, ev: null, ac: itemAc, sv: null, cv: null, spi: null, cpi: null });
      continue;
    }
    if (share === null && item.bac > 0) undated += 1;
    const itemPv = roundMoney(item.bac * (share ?? 0));
    const itemEv = roundMoney(item.bac * earned);
    bac += item.bac;
    pv += itemPv;
    ev += itemEv;
    results.push({
      workPackageId: item.workPackageId,
      projectId: item.projectId,
      method,
      bac: roundMoney(item.bac),
      plannedShare: share,
      earnedShare: earned,
      pv: itemPv,
      ev: itemEv,
      ac: itemAc,
      ...indices(itemPv, itemEv, itemAc),
    });
  }

  const acOutsidePlan = [...acByItem.entries()].filter(([id]) => !inPlan.has(id)).reduce((sum, [, cost]) => sum + cost, 0) +
    labour.filter((entry) => entry.workPackageId === null && entry.cost !== null).reduce((sum, entry) => sum + entry.cost!, 0);

  const totals = {
    bac: roundMoney(bac),
    pv: roundMoney(pv),
    ev: roundMoney(ev),
    ac: roundMoney(ac),
  };
  return {
    items: results,
    totals: {
      ...totals,
      ...indices(totals.pv, totals.ev, totals.ac),
      ...forecasts(totals.bac, totals.ev, totals.ac),
      counts: { planned: items.length, unpriced, undated },
      acOutsidePlan: roundMoney(acOutsidePlan),
      uncostedHours: Math.round(uncostedHours * 100) / 100,
    },
  };
}

/**
 * Totals for several plans — a portfolio's projects — added up: the money
 * figures summed, the indices and forecasts from the sums, never averaged.
 */
export function combineTotals(parts: Totals[]): Totals {
  const sum = (pick: (totals: Totals) => number) => roundMoney(parts.reduce((total, part) => total + pick(part), 0));
  const bac = sum((part) => part.bac);
  const pv = sum((part) => part.pv);
  const ev = sum((part) => part.ev);
  const ac = sum((part) => part.ac);
  return {
    bac,
    pv,
    ev,
    ac,
    ...indices(pv, ev, ac),
    ...forecasts(bac, ev, ac),
    counts: {
      planned: parts.reduce((total, part) => total + part.counts.planned, 0),
      unpriced: parts.reduce((total, part) => total + part.counts.unpriced, 0),
      undated: parts.reduce((total, part) => total + part.counts.undated, 0),
    },
    acOutsidePlan: sum((part) => part.acOutsidePlan),
    uncostedHours: Math.round(parts.reduce((total, part) => total + part.uncostedHours, 0) * 100) / 100,
  };
}
