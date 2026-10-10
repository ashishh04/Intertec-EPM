import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError } from '../lib/errors.js';
import { message, msg, type Message } from '../lib/i18n.js';
import { roundMoney } from '../lib/money.js';
import { getCatalog } from '../mapping/catalog.js';
import { linkId, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import { withAudit } from './audit.js';
import { dayOf, isoOf } from './critical-path.js';
import {
  combineTotals,
  DEFAULT_METHOD,
  EARNING_METHODS,
  evaluateEarnedValue,
  isEarningMethod,
  WorkingDayCounter,
  type EarningMethod,
  type Evaluation,
  type LabourEntry,
  type PlannedItem,
  type ProgressState,
  type Totals,
} from './earned-value.js';
import type { ModelFacts, TimeFact, WorkFact } from './measure-facts.js';
import { isDelivered } from './work-definitions.js';

/**
 * Earned value's records and how they meet the analytics model (BR-301 to
 * BR-303): the earning rules and the rate for unpriced work (versioned
 * settings), each project's baselines,
 * and the evaluation the measures, the dashboard and the API all call.
 *
 * What planned value is measured against, per project and reporting date: the
 * baseline in force then — the last one set by then, or the first one for a
 * date before any was set — and, for a project with no baseline at all, its
 * plan as it stood that day, priced at today's rates. Every figure says which.
 */

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export interface EvmSettings {
  /** 0 is the defaults, before anything was saved. */
  version: number;
  defaultMethod: EarningMethod;
  /** Type id → how it earns, where that is not the default. */
  methods: Record<string, EarningMethod>;
  /** The hourly rate for work whose assignee has none; null leaves such work unpriced. */
  unpricedRate: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_SETTINGS: EvmSettings = {
  version: 0,
  defaultMethod: DEFAULT_METHOD,
  methods: {},
  unpricedRate: null,
};

const method = z.string().refine(isEarningMethod, msg('Not an earning rule.')) as unknown as z.ZodType<EarningMethod>;

const settingsSchema = z.object({
  defaultMethod: method.default(DEFAULT_METHOD),
  methods: z.record(z.string().regex(/^\d+$/, msg('Type ids are numbers.')), method).default({}),
  unpricedRate: z.number().nonnegative().max(1_000_000).nullable().default(null),
});

/** Every version, oldest first. Kept briefly: other servers save too. */
let history: { at: number; rows: Promise<(EvmSettings & { createdAt: Date })[]> } | undefined;
const HISTORY_TTL_MS = 30_000;

export function settingsHistory(): Promise<(EvmSettings & { createdAt: Date })[]> {
  if (history && Date.now() - history.at < HISTORY_TTL_MS) return history.rows;
  const rows = prisma.evmSettingSet
    .findMany({ orderBy: { version: 'asc' } })
    .then((sets) =>
      sets.map((row) => {
        const parsed = settingsSchema.safeParse(row.settings);
        const settings = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
        return {
          ...settings,
          version: row.version,
          createdAt: row.createdAt,
          updatedAt: row.createdAt.toISOString(),
          updatedBy: row.createdBy,
        };
      }),
    )
    .catch((error: unknown) => {
      history = undefined;
      throw error;
    });
  history = { at: Date.now(), rows };
  return rows;
}

function forgetSettings(): void {
  history = undefined;
}

/** The settings in force at an instant: the last saved by then, or the defaults. */
export function settingsAt(versions: (EvmSettings & { createdAt: Date })[], instant: Date): EvmSettings {
  let found: EvmSettings = DEFAULT_SETTINGS;
  for (const version of versions) if (version.createdAt.getTime() <= instant.getTime()) found = version;
  return found;
}

export async function getEvmSettings(): Promise<EvmSettings> {
  const versions = await settingsHistory();
  return versions.at(-1) ?? DEFAULT_SETTINGS;
}

export const methodOf = (settings: EvmSettings) => (typeId: number): EarningMethod =>
  settings.methods[String(typeId)] ?? settings.defaultMethod;

/** Several messages as one, "a; b; c", each written out in the reader's language. */
function joined(parts: (string | Message)[]): string | Message {
  return parts.slice(1).reduce<string | Message>((text, next) => message('{first}; {next}', { first: text, next }), parts[0] ?? '');
}

/** Saves a new version and journals what changed. */
export async function saveEvmSettings(input: unknown, actorId: string): Promise<EvmSettings> {
  const parsed = settingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation(joined(parsed.error.issues.map((issue) => issue.message)));
  const next = parsed.data;
  // A type set to the default is not an exception to it.
  next.methods = Object.fromEntries(Object.entries(next.methods).filter(([, value]) => value !== next.defaultMethod));
  const current = await getEvmSettings();

  // The rules' names are catalogue entries, so the journal reads them in its
  // reader's language; a type's name is data.
  const catalog = await getCatalog();
  const typeName = (id: string): string | Message => catalog.typeById.get(id)?.name ?? message('type {id}', { id });
  const changes: Message[] = [];
  if (current.defaultMethod !== next.defaultMethod) {
    changes.push(
      message('default rule {from} → {to}', {
        from: EARNING_METHODS[current.defaultMethod].label,
        to: EARNING_METHODS[next.defaultMethod].label,
      }),
    );
  }
  for (const id of new Set([...Object.keys(current.methods), ...Object.keys(next.methods)])) {
    const before = current.methods[id] ?? current.defaultMethod;
    const after = next.methods[id] ?? next.defaultMethod;
    if (before !== after) {
      changes.push(message('{type} {from} → {to}', { type: typeName(id), from: EARNING_METHODS[before].label, to: EARNING_METHODS[after].label }));
    }
  }
  if (current.unpricedRate !== next.unpricedRate) {
    changes.push(
      message('rate for unpriced work {from} → {to}', {
        from: current.unpricedRate ?? msg('none'),
        to: next.unpricedRate ?? msg('none'),
      }),
    );
  }
  if (changes.length === 0) throw EpmError.conflict('Those are already the settings in force.');

  const saved = await withAudit(
    async (tx) => {
      const top = await tx.evmSettingSet.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      return tx.evmSettingSet.create({
        data: { version: (top?.version ?? 0) + 1, settings: next as unknown as object, createdBy: actorId },
      });
    },
    (row) => ({
      actorId,
      entityType: 'evm-settings',
      entityId: String(row.version),
      action: 'evm.settings.updated',
      summary: message('Earned value settings version {version}: {changes}.', { version: row.version, changes: joined(changes) }),
      before: { ...current },
      after: { version: row.version, ...next },
    }),
  );
  forgetSettings();
  return { ...next, version: saved.version, updatedAt: saved.createdAt.toISOString(), updatedBy: actorId };
}

/* -------------------------------------------------------------------------- */
/* Rates                                                                      */
/* -------------------------------------------------------------------------- */

let rates: { at: number; value: Promise<Map<number, number>> } | undefined;

/** Each person's hourly rate, by OpenProject user id. Today's: EPM keeps no rate history yet (BRL-08). */
export function hourlyRates(): Promise<Map<number, number>> {
  if (rates && Date.now() - rates.at < HISTORY_TTL_MS) return rates.value;
  const value = prisma.userProfile
    .findMany({ where: { hourlyRate: { not: null } }, select: { openProjectId: true, hourlyRate: true } })
    .then((rows) => new Map(rows.map((row) => [Number(row.openProjectId), row.hourlyRate ?? 0])));
  rates = { at: Date.now(), value };
  return value;
}

/* -------------------------------------------------------------------------- */
/* Baselines                                                                  */
/* -------------------------------------------------------------------------- */

export interface BaselineView {
  id: string;
  projectId: string;
  number: number;
  reason: string | null;
  setBy: string;
  setAt: string;
  bac: number;
  items: number;
  unpriced: number;
  undated: number;
}

interface StoredBaseline {
  id: string;
  number: number;
  createdAt: Date;
  items: PlannedItem[];
}

const toView = (row: {
  id: string;
  projectId: number;
  number: number;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
  bac: number;
  items: number;
  unpriced: number;
  undated: number;
}): BaselineView => ({
  id: row.id,
  projectId: String(row.projectId),
  number: row.number,
  reason: row.reason,
  setBy: row.createdBy,
  setAt: row.createdAt.toISOString(),
  bac: row.bac,
  items: row.items,
  unpriced: row.unpriced,
  undated: row.undated,
});

export async function listBaselines(projectId: number): Promise<BaselineView[]> {
  const rows = await prisma.evmBaseline.findMany({ where: { projectId }, orderBy: { number: 'desc' } });
  return rows.map(toView);
}

interface OpWorkPackageLite {
  id: number;
  subject?: string;
  startDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  estimatedTime?: string | null;
  _links?: Record<string, HalLink | undefined>;
}

/**
 * Prices a work package's estimate: at its assignee's rate, or the rate for
 * unpriced work, or not at all. Nothing to price is a budget of nought.
 */
export function priced(hours: number | null, assigneeId: number | null, rateOf: Map<number, number>, unpricedRate: number | null) {
  const rate = (assigneeId !== null ? rateOf.get(assigneeId) : undefined) ?? unpricedRate;
  if (!hours || hours <= 0) return { rate: rate ?? null, bac: 0 };
  return { rate: rate ?? null, bac: rate === null || rate === undefined ? null : roundMoney(hours * rate) };
}

/** The journal's line for a baseline: what it holds, and why it was set when a reason was given. */
function baselineSummary(baseline: { number: number; count: number; bac: string; unpriced: number; reason: string | null }): Message {
  const { number, count, bac, unpriced, reason } = baseline;
  if (unpriced && reason) {
    return message(
      'Baseline {number} set: {count} work packages, budget at completion {bac}, {unpriced} with no rate to price them. {reason}',
      { number, count, bac, unpriced, reason },
    );
  }
  if (unpriced) {
    return message('Baseline {number} set: {count} work packages, budget at completion {bac}, {unpriced} with no rate to price them.', {
      number,
      count,
      bac,
      unpriced,
    });
  }
  if (reason) {
    return message('Baseline {number} set: {count} work packages, budget at completion {bac}. {reason}', { number, count, bac, reason });
  }
  return message('Baseline {number} set: {count} work packages, budget at completion {bac}.', { number, count, bac });
}

/**
 * Sets a project's baseline: its plan as OpenProject has it now — every work
 * package's estimate, priced, and its planned dates — frozen and journalled.
 */
export async function setBaseline(projectId: number, reason: string | null, actorId: string): Promise<BaselineView> {
  const [catalog, rateOf, settings] = await Promise.all([getCatalog(), hourlyRates(), getEvmSettings()]);
  const work = await runAsSystem(() =>
    openProject.getAll<OpWorkPackageLite>(`/projects/${projectId}/work_packages`, {
      filters: [{ field: 'status', operator: '*', values: [] }],
      pageSize: 1000,
    }),
  );
  if (work.truncated) throw EpmError.conflict('The project has more work than a baseline can hold at once.');

  const items: (PlannedItem & { subject: string })[] = work.items
    .filter((item) => linkId(item._links, 'project') === String(projectId) || !item._links?.project)
    .map((item) => {
      const typeId = Number(linkId(item._links, 'type') ?? 0);
      const assignee = linkId(item._links, 'assignee');
      const hours = durationToHours(item.estimatedTime) ?? null;
      const price = priced(hours, assignee ? Number(assignee) : null, rateOf, settings.unpricedRate);
      const isMilestone = catalog.typeById.get(String(typeId))?.epm === 'milestone';
      return {
        workPackageId: item.id,
        projectId,
        parentId: linkId(item._links, 'parent') ? Number(linkId(item._links, 'parent')) : null,
        typeId,
        isMilestone,
        // Stored with the baseline as data, like a subject OpenProject sent.
        subject: item.subject ?? `Work package ${item.id}`,
        estimatedHours: hours,
        rate: price.rate,
        bac: price.bac,
        plannedStart: item.startDate ?? item.date ?? null,
        plannedFinish: item.dueDate ?? item.date ?? null,
      };
    });

  const bac = roundMoney(items.reduce((sum, item) => sum + (item.bac ?? 0), 0));
  const unpriced = items.filter((item) => item.bac === null).length;
  const undated = items.filter((item) => (item.bac ?? 0) > 0 && (!item.plannedStart || !item.plannedFinish)).length;

  const created = await withAudit(
    async (tx) => {
      const top = await tx.evmBaseline.findFirst({ where: { projectId }, orderBy: { number: 'desc' }, select: { number: true } });
      return tx.evmBaseline.create({
        data: {
          projectId,
          number: (top?.number ?? 0) + 1,
          reason: reason?.trim() || null,
          createdBy: actorId,
          bac,
          items: items.length,
          unpriced,
          undated,
          workPackages: {
            create: items.map((item) => ({
              workPackageId: item.workPackageId,
              parentId: item.parentId,
              typeId: item.typeId,
              isMilestone: item.isMilestone,
              subject: item.subject,
              estimatedHours: item.estimatedHours,
              rate: item.rate,
              bac: item.bac,
              plannedStart: item.plannedStart ? new Date(`${item.plannedStart}T00:00:00Z`) : null,
              plannedFinish: item.plannedFinish ? new Date(`${item.plannedFinish}T00:00:00Z`) : null,
            })),
          },
        },
      });
    },
    (row) => ({
      actorId,
      projectId: String(projectId),
      entityType: 'evm-baseline',
      entityId: row.id,
      action: 'evm.baseline.set',
      summary: baselineSummary({ number: row.number, count: items.length, bac: bac.toFixed(2), unpriced, reason: row.reason }),
      after: { number: row.number, bac, items: items.length, unpriced, undated, reason: row.reason },
    }),
  );
  forgetBaselines();
  return toView(created);
}

let baselineCache: { at: number; value: Promise<Map<number, StoredBaseline[]>> } | undefined;

function forgetBaselines(): void {
  baselineCache = undefined;
}

/** Every project's baselines with their items, oldest first. Kept briefly. */
function allBaselines(): Promise<Map<number, StoredBaseline[]>> {
  if (baselineCache && Date.now() - baselineCache.at < HISTORY_TTL_MS) return baselineCache.value;
  const value = prisma.evmBaseline
    .findMany({ orderBy: [{ projectId: 'asc' }, { number: 'asc' }], include: { workPackages: true } })
    .then((rows) => {
      const byProject = new Map<number, StoredBaseline[]>();
      for (const row of rows) {
        const list = byProject.get(row.projectId) ?? [];
        list.push({
          id: row.id,
          number: row.number,
          createdAt: row.createdAt,
          items: row.workPackages.map((item) => ({
            workPackageId: item.workPackageId,
            projectId: row.projectId,
            parentId: item.parentId,
            typeId: item.typeId,
            isMilestone: item.isMilestone,
            estimatedHours: item.estimatedHours,
            rate: item.rate,
            bac: item.bac,
            plannedStart: item.plannedStart ? isoOf(dayOf(item.plannedStart.toISOString().slice(0, 10))) : null,
            plannedFinish: item.plannedFinish ? isoOf(dayOf(item.plannedFinish.toISOString().slice(0, 10))) : null,
          })),
        });
        byProject.set(row.projectId, list);
      }
      return byProject;
    })
    .catch((error: unknown) => {
      baselineCache = undefined;
      throw error;
    });
  baselineCache = { at: Date.now(), value };
  return value;
}

/** Deletes a project's baselines, with the project. */
export async function forgetProjectBaselines(projectId: number): Promise<void> {
  await prisma.evmBaseline.deleteMany({ where: { projectId } });
  forgetBaselines();
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

export interface EvmShared {
  settings: (EvmSettings & { createdAt: Date })[];
  baselines: Map<number, StoredBaseline[]>;
  rates: Map<number, number>;
  days: WorkingDayCounter;
}

const counters = new WeakMap<ModelFacts['calendar'], WorkingDayCounter>();

/** The instance's working days, from the model's calendar. */
export function workingDaysOf(calendar: ModelFacts['calendar']): WorkingDayCounter {
  let counter = counters.get(calendar);
  if (!counter) {
    counter = new WorkingDayCounter({
      isWorking: (day) => {
        if (day >= calendar.from && day <= calendar.to) return !calendar.nonWorking.has(day);
        const weekday = ((((day + 3) % 7) + 7) % 7) + 1;
        return weekday <= 5;
      },
    });
    counters.set(calendar, counter);
  }
  return counter;
}

/** What evaluation needs beyond the model, loaded once per request. */
export async function loadEvmShared(facts: ModelFacts): Promise<EvmShared> {
  const [settings, baselines, rateOf] = await Promise.all([settingsHistory(), allBaselines(), hourlyRates()]);
  return { settings, baselines, rates: rateOf, days: workingDaysOf(facts.calendar) };
}

export type MeasuredAgainst = { kind: 'baseline'; number: number; setAt: string } | { kind: 'plan' };

export interface ProjectEvaluation {
  projectId: number;
  measuredAgainst: MeasuredAgainst;
  evaluation: Evaluation;
}

export interface ScopeEvaluation {
  at: string;
  settingsVersion: number;
  projects: ProjectEvaluation[];
  totals: Totals;
}

/** A work package's progress as earned value reads it. */
export function progressOf(work: WorkFact): ProgressState {
  const started = (work.doneRatio ?? 0) > 0 || ['in_progress', 'review', 'done'].includes(work.statusCategory);
  return {
    workPackageId: work.id,
    parentId: work.parentId,
    isMilestone: work.isMilestone,
    doneRatio: work.doneRatio,
    delivered: isDelivered(work),
    started,
    estimatedHours: work.estimatedHours,
  };
}

const labourOf = (time: TimeFact): LabourEntry => ({
  projectId: time.projectId,
  workPackageId: time.workPackageId,
  spentOn: time.spentOn,
  hours: time.hours,
  cost: time.cost,
});

/** The plan a project is measured against at an instant, and what it is. */
export function planFor(
  shared: EvmShared,
  settings: EvmSettings,
  projectId: number,
  instant: Date,
  work: WorkFact[],
): { items: PlannedItem[]; measuredAgainst: MeasuredAgainst } {
  const baselines = shared.baselines.get(projectId) ?? [];
  if (baselines.length > 0) {
    let chosen = baselines[0]!;
    for (const baseline of baselines) if (baseline.createdAt.getTime() <= instant.getTime()) chosen = baseline;
    return {
      items: chosen.items,
      measuredAgainst: { kind: 'baseline', number: chosen.number, setAt: chosen.createdAt.toISOString() },
    };
  }
  return {
    items: work
      .filter((item) => item.projectId === projectId)
      .map((item) => {
        const price = priced(item.estimatedHours, item.assigneeId, shared.rates, settings.unpricedRate);
        return {
          workPackageId: item.id,
          projectId,
          parentId: item.parentId,
          typeId: item.typeId,
          isMilestone: item.isMilestone,
          estimatedHours: item.estimatedHours,
          rate: price.rate,
          bac: price.bac,
          plannedStart: item.startDate,
          plannedFinish: item.dueDate,
        };
      }),
    measuredAgainst: { kind: 'plan' },
  };
}

/**
 * Earned value for some projects as at a reporting date, from work as it
 * stood then (`work`) and the labour of those projects (`time`). The settings
 * and baselines are those in force at `instant`, the end of the reporting date
 * unless given.
 */
export function evaluateProjects(
  shared: EvmShared,
  input: { projectIds: number[]; at: string; instant?: Date; work: WorkFact[]; time: TimeFact[] },
): ScopeEvaluation {
  const instant = input.instant ?? new Date(`${input.at}T23:59:59.999Z`);
  const settings = settingsAt(shared.settings, instant);
  const progress = new Map(input.work.map((item) => [item.id, progressOf(item)]));
  const projects = input.projectIds.map((projectId) => {
    const plan = planFor(shared, settings, projectId, instant, input.work);
    const evaluation = evaluateEarnedValue({
      at: input.at,
      items: plan.items,
      progress,
      methodOf: methodOf(settings),
      days: shared.days,
      labour: input.time.filter((entry) => entry.projectId === projectId).map(labourOf),
    });
    return { projectId, measuredAgainst: plan.measuredAgainst, evaluation };
  });
  return {
    at: input.at,
    settingsVersion: settings.version,
    projects,
    totals: combineTotals(projects.map((project) => project.evaluation.totals)),
  };
}
