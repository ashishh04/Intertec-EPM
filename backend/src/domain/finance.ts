/**
 * The finance engine (Module 11, part 2): pure figures, no I/O, so each can be
 * checked against a control worked out by hand (`__checks__/finance.check.ts`).
 *
 * - Budget phasing across months (BR-310), always summing to the budget.
 * - Planned against actual cash flow, month by month and cumulative (BR-311).
 * - Estimated against actual margin (BR-318).
 * - Labour revenue forecast, weighted by confidence (BR-319).
 * - Reconciling billable items with what was approved (BR-322) and a
 *   transferred batch with the finance system's answer (BR-323).
 *
 * Money is added up in whole cents, so parts and totals agree exactly.
 */

export type BillingModel = 'time_and_materials' | 'fixed_price' | 'non_billable';
export const BILLING_MODELS: BillingModel[] = ['time_and_materials', 'fixed_price', 'non_billable'];

export const toCents = (value: number): number => Math.round(value * 100);
export const fromCents = (cents: number): number => cents / 100;
export const money = (value: number): number => fromCents(toCents(value));

/* -------------------------------------------------------------------------- */
/* Months                                                                     */
/* -------------------------------------------------------------------------- */

/** The month a day falls in, as its first day: 2026-10-14 → 2026-10-01. */
export const monthOf = (day: string): string => `${day.slice(0, 7)}-01`;

/** The last day of a month given by its first day. */
export function monthEnd(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, mon, 0));
  return last.toISOString().slice(0, 10);
}

/** The month after. */
export function nextMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10);
}

/** The day before a day. */
export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Every month from the one `first` falls in to the one `last` falls in. */
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  const end = monthOf(last);
  for (let month = monthOf(first); month <= end; month = nextMonth(month)) out.push(month);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Apportioning                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Splits `total` in proportion to `weights` so that the parts add up to it
 * exactly, to the cent: each part is rounded down and the cents left over go,
 * one each, to the largest remainders (earliest first on a tie). With no
 * weight at all it is split evenly.
 */
export function apportion(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const cents = toCents(total);
  const positive = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const sum = positive.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? positive.map((weight) => (cents * weight) / sum) : positive.map(() => cents / weights.length);
  const floors = shares.map((share) => Math.floor(share));
  let left = cents - floors.reduce((a, b) => a + b, 0);
  const order = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index]! += 1;
    left -= 1;
  }
  return floors.map(fromCents);
}

/* -------------------------------------------------------------------------- */
/* Budget phasing (BR-310)                                                    */
/* -------------------------------------------------------------------------- */

export interface PhasingItem {
  /** The work package's priced estimate; null or 0 when it has none. */
  bac: number | null;
  start: string | null;
  finish: string | null;
}

export interface PhasingInput {
  budget: number;
  items: PhasingItem[];
  /** The project's planned start and finish. */
  plannedStart: string | null;
  plannedFinish: string | null;
  today: string;
  /** Earned value's planned share of a span spent by the end of a day (0..1). */
  share: (start: string, finish: string, at: string) => number | null;
  /** Working days from one day to another, both counted. */
  workingDays: (first: string, last: string) => number;
}

export type PhasingBasis = 'schedule' | 'dates' | 'single';

export interface Phase {
  month: string;
  amount: number;
}

/**
 * The budget spread over months from the schedule: in proportion to the
 * priced work planned in each month — each work package's estimate spread
 * over the working days of its dates, as earned value plans it. Without priced,
 * dated work, over the working days of the project's planned dates; without
 * those, all in one month — the planned start's, or this one.
 */
export function derivePhasing(input: PhasingInput): { basis: PhasingBasis; phases: Phase[] } {
  const priced = input.items.filter((item) => (item.bac ?? 0) > 0 && item.start && item.finish);
  if (priced.length > 0) {
    const first = priced.reduce((low, item) => (item.start! < low ? item.start! : low), priced[0]!.start!);
    const last = priced.reduce((high, item) => (item.finish! > high ? item.finish! : high), priced[0]!.finish!);
    const months = monthsBetween(first < last ? first : last, first < last ? last : first);
    const weights = months.map((month) => {
      let weight = 0;
      for (const item of priced) {
        const end = input.share(item.start!, item.finish!, monthEnd(month)) ?? 0;
        const before = input.share(item.start!, item.finish!, dayBefore(month)) ?? 0;
        weight += item.bac! * (end - before);
      }
      return weight;
    });
    if (weights.some((weight) => weight > 0)) {
      return { basis: 'schedule', phases: zip(months, apportion(input.budget, weights)) };
    }
  }
  if (input.plannedStart && input.plannedFinish && input.plannedStart <= input.plannedFinish) {
    const months = monthsBetween(input.plannedStart, input.plannedFinish);
    const weights = months.map((month) => {
      const from = month < input.plannedStart! ? input.plannedStart! : month;
      const end = monthEnd(month);
      const to = end > input.plannedFinish! ? input.plannedFinish! : end;
      return input.workingDays(from, to);
    });
    return { basis: 'dates', phases: zip(months, apportion(input.budget, weights)) };
  }
  return { basis: 'single', phases: [{ month: monthOf(input.plannedStart ?? input.today), amount: money(input.budget) }] };
}

const zip = (months: string[], amounts: number[]): Phase[] => months.map((month, index) => ({ month, amount: amounts[index]! }));

/** A phasing set by hand, scaled to a budget that has since changed — still summing to it exactly. */
export function rescalePhasing(phases: Phase[], budget: number): Phase[] {
  const amounts = apportion(
    budget,
    phases.map((phase) => phase.amount),
  );
  return phases.map((phase, index) => ({ month: phase.month, amount: amounts[index]! }));
}

/** How far a phasing set by hand is from the budget: 0 when it sums to it, to the cent. */
export function phasingDifference(phases: Phase[], budget: number): number {
  return fromCents(toCents(budget) - phases.reduce((sum, phase) => sum + toCents(phase.amount), 0));
}

/* -------------------------------------------------------------------------- */
/* Cash flow (BR-311)                                                         */
/* -------------------------------------------------------------------------- */

export interface CashFlowPoint {
  month: string;
  /** The phased budget for the month; null where there is no budget. */
  planned: number | null;
  labour: number;
  other: number;
  actual: number;
  cumulativePlanned: number | null;
  cumulativeActual: number;
}

export interface CashFlow {
  points: CashFlowPoint[];
  totals: { planned: number | null; labour: number; other: number; actual: number; uncostedHours: number };
}

/**
 * Planned against actual spend by month. Actual is labour — hours at the
 * person's rate — and other costs, each in the month it was spent; hours
 * nobody's rate prices are counted apart, in no figure. The months run from
 * the first planned or spent to the last, and at least to `through`.
 */
export function cashFlow(input: {
  planned: Phase[] | null;
  labour: { day: string; cost: number | null; hours: number }[];
  other: { day: string; amount: number }[];
  through?: string;
}): CashFlow {
  const plannedCents = new Map<string, number>();
  for (const phase of input.planned ?? []) plannedCents.set(phase.month, (plannedCents.get(phase.month) ?? 0) + toCents(phase.amount));
  const labourCents = new Map<string, number>();
  const otherCents = new Map<string, number>();
  let uncosted = 0;
  for (const entry of input.labour) {
    if (entry.hours <= 0) continue;
    if (entry.cost === null) {
      uncosted += entry.hours;
      continue;
    }
    const month = monthOf(entry.day);
    labourCents.set(month, (labourCents.get(month) ?? 0) + toCents(entry.cost));
  }
  for (const entry of input.other) {
    const month = monthOf(entry.day);
    otherCents.set(month, (otherCents.get(month) ?? 0) + toCents(entry.amount));
  }
  const all = [...plannedCents.keys(), ...labourCents.keys(), ...otherCents.keys()].sort();
  if (input.through) all.push(monthOf(input.through));
  if (all.length === 0) {
    return { points: [], totals: { planned: input.planned ? 0 : null, labour: 0, other: 0, actual: 0, uncostedHours: money(uncosted) } };
  }
  const first = all.reduce((a, b) => (a < b ? a : b));
  const last = all.reduce((a, b) => (a > b ? a : b));
  let runningPlanned = 0;
  let runningActual = 0;
  let totalLabour = 0;
  let totalOther = 0;
  const points = monthsBetween(first, last).map((month): CashFlowPoint => {
    const planned = input.planned ? (plannedCents.get(month) ?? 0) : null;
    const labour = labourCents.get(month) ?? 0;
    const other = otherCents.get(month) ?? 0;
    runningPlanned += planned ?? 0;
    runningActual += labour + other;
    totalLabour += labour;
    totalOther += other;
    return {
      month,
      planned: planned === null ? null : fromCents(planned),
      labour: fromCents(labour),
      other: fromCents(other),
      actual: fromCents(labour + other),
      cumulativePlanned: planned === null ? null : fromCents(runningPlanned),
      cumulativeActual: fromCents(runningActual),
    };
  });
  return {
    points,
    totals: {
      planned: input.planned ? fromCents(runningPlanned) : null,
      labour: fromCents(totalLabour),
      other: fromCents(totalOther),
      actual: fromCents(totalLabour + totalOther),
      uncostedHours: money(uncosted),
    },
  };
}

/** Adds cash flows month by month: a portfolio's from its projects'. */
export function combineCashFlows(flows: CashFlow[]): CashFlow {
  const hasPlan = flows.some((flow) => flow.totals.planned !== null);
  const combined = cashFlow({
    planned: hasPlan
      ? flows.flatMap((flow) => flow.points.filter((point) => point.planned !== null).map((point) => ({ month: point.month, amount: point.planned! })))
      : null,
    labour: flows.flatMap((flow) => flow.points.map((point) => ({ day: point.month, cost: point.labour, hours: 1 }))),
    other: flows.flatMap((flow) => flow.points.map((point) => ({ day: point.month, amount: point.other }))),
  });
  const uncostedHours = money(flows.reduce((sum, flow) => sum + flow.totals.uncostedHours, 0));
  return { ...combined, totals: { ...combined.totals, uncostedHours } };
}

/* -------------------------------------------------------------------------- */
/* Margin (BR-318)                                                            */
/* -------------------------------------------------------------------------- */

export interface MarginSide {
  revenue: number | null;
  cost: number | null;
  margin: number | null;
  /** Margin as a share of revenue, in %, to one decimal; null without revenue. */
  percent: number | null;
}

const side = (revenue: number | null, cost: number | null): MarginSide => {
  const margin = revenue === null || cost === null ? null : money(revenue - cost);
  return {
    revenue: revenue === null ? null : money(revenue),
    cost: cost === null ? null : money(cost),
    margin,
    percent: margin === null || !revenue ? null : Math.round((margin / revenue) * 1000) / 10,
  };
};

/**
 * What the project is expected to earn: its contract value; on time and
 * materials without one, its estimated hours at their bill rates; nothing when
 * it is not billed.
 */
export function estimatedRevenue(model: BillingModel, contractValue: number | null, pricedEstimate: number | null): number | null {
  if (model === 'non_billable') return 0;
  if (contractValue !== null) return contractValue;
  return model === 'time_and_materials' ? pricedEstimate : null;
}

/**
 * What it has earned so far: on time and materials, its billable hours at
 * their bill rates (no more than the contract, where there is one); on a fixed
 * price, the contract in proportion to the work earned (earned value ÷ budget
 * at completion).
 */
export function actualRevenue(model: BillingModel, contractValue: number | null, billedTime: number, earnedShare: number | null): number | null {
  if (model === 'non_billable') return 0;
  if (model === 'time_and_materials') return contractValue === null ? billedTime : Math.min(billedTime, contractValue);
  if (contractValue === null || earnedShare === null) return null;
  return contractValue * Math.min(1, Math.max(0, earnedShare));
}

export interface Margin {
  estimated: MarginSide;
  actual: MarginSide;
}

/** Estimated margin (expected revenue less the budget) beside actual (revenue earned less cost spent). */
export function margin(input: { estimatedRevenue: number | null; estimatedCost: number | null; actualRevenue: number | null; actualCost: number }): Margin {
  return {
    estimated: side(input.estimatedRevenue, input.estimatedCost),
    actual: side(input.actualRevenue, input.actualCost),
  };
}

/** Margins added up: a portfolio's from its projects'. A side with any unknown is unknown. */
export function combineMargins(parts: Margin[]): Margin {
  const total = (pick: (part: Margin) => number | null) =>
    parts.some((part) => pick(part) === null) ? null : parts.reduce((sum, part) => sum + pick(part)!, 0);
  return margin({
    estimatedRevenue: total((part) => part.estimated.revenue),
    estimatedCost: total((part) => part.estimated.cost),
    actualRevenue: total((part) => part.actual.revenue),
    actualCost: total((part) => part.actual.cost) ?? 0,
  });
}

/* -------------------------------------------------------------------------- */
/* Revenue forecast (BR-319)                                                  */
/* -------------------------------------------------------------------------- */

export interface ForecastMonth {
  month: string;
  hours: number;
  /** Revenue at bill rates, before weighting. */
  revenue: number;
  /** Revenue × the project's confidence. */
  weighted: number;
}

export interface ProjectForecastInput {
  model: BillingModel;
  contractValue: number | null;
  /** Revenue already earned, in the project's currency. */
  earned: number;
  /** The forecast months, in order (the horizon). */
  months: string[];
  /** Planned hours in each month and their revenue at bill rates. */
  planned: Map<string, { hours: number; revenue: number }>;
  plannedFinish: string | null;
  /** 0..1. */
  confidence: number;
}

/**
 * A project's labour revenue to come, month by month.
 *
 * Time and materials: the hours planned each month at their bill rates — no
 * more in all than what is left of the contract, where there is one, cut back
 * in proportion. Fixed price: what is left of the contract, spread over the
 * months in proportion to the hours planned in them; with none planned, evenly
 * to the planned finish, or all this month. Not billed: nothing. Each month is
 * then weighted by the project's confidence.
 */
export function forecastProject(input: ProjectForecastInput): ForecastMonth[] {
  const hours = input.months.map((month) => input.planned.get(month)?.hours ?? 0);
  let revenue: number[];
  if (input.model === 'non_billable') {
    revenue = input.months.map(() => 0);
  } else if (input.model === 'time_and_materials') {
    revenue = input.months.map((month) => money(input.planned.get(month)?.revenue ?? 0));
    if (input.contractValue !== null) {
      const left = Math.max(0, input.contractValue - input.earned);
      const total = revenue.reduce((a, b) => a + b, 0);
      if (total > left) revenue = apportion(left, revenue);
    }
  } else {
    const left = input.contractValue === null ? 0 : Math.max(0, input.contractValue - input.earned);
    let weights = hours;
    if (!weights.some((weight) => weight > 0)) {
      const finish = input.plannedFinish ? monthOf(input.plannedFinish) : input.months[0];
      weights = input.months.map((month) => (finish !== undefined && month <= finish ? 1 : 0));
      if (!weights.some((weight) => weight > 0)) weights = input.months.map((_, index) => (index === 0 ? 1 : 0));
    }
    revenue = apportion(left, weights);
  }
  return input.months.map((month, index) => ({
    month,
    hours: money(hours[index]!),
    revenue: revenue[index]!,
    weighted: money(revenue[index]! * input.confidence),
  }));
}

/* -------------------------------------------------------------------------- */
/* Billing (BR-322) and transfer (BR-323)                                     */
/* -------------------------------------------------------------------------- */

export interface BillingReconciliation {
  hours: { approved: number; billed: number };
  expenses: { approved: number; billed: number };
  reconciles: boolean;
}

/** Billable items against what was approved for the period: the same hours, the same expenses. */
export function reconcileBilling(input: {
  approvedHours: number;
  approvedExpenses: number;
  items: { kind: string; quantity: number; amount: number }[];
}): BillingReconciliation {
  const billedHours = input.items.filter((item) => item.kind === 'time').reduce((sum, item) => sum + toCents(item.quantity), 0);
  const billedExpenses = input.items.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + toCents(item.amount), 0);
  const approvedHours = toCents(input.approvedHours);
  const approvedExpenses = toCents(input.approvedExpenses);
  return {
    hours: { approved: fromCents(approvedHours), billed: fromCents(billedHours) },
    expenses: { approved: fromCents(approvedExpenses), billed: fromCents(billedExpenses) },
    reconciles: approvedHours === billedHours && approvedExpenses === billedExpenses,
  };
}

export interface BatchItem {
  id: string;
  amount: number;
  currency: string;
  /** The finance system's reference from an earlier answer, if any. */
  reference: string | null;
}

export interface BatchAnswer {
  received: { itemId: string; reference: string }[];
  /** The receiver's own totals by currency, if it gives them. */
  totals?: Record<string, number>;
}

export interface BatchReconciliation {
  epm: { count: number; totals: Record<string, number> };
  finance: { count: number; totals: Record<string, number> };
  /** Sent and not acknowledged. */
  missing: string[];
  /** Acknowledged and never sent. */
  unexpected: string[];
  /** Acknowledged under a new reference after an earlier one: a second document. */
  duplicates: string[];
  matched: boolean;
}

const totalsOf = (items: { amount: number; currency: string }[]): Record<string, number> => {
  const cents = new Map<string, number>();
  for (const item of items) cents.set(item.currency, (cents.get(item.currency) ?? 0) + toCents(item.amount));
  return Object.fromEntries([...cents].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => [currency, fromCents(value)]));
};

/**
 * A batch against the finance system's answer: every item acknowledged once,
 * nothing else, the same totals — and, on a replay, the same reference for each
 * item as before, so no second document was made.
 */
export function reconcileBatch(items: BatchItem[], answer: BatchAnswer): BatchReconciliation {
  const sent = new Map(items.map((item) => [item.id, item]));
  const seen = new Map<string, string>();
  const unexpected: string[] = [];
  const duplicates: string[] = [];
  for (const entry of answer.received) {
    const item = sent.get(entry.itemId);
    if (!item) {
      unexpected.push(entry.itemId);
      continue;
    }
    if (seen.has(entry.itemId) && seen.get(entry.itemId) !== entry.reference) duplicates.push(entry.itemId);
    seen.set(entry.itemId, entry.reference);
    if (item.reference !== null && item.reference !== entry.reference) duplicates.push(entry.itemId);
  }
  const missing = items.filter((item) => !seen.has(item.id)).map((item) => item.id);
  const epmTotals = totalsOf(items);
  const acknowledged = items.filter((item) => seen.has(item.id));
  const financeTotals = answer.totals
    ? Object.fromEntries(Object.entries(answer.totals).sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => [currency, money(value)]))
    : totalsOf(acknowledged);
  const sameTotals = JSON.stringify(epmTotals) === JSON.stringify(financeTotals);
  return {
    epm: { count: items.length, totals: epmTotals },
    finance: { count: seen.size + unexpected.length, totals: financeTotals },
    missing,
    unexpected,
    duplicates: [...new Set(duplicates)],
    matched: missing.length === 0 && unexpected.length === 0 && duplicates.length === 0 && sameTotals,
  };
}
