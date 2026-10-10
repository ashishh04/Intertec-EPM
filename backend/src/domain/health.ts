import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { aggregateCache } from '../lib/cache.js';
import { appLog } from '../lib/log.js';
import { daysBetween, today as todayIso } from '../lib/dates.js';
import { dateOf, listOf, message, render, renderStored, type Message } from '../lib/i18n.js';
import { countsByProject, listProjects, type ProjectHealthView } from '../mapping/projects.js';
import { openProject, type OpFilter } from '../openproject/client.js';
import type {
  HealthCriterion,
  HealthCriterionResult,
  HealthCriterionRule,
  HealthLevel,
  HealthOverride,
  HealthOverrideRecord,
  HealthRules,
  ProjectHealth,
  ProjectHealthDetail,
} from '../types/epm.js';
import { recordAuditQuietly, type AuditInput } from './audit.js';
import { projectCosts, type ProjectCost } from './costs.js';
import { HEALTH_CRITERIA, criterionName, getHealthRules, resolveRiskSelection } from './health-rules.js';
import { clauses, notifyHealthChange } from './notifications.js';
import { noteRuleEvent } from './rule-events.js';
import { OVERDUE_DUE_FILTER } from './work-definitions.js';

/**
 * Project health, as the BRD defines it (BR-204, BR-205, BR-206).
 *
 * Four criteria, each measured, each with administrator-set thresholds and a
 * weight; an overall decided by how much weight is amber or red; the result
 * stored per project, journalled when it moves, and recalculated when the data
 * behind it changes and on a schedule. An override pins levels over the result
 * without hiding it, and needs a reason.
 *
 * The calculation itself (`computeHealth`) is a pure function of the inputs and
 * the rules, so it can be checked against worked examples without an instance —
 * see `domain/__checks__/health.check.ts`. Everything else here is gathering
 * those inputs and keeping the result.
 */

/* -------------------------------------------------------------------------- */
/* The calculation                                                             */
/* -------------------------------------------------------------------------- */

/** Everything one project's health is calculated from. */
export interface HealthInputs {
  /** Work packages in the project, open or closed. */
  total: number;
  open: number;
  /** Open and due before today. */
  overdue: number;
  /** Open work packages of a risk type, any priority. */
  openRisks: number;
  /** Open work packages of a risk type at a high priority. */
  openHighRisks: number;
  /** Whether any type on the instance is a risk; without one, risks are not assessed. */
  riskTypesConfigured: boolean;
  /** The latest due date among open work. */
  latestOpenDue?: string;
  plannedStart?: string;
  plannedFinish?: string;
  /** The approved budget; absent or zero means none is set. */
  budget?: number;
  /** Actual cost to date; absent when it could not be read. */
  cost?: ProjectCost;
  today: string;
}

/**
 * A criterion's result as it is stored: the reason in English, which is the
 * record, and as the message it was written from, so each reader is shown it
 * in their own language (BR-605). The message never leaves the server.
 */
export interface StoredCriterion extends HealthCriterionResult {
  reasonMessage?: Message;
}

export interface HealthComputation {
  levels: ProjectHealth;
  criteria: StoredCriterion[];
  explanation: string;
  explanationMessage: Message;
  forecastFinish?: string;
}

function levelFor(value: number, rule: HealthCriterionRule): HealthLevel {
  if (value >= rule.redAt) return 'critical';
  if (value >= rule.amberAt) return 'warning';
  return 'healthy';
}

/*
 * The reasons are messages. In the English their figures are plain arguments —
 * `{days}`, not `#` or `{days, number}`, which would write "1,200" where the
 * stored English has always said "1200" — so the English reads exactly as it
 * always has; a translation writes them in its reader's format. Amounts are
 * written in the house format below and passed as text, for the same reason.
 */

function money(value: number): string {
  return `${env.EPM_CURRENCY} ${Math.round(value).toLocaleString('en-US')}`;
}

/** What one criterion measured, and why it stands where it does. */
interface Measured {
  level: HealthLevel | null;
  value: number | null;
  reason: Message;
}

/** Calendar days from `from` to `to`; negative when `to` is earlier. */
function dayDifference(from: string, to: string): number {
  return to >= from ? daysBetween(from, to) - 1 : -(daysBetween(to, from) - 1);
}

/**
 * When the open work will finish, judged from its dates.
 *
 * The latest due date among it — but never before today while anything is
 * already overdue, because late work cannot finish in the past. With open work
 * and no dates at all, a project already past its planned finish is at least
 * as late as today; otherwise there is nothing to forecast from.
 */
export function forecastFinish(inputs: HealthInputs): string | undefined {
  if (inputs.open === 0) return undefined;
  let forecast = inputs.latestOpenDue;
  if (inputs.overdue > 0 && (!forecast || forecast < inputs.today)) forecast = inputs.today;
  if (!forecast && inputs.plannedFinish && inputs.plannedFinish < inputs.today) forecast = inputs.today;
  return forecast;
}

function scheduleCriterion(inputs: HealthInputs, rule: HealthCriterionRule): Measured {
  if (!inputs.plannedFinish) {
    return { level: null, value: null, reason: message('No planned finish is set, so schedule variance is not measured.') };
  }
  if (inputs.total === 0) {
    return { level: null, value: null, reason: message('No work is planned yet, so there is no finish to forecast.') };
  }
  if (inputs.open === 0) {
    return { level: 'healthy', value: 0, reason: message('All work is complete.') };
  }

  const forecast = forecastFinish(inputs);
  if (!forecast) {
    return {
      level: null,
      value: null,
      reason: message('None of the open work has a due date, so no finish can be forecast.'),
    };
  }

  const variance = dayDifference(inputs.plannedFinish, forecast);
  return {
    level: levelFor(variance, rule),
    value: variance,
    reason: message(
      'Open work is forecast to finish on {forecast}, {direction, select, after {{days, plural, one {{days} day} other {{days} days}} after} before {{days, plural, one {{days} day} other {{days} days}} before} other {on}} the planned finish of {planned} (amber from {amberAt}, red from {redAt} days).',
      {
        forecast: dateOf(forecast),
        direction: variance > 0 ? 'after' : variance < 0 ? 'before' : 'on',
        days: Math.abs(variance),
        planned: dateOf(inputs.plannedFinish),
        amberAt: rule.amberAt,
        redAt: rule.redAt,
      },
    ),
  };
}

/** Spend against plan as a share of the whole budget, to one decimal place: positive is over. */
export function budgetVariancePct(cost: number, planned: number, budget: number): number {
  return Math.round(((cost - planned) / budget) * 1000) / 10;
}

/**
 * How much of a budget was planned to be spent by `today`.
 *
 * Phased evenly across the planned start and finish: nothing before the
 * start, all of it after the finish. Without a usable plan there is no
 * phasing, and the whole budget counts as planned — `share` is then null.
 * The one rule for "planned to date": health's budget criterion and the cost
 * variance measures both use it. Phased budgets (BR-310) will replace the
 * even spread here.
 */
export function plannedBudgetToDate(
  budget: number,
  plannedStart: string | undefined | null,
  plannedFinish: string | undefined | null,
  today: string,
): { planned: number; share: number | null } {
  if (!plannedStart || !plannedFinish || plannedFinish < plannedStart) return { planned: budget, share: null };
  const span = daysBetween(plannedStart, plannedFinish);
  const elapsed = today < plannedStart ? 0 : Math.min(span, daysBetween(plannedStart, today));
  const share = span > 0 ? elapsed / span : 1;
  return { planned: budget * share, share };
}

/**
 * Spend against the budget planned to date.
 *
 * The plan to date phases the budget evenly across the planned start and
 * finish; before the start nothing is planned, after the finish all of it is.
 * Without planned dates there is no phasing, and the comparison is with the
 * whole budget — which makes the criterion an overrun check. The variance is a
 * share of the whole budget, so it means the same on a large project as on a
 * small one. Phased budgets (BR-310) will replace the even spread here.
 */
function budgetCriterion(inputs: HealthInputs, rule: HealthCriterionRule): Measured {
  if (!inputs.budget || inputs.budget <= 0) {
    return { level: null, value: null, reason: message('No budget is set, so budget variance is not measured.') };
  }
  if (!inputs.cost) {
    return {
      level: null,
      value: null,
      reason: message('Logged time could not be read, so spend to date is not known.'),
    };
  }

  const { budget, cost } = inputs;
  const { planned, share } = plannedBudgetToDate(budget, inputs.plannedStart, inputs.plannedFinish, inputs.today);
  const basis =
    share === null
      ? message('with no planned dates to phase it over, all of it counts as planned')
      : message('{planned} of it was planned by today, {share}% of the way through the schedule', {
          planned: money(planned),
          share: Math.round(share * 100),
        });

  const variance = budgetVariancePct(cost.cost, planned, budget);
  return {
    level: levelFor(variance, rule),
    value: variance,
    reason: message(
      'Spent {spent} of the {budget} budget; {basis}. That is {direction, select, over {{variance}% of the budget over plan} under {{variance}% of the budget under plan} other {exactly on plan}} (amber from {amberAt}%, red from {redAt}% of the budget).{uncosted, plural, =0 {} one { {uncosted} hour logged by people with no hourly rate are not included.} other { {uncosted} hours logged by people with no hourly rate are not included.}}',
      {
        spent: money(cost.cost),
        budget: money(budget),
        basis,
        direction: variance > 0 ? 'over' : variance < 0 ? 'under' : 'on',
        variance: Math.abs(variance),
        amberAt: rule.amberAt,
        redAt: rule.redAt,
        uncosted: cost.uncostedHours > 0 ? cost.uncostedHours : 0,
      },
    ),
  };
}

function risksCriterion(inputs: HealthInputs, rule: HealthCriterionRule): Measured {
  if (!inputs.riskTypesConfigured) {
    return {
      level: null,
      value: null,
      reason: message('No work package type is set up as a risk, so risks are not counted.'),
    };
  }
  return {
    level: levelFor(inputs.openHighRisks, rule),
    value: inputs.openHighRisks,
    reason: message(
      '{high, plural, one {{high} open risk} other {{high} open risks}} at high priority{wider, select, yes { (of {all, plural, one {{all} open risk} other {{all} open risks}})} other {}} (amber from {amberAt}, red from {redAt}).',
      {
        high: inputs.openHighRisks,
        wider: inputs.openRisks > inputs.openHighRisks ? 'yes' : 'no',
        all: inputs.openRisks,
        amberAt: rule.amberAt,
        redAt: rule.redAt,
      },
    ),
  };
}

function overdueCriterion(inputs: HealthInputs, rule: HealthCriterionRule): Measured {
  if (inputs.total === 0) {
    return { level: 'healthy', value: 0, reason: message('This project has no work packages yet.') };
  }
  return {
    level: levelFor(inputs.overdue, rule),
    value: inputs.overdue,
    reason: message(
      '{overdue} of {open, plural, one {{open} open work package} other {{open} open work packages}} {overdue, plural, one {is} other {are}} past the due date (amber from {amberAt}, red from {redAt}).',
      { overdue: inputs.overdue, open: inputs.open, amberAt: rule.amberAt, redAt: rule.redAt },
    ),
  };
}

const UNITS = { schedule: 'days', budget: 'percent', risks: 'count', overdue: 'count' } as const;

/**
 * The overall level, from criterion levels and their weights.
 *
 * Red when the red criteria carry at least `redShare` percent of the weight
 * of everything assessed; amber when the amber-or-red ones carry at least
 * `amberShare`. A criterion that could not be assessed is left out of the
 * total rather than counted as green, so a project with no budget is judged on
 * what can be measured instead of being pulled towards green by what cannot.
 */
export function aggregateHealth(
  levels: Partial<Record<HealthCriterion, HealthLevel | null>>,
  rules: HealthRules,
): { overall: HealthLevel; explanation: string; explanationMessage: Message } {
  // The English is the record; the message is how each reader is shown it.
  const explained = (overall: HealthLevel, why: Message) => ({ overall, explanation: render('en', why), explanationMessage: why });

  const counted = HEALTH_CRITERIA.filter((key) => {
    const rule = rules.criteria[key];
    return rule.enabled && rule.weight > 0 && levels[key] != null;
  });

  const total = counted.reduce((sum, key) => sum + rules.criteria[key].weight, 0);
  if (total === 0) {
    return explained(
      'healthy',
      message('Nothing could be assessed yet, so the overall stays green until something can be measured.'),
    );
  }

  const weightOf = (keys: HealthCriterion[]) => keys.reduce((sum, key) => sum + rules.criteria[key].weight, 0);
  const red = counted.filter((key) => levels[key] === 'critical');
  const nonGreen = counted.filter((key) => levels[key] !== 'healthy');
  const redShare = Math.round((weightOf(red) / total) * 100);
  const nonGreenShare = Math.round((weightOf(nonGreen) / total) * 100);

  // "schedule variance, budget variance and overdue items", joined the way the
  // reader's language joins them.
  const names = (keys: HealthCriterion[]) => {
    const words = keys.map(criterionName);
    return words.length <= 2 ? listOf(words, 'and') : listOf([listOf(words.slice(0, -1)), words.at(-1)!], 'and');
  };

  if (red.length > 0 && redShare >= rules.redShare) {
    return explained(
      'critical',
      message(
        'Red: {criteria} {count, plural, one {is} other {are}} red, carrying {share}% of the weight assessed (red from {threshold}%).',
        { criteria: names(red), count: red.length, share: redShare, threshold: rules.redShare },
      ),
    );
  }
  if (nonGreen.length > 0 && nonGreenShare >= rules.amberShare) {
    return explained(
      'warning',
      message(
        'Amber: {criteria} {count, plural, one {is} other {are}} amber or red, carrying {share}% of the weight assessed (amber from {threshold}%).',
        { criteria: names(nonGreen), count: nonGreen.length, share: nonGreenShare, threshold: rules.amberShare },
      ),
    );
  }
  if (nonGreen.length > 0) {
    return explained(
      'healthy',
      message(
        'Green: {criteria} {count, plural, one {is amber or red but carries} other {are amber or red but carry}} only {share}% of the weight assessed, below the {threshold}% that turns the overall amber.',
        { criteria: names(nonGreen), count: nonGreen.length, share: nonGreenShare, threshold: rules.amberShare },
      ),
    );
  }
  return explained('healthy', message('Green: every criterion assessed is green.'));
}

/** One project's health, from its inputs and the rules. Pure. */
export function computeHealth(inputs: HealthInputs, rules: HealthRules): HealthComputation {
  const measured: Record<HealthCriterion, Measured> = {
    schedule: scheduleCriterion(inputs, rules.criteria.schedule),
    budget: budgetCriterion(inputs, rules.criteria.budget),
    risks: risksCriterion(inputs, rules.criteria.risks),
    overdue: overdueCriterion(inputs, rules.criteria.overdue),
  };

  const criteria: StoredCriterion[] = [];
  const levels: Partial<Record<HealthCriterion, HealthLevel | null>> = {};

  for (const key of HEALTH_CRITERIA) {
    const rule = rules.criteria[key];
    // A criterion switched off is neither measured nor shown.
    if (!rule.enabled) {
      levels[key] = null;
      continue;
    }
    const result = measured[key];
    levels[key] = result.level;
    criteria.push({
      criterion: key,
      level: result.level,
      value: result.value,
      unit: UNITS[key],
      reason: render('en', result.reason),
      reasonMessage: result.reason,
      weight: rule.weight,
      amberAt: rule.amberAt,
      redAt: rule.redAt,
    });
  }

  const { overall, explanation, explanationMessage } = aggregateHealth(levels, rules);

  return {
    levels: {
      schedule: levels.schedule ?? null,
      budget: levels.budget ?? null,
      risks: levels.risks ?? null,
      overdue: levels.overdue ?? null,
      overall,
    },
    criteria,
    explanation,
    explanationMessage,
    forecastFinish: forecastFinish(inputs),
  };
}

/**
 * Calculated health with an override applied.
 *
 * A pinned criterion replaces the calculated one, and overall is then
 * recomputed from the effective levels — pinning a criterion is meant to move
 * the headline. A pinned overall takes precedence over that.
 */
export function effectiveHealth(
  calculated: ProjectHealth,
  pinned: HealthOverride | undefined,
  rules: HealthRules,
): ProjectHealth {
  if (!pinned || Object.keys(pinned).length === 0) return calculated;

  const levels = {
    schedule: pinned.schedule ?? calculated.schedule,
    budget: pinned.budget ?? calculated.budget,
    risks: pinned.risks ?? calculated.risks,
    overdue: pinned.overdue ?? calculated.overdue,
  };
  const anyCriterionPinned = HEALTH_CRITERIA.some((key) => pinned[key] !== undefined);
  const overall =
    pinned.overall ?? (anyCriterionPinned ? aggregateHealth(levels, rules).overall : calculated.overall);
  return { ...levels, overall };
}

const LEVELS: HealthLevel[] = ['healthy', 'warning', 'critical'];
const DIMENSIONS = [...HEALTH_CRITERIA, 'overall'] as const;

/**
 * Reads pinned levels out of a JSON column, dropping anything unknown.
 *
 * Validated rather than trusted: the column holds whatever was written, and a
 * malformed row must cost the pin, not the project page.
 */
export function parseOverrideLevels(value: unknown): HealthOverride {
  const parsed: HealthOverride = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parsed;
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (!(DIMENSIONS as readonly string[]).includes(key)) continue;
    if (!LEVELS.includes(level as HealthLevel)) continue;
    parsed[key as keyof HealthOverride] = level as HealthLevel;
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Stored state                                                                */
/* -------------------------------------------------------------------------- */

export type HealthTrigger = 'change' | 'sweep' | 'rules' | 'read' | 'manual';

/**
 * A project's stored calculation, ready to merge into the project.
 *
 * Its sentences are the stored English, each criterion carrying the message
 * its reason was written from; `presentedDetail` writes them out for a reader.
 */
export interface StoredHealth {
  calculated: ProjectHealth;
  detail: ProjectHealthDetail;
  /** The explanation's message, when one was kept. */
  explanationMessage?: unknown;
  forecastFinish?: string;
  cost?: ProjectCost;
  openRisks: number;
}

/** What a project looks like before anything has been calculated for it. */
export function unassessedHealth(reason: string | Message): StoredHealth {
  return {
    calculated: { schedule: null, budget: null, risks: null, overdue: null, overall: 'healthy' },
    detail: {
      criteria: [],
      explanation: typeof reason === 'string' ? reason : render('en', reason),
      calculatedAt: new Date(0).toISOString(),
      ruleVersion: 0,
    },
    explanationMessage: typeof reason === 'string' ? undefined : reason,
    openRisks: 0,
  };
}

/**
 * A stored calculation as a reader is shown it: each reason and the
 * explanation in the language of the request being served, from the messages
 * kept with them — English, or a calculation stored before there were
 * messages, reads as stored.
 */
export function presentedDetail(stored: Pick<StoredHealth, 'detail' | 'explanationMessage'>): ProjectHealthDetail {
  const { detail } = stored;
  return {
    ...detail,
    criteria: detail.criteria.map((criterion) => {
      const { reasonMessage, ...shown } = criterion as StoredCriterion;
      return { ...shown, reason: renderStored(shown.reason, reasonMessage) };
    }),
    explanation: renderStored(detail.explanation, stored.explanationMessage),
  };
}

function levelsFromJson(value: unknown): ProjectHealth {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const level = (key: string) => (LEVELS.includes(source[key] as HealthLevel) ? (source[key] as HealthLevel) : null);
  return {
    schedule: level('schedule'),
    budget: level('budget'),
    risks: level('risks'),
    overdue: level('overdue'),
    overall: level('overall') ?? 'healthy',
  };
}

type StateRow = Awaited<ReturnType<typeof prisma.projectHealthState.findFirstOrThrow>>;

function fromRow(row: StateRow): StoredHealth {
  const inputs = (row.inputs ?? {}) as Partial<HealthInputs> & { forecastFinish?: string };
  return {
    calculated: levelsFromJson(row.levels),
    detail: {
      criteria: Array.isArray(row.criteria) ? (row.criteria as unknown as StoredCriterion[]) : [],
      explanation: row.explanation,
      calculatedAt: row.calculatedAt.toISOString(),
      ruleVersion: row.ruleVersion,
    },
    explanationMessage: row.explanationMessage ?? undefined,
    forecastFinish: inputs.forecastFinish,
    cost: inputs.cost,
    openRisks: inputs.openRisks ?? 0,
  };
}

/** The override in force on each of `projectIds`. */
export async function loadOverrides(projectIds?: string[]): Promise<Map<string, HealthOverrideRecord>> {
  const rows = await prisma.projectHealthOverride
    .findMany(projectIds ? { where: { projectId: { in: projectIds } } } : undefined)
    .catch(() => []);

  const result = new Map<string, HealthOverrideRecord>();
  for (const row of rows) {
    const levels = parseOverrideLevels(row.levels);
    if (Object.keys(levels).length === 0) continue;
    result.set(row.projectId, {
      levels,
      reason: row.reason,
      setBy: row.setBy,
      setAt: row.setAt.toISOString(),
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Gathering inputs                                                            */
/* -------------------------------------------------------------------------- */

const isoDate = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : undefined);

/** Runs `work` over `items`, at most `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return results;
}

/**
 * The latest due date among a project's open work.
 *
 * One small request per project, sorted so the answer is the first row. A
 * grouped count cannot return a maximum, and walking every open work package
 * on the instance to find one date per project is the expensive alternative.
 */
async function latestOpenDue(projectId: string, signal?: AbortSignal): Promise<string | undefined> {
  const page = await openProject
    .getCollection<{ dueDate?: string | null }>(
      '/work_packages',
      {
        filters: [
          { field: 'project', operator: '=', values: [projectId] },
          { field: 'status', operator: 'o', values: [] },
          { field: 'dueDate', operator: '*', values: [] },
        ],
        sortBy: [['dueDate', 'desc']],
        pageSize: 1,
      },
      signal,
    )
    .catch(() => undefined);
  return page?._embedded?.elements?.[0]?.dueDate ?? undefined;
}

interface Gathered {
  inputs: Map<string, HealthInputs>;
  riskTypeIds: string[];
  highPriorityIds: string[];
}

/**
 * Everything the calculation needs, for the active projects among `scope`.
 *
 * Always on the service key. Counts come from grouped queries — one request
 * each, however many projects — so the cost of recalculating grows with the
 * number of projects only through the one forecast request each needs.
 */
async function gatherInputs(scope: string[] | 'all', rules: HealthRules, refreshCost: boolean): Promise<Gathered> {
  return runAsSystem(async () => {
    const signal = AbortSignal.timeout(Math.max(env.OPENPROJECT_TIMEOUT_MS * 3, 60_000));
    const projects = (await listProjects(signal)).filter((project) => project.active);
    const ids = projects
      .map((project) => String(project.id))
      .filter((id) => scope === 'all' || scope.includes(id));

    const { typeIds: riskTypeIds, priorityIds: highPriorityIds } = await resolveRiskSelection(rules, signal);
    if (ids.length === 0) return { inputs: new Map(), riskTypeIds, highPriorityIds };

    // A targeted recalculation narrows every count to its projects; a full one
    // asks for everything and lets the grouping split it.
    const narrow: OpFilter[] = ids.length <= 50 ? [{ field: 'project', operator: '=', values: ids }] : [];
    const open: OpFilter = { field: 'status', operator: 'o', values: [] };
    const none = Promise.resolve(new Map<string, number>());

    const [total, openCounts, overdue, risks, highRisks, latest, profiles, costs] = await Promise.all([
      countsByProject([...narrow], signal),
      countsByProject([...narrow, open], signal),
      countsByProject([...narrow, open, OVERDUE_DUE_FILTER], signal),
      riskTypeIds.length > 0
        ? countsByProject([...narrow, open, { field: 'type', operator: '=', values: riskTypeIds }], signal)
        : none,
      riskTypeIds.length > 0 && highPriorityIds.length > 0
        ? countsByProject(
            [
              ...narrow,
              open,
              { field: 'type', operator: '=', values: riskTypeIds },
              { field: 'priority', operator: '=', values: highPriorityIds },
            ],
            signal,
          )
        : none,
      inBatches(ids, 6, async (id) => [id, await latestOpenDue(id, signal)] as const),
      prisma.projectProfile
        .findMany({
          where: { openProjectId: { in: ids } },
          select: { openProjectId: true, plannedStart: true, plannedFinish: true, budgetTotal: true },
        })
        .catch(() => []),
      projectCosts(ids, { refresh: refreshCost, signal }),
    ]);

    const latestById = new Map(latest);
    const profileById = new Map(profiles.map((row) => [row.openProjectId, row]));
    const today = todayIso();

    const inputs = new Map<string, HealthInputs>();
    for (const id of ids) {
      const profile = profileById.get(id);
      inputs.set(id, {
        total: total.get(id) ?? 0,
        open: openCounts.get(id) ?? 0,
        overdue: overdue.get(id) ?? 0,
        openRisks: risks.get(id) ?? 0,
        openHighRisks: highRisks.get(id) ?? 0,
        riskTypesConfigured: riskTypeIds.length > 0,
        latestOpenDue: latestById.get(id),
        plannedStart: isoDate(profile?.plannedStart),
        plannedFinish: isoDate(profile?.plannedFinish),
        budget: profile?.budgetTotal ?? undefined,
        cost: costs.get(id),
        today,
      });
    }

    return { inputs, riskTypeIds, highPriorityIds };
  });
}

/* -------------------------------------------------------------------------- */
/* Recalculating                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What moved between two calculations — "schedule variance green → amber" —
 * for the journal and for the owner, who read them in their own language.
 */
function changedCriteriaMessages(before: ProjectHealth, after: ProjectHealth): Message[] {
  return HEALTH_CRITERIA.filter((key) => before[key] !== after[key]).map((key) =>
    message(
      '{criterion, select, schedule {schedule variance} budget {budget variance} risks {open high risks} other {overdue items}} {from, select, healthy {green} warning {amber} critical {red} other {not assessed}} → {to, select, healthy {green} warning {amber} critical {red} other {not assessed}}',
      { criterion: key, from: before[key] ?? 'none', to: after[key] ?? 'none' },
    ),
  );
}

function sameLevels(a: ProjectHealth, b: ProjectHealth): boolean {
  return DIMENSIONS.every((key) => a[key] === b[key]);
}

/**
 * Recalculates health for `scope`, stores it, and journals what moved.
 *
 * Returns every project it calculated, stored or not: when the overlay
 * database is down the results are still correct, just not kept, and the read
 * path can use them directly.
 *
 * A project's first calculation is journalled as its baseline but tells
 * nobody — on the first run after an upgrade every project would otherwise
 * "change" at once, and none of those is news to its owner.
 */
export async function recalculateHealth(
  scope: string[] | 'all',
  trigger: HealthTrigger,
): Promise<Map<string, StoredHealth>> {
  const rules = await getHealthRules();
  const gathered = await gatherInputs(scope, rules, trigger === 'sweep');
  const ids = [...gathered.inputs.keys()];
  const results = new Map<string, StoredHealth>();
  if (ids.length === 0) return results;

  const [previousRows, overrides, owners] = await Promise.all([
    prisma.projectHealthState.findMany({ where: { projectId: { in: ids } } }).catch(() => [] as StateRow[]),
    loadOverrides(ids),
    prisma.projectProfile
      .findMany({ where: { openProjectId: { in: ids } }, select: { openProjectId: true, ownerId: true } })
      .catch(() => []),
  ]);
  const previous = new Map(previousRows.map((row) => [row.projectId, fromRow(row)]));
  const ownerById = new Map(owners.map((row) => [row.openProjectId, row.ownerId ?? undefined]));
  const names = new Map(
    (await runAsSystem(() => listProjects())).map((project) => [String(project.id), project.name]),
  );

  const calculatedAt = new Date();
  const journal: AuditInput[] = [];
  const transitions: Parameters<typeof notifyHealthChange>[0][] = [];

  for (const id of ids) {
    const inputs = gathered.inputs.get(id)!;
    const computed = computeHealth(inputs, rules);
    const stored: StoredHealth = {
      calculated: computed.levels,
      detail: {
        criteria: computed.criteria,
        explanation: computed.explanation,
        calculatedAt: calculatedAt.toISOString(),
        ruleVersion: rules.version,
      },
      explanationMessage: computed.explanationMessage,
      forecastFinish: computed.forecastFinish,
      cost: inputs.cost,
      openRisks: inputs.openRisks,
    };
    results.set(id, stored);

    const before = previous.get(id);
    const persisted = await prisma.projectHealthState
      .upsert({
        where: { projectId: id },
        create: {
          projectId: id,
          levels: computed.levels as unknown as object,
          criteria: computed.criteria as unknown as object,
          explanation: computed.explanation,
          explanationMessage: computed.explanationMessage as unknown as object,
          inputs: {
            ...inputs,
            forecastFinish: computed.forecastFinish,
            riskTypeIds: gathered.riskTypeIds,
            highPriorityIds: gathered.highPriorityIds,
          } as unknown as object,
          ruleVersion: rules.version,
          trigger,
          calculatedAt,
        },
        update: {
          levels: computed.levels as unknown as object,
          criteria: computed.criteria as unknown as object,
          explanation: computed.explanation,
          explanationMessage: computed.explanationMessage as unknown as object,
          inputs: {
            ...inputs,
            forecastFinish: computed.forecastFinish,
            riskTypeIds: gathered.riskTypeIds,
            highPriorityIds: gathered.highPriorityIds,
          } as unknown as object,
          ruleVersion: rules.version,
          trigger,
          calculatedAt,
        },
      })
      .then(() => true)
      .catch((error: unknown) => {
        appLog.warn({ err: error, projectId: id }, 'Could not store calculated health');
        return false;
      });
    if (!persisted) continue;

    const name = names.get(id) ?? `Project ${id}`;
    const project = names.get(id) ?? message('Project {id}', { id });
    if (!before) {
      journal.push({
        actorId: null,
        projectId: id,
        entityType: 'project',
        entityId: id,
        action: 'health.calculated',
        summary: message(
          'Health first calculated for {project}: overall {level, select, healthy {green} warning {amber} other {red}}.',
          { project, level: computed.levels.overall },
        ),
        after: computed.levels,
        metadata: { trigger, ruleVersion: rules.version, baseline: true },
      });
      continue;
    }
    if (sameLevels(before.calculated, computed.levels)) continue;

    const moved = changedCriteriaMessages(before.calculated, computed.levels);
    const overallMoved = before.calculated.overall !== computed.levels.overall;
    const from = before.calculated.overall;
    const to = computed.levels.overall;
    journal.push({
      actorId: null,
      projectId: id,
      entityType: 'project',
      entityId: id,
      action: 'health.calculated',
      summary: overallMoved
        ? moved.length
          ? message(
              'Calculated health moved from {from, select, healthy {green} warning {amber} other {red}} to {to, select, healthy {green} warning {amber} other {red}}: {changes}.',
              { from, to, changes: clauses(moved) },
            )
          : message(
              'Calculated health moved from {from, select, healthy {green} warning {amber} other {red}} to {to, select, healthy {green} warning {amber} other {red}}.',
              { from, to },
            )
        : message(
            'Calculated criteria moved: {changes}. Overall stays {level, select, healthy {green} warning {amber} other {red}}.',
            { changes: moved.length ? clauses(moved) : '', level: to },
          ),
      before: before.calculated,
      after: computed.levels,
      metadata: { trigger, ruleVersion: rules.version },
    });

    // The owner hears about what they see: the effective level, with any
    // override applied to both ends. A recalculation under a pinned overall
    // changes nothing on their screen, so it is journalled but not announced.
    const pinned = overrides.get(id)?.levels;
    const wasEffective = effectiveHealth(before.calculated, pinned, rules).overall;
    const nowEffective = effectiveHealth(computed.levels, pinned, rules).overall;
    if (wasEffective !== nowEffective) {
      transitions.push({
        projectId: id,
        projectName: name,
        ownerId: ownerById.get(id),
        previous: wasEffective,
        next: nowEffective,
        overridden: Boolean(pinned),
        occurrence: calculatedAt.toISOString().slice(0, 10),
        detail: moved.length ? message('What moved: {changes}.', { changes: clauses(moved) }) : undefined,
      });
    }
  }

  await recordAuditQuietly(journal);

  // The project lists, dashboards and reports are cached per person for a few
  // seconds, and a write through the API clears them — but this ran in the
  // background, so nothing else will. Without this a page read straight after
  // a recalculation is served the health from before it.
  aggregateCache.clear();

  for (const transition of transitions) {
    await notifyHealthChange(transition).catch((error: unknown) => {
      appLog.warn({ err: error, projectId: transition.projectId }, 'Could not notify a health change');
    });
    // Rules can watch for it too (BR-216): "when a project turns red".
    await noteRuleEvent({
      source: 'epm',
      kind: 'project.health_changed',
      subjectType: 'project',
      subjectId: transition.projectId,
      projectId: transition.projectId,
      dedupeKey: `project:${transition.projectId}:health:${transition.next}:${calculatedAt.toISOString()}`,
    });
  }

  return results;
}

/**
 * Stored health for `projectIds`, calculating whatever is missing now.
 *
 * Reads are served from the stored values; a project calculated under an
 * older version of the rules is served as it is and recalculated in the
 * background. One with nothing stored at all — new, or the database was down —
 * is calculated before answering, so a project page never shows a blank.
 */
export async function healthFor(
  projectIds: string[],
  options: { calculate?: boolean } = {},
): Promise<Map<string, StoredHealth>> {
  const result = new Map<string, StoredHealth>();
  if (projectIds.length === 0) return result;

  const [rules, rows] = await Promise.all([
    getHealthRules(),
    prisma.projectHealthState.findMany({ where: { projectId: { in: projectIds } } }).catch(() => [] as StateRow[]),
  ]);

  const stale: string[] = [];
  for (const row of rows) {
    result.set(row.projectId, fromRow(row));
    if (row.ruleVersion !== rules.version) stale.push(row.projectId);
  }
  if (options.calculate === false) return result;
  if (stale.length > 0) requestHealthRecalc(stale, 'rules');

  const missing = projectIds.filter((id) => !result.has(id));
  if (missing.length > 0) {
    const computed = await calculateMissing(missing);
    for (const [id, health] of computed) result.set(id, health);
  }
  return result;
}

/**
 * Health for every project in a list, ready for the project read.
 *
 * Active projects are calculated if nothing is stored. Archived ones are not:
 * an archived project is not delivering, so it keeps whatever was last
 * calculated, or says it was never assessed — it is not worth a calculation
 * on every read to find that out again.
 *
 * The reasons and explanation come out in the language of the request being
 * served, so a cache that holds views has to be keyed by language too.
 */
/** The view for a project nothing could be calculated for — never a missing project. */
export function unassessedView(reason: string | Message): ProjectHealthView {
  const stored = unassessedHealth(reason);
  return {
    calculated: stored.calculated,
    effective: stored.calculated,
    detail: presentedDetail(stored),
    openRisks: stored.openRisks,
  };
}

export async function healthViews(
  projects: { id: number | string; active: boolean }[],
): Promise<Map<string, ProjectHealthView>> {
  const active = projects.filter((project) => project.active).map((project) => String(project.id));
  const archived = projects.filter((project) => !project.active).map((project) => String(project.id));

  const [rules, current, frozen, overrides] = await Promise.all([
    getHealthRules(),
    healthFor(active),
    healthFor(archived, { calculate: false }),
    loadOverrides([...active, ...archived]),
  ]);

  const views = new Map<string, ProjectHealthView>();
  for (const id of [...active, ...archived]) {
    const stored =
      current.get(id) ??
      frozen.get(id) ??
      unassessedHealth(
        archived.includes(id)
          ? message('Archived before its health was ever calculated, so it has not been assessed.')
          : message('Health could not be calculated just now; it will be on the next recalculation.'),
      );
    const override = overrides.get(id);
    views.set(id, {
      calculated: stored.calculated,
      effective: effectiveHealth(stored.calculated, override?.levels, rules),
      // In the language of the request being served.
      detail: presentedDetail(stored),
      override,
      forecastFinish: stored.forecastFinish,
      cost: stored.cost,
      openRisks: stored.openRisks,
    });
  }
  return views;
}

/**
 * Every recalculation runs on one chain, one after another.
 *
 * Two calculations of the same project running together would both read the
 * same "before", both journal the same move and both tell the owner. Queued
 * on one chain they cannot overlap, and a calculation that finds its work
 * already done by the one ahead of it does nothing.
 */
let running: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = running.catch(() => undefined).then(() => runAsSystem(work));
  running = next.catch(() => undefined);
  return next;
}

/**
 * Calculates projects that have nothing stored, before a read answers.
 *
 * Several requests arriving together for the same new project — a dashboard
 * load is a dozen at once — queue behind each other, and each re-checks what
 * the one ahead of it stored before calculating anything itself.
 */
async function calculateMissing(ids: string[]): Promise<Map<string, StoredHealth>> {
  return serial(async () => {
    const stored = await prisma.projectHealthState
      .findMany({ where: { projectId: { in: ids } } })
      .catch(() => [] as StateRow[]);
    const result = new Map(stored.map((row) => [row.projectId, fromRow(row)]));
    const still = ids.filter((id) => !result.has(id));
    if (still.length > 0) {
      for (const [id, health] of await recalculateHealth(still, 'read')) result.set(id, health);
    }
    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Recalculation on change                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Debounced, single-flight recalculation.
 *
 * Changes arrive in bursts — a bulk edit is twenty writes — and each would
 * otherwise start its own calculation. They are collected for a moment and
 * calculated together; while one calculation runs, the next waits for it, so
 * two never race to store the same project.
 *
 * In-process, like the other schedulers. Losing a request on restart costs
 * nothing worse than waiting for the next sweep.
 */
const DEBOUNCE_MS = 1_500;
let pendingIds = new Set<string>();
let pendingAll = false;
let pendingTrigger: HealthTrigger = 'change';
let timer: NodeJS.Timeout | undefined;

export function requestHealthRecalc(scope: string | string[] | 'all', trigger: HealthTrigger = 'change'): void {
  if (scope === 'all') pendingAll = true;
  else for (const id of Array.isArray(scope) ? scope : [scope]) if (id) pendingIds.add(id);
  // The strongest reason wins: a rules change outranks an edit.
  if (trigger === 'rules' || trigger === 'sweep') pendingTrigger = trigger;

  if (timer) clearTimeout(timer);
  // Out of whatever request queued this, so the timer cannot carry its token.
  timer = runAsSystem(() => setTimeout(flush, DEBOUNCE_MS));
  timer.unref();
}

function flush(): void {
  timer = undefined;
  const scope: string[] | 'all' = pendingAll ? 'all' : [...pendingIds];
  const trigger = pendingTrigger;
  pendingIds = new Set();
  pendingAll = false;
  pendingTrigger = 'change';
  if (scope !== 'all' && scope.length === 0) return;

  void serial(() => recalculateHealth(scope, trigger)).catch((error: unknown) =>
    appLog.warn({ err: error }, 'Health recalculation failed'),
  );
}

/**
 * Recalculates now and waits for it — for an explicit "recalculate" request,
 * which should answer with the result rather than a promise of one.
 */
export function recalculateNow(scope: string[] | 'all', trigger: HealthTrigger): Promise<Map<string, StoredHealth>> {
  return serial(() => recalculateHealth(scope, trigger));
}

/** Resolves once nothing is queued or running. For tests and the manual route. */
export async function healthIdle(): Promise<void> {
  while (timer || pendingAll || pendingIds.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await running.catch(() => undefined);
}

