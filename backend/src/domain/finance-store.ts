import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { daysBetween, today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { contextLanguage, dateOf, message, msg, t } from '../lib/i18n.js';
import { endpointProblem, postJson } from '../lib/outbound.js';
import { buildWorkbook } from '../lib/xlsx.js';
import { getCatalog } from '../mapping/catalog.js';
import { linkId, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type {
  BillableItemView,
  BillingMilestoneView,
  BillingModel,
  BillingView,
  CashFlowReconciliation,
  CashFlowView,
  FinanceBatchView,
  FinanceSettings,
  ForecastMonthView,
  ForecastView,
  MarginView,
  PhasingView,
  ProjectContract,
  ProjectForecastView,
  ProjectMarginView,
  ProjectStatusKey,
  RateCardView,
} from '../types/epm.js';
import { withAudit } from './audit.js';
import { dayOf, isoOf } from './critical-path.js';
import { assertKnownCurrency, Converter, reportingCurrency } from './currency.js';
import { plannedShare } from './earned-value.js';
import { evaluateProjects, loadEvmShared, planFor, settingsAt, type EvmShared } from './earned-value-store.js';
import {
  actualRevenue,
  BILLING_MODELS,
  cashFlow,
  combineCashFlows,
  combineMargins,
  derivePhasing,
  estimatedRevenue,
  forecastProject,
  fromCents,
  margin,
  money,
  monthOf,
  nextMonth,
  phasingDifference,
  reconcileBatch,
  reconcileBilling,
  rescalePhasing,
  toCents,
  type Phase,
} from './finance.js';
import { modelFacts, type ModelFacts } from './measure-facts.js';
import { costOf } from './measures.js';
import { spread } from './resource-model.js';
import { getResourceSettings, loadResourceShared } from './resources-store.js';
import { entriesOf } from './time-rules.js';

/**
 * Finance (Module 11, part 2): budget phasing and cash flow (BR-310, BR-311),
 * margin and revenue forecast (BR-318, BR-319), billable items and their
 * transfer to the finance system (BR-322, BR-323). Currencies: `currency.ts`.
 *
 * OpenProject 15.5.1 has none of this. Its budgets are totals with no time
 * profile; it has no contract value, bill rates, revenue or billing; one
 * currency. Its project phases are a beta feature, switched off and absent
 * from API v3, so the forecast weights by the project status it does publish.
 * What EPM reads from it is unchanged: time entries, cost entries (approved
 * expense claims among them), work packages and their estimates.
 *
 * Every figure is in the reporting currency. A project's contract, bill rates
 * and billable items are in its own currency, converted at the day's fixed
 * rate for what happened and at the planning rate for what is planned.
 */

const isoDay = (value: Date) => value.toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export const PROJECT_STATUSES: ProjectStatusKey[] = ['not_started', 'on_track', 'at_risk', 'off_track', 'finished', 'discontinued', 'none'];

export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = {
  version: 0,
  confidence: { not_started: 50, on_track: 100, at_risk: 75, off_track: 50, finished: 100, discontinued: 0, none: 100 },
  horizonMonths: 12,
  endpoint: null,
};

const percent = z.number().min(0).max(100);
const settingsSchema = z.object({
  confidence: z.object(Object.fromEntries(PROJECT_STATUSES.map((key) => [key, percent])) as Record<ProjectStatusKey, typeof percent>),
  horizonMonths: z.number().int().min(1).max(36),
  endpoint: z.string().trim().max(500).nullable(),
});

let settingsCache: { at: number; value: FinanceSettings } | undefined;

export async function getFinanceSettings(): Promise<FinanceSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  const top = await prisma.financeSettingSet.findFirst({ orderBy: { version: 'desc' } });
  const stored = (top?.settings ?? {}) as Partial<FinanceSettings>;
  const value: FinanceSettings = top
    ? {
        confidence: { ...DEFAULT_FINANCE_SETTINGS.confidence, ...stored.confidence },
        horizonMonths: stored.horizonMonths ?? DEFAULT_FINANCE_SETTINGS.horizonMonths,
        endpoint: stored.endpoint ?? null,
        version: top.version,
        updatedAt: top.createdAt.toISOString(),
        updatedBy: top.createdBy,
      }
    : DEFAULT_FINANCE_SETTINGS;
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Saves a new version and journals it. */
export async function saveFinanceSettings(input: unknown, actorId: string): Promise<FinanceSettings> {
  const parsed = settingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The finance settings are not complete.', parsed.error.issues);
  const next = { ...parsed.data, endpoint: parsed.data.endpoint ? parsed.data.endpoint : null };
  if (next.endpoint) {
    const problem = endpointProblem(next.endpoint);
    if (problem) throw EpmError.validation(problem);
  }
  const current = await getFinanceSettings();
  const comparable = (value: Pick<FinanceSettings, 'confidence' | 'horizonMonths' | 'endpoint'>) =>
    JSON.stringify({ confidence: value.confidence, horizonMonths: value.horizonMonths, endpoint: value.endpoint });
  if (comparable(current) === comparable(next)) throw EpmError.conflict('Those are already the settings in force.');
  const saved = await withAudit(
    async (tx) => {
      const top = await tx.financeSettingSet.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      return tx.financeSettingSet.create({ data: { version: (top?.version ?? 0) + 1, settings: next as unknown as object, createdBy: actorId } });
    },
    (row) => ({
      actorId,
      entityType: 'finance-settings',
      entityId: String(row.version),
      action: 'finance.settings.updated',
      summary: message('Finance settings version {version} saved.', { version: row.version }),
      before: { ...current },
      after: { version: row.version, ...next },
    }),
  );
  settingsCache = undefined;
  return { ...next, version: saved.version, updatedAt: saved.createdAt.toISOString(), updatedBy: actorId };
}

/* -------------------------------------------------------------------------- */
/* Contracts and rate cards                                                   */
/* -------------------------------------------------------------------------- */

interface Contract {
  projectId: number;
  currency: string;
  contractValue: number | null;
  billingModel: BillingModel;
  modelSet: boolean;
  rateCardId: string | null;
  budget: number | null;
  plannedStart: string | null;
  plannedFinish: string | null;
}

const isModel = (value: unknown): value is BillingModel => BILLING_MODELS.includes(value as BillingModel);

async function contractsOf(projectIds: number[]): Promise<Map<number, Contract>> {
  const [rows, resource] = await Promise.all([
    prisma.projectProfile.findMany({ where: { openProjectId: { in: projectIds.map(String) } } }),
    getResourceSettings(),
  ]);
  const byId = new Map(rows.map((row) => [Number(row.openProjectId), row]));
  return new Map(
    projectIds.map((projectId) => {
      const row = byId.get(projectId);
      const set = isModel(row?.billingModel);
      const billable = row?.billable ?? resource.billableByDefault;
      return [
        projectId,
        {
          projectId,
          currency: row?.currency ?? reportingCurrency(),
          contractValue: row?.contractValue === null || row?.contractValue === undefined ? null : Number(row.contractValue),
          billingModel: set ? (row!.billingModel as BillingModel) : billable ? 'time_and_materials' : 'non_billable',
          modelSet: set,
          rateCardId: row?.rateCardId ?? null,
          budget: row?.budgetTotal ?? null,
          plannedStart: row?.plannedStart ? isoDay(row.plannedStart) : null,
          plannedFinish: row?.plannedFinish ? isoDay(row.plannedFinish) : null,
        },
      ];
    }),
  );
}

interface Card {
  id: string;
  name: string;
  currency: string;
  isDefault: boolean;
  byRole: Map<string | null, number>;
}

interface Pricing {
  cards: Map<string, Card>;
  defaults: Map<string, Card>;
  /** Person → their resource role. */
  roleOf: Map<number, string | null>;
}

async function loadPricing(): Promise<Pricing> {
  const [cards, people] = await Promise.all([
    prisma.rateCard.findMany({ include: { rates: true } }),
    prisma.userProfile.findMany({ select: { openProjectId: true, resourceRoleId: true } }),
  ]);
  const map = new Map<string, Card>();
  const defaults = new Map<string, Card>();
  for (const card of cards) {
    const value: Card = {
      id: card.id,
      name: card.name,
      currency: card.currency,
      isDefault: card.isDefault,
      byRole: new Map(card.rates.map((rate) => [rate.resourceRoleId, Number(rate.hourlyRate)])),
    };
    map.set(card.id, value);
    if (card.isDefault) defaults.set(card.currency, value);
  }
  return { cards: map, defaults, roleOf: new Map(people.map((row) => [Number(row.openProjectId), row.resourceRoleId])) };
}

/** The card a project's time is billed at: the one it names, in its currency, or that currency's default. */
function cardOf(pricing: Pricing, contract: Contract): Card | null {
  if (contract.rateCardId) {
    const named = pricing.cards.get(contract.rateCardId);
    return named && named.currency === contract.currency ? named : null;
  }
  return pricing.defaults.get(contract.currency) ?? null;
}

/** A role's bill rate on a card, else the card's rate for everyone else; null when neither. */
function billRate(card: Card | null, roleId: string | null): number | null {
  if (!card) return null;
  if (roleId !== null && card.byRole.has(roleId)) return card.byRole.get(roleId)!;
  return card.byRole.get(null) ?? null;
}

export async function getContract(projectId: number): Promise<ProjectContract> {
  const [contract, pricing] = await Promise.all([contractsOf([projectId]).then((map) => map.get(projectId)!), loadPricing()]);
  const card = cardOf(pricing, contract);
  return {
    projectId: String(projectId),
    currency: contract.currency,
    reportingCurrency: reportingCurrency(),
    contractValue: contract.contractValue,
    billingModel: contract.billingModel,
    billingModelSet: contract.modelSet,
    rateCardId: contract.rateCardId,
    rateCardName: card?.name ?? null,
    budget: contract.budget,
  };
}

const contractSchema = z.object({
  currency: z.string().nullable().optional(),
  contractValue: z.number().min(0).max(1e12).nullable().optional(),
  billingModel: z.enum(['time_and_materials', 'fixed_price', 'non_billable']).nullable().optional(),
  rateCardId: z.string().max(64).nullable().optional(),
});

export async function updateContract(projectId: number, input: unknown, actorId: string): Promise<ProjectContract> {
  const parsed = contractSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation("The project's contract is not complete.", parsed.error.issues);
  const before = await getContract(projectId);
  const body = parsed.data;
  const currency = body.currency === undefined ? before.currency : body.currency === null ? reportingCurrency() : await assertKnownCurrency(body.currency);
  const rateCardId = body.rateCardId === undefined ? before.rateCardId : body.rateCardId;
  if (rateCardId) {
    const card = await prisma.rateCard.findUnique({ where: { id: rateCardId } });
    if (!card) throw EpmError.notFound('That rate card');
    if (card.currency !== currency) {
      throw EpmError.validation(message('The rate card is in {card}, the project in {project}: choose a card in {project}.', { card: card.currency, project: currency }));
    }
  }
  const data = {
    currency: currency === reportingCurrency() ? null : currency,
    ...(body.contractValue !== undefined ? { contractValue: body.contractValue } : {}),
    ...(body.billingModel !== undefined ? { billingModel: body.billingModel } : {}),
    rateCardId,
  };
  await withAudit(
    (tx) =>
      tx.projectProfile.upsert({
        where: { openProjectId: String(projectId) },
        create: { openProjectId: String(projectId), ...data },
        update: data,
      }),
    () => ({
      actorId,
      entityType: 'project',
      entityId: String(projectId),
      action: 'project.finance.updated',
      summary: message('Contract of project #{project} changed.', { project: projectId }),
      before: { currency: before.currency, contractValue: before.contractValue, billingModel: before.billingModelSet ? before.billingModel : null, rateCardId: before.rateCardId },
      after: { currency, contractValue: body.contractValue ?? before.contractValue, billingModel: body.billingModel ?? null, rateCardId },
    }),
  );
  return getContract(projectId);
}

export async function listRateCards(): Promise<RateCardView[]> {
  const [cards, roles, usage] = await Promise.all([
    prisma.rateCard.findMany({ include: { rates: true }, orderBy: [{ currency: 'asc' }, { name: 'asc' }] }),
    prisma.resourceRole.findMany({ select: { id: true, name: true } }),
    prisma.projectProfile.groupBy({ by: ['rateCardId'], _count: { _all: true }, where: { rateCardId: { not: null } } }),
  ]);
  const roleName = new Map(roles.map((role) => [role.id, role.name]));
  const used = new Map(usage.map((row) => [row.rateCardId, row._count._all]));
  return cards.map((card) => ({
    id: card.id,
    name: card.name,
    currency: card.currency,
    isDefault: card.isDefault,
    projects: used.get(card.id) ?? 0,
    rates: card.rates
      .map((rate) => ({ roleId: rate.resourceRoleId, roleName: rate.resourceRoleId ? (roleName.get(rate.resourceRoleId) ?? null) : null, hourlyRate: Number(rate.hourlyRate) }))
      .sort((a, b) => (a.roleId === null ? -1 : b.roleId === null ? 1 : (a.roleName ?? '').localeCompare(b.roleName ?? ''))),
  }));
}

const cardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  currency: z.string(),
  isDefault: z.boolean(),
  rates: z.array(z.object({ roleId: z.string().max(64).nullable(), hourlyRate: z.number().min(0).max(1e6) })).max(200),
});

/** Creates a card (`id` null) or replaces one: its name, currency, default and every rate. */
export async function saveRateCard(id: string | null, input: unknown, actorId: string): Promise<RateCardView> {
  const parsed = cardSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The rate card is not complete.', parsed.error.issues);
  const body = parsed.data;
  const currency = await assertKnownCurrency(body.currency);
  const roles = body.rates.map((rate) => rate.roleId);
  if (new Set(roles).size !== roles.length) throw EpmError.validation('A role can have one rate on a card.');
  const known = new Set((await prisma.resourceRole.findMany({ select: { id: true } })).map((role) => role.id));
  if (roles.some((role) => role !== null && !known.has(role))) throw EpmError.validation('One of those roles does not exist.');
  const existing = id ? await prisma.rateCard.findUnique({ where: { id }, include: { rates: true } }) : null;
  if (id && !existing) throw EpmError.notFound('That rate card');
  if (existing && existing.currency !== currency) {
    const projects = await prisma.projectProfile.count({ where: { rateCardId: existing.id } });
    if (projects > 0) throw EpmError.conflict('Projects bill at this card: its currency cannot change.');
  }
  const saved = await withAudit(
    async (tx) => {
      if (body.isDefault) await tx.rateCard.updateMany({ where: { currency, isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
      const card = id
        ? await tx.rateCard.update({ where: { id }, data: { name: body.name, currency, isDefault: body.isDefault } })
        : await tx.rateCard.create({ data: { name: body.name, currency, isDefault: body.isDefault, createdBy: actorId } });
      await tx.rateCardRate.deleteMany({ where: { cardId: card.id } });
      if (body.rates.length > 0) {
        await tx.rateCardRate.createMany({ data: body.rates.map((rate) => ({ cardId: card.id, resourceRoleId: rate.roleId, hourlyRate: rate.hourlyRate })) });
      }
      return card;
    },
    (card) => ({
      actorId,
      entityType: 'rate-card',
      entityId: card.id,
      action: id ? 'finance.rate_card.updated' : 'finance.rate_card.created',
      summary: message('Rate card {name} ({currency}) saved with {count, plural, one {# rate} other {# rates}}.', { name: body.name, currency, count: body.rates.length }),
      before: existing ? { name: existing.name, currency: existing.currency, isDefault: existing.isDefault, rates: existing.rates.map((rate) => ({ roleId: rate.resourceRoleId, hourlyRate: Number(rate.hourlyRate) })) } : null,
      after: { name: body.name, currency, isDefault: body.isDefault, rates: body.rates },
    }),
  );
  return (await listRateCards()).find((card) => card.id === saved.id)!;
}

export async function deleteRateCard(id: string, actorId: string): Promise<void> {
  const card = await prisma.rateCard.findUnique({ where: { id } });
  if (!card) throw EpmError.notFound('That rate card');
  if ((await prisma.projectProfile.count({ where: { rateCardId: id } })) > 0) throw EpmError.conflict('Projects bill at this card: name another card on them first.');
  await withAudit(
    (tx) => tx.rateCard.delete({ where: { id } }),
    () => ({
      actorId,
      entityType: 'rate-card',
      entityId: id,
      action: 'finance.rate_card.deleted',
      summary: message('Rate card {name} removed.', { name: card.name }),
      before: { name: card.name, currency: card.currency },
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Budget phasing (BR-310)                                                    */
/* -------------------------------------------------------------------------- */

interface Context {
  facts: ModelFacts;
  evm: EvmShared;
  today: string;
}

async function contextNow(): Promise<Context> {
  const facts = await modelFacts();
  return { facts, evm: await loadEvmShared(facts), today: todayIso() };
}

export async function projectPhasing(projectId: number, context?: Context): Promise<PhasingView> {
  const [profile, rows] = await Promise.all([
    prisma.projectProfile.findUnique({ where: { openProjectId: String(projectId) } }),
    prisma.budgetPhase.findMany({ where: { projectId }, orderBy: { periodStart: 'asc' } }),
  ]);
  const budget = profile?.budgetTotal ?? null;
  const base = { projectId: String(projectId), currency: reportingCurrency(), budget };
  if (budget === null) return { ...base, basis: 'none', phases: [], total: 0, rescaled: false, updatedAt: null, updatedBy: null };
  if (rows.length > 0) {
    let phases: Phase[] = rows.map((row) => ({ month: isoDay(row.periodStart), amount: Number(row.amount) }));
    const rescaled = phasingDifference(phases, budget) !== 0;
    if (rescaled) phases = rescalePhasing(phases, budget);
    const latest = rows.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    return { ...base, basis: 'manual', phases, total: money(budget), rescaled, updatedAt: latest.updatedAt.toISOString(), updatedBy: latest.updatedBy };
  }
  const ctx = context ?? (await contextNow());
  const instant = new Date();
  const plan = planFor(ctx.evm, settingsAt(ctx.evm.settings, instant), projectId, instant, ctx.facts.workPackages);
  const derived = derivePhasing({
    budget,
    items: plan.items.map((item) => ({ bac: item.bac, start: item.plannedStart, finish: item.plannedFinish })),
    plannedStart: profile?.plannedStart ? isoDay(profile.plannedStart) : null,
    plannedFinish: profile?.plannedFinish ? isoDay(profile.plannedFinish) : null,
    today: ctx.today,
    share: (start, finish, at) => plannedShare(start, finish, at, ctx.evm.days),
    workingDays: (first, last) => ctx.evm.days.between(dayOf(first), dayOf(last)),
  });
  return { ...base, basis: derived.basis, phases: derived.phases, total: money(budget), rescaled: false, updatedAt: null, updatedBy: null };
}

const phasingSchema = z.object({
  phases: z
    .array(z.object({ month: z.string().regex(/^\d{4}-\d{2}-01$/, msg('A month is given as its first day, e.g. 2026-10-01.')), amount: z.number().min(0).max(1e12) }))
    .min(1)
    .max(240),
});

/** Saves a phasing set by hand: it must add up to the budget, to the cent. */
export async function savePhasing(projectId: number, input: unknown, actorId: string): Promise<PhasingView> {
  const parsed = phasingSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The phasing is not complete.', parsed.error.issues);
  const phases = parsed.data.phases.map((phase) => ({ month: phase.month, amount: money(phase.amount) }));
  if (new Set(phases.map((phase) => phase.month)).size !== phases.length) throw EpmError.validation('Each month can appear once.');
  const before = await projectPhasing(projectId);
  if (before.budget === null) throw EpmError.validation("Set the project's budget before phasing it.");
  const difference = phasingDifference(phases, before.budget);
  if (difference !== 0) {
    throw EpmError.validation(
      message('The months add up to {sum, number}, not the budget of {budget, number}: {difference, number} apart.', {
        sum: money(before.budget - difference),
        budget: before.budget,
        difference: Math.abs(difference),
      }),
    );
  }
  await withAudit(
    async (tx) => {
      await tx.budgetPhase.deleteMany({ where: { projectId } });
      await tx.budgetPhase.createMany({ data: phases.map((phase) => ({ projectId, periodStart: new Date(phase.month), amount: phase.amount, updatedBy: actorId })) });
    },
    () => ({
      actorId,
      entityType: 'project',
      entityId: String(projectId),
      action: 'project.phasing.saved',
      summary: message('Budget of project #{project} phased over {count, plural, one {# month} other {# months}} by hand.', { project: projectId, count: phases.length }),
      before: { basis: before.basis, phases: before.phases },
      after: { basis: 'manual', phases },
    }),
  );
  return projectPhasing(projectId);
}

/** Back to the phasing derived from the schedule. */
export async function resetPhasing(projectId: number, actorId: string): Promise<PhasingView> {
  const before = await projectPhasing(projectId);
  if (before.basis !== 'manual') return before;
  await withAudit(
    (tx) => tx.budgetPhase.deleteMany({ where: { projectId } }),
    () => ({
      actorId,
      entityType: 'project',
      entityId: String(projectId),
      action: 'project.phasing.reset',
      summary: message('Budget of project #{project} phased from its schedule again.', { project: projectId }),
      before: { basis: 'manual', phases: before.phases },
    }),
  );
  return projectPhasing(projectId);
}

/* -------------------------------------------------------------------------- */
/* Cash flow (BR-311)                                                         */
/* -------------------------------------------------------------------------- */

const nameOf = (facts: ModelFacts, projectId: number) => facts.projects.get(projectId)?.name ?? `#${projectId}`;

function reconciled(flowActual: number, totalActualCost: number): CashFlowReconciliation {
  return { totalActualCost: money(totalActualCost), cumulativeAtEnd: money(flowActual), reconciles: toCents(flowActual) === toCents(totalActualCost) };
}

/**
 * Planned against actual spend, month by month, for each project and for them
 * together. Actual comes from the same facts as the cost measures, and each
 * cumulative is checked against actual cost as they add it up.
 */
export async function cashFlowFor(projectIds: number[]): Promise<CashFlowView> {
  const ctx = await contextNow();
  const projects = [];
  for (const projectId of projectIds) {
    const phasing = await projectPhasing(projectId, ctx);
    const time = ctx.facts.time.filter((entry) => entry.projectId === projectId);
    const costs = ctx.facts.costs.filter((entry) => entry.projectId === projectId);
    const flow = cashFlow({
      planned: phasing.basis === 'none' ? null : phasing.phases,
      labour: time.map((entry) => ({ day: entry.spentOn, cost: entry.cost, hours: entry.hours })),
      other: costs.map((entry) => ({ day: entry.spentOn, amount: entry.amount })),
      through: ctx.today,
    });
    projects.push({
      projectId: String(projectId),
      name: nameOf(ctx.facts, projectId),
      flow,
      reconciliation: reconciled(flow.points.at(-1)?.cumulativeActual ?? 0, costOf(time, costs).cost),
    });
  }
  const combined = combineCashFlows(projects.map((project) => project.flow));
  const ids = new Set(projectIds);
  const total = costOf(
    ctx.facts.time.filter((entry) => entry.projectId !== null && ids.has(entry.projectId)),
    ctx.facts.costs.filter((entry) => ids.has(entry.projectId)),
  ).cost;
  return {
    currency: reportingCurrency(),
    projects,
    combined,
    reconciliation: reconciled(combined.points.at(-1)?.cumulativeActual ?? 0, total),
  };
}

/* -------------------------------------------------------------------------- */
/* Revenue earned, margin (BR-318)                                            */
/* -------------------------------------------------------------------------- */

interface Earned {
  /** Billable hours priced at a bill rate. */
  billedHours: number;
  unpricedHours: number;
  /** Those hours at their bill rates, in the project's currency, and in the reporting currency at their days' rates. */
  billed: number;
  billedReporting: number;
  /** Earned value ÷ budget at completion; null without a budget at completion. */
  earnedShare: number | null;
  bac: number | null;
}

async function earnedOf(
  projectIds: number[],
  ctx: Context,
  contracts: Map<number, Contract>,
  pricing: Pricing,
  converter: Converter,
): Promise<Map<number, Earned>> {
  const resource = await getResourceSettings();
  const nonBillable = new Set(resource.nonBillableActivityIds.map(String));
  const evaluation = evaluateProjects(ctx.evm, { projectIds, at: ctx.today, work: ctx.facts.workPackages, time: ctx.facts.time });
  const evaluated = new Map(evaluation.projects.map((project) => [project.projectId, project.evaluation.totals]));
  const reporting = reportingCurrency();
  const out = new Map<number, Earned>();
  for (const projectId of projectIds) {
    const contract = contracts.get(projectId)!;
    const totals = evaluated.get(projectId);
    const earned: Earned = {
      billedHours: 0,
      unpricedHours: 0,
      billed: 0,
      billedReporting: 0,
      earnedShare: totals && totals.bac > 0 ? totals.ev / totals.bac : null,
      bac: totals ? totals.bac : null,
    };
    if (contract.billingModel === 'time_and_materials') {
      const card = cardOf(pricing, contract);
      let billedCents = 0;
      let reportingCents = 0;
      for (const entry of ctx.facts.time) {
        if (entry.projectId !== projectId || entry.hours <= 0) continue;
        if (entry.activityId !== null && nonBillable.has(String(entry.activityId))) continue;
        const rate = billRate(card, entry.userId === null ? null : (pricing.roleOf.get(entry.userId) ?? null));
        if (rate === null) {
          earned.unpricedHours += entry.hours;
          continue;
        }
        earned.billedHours += entry.hours;
        const amount = money(entry.hours * rate);
        billedCents += toCents(amount);
        reportingCents += toCents((await converter.on(amount, contract.currency, reporting, entry.spentOn)).amount);
      }
      earned.billed = fromCents(billedCents);
      earned.billedReporting = fromCents(reportingCents);
    }
    earned.billedHours = money(earned.billedHours);
    earned.unpricedHours = money(earned.unpricedHours);
    out.set(projectId, earned);
  }
  return out;
}

/** Revenue earned so far, in the project's currency. */
const earnedRevenue = (contract: Contract, earned: Earned) =>
  actualRevenue(contract.billingModel, contract.contractValue, earned.billed, earned.earnedShare);

/**
 * Estimated against actual margin for each project and for them together, in
 * the reporting currency. Estimated: the contract value (or, on time and
 * materials without one, the estimates at their bill rates) less the budget
 * (or, without one, the budget at completion). Actual: revenue earned less
 * actual cost — labour at people's rates and every other cost entry.
 */
export async function marginFor(projectIds: number[]): Promise<MarginView> {
  const ctx = await contextNow();
  const [contracts, pricing] = await Promise.all([contractsOf(projectIds), loadPricing()]);
  const converter = new Converter();
  const earnedBy = await earnedOf(projectIds, ctx, contracts, pricing, converter);
  const reporting = reportingCurrency();
  const projects: ProjectMarginView[] = [];
  for (const projectId of projectIds) {
    const contract = contracts.get(projectId)!;
    const earned = earnedBy.get(projectId)!;
    const card = cardOf(pricing, contract);
    let estimateCents = 0;
    let unpricedEstimate = 0;
    if (contract.billingModel === 'time_and_materials' && contract.contractValue === null) {
      for (const work of ctx.facts.workPackages) {
        if (work.projectId !== projectId || !(work.estimatedHours && work.estimatedHours > 0)) continue;
        const rate = billRate(card, work.assigneeId === null ? null : (pricing.roleOf.get(work.assigneeId) ?? null));
        if (rate === null) unpricedEstimate += work.estimatedHours;
        else estimateCents += toCents(work.estimatedHours * rate);
      }
    }
    const expected = estimatedRevenue(contract.billingModel, contract.contractValue, fromCents(estimateCents));
    const actual = earnedRevenue(contract, earned);
    let actualReporting: number | null = null;
    if (actual !== null) {
      if (contract.billingModel === 'time_and_materials') {
        actualReporting = earned.billed > 0 ? money((earned.billedReporting * actual) / earned.billed) : 0;
      } else {
        actualReporting = (await converter.planned(actual, contract.currency, reporting)).amount;
      }
    }
    const time = ctx.facts.time.filter((entry) => entry.projectId === projectId);
    const costs = ctx.facts.costs.filter((entry) => entry.projectId === projectId);
    projects.push({
      projectId: String(projectId),
      name: nameOf(ctx.facts, projectId),
      projectCurrency: contract.currency,
      billingModel: contract.billingModel,
      contractValue: contract.contractValue,
      margin: margin({
        estimatedRevenue: expected === null ? null : (await converter.planned(expected, contract.currency, reporting)).amount,
        estimatedCost: contract.budget ?? earned.bac,
        actualRevenue: actualReporting,
        actualCost: costOf(time, costs).cost,
      }),
      billedHours: earned.billedHours,
      unpricedHours: money(earned.unpricedHours + unpricedEstimate),
    });
  }
  return { currency: reporting, projects, combined: combineMargins(projects.map((project) => project.margin)) };
}

/* -------------------------------------------------------------------------- */
/* Revenue forecast (BR-319)                                                  */
/* -------------------------------------------------------------------------- */

/** OpenProject's project status for each project: what the forecast's confidence goes by. */
async function projectStatuses(projectIds: number[]): Promise<Map<number, ProjectStatusKey>> {
  const out = new Map<number, ProjectStatusKey>(projectIds.map((id) => [id, 'none']));
  if (projectIds.length === 0) return out;
  const rows = await runAsSystem(() =>
    openProject.getAll<{ id: number; _links?: { status?: HalLink | null } }>('/projects', {
      filters: [{ field: 'id', operator: '=', values: projectIds.map(String) }],
      pageSize: 200,
    }),
  );
  for (const row of rows.items) {
    const code = row._links?.status?.href?.split('/').pop() ?? null;
    if (code && PROJECT_STATUSES.includes(code as ProjectStatusKey)) out.set(row.id, code as ProjectStatusKey);
  }
  return out;
}

/**
 * Labour revenue to come, month by month over the horizon, for each project
 * and for them together, in the reporting currency at the planning rate. The
 * hours are those resource planning has falling in each month — open work's
 * remaining hours spread over its carrier's availability, and bookings — at
 * the bill rate of each carrier's role (BR-313); each project is weighted by
 * the confidence its status carries.
 */
export async function forecastFor(projectIds: number[]): Promise<ForecastView> {
  const [ctx, settings, shared, contracts, pricing, statuses] = await Promise.all([
    contextNow(),
    getFinanceSettings(),
    loadResourceShared(),
    contractsOf(projectIds),
    loadPricing(),
    projectStatuses(projectIds),
  ]);
  const months: string[] = [];
  for (let month = monthOf(ctx.today); months.length < settings.horizonMonths; month = nextMonth(month)) months.push(month);
  const inHorizon = new Set(months);
  const ids = new Set(projectIds);
  const planned = new Map<number, Map<string, { hours: number; revenue: number }>>();
  const unpriced = new Map<number, number>();
  const today = dayOf(ctx.today);
  for (const item of shared.demand) {
    if (!ids.has(item.projectId)) continue;
    const days = spread(item, shared.availability, today);
    if (!days) continue;
    const roleId = item.roleId ?? (item.carrier ? (shared.carriers.get(item.carrier)?.roleId ?? null) : null);
    const rate = billRate(cardOf(pricing, contracts.get(item.projectId)!), roleId);
    const byMonth = planned.get(item.projectId) ?? new Map<string, { hours: number; revenue: number }>();
    planned.set(item.projectId, byMonth);
    for (const [day, hours] of days) {
      const month = monthOf(isoOf(day));
      if (!inHorizon.has(month) || hours <= 0) continue;
      const cell = byMonth.get(month) ?? { hours: 0, revenue: 0 };
      cell.hours += hours;
      if (rate === null) unpriced.set(item.projectId, (unpriced.get(item.projectId) ?? 0) + hours);
      else cell.revenue += hours * rate;
      byMonth.set(month, cell);
    }
  }
  const converter = new Converter();
  const earnedBy = await earnedOf(projectIds, ctx, contracts, pricing, converter);
  const reporting = reportingCurrency();
  const projects: ProjectForecastView[] = [];
  for (const projectId of projectIds) {
    const contract = contracts.get(projectId)!;
    const status = statuses.get(projectId) ?? 'none';
    const confidence = settings.confidence[status];
    const lines = forecastProject({
      model: contract.billingModel,
      contractValue: contract.contractValue,
      earned: earnedRevenue(contract, earnedBy.get(projectId)!) ?? 0,
      months,
      planned: planned.get(projectId) ?? new Map(),
      plannedFinish: contract.plannedFinish,
      confidence: confidence / 100,
    });
    const rate = contract.billingModel === 'non_billable' ? 1 : (await converter.planned(1, contract.currency, reporting)).rate;
    const converted: ForecastMonthView[] = lines.map((line) => ({ ...line, revenue: money(line.revenue * rate), weighted: money(line.weighted * rate) }));
    projects.push({
      projectId: String(projectId),
      name: nameOf(ctx.facts, projectId),
      status,
      confidence,
      billingModel: contract.billingModel,
      projectCurrency: contract.currency,
      months: converted,
      total: {
        revenue: fromCents(converted.reduce((sum, line) => sum + toCents(line.revenue), 0)),
        weighted: fromCents(converted.reduce((sum, line) => sum + toCents(line.weighted), 0)),
      },
      unpricedHours: money(unpriced.get(projectId) ?? 0),
    });
  }
  const combined = months.map((month, index) => ({
    month,
    hours: money(projects.reduce((sum, project) => sum + project.months[index]!.hours, 0)),
    revenue: fromCents(projects.reduce((sum, project) => sum + toCents(project.months[index]!.revenue), 0)),
    weighted: fromCents(projects.reduce((sum, project) => sum + toCents(project.months[index]!.weighted), 0)),
  }));
  return {
    currency: reporting,
    months,
    projects,
    combined,
    total: {
      revenue: fromCents(combined.reduce((sum, line) => sum + toCents(line.revenue), 0)),
      weighted: fromCents(combined.reduce((sum, line) => sum + toCents(line.weighted), 0)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Billing milestones and billable items (BR-322)                             */
/* -------------------------------------------------------------------------- */

interface LiveWork {
  projectId: string | null;
  subject: string;
  closed: boolean;
}

async function liveWork(workPackageId: number): Promise<LiveWork | null> {
  const [work, catalog] = await Promise.all([
    runAsSystem(() => openProject.request<{ subject: string; _links: Record<string, HalLink | HalLink[] | undefined> }>(`/work_packages/${workPackageId}`)).catch(() => null),
    getCatalog(),
  ]);
  if (!work) return null;
  const statusId = linkId(work._links, 'status');
  return {
    projectId: linkId(work._links, 'project') ?? null,
    subject: work.subject,
    closed: statusId ? (catalog.statusById.get(statusId)?.isClosed ?? false) : false,
  };
}

export async function listMilestones(projectId: number): Promise<BillingMilestoneView[]> {
  const rows = await prisma.billingMilestone.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  const out: BillingMilestoneView[] = [];
  for (const row of rows) {
    const work = await liveWork(row.workPackageId);
    out.push({ workPackageId: String(row.workPackageId), subject: work?.subject ?? `#${row.workPackageId}`, amount: Number(row.amount), closed: work?.closed ?? false });
  }
  return out;
}

export async function setMilestone(projectId: number, workPackageId: number, input: unknown, actorId: string): Promise<BillingMilestoneView[]> {
  const parsed = z.object({ amount: z.number().positive().max(1e12) }).safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('Give the amount the milestone bills.', parsed.error.issues);
  const amount = money(parsed.data.amount);
  const work = await liveWork(workPackageId);
  if (!work || work.projectId !== String(projectId)) throw EpmError.validation('That work package is not in this project.');
  const contract = (await contractsOf([projectId])).get(projectId)!;
  if (contract.contractValue !== null) {
    const others = await prisma.billingMilestone.findMany({ where: { projectId, workPackageId: { not: workPackageId } } });
    const total = others.reduce((sum, row) => sum + toCents(Number(row.amount)), 0) + toCents(amount);
    if (total > toCents(contract.contractValue)) {
      throw EpmError.validation(message('The milestones would bill {total, number}, more than the contract value of {contract, number}.', { total: fromCents(total), contract: contract.contractValue }));
    }
  }
  await withAudit(
    (tx) =>
      tx.billingMilestone.upsert({
        where: { projectId_workPackageId: { projectId, workPackageId } },
        create: { projectId, workPackageId, amount, createdBy: actorId },
        update: { amount },
      }),
    () => ({
      actorId,
      entityType: 'project',
      entityId: String(projectId),
      action: 'billing.milestone.set',
      summary: message('Milestone #{workPackage} bills {amount, number} {currency}.', { workPackage: workPackageId, amount, currency: contract.currency }),
      after: { workPackageId, amount },
    }),
  );
  return listMilestones(projectId);
}

export async function removeMilestone(projectId: number, workPackageId: number, actorId: string): Promise<BillingMilestoneView[]> {
  const row = await prisma.billingMilestone.findUnique({ where: { projectId_workPackageId: { projectId, workPackageId } } });
  if (!row) throw EpmError.notFound('That billing milestone');
  await withAudit(
    (tx) => tx.billingMilestone.delete({ where: { projectId_workPackageId: { projectId, workPackageId } } }),
    () => ({
      actorId,
      entityType: 'project',
      entityId: String(projectId),
      action: 'billing.milestone.removed',
      summary: message('Milestone #{workPackage} no longer bills.', { workPackage: workPackageId }),
      before: { workPackageId, amount: Number(row.amount) },
    }),
  );
  return listMilestones(projectId);
}

interface ApprovedEntry {
  id: string;
  personId: string;
  hours: number;
  spentOn: string;
  workPackageId: string | null;
}

/** Billable time on the project in the period that an approved timesheet covers (BR-305). */
async function approvedTime(projectId: number, from: string, to: string): Promise<ApprovedEntry[]> {
  const [sheets, resource] = await Promise.all([
    prisma.timesheet.findMany({ where: { status: 'approved', periodStart: { lte: new Date(to) }, periodEnd: { gte: new Date(from) } } }),
    getResourceSettings(),
  ]);
  const nonBillable = new Set(resource.nonBillableActivityIds.map(String));
  const out: ApprovedEntry[] = [];
  for (const sheet of sheets) {
    const start = isoDay(sheet.periodStart) > from ? isoDay(sheet.periodStart) : from;
    const end = isoDay(sheet.periodEnd) < to ? isoDay(sheet.periodEnd) : to;
    for (const entry of await entriesOf(sheet.personId, start, end)) {
      if (entry.projectId !== String(projectId) || entry.hours <= 0) continue;
      if (entry.activityId && nonBillable.has(entry.activityId)) continue;
      out.push({ id: entry.id, personId: sheet.personId, hours: entry.hours, spentOn: entry.spentOn, workPackageId: entry.workPackageId ?? null });
    }
  }
  return out;
}

const claimKey = (id: string) => `EX-${id.slice(-6).toUpperCase()}`;

/** The current calendar month, first day to last. */
function thisMonth(): { from: string; to: string } {
  const day = todayIso();
  // Day 0 of the next month is the last of this one; months here count from 1.
  const last = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
  return { from: `${day.slice(0, 7)}-01`, to: `${day.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

function periodOf(query: { from?: unknown; to?: unknown }): { from: string; to: string } {
  const from = typeof query.from === 'string' && DAY.test(query.from) ? query.from : null;
  const to = typeof query.to === 'string' && DAY.test(query.to) ? query.to : null;
  if (!from || !to) throw EpmError.badRequest('Give the period as from and to dates, e.g. 2026-10-01 and 2026-10-31.');
  if (from > to) throw EpmError.badRequest('from must not be after to.');
  if (daysBetween(from, to) > 366) throw EpmError.badRequest('A period can be at most a year long.');
  return { from, to };
}

interface Candidate {
  kind: 'time' | 'expense' | 'milestone';
  sourceId: string;
  day: string;
  personId: string | null;
  description: string;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  reportingAmount: number;
  exchangeRate: number;
}

/** What the project is to bill for in the period, by its billing model, and what could not be priced. */
async function candidatesFor(projectId: number, from: string, to: string, contract: Contract) {
  const reporting = reportingCurrency();
  const converter = new Converter();
  const candidates: Candidate[] = [];
  const unpriced = new Map<string, number>();
  let approvedHours = 0;
  if (contract.billingModel === 'time_and_materials') {
    const pricing = await loadPricing();
    const card = cardOf(pricing, contract);
    for (const entry of await approvedTime(projectId, from, to)) {
      approvedHours += entry.hours;
      const rate = billRate(card, pricing.roleOf.get(Number(entry.personId)) ?? null);
      if (rate === null) {
        unpriced.set(entry.personId, (unpriced.get(entry.personId) ?? 0) + entry.hours);
        continue;
      }
      const amount = money(entry.hours * rate);
      const converted = await converter.on(amount, contract.currency, reporting, entry.spentOn);
      candidates.push({
        kind: 'time',
        sourceId: entry.id,
        day: entry.spentOn,
        personId: entry.personId,
        description: `${entry.workPackageId ? `#${entry.workPackageId} ` : ''}${entry.spentOn}, ${entry.hours} h`,
        quantity: entry.hours,
        unitPrice: rate,
        amount,
        reportingAmount: converted.amount,
        exchangeRate: converted.rate,
      });
    }
  }
  let approvedExpenses = 0;
  const claims = await prisma.expenseClaim.findMany({
    where: { projectId, status: { in: ['approved', 'posted'] }, spentOn: { gte: new Date(from), lte: new Date(to) } },
    orderBy: { spentOn: 'asc' },
  });
  for (const claim of claims) {
    const day = isoDay(claim.spentOn);
    const inProject = await converter.on(Number(claim.amount), claim.currency, contract.currency, day);
    approvedExpenses += inProject.amount;
    const reportingAmount = claim.reportingAmount !== null ? Number(claim.reportingAmount) : (await converter.on(Number(claim.amount), claim.currency, reporting, day)).amount;
    candidates.push({
      kind: 'expense',
      sourceId: claim.id,
      day,
      personId: claim.claimantId,
      description: `${claimKey(claim.id)} ${claim.description}`.slice(0, 500),
      quantity: 1,
      unitPrice: null,
      amount: inProject.amount,
      reportingAmount,
      exchangeRate: inProject.rate,
    });
  }
  if (contract.billingModel === 'fixed_price') {
    const day = to < todayIso() ? to : todayIso();
    for (const row of await prisma.billingMilestone.findMany({ where: { projectId } })) {
      const work = await liveWork(row.workPackageId);
      if (!work?.closed) continue;
      const amount = Number(row.amount);
      const converted = await converter.on(amount, contract.currency, reporting, day);
      candidates.push({
        kind: 'milestone',
        sourceId: String(row.workPackageId),
        day,
        personId: null,
        description: `#${row.workPackageId} ${work.subject}`.slice(0, 500),
        quantity: 1,
        unitPrice: amount,
        amount,
        reportingAmount: converted.amount,
        exchangeRate: converted.rate,
      });
    }
  }
  return {
    candidates,
    unpriced: [...unpriced].map(([personId, hours]) => ({ personId, hours: money(hours) })),
    approvedHours: money(approvedHours),
    approvedExpenses: money(approvedExpenses),
  };
}

function itemView(row: Awaited<ReturnType<typeof prisma.billableItem.findFirstOrThrow>>): BillableItemView {
  return {
    id: row.id,
    projectId: String(row.projectId),
    kind: row.kind as BillableItemView['kind'],
    sourceId: row.sourceId,
    day: isoDay(row.day),
    personId: row.personId,
    description: row.description,
    quantity: Number(row.quantity),
    unitPrice: row.unitPrice === null ? null : Number(row.unitPrice),
    amount: Number(row.amount),
    currency: row.currency,
    reportingAmount: Number(row.reportingAmount),
    exchangeRate: Number(row.exchangeRate),
    status: row.status as BillableItemView['status'],
    batchId: row.batchId,
    externalRef: row.externalRef,
  };
}

/**
 * The billable items of a project's period, against what was approved for it.
 * Reading without a period shows this month, as the other period reports
 * default theirs; creating billable items still needs the period named.
 */
export async function billingView(projectId: number, query: { from?: unknown; to?: unknown }): Promise<BillingView> {
  const { from, to } = periodOf(query.from === undefined && query.to === undefined ? thisMonth() : query);
  const contract = (await contractsOf([projectId])).get(projectId)!;
  const [rows, expected] = await Promise.all([
    prisma.billableItem.findMany({ where: { projectId, day: { gte: new Date(from), lte: new Date(to) } }, orderBy: [{ day: 'asc' }, { kind: 'asc' }, { id: 'asc' }] }),
    contract.billingModel === 'non_billable' ? null : candidatesFor(projectId, from, to, contract),
  ]);
  const items = rows.map(itemView);
  const reconciliation = reconcileBilling({
    approvedHours: expected?.approvedHours ?? 0,
    approvedExpenses: expected?.approvedExpenses ?? 0,
    items,
  });
  return {
    projectId: String(projectId),
    currency: contract.currency,
    billingModel: contract.billingModel,
    from,
    to,
    items,
    reconciliation: { ...reconciliation, unpriced: expected?.unpriced ?? [] },
    totals: {
      amount: fromCents(items.reduce((sum, item) => sum + toCents(item.amount), 0)),
      reportingAmount: fromCents(items.reduce((sum, item) => sum + toCents(item.reportingAmount), 0)),
    },
  };
}

/**
 * Makes the billable items of a project's period from approved time, approved
 * expense claims and milestones reached — by its billing model — one per
 * source: generating again updates what is still open and never duplicates.
 * Items whose source is no longer approved go, unless already sent.
 */
export async function generateBilling(projectId: number, query: { from?: unknown; to?: unknown }, actorId: string): Promise<BillingView> {
  const { from, to } = periodOf(query);
  const contract = (await contractsOf([projectId])).get(projectId)!;
  if (contract.billingModel === 'non_billable') throw EpmError.conflict('This project is not billed: its billing model is non-billable.');
  const { candidates } = await candidatesFor(projectId, from, to, contract);
  const keyOf = (item: { kind: string; sourceId: string }) => `${item.kind}:${item.sourceId}`;
  const wanted = new Map(candidates.map((candidate) => [keyOf(candidate), candidate]));
  const outcome = await withAudit(
    async (tx) => {
      const existing = await tx.billableItem.findMany({
        where: {
          OR: [
            { projectId, day: { gte: new Date(from), lte: new Date(to) } },
            ...(candidates.length > 0 ? [{ OR: candidates.map((candidate) => ({ kind: candidate.kind, sourceId: candidate.sourceId })) }] : []),
          ],
        },
      });
      const byKey = new Map(existing.map((row) => [keyOf(row), row]));
      let created = 0;
      let updated = 0;
      let removed = 0;
      for (const candidate of candidates) {
        const row = byKey.get(keyOf(candidate));
        const data = {
          projectId,
          day: new Date(candidate.day),
          personId: candidate.personId,
          description: candidate.description,
          quantity: candidate.quantity,
          unitPrice: candidate.unitPrice,
          amount: candidate.amount,
          currency: contract.currency,
          reportingAmount: candidate.reportingAmount,
          exchangeRate: candidate.exchangeRate,
        };
        if (!row) {
          await tx.billableItem.create({ data: { kind: candidate.kind, sourceId: candidate.sourceId, ...data } });
          created += 1;
        } else if (row.status === 'open') {
          await tx.billableItem.update({ where: { id: row.id }, data });
          updated += 1;
        }
      }
      for (const row of existing) {
        if (row.status !== 'open' || row.projectId !== projectId || wanted.has(keyOf(row))) continue;
        await tx.billableItem.delete({ where: { id: row.id } });
        removed += 1;
      }
      return { created, updated, removed };
    },
    (counts) => ({
      actorId,
      entityType: 'project',
      entityId: String(projectId),
      action: 'billing.generated',
      summary: message('Billable items for project #{project} from {from} to {to}: {created} new, {updated} updated, {removed} removed.', {
        project: projectId,
        from: dateOf(from),
        to: dateOf(to),
        ...counts,
      }),
      after: { from, to, ...counts },
    }),
  );
  void outcome;
  return billingView(projectId, { from, to });
}

/* -------------------------------------------------------------------------- */
/* Transfer to the finance system (BR-323)                                    */
/* -------------------------------------------------------------------------- */

type BatchRow = Awaited<ReturnType<typeof prisma.financeBatch.findFirstOrThrow>>;

function batchView(row: BatchRow, items?: Awaited<ReturnType<typeof prisma.billableItem.findMany>>): FinanceBatchView {
  return {
    id: row.id,
    status: row.status as FinanceBatchView['status'],
    itemCount: row.itemCount,
    totals: row.totals as Record<string, number>,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    attempts: row.attempts,
    replays: row.replays,
    lastError: row.lastError,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    reconciliation: (row.reconciliation as FinanceBatchView['reconciliation']) ?? null,
    ...(items ? { items: items.map(itemView) } : {}),
  };
}

export async function listBatches(): Promise<FinanceBatchView[]> {
  const rows = await prisma.financeBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map((row) => batchView(row));
}

export async function getBatch(id: string): Promise<FinanceBatchView> {
  const row = await prisma.financeBatch.findUnique({ where: { id }, include: { items: { orderBy: [{ day: 'asc' }, { id: 'asc' }] } } });
  if (!row) throw EpmError.notFound('That batch');
  return batchView(row, row.items);
}

/** Puts every open billable item — of one project, if named — into a new batch, ready to send. */
export async function createBatch(input: unknown, actorId: string): Promise<FinanceBatchView> {
  const parsed = z.object({ projectId: z.union([z.string(), z.number()]).transform(Number).optional() }).safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The batch is not complete.', parsed.error.issues);
  const projectId = parsed.data.projectId;
  const batch = await withAudit(
    async (tx) => {
      const items = await tx.billableItem.findMany({ where: { status: 'open', batchId: null, ...(projectId ? { projectId } : {}) } });
      if (items.length === 0) throw EpmError.conflict('There are no open billable items to send.');
      const cents = new Map<string, number>();
      for (const item of items) cents.set(item.currency, (cents.get(item.currency) ?? 0) + toCents(Number(item.amount)));
      const totals = Object.fromEntries([...cents].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => [currency, fromCents(value)]));
      const created = await tx.financeBatch.create({ data: { itemCount: items.length, totals, createdBy: actorId } });
      await tx.billableItem.updateMany({ where: { id: { in: items.map((item) => item.id) } }, data: { batchId: created.id, status: 'batched' } });
      return created;
    },
    (created) => ({
      actorId,
      entityType: 'finance-batch',
      entityId: created.id,
      action: 'finance.batch.created',
      summary: message('Batch {batch} made of {count, plural, one {# billable item} other {# billable items}}.', { batch: created.id.slice(0, 8), count: created.itemCount }),
      after: { itemCount: created.itemCount, totals: created.totals },
    }),
  );
  return getBatch(batch.id);
}

const answerSchema = z.object({
  received: z.array(z.object({ itemId: z.string().min(1).max(64), reference: z.string().min(1).max(200) })).max(20_000),
  totals: z.record(z.string(), z.number()).optional(),
});

/**
 * Sends a batch to the finance system — or, with `replay`, sends it again: the
 * same batch id as the idempotency key and correlation id, the same item ids.
 * The answer lists what it took, with its reference for each; the batch is
 * reconciled against it, and a replay that came back with new references —
 * a second document — is reported as a duplicate.
 */
export async function sendBatch(id: string, actorId: string, replay: boolean): Promise<FinanceBatchView> {
  const settings = await getFinanceSettings();
  if (!settings.endpoint) throw EpmError.conflict('No finance system is connected: set its address under Administration, or download the batch.');
  const batch = await prisma.financeBatch.findUnique({ where: { id }, include: { items: { orderBy: [{ day: 'asc' }, { id: 'asc' }] } } });
  if (!batch) throw EpmError.notFound('That batch');
  if (!replay && !['ready', 'failed'].includes(batch.status)) throw EpmError.conflict('This batch has been sent: replay it instead.');
  if (replay && batch.status === 'ready') throw EpmError.conflict('This batch has not been sent yet.');
  const facts = await modelFacts();
  const payload = {
    batchId: batch.id,
    correlationId: batch.id,
    createdAt: batch.createdAt.toISOString(),
    replay,
    totals: batch.totals,
    items: batch.items.map((item) => ({
      itemId: item.id,
      projectId: String(item.projectId),
      project: nameOf(facts, item.projectId),
      kind: item.kind,
      day: isoDay(item.day),
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: item.unitPrice === null ? null : Number(item.unitPrice),
      amount: Number(item.amount),
      currency: item.currency,
    })),
  };
  const result = await postJson(settings.endpoint, payload, 15_000, {
    headers: { 'Idempotency-Key': batch.id, 'User-Agent': 'EPM-Finance/1' },
    readBody: true,
  });
  const counter = replay ? { replays: { increment: 1 } } : { attempts: { increment: 1 } };
  let answer: z.infer<typeof answerSchema> | null = null;
  let problem: string | null = result.ok ? null : (result.error ?? msg('The finance system did not answer.'));
  if (result.ok) {
    try {
      const parsed = answerSchema.safeParse(JSON.parse(result.body ?? ''));
      if (parsed.success) answer = parsed.data;
    } catch {
      // Not JSON: reported below.
    }
    if (!answer) problem = msg('The finance system answered, but not with what it received.');
  }
  if (!answer) {
    const failed = await prisma.financeBatch.update({
      where: { id },
      data: { ...counter, lastError: problem, ...(replay ? {} : { status: 'failed' }) },
    });
    return batchView(failed, batch.items);
  }
  const reconciliation = reconcileBatch(
    batch.items.map((item) => ({ id: item.id, amount: Number(item.amount), currency: item.currency, reference: item.externalRef })),
    answer,
  );
  const now = new Date();
  await withAudit(
    async (tx) => {
      const seen = new Set<string>();
      for (const entry of answer.received) {
        if (seen.has(entry.itemId)) continue;
        seen.add(entry.itemId);
        const item = batch.items.find((one) => one.id === entry.itemId);
        if (!item) continue;
        await tx.billableItem.update({ where: { id: item.id }, data: { status: 'transferred', externalRef: item.externalRef ?? entry.reference } });
      }
      return tx.financeBatch.update({
        where: { id },
        data: {
          ...counter,
          status: reconciliation.matched ? 'acknowledged' : 'mismatch',
          sentAt: batch.sentAt ?? now,
          acknowledgedAt: reconciliation.matched ? (batch.acknowledgedAt ?? now) : batch.acknowledgedAt,
          lastError: null,
          reconciliation: reconciliation as unknown as object,
        },
      });
    },
    () => ({
      actorId,
      entityType: 'finance-batch',
      entityId: id,
      action: replay ? 'finance.batch.replayed' : 'finance.batch.sent',
      summary: message(
        '{replay, select, true {Batch {batch} sent again} other {Batch {batch} sent}}: {received} of {count} acknowledged, {matched, select, true {reconciled} other {not reconciled}}.',
        { replay: String(replay), batch: id.slice(0, 8), received: reconciliation.finance.count, count: reconciliation.epm.count, matched: String(reconciliation.matched) },
      ),
      after: { reconciliation },
    }),
  );
  return getBatch(id);
}

/** A batch as a workbook, for a finance system nothing sends to. */
export async function batchWorkbook(id: string): Promise<{ filename: string; content: Uint8Array }> {
  const batch = await getBatch(id);
  const facts = await modelFacts();
  const language = contextLanguage();
  const word = (source: string) => t(language, source);
  return {
    filename: `epm-billing-${id.slice(0, 8)}.xlsx`,
    content: buildWorkbook(
      [
        {
          name: word('Billable items'),
          headers: [word('Item'), word('Project'), word('Kind'), word('Date'), word('Description'), word('Quantity'), word('Unit price'), word('Amount'), word('Currency'), word('Reference')],
          rows: (batch.items ?? []).map((item) => [
            item.id,
            nameOf(facts, Number(item.projectId)),
            item.kind,
            item.day,
            item.description,
            item.quantity,
            item.unitPrice ?? '',
            item.amount,
            item.currency,
            item.externalRef ?? '',
          ]),
        },
      ],
      { title: t(language, 'Billing batch {batch}', { batch: id }), rightToLeft: language === 'ar' },
    ),
  };
}
