import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { withAudit } from './audit.js';
import { dayOf, isoOf } from './critical-path.js';
import {
  calibrate,
  forecastProject,
  groupOf,
  hashOf,
  MIN_GROUP,
  trainModel,
  type BacktestCase,
  type Calendar,
  type Calibration,
  type ForecastModel,
  type HistoryItem,
  type ProjectForecast,
  type ProjectInput,
} from './forecasting.js';
import { modelFacts, workFactsAsAt, type ModelFacts, type WorkFact } from './measure-facts.js';
import { generateRecommendations } from './recommendations.js';

/**
 * Forecasts made and kept (BR-509, BR-510): the model trained on the
 * organisation's history as the analytics model holds it, a forecast for every
 * active project with its inputs stored beside it, and the back-test that
 * checks the model against what actually happened.
 */

/** How far a back-test may miss and still pass (configurable per run). */
export const DEFAULT_TOLERANCE = { brier: 0.25, calibrationError: 0.15, minCases: 20 };

/**
 * At most this many work packages are forecast at each cut-off, chosen evenly
 * by id so a rerun picks the same ones: enough to measure calibration, and a
 * back-test of a large instance still finishes in minutes.
 */
const CASES_PER_CUTOFF = 500;

/** A back-test still running after this long has died with its server; another may start. */
const BACKTEST_STALE_MS = 30 * 60_000;

/**
 * Lets the server answer other requests before carrying on. A back-test runs
 * inside the API server, so a long stretch of forecasting without a pause would
 * hold up every request until it ended.
 */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

const calendarOf = (facts: ModelFacts): Calendar => ({ nonWorking: facts.calendar.nonWorking, workingWeekdays: facts.calendar.workingWeekdays });
const dayOfStamp = (stamp: string) => dayOf(stamp.slice(0, 10));
const todayDay = () => dayOf(new Date().toISOString().slice(0, 10));

/** What history teaches: every work package closed with a due date. */
function historyOf(work: WorkFact[]): HistoryItem[] {
  return work
    .filter((item) => item.isClosed && item.closedAt && item.dueDate && !item.isMilestone)
    .map((item) => ({
      id: item.id,
      group: groupOf(item.typeCategory, item.estimatedHours),
      due: dayOf(item.dueDate!),
      finished: dayOfStamp(item.closedAt!),
      estimatedHours: item.estimatedHours,
      spentHours: item.spentHours,
    }));
}

/** A project's forecast inputs from the facts: its open work, plan, budget and spend so far. */
function inputsFor(facts: ModelFacts, projectId: number, work: WorkFact[], today: number): ProjectInput | null {
  const project = facts.projects.get(projectId);
  if (!project || !project.active) return null;
  const own = work.filter((item) => item.projectId === projectId);
  const open = own.filter((item) => !item.isClosed && !item.isMilestone);
  if (open.length === 0) return null;
  const time = facts.time.filter((entry) => entry.projectId === projectId);
  const costed = time.filter((entry) => entry.cost !== null);
  const costedHours = costed.reduce((sum, entry) => sum + entry.hours, 0);
  const labour = costed.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const other = facts.costs.filter((entry) => entry.projectId === projectId).reduce((sum, entry) => sum + entry.amount, 0);
  const dues = open.map((item) => item.dueDate).filter((due): due is string => Boolean(due));
  return {
    projectId,
    name: project.name,
    today,
    plannedFinish: project.plannedFinish ? dayOf(project.plannedFinish) : dues.length ? dues.reduce((last, due) => Math.max(last, dayOf(due)), -Infinity) : null,
    budget: project.budget,
    spentCost: Math.round(labour + other),
    spentHours: Math.round(time.reduce((sum, entry) => sum + entry.hours, 0) * 100) / 100,
    costPerHour: costedHours > 0 ? Math.round((labour / costedHours) * 100) / 100 : null,
    open: open
      .sort((a, b) => a.id - b.id)
      .map((item) => ({
        id: item.id,
        subject: item.subject,
        group: groupOf(item.typeCategory, item.estimatedHours),
        due: item.dueDate ? dayOf(item.dueDate) : null,
        estimatedHours: item.estimatedHours,
        spentHours: item.spentHours,
      })),
  };
}

export interface ForecastView extends Omit<ProjectForecast, 'finish' | 'plannedFinish'> {
  id: string;
  runId: string;
  createdAt: string;
  plannedFinish: string | null;
  finish: { p10: string; p50: string; p90: string } | null;
  trainedOn: { items: number; withEstimates: number };
}

const toView = (row: { id: string; runId: string; createdAt: Date; output: unknown }, model: ForecastModel | null): ForecastView => {
  const output = row.output as ProjectForecast;
  return {
    ...output,
    id: row.id,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    plannedFinish: output.plannedFinish === null ? null : isoOf(output.plannedFinish),
    finish: output.finish ? { p10: isoOf(output.finish.p10), p50: isoOf(output.finish.p50), p90: isoOf(output.finish.p90) } : null,
    trainedOn: { items: model?.trainedOn.items ?? 0, withEstimates: model?.trainedOn.withEstimates ?? 0 },
  };
};

/**
 * Trains the model on the history as it stands and forecasts every active
 * project with open work; stores the model, each forecast with its inputs, and
 * the recommendations they lead to (BR-511, proposed only).
 */
export async function runForecasts(trigger: 'schedule' | 'manual', actorId: string | null): Promise<{ runId: string; projects: number; recommendations: number }> {
  const run = await prisma.forecastRun.create({ data: { kind: 'forecast', trigger, startedBy: actorId } });
  try {
    const facts = await modelFacts();
    const calendar = calendarOf(facts);
    const model = trainModel(historyOf(facts.workPackages), calendar);
    const today = todayDay();
    const forecasts: { projectId: number; inputs: ProjectInput; output: ProjectForecast }[] = [];
    for (const projectId of [...facts.projects.keys()].sort((a, b) => a - b)) {
      const inputs = inputsFor(facts, projectId, facts.workPackages, today);
      if (!inputs) continue;
      forecasts.push({ projectId, inputs, output: forecastProject(inputs, model, calendar) });
    }
    // The calendar is kept with the model: a forecast is reproduced on the working days it was made with.
    const stored = { ...model, calendar: { nonWorking: [...calendar.nonWorking].sort((a, b) => a - b), workingWeekdays: [...calendar.workingWeekdays].sort() } };
    await prisma.forecastRun.update({ where: { id: run.id }, data: { modelVersion: model.version, model: stored as unknown as Prisma.InputJsonValue } });
    const rows = [];
    for (const forecast of forecasts) {
      rows.push(
        await prisma.projectForecast.create({
          data: { runId: run.id, projectId: forecast.projectId, inputs: forecast.inputs as unknown as Prisma.InputJsonValue, output: forecast.output as unknown as Prisma.InputJsonValue },
        }),
      );
    }
    const proposed = await generateRecommendations(
      rows.map((row, index) => ({ id: row.id, inputs: forecasts[index]!.inputs, output: forecasts[index]!.output })),
      { facts, model, calendar },
    );
    await prisma.forecastRun.update({
      where: { id: run.id },
      data: { status: 'done', finishedAt: new Date(), summary: { projects: forecasts.length, trainedOn: model.trainedOn, recommendations: proposed } as Prisma.InputJsonValue },
    });
    return { runId: run.id, projects: forecasts.length, recommendations: proposed };
  } catch (error) {
    await prisma.forecastRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), error: String((error as Error)?.message ?? error).slice(0, 1000) } });
    throw error;
  }
}

/**
 * The forecasts of these projects from the latest completed run — a project
 * with no open work then has none, rather than a stale one — most at risk
 * first (lowest chance of finishing on time; those without a planned finish
 * last), and one page of them.
 */
export async function latestForecasts(projectIds: number[], page: { page: number; pageSize: number }): Promise<{ items: ForecastView[]; total: number }> {
  if (projectIds.length === 0) return { items: [], total: 0 };
  const run = await prisma.forecastRun.findFirst({ where: { kind: 'forecast', status: 'done' }, orderBy: { startedAt: 'desc' }, select: { id: true, model: true } });
  if (!run) return { items: [], total: 0 };
  const rows = await prisma.projectForecast.findMany({ where: { runId: run.id, projectId: { in: projectIds } } });
  const model = run.model as unknown as ForecastModel | null;
  const views = rows
    .map((row) => toView(row, model))
    .sort((a, b) => (a.probabilityOnTime ?? 2) - (b.probabilityOnTime ?? 2) || a.name.localeCompare(b.name) || a.projectId - b.projectId);
  const start = (page.page - 1) * page.pageSize;
  return { items: views.slice(start, start + page.pageSize), total: views.length };
}

/**
 * Reproduces a stored forecast from its stored inputs and model (BR-510), and
 * says whether the result is identical.
 */
export async function reproduceForecast(id: string): Promise<{ identical: boolean; stored: ProjectForecast; recomputed: ProjectForecast }> {
  const row = await prisma.projectForecast.findUnique({ where: { id }, include: { run: { select: { model: true } } } });
  if (!row) throw EpmError.notFound('That forecast');
  const model = row.run.model as unknown as ForecastModel & { calendar?: { nonWorking: number[]; workingWeekdays: number[] } };
  const calendar: Calendar = model.calendar
    ? { nonWorking: new Set(model.calendar.nonWorking), workingWeekdays: new Set(model.calendar.workingWeekdays) }
    : calendarOf(await modelFacts());
  const recomputed = forecastProject(row.inputs as unknown as ProjectInput, model, calendar);
  const stored = row.output as unknown as ProjectForecast;
  return { identical: hashOf(recomputed) === hashOf(stored), stored, recomputed };
}

export interface BacktestResult {
  runId: string;
  cutoffs: string[];
  /** Cut-offs with enough history before them to train on; the others are skipped. */
  cutoffsUsed: number;
  /** Cut-offs where more work packages qualified than CASES_PER_CUTOFF, and a sample was taken. */
  sampledAt: string[];
  tolerance: typeof DEFAULT_TOLERANCE;
  /** Projects as forecast at each cut-off, against how they actually finished. */
  projects: Calibration;
  /** Each work package open and dated at a cut-off, against whether it finished by its due date. */
  workPackages: Calibration;
  /** Pass, fail, or not enough history to say. */
  verdict: 'pass' | 'fail' | 'insufficient';
  basis: 'projects' | 'workPackages';
  /**
   * The history there is to learn from — work packages finished with a due
   * date, and when — and how many must have finished before a cut-off for it
   * to be used: what "not enough history" means on this instance.
   */
  history: { finished: number; firstClosed: string | null; lastClosed: string | null; minToLearn: number };
}

/** A back-test attempt, for showing that one is running or why it did not finish. */
export interface BacktestRunView {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** Why it failed; null when it was abandoned (its server stopped). */
  error: string | null;
}

const runView = (row: { id: string; status: string; startedAt: Date; finishedAt: Date | null; error: string | null }): BacktestRunView => {
  const abandoned = row.status === 'running' && row.startedAt.getTime() < Date.now() - BACKTEST_STALE_MS;
  return {
    id: row.id,
    status: abandoned ? 'failed' : (row.status as BacktestRunView['status']),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: abandoned ? null : row.error,
  };
};

/** Work packages by project, in their order. */
function groupByProject(items: WorkFact[]): Map<number, WorkFact[]> {
  const groups = new Map<number, WorkFact[]>();
  for (const item of items) {
    const list = groups.get(item.projectId);
    if (list) list.push(item);
    else groups.set(item.projectId, [item]);
  }
  return groups;
}

/** Every n-th of `items` by id, at most `limit` of them: the same ones on every run. */
function evenly<T extends { id: number }>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const sorted = [...items].sort((a, b) => a.id - b.id);
  return Array.from({ length: limit }, (_, index) => sorted[Math.floor((index * sorted.length) / limit)]!);
}

/**
 * Starts a back-test unless one is already running, and answers at once: a
 * back-test of a large instance takes longer than anyone should wait on a
 * request. `result` settles when it ends (null when one was already running);
 * either way the run records how it ended.
 */
export async function startBacktest(
  options: { months?: number; stepDays?: number; tolerance?: Partial<typeof DEFAULT_TOLERANCE> },
  actorId: string | null,
): Promise<{ run: BacktestRunView; started: boolean; result: Promise<BacktestResult> | null }> {
  const { row, started } = await prisma.$transaction(async (tx) => {
    // One at a time across servers: the check and the start are one step.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('epm-forecast-backtest', 0))`;
    const running = await tx.forecastRun.findFirst({
      where: { kind: 'backtest', status: 'running', startedAt: { gt: new Date(Date.now() - BACKTEST_STALE_MS) } },
      orderBy: { startedAt: 'desc' },
    });
    if (running) return { row: running, started: false };
    return { row: await tx.forecastRun.create({ data: { kind: 'backtest', trigger: 'manual', startedBy: actorId } }), started: true };
  });
  return { run: runView(row), started, result: started ? backtest(row.id, options, actorId) : null };
}

/**
 * Back-tests the model (BR-509): at cut-offs in the past, the state of every
 * project rebuilt from history, the model trained only on what had finished
 * by then, and its forecast compared with what happened after. Calibrated
 * within tolerance passes. Projects are the measure where enough of them have
 * since finished; otherwise work packages, which there are many more of.
 */
async function backtest(runId: string, options: { months?: number; stepDays?: number; tolerance?: Partial<typeof DEFAULT_TOLERANCE> }, actorId: string | null): Promise<BacktestResult> {
  const tolerance = { ...DEFAULT_TOLERANCE, ...(options.tolerance ?? {}) };
  const months = Math.min(Math.max(options.months ?? 12, 1), 36);
  const step = Math.min(Math.max(options.stepDays ?? 30, 7), 120);
  const run = { id: runId };
  try {
    const facts = await modelFacts();
    const calendar = calendarOf(facts);
    const now = todayDay();
    const closedAt = new Map(facts.workPackages.filter((item) => item.closedAt).map((item) => [item.id, dayOfStamp(item.closedAt!)]));
    // The whole finished history, once: each cut-off learns from the part of it finished before.
    const finishedHistory = historyOf(facts.workPackages);
    const finishedDays = finishedHistory.map((item) => item.finished);
    const history = {
      finished: finishedDays.length,
      firstClosed: finishedDays.length ? isoOf(finishedDays.reduce((a, b) => Math.min(a, b))) : null,
      lastClosed: finishedDays.length ? isoOf(finishedDays.reduce((a, b) => Math.max(a, b))) : null,
      minToLearn: MIN_GROUP,
    };
    const projectCases: BacktestCase[] = [];
    const workCases: BacktestCase[] = [];
    const cutoffs: string[] = [];
    const sampledAt: string[] = [];
    let cutoffsUsed = 0;
    for (let cutoff = now - months * 30; cutoff <= now - step; cutoff += step) {
      cutoffs.push(isoOf(cutoff));
      const model = trainModel(finishedHistory.filter((item) => item.finished < cutoff), calendar);
      if (model.trainedOn.items < model.minGroupSize) continue;
      cutoffsUsed += 1;
      const state = await workFactsAsAt(new Date(`${isoOf(cutoff)}T23:59:59Z`), facts);
      const open = state.filter((item) => !item.isClosed && !item.isMilestone && item.dueDate);
      // Work packages: open and dated then, finished since.
      const finishedSince = open.filter((item) => {
        const finished = closedAt.get(item.id);
        return finished !== undefined && finished > cutoff;
      });
      if (finishedSince.length > CASES_PER_CUTOFF) sampledAt.push(isoOf(cutoff));
      for (const [index, item] of evenly(finishedSince, CASES_PER_CUTOFF).entries()) {
        if (index > 0 && index % 50 === 0) await breathe();
        const finished = closedAt.get(item.id)!;
        const single: ProjectInput = {
          projectId: item.projectId, name: '', today: cutoff, plannedFinish: dayOf(item.dueDate!), budget: null, spentCost: 0, spentHours: 0, costPerHour: null,
          open: [{ id: item.id, subject: '', group: groupOf(item.typeCategory, item.estimatedHours), due: dayOf(item.dueDate!), estimatedHours: null, spentHours: 0 }],
        };
        const forecast = forecastProject(single, model, calendar, 400);
        workCases.push({ probability: forecast.probabilityOnTime ?? 0, onTime: finished <= dayOf(item.dueDate!) });
      }
      // Projects: all of whose work open then has finished since. Each project's
      // work is gathered once, rather than the whole state searched per project.
      const byProject = groupByProject(open);
      const stateByProject = groupByProject(state);
      for (const [projectId, items] of byProject) {
        const finishes = items.map((item) => closedAt.get(item.id));
        if (finishes.some((day) => day === undefined || day <= cutoff)) continue;
        await breathe();
        const inputs = inputsFor(facts, projectId, stateByProject.get(projectId) ?? [], cutoff);
        if (!inputs) continue;
        // reduce, not Math.max(...): a project's work can outnumber the arguments a call may take.
        const planned = items.reduce((latest, item) => Math.max(latest, dayOf(item.dueDate!)), -Infinity);
        const finished = (finishes as number[]).reduce((latest, day) => Math.max(latest, day), -Infinity);
        const forecast = forecastProject({ ...inputs, plannedFinish: planned }, model, calendar, 600);
        projectCases.push({ probability: forecast.probabilityOnTime ?? 0, onTime: finished <= planned });
      }
    }
    const projects = calibrate(projectCases);
    const workPackages = calibrate(workCases);
    const basis = projects.cases >= tolerance.minCases ? 'projects' : 'workPackages';
    const measured = basis === 'projects' ? projects : workPackages;
    const verdict =
      measured.cases < tolerance.minCases
        ? 'insufficient'
        : (measured.brier ?? 1) <= tolerance.brier && (measured.calibrationError ?? 1) <= tolerance.calibrationError
          ? 'pass'
          : 'fail';
    const result: BacktestResult = { runId: run.id, cutoffs, cutoffsUsed, sampledAt, tolerance, projects, workPackages, verdict, basis, history };
    await withAudit(
      (tx) => tx.forecastRun.update({ where: { id: run.id }, data: { status: 'done', finishedAt: new Date(), summary: result as unknown as Prisma.InputJsonValue } }),
      () => ({
        actorId: actorId ?? 'system',
        entityType: 'forecast',
        entityId: run.id,
        action: 'forecast.backtested',
        summary: message('Forecast back-test: {verdict} on {count} cases (Brier {brier}).', { verdict, count: measured.cases, brier: String(measured.brier ?? '—') }),
        after: { verdict, basis, cases: measured.cases, brier: measured.brier, calibrationError: measured.calibrationError },
      }),
    );
    return result;
  } catch (error) {
    await prisma.forecastRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), error: String((error as Error)?.message ?? error).slice(0, 1000) } });
    throw error;
  }
}

/**
 * The latest completed back-test and when it finished, and the latest attempt
 * — which may still be running, or have failed after that result.
 */
export async function latestBacktest(): Promise<{ backtest: (BacktestResult & { finishedAt: string | null }) | null; run: BacktestRunView | null }> {
  const [done, latest] = await Promise.all([
    prisma.forecastRun.findFirst({ where: { kind: 'backtest', status: 'done' }, orderBy: { startedAt: 'desc' } }),
    prisma.forecastRun.findFirst({ where: { kind: 'backtest' }, orderBy: { startedAt: 'desc' } }),
  ]);
  const result = done?.summary as unknown as BacktestResult | undefined;
  return {
    backtest: result ? { ...result, finishedAt: done!.finishedAt?.toISOString() ?? null } : null,
    run: latest ? runView(latest) : null,
  };
}

/** The latest forecasting run, for the status line. */
export async function latestRun(): Promise<{ id: string; status: string; startedAt: string; finishedAt: string | null; summary: unknown } | null> {
  const row = await prisma.forecastRun.findFirst({ where: { kind: 'forecast' }, orderBy: { startedAt: 'desc' } });
  return row ? { id: row.id, status: row.status, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, summary: row.summary } : null;
}

