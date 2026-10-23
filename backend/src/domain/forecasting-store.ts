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

const calendarOf = (facts: ModelFacts): Calendar => ({ nonWorking: facts.calendar.nonWorking, workingWeekdays: facts.calendar.workingWeekdays });
const dayOfStamp = (stamp: string) => dayOf(stamp.slice(0, 10));
const todayDay = () => dayOf(new Date().toISOString().slice(0, 10));

/** What history teaches: every work package closed with a due date, closed before `before` if given. */
function historyOf(work: WorkFact[], before?: number): HistoryItem[] {
  return work
    .filter((item) => item.isClosed && item.closedAt && item.dueDate && !item.isMilestone)
    .filter((item) => before === undefined || dayOfStamp(item.closedAt!) < before)
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
    plannedFinish: project.plannedFinish ? dayOf(project.plannedFinish) : dues.length ? Math.max(...dues.map(dayOf)) : null,
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

/** The latest forecast of each of these projects. */
export async function latestForecasts(projectIds: number[]): Promise<ForecastView[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.projectForecast.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { createdAt: 'desc' },
    include: { run: { select: { model: true, status: true } } },
    take: projectIds.length * 3,
  });
  const latest = new Map<number, (typeof rows)[number]>();
  for (const row of rows) if (row.run.status === 'done' && !latest.has(row.projectId)) latest.set(row.projectId, row);
  return [...latest.values()].map((row) => toView(row, row.run.model as unknown as ForecastModel | null));
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
  tolerance: typeof DEFAULT_TOLERANCE;
  /** Projects as forecast at each cut-off, against how they actually finished. */
  projects: Calibration;
  /** Each work package open and dated at a cut-off, against whether it finished by its due date. */
  workPackages: Calibration;
  /** Pass, fail, or not enough history to say. */
  verdict: 'pass' | 'fail' | 'insufficient';
  basis: 'projects' | 'workPackages';
}

/**
 * Back-tests the model (BR-509): at cut-offs in the past, the state of every
 * project rebuilt from history, the model trained only on what had finished
 * by then, and its forecast compared with what happened after. Calibrated
 * within tolerance passes. Projects are the measure where enough of them have
 * since finished; otherwise work packages, which there are many more of.
 */
export async function backtest(options: { months?: number; stepDays?: number; tolerance?: Partial<typeof DEFAULT_TOLERANCE> }, actorId: string | null): Promise<BacktestResult> {
  const tolerance = { ...DEFAULT_TOLERANCE, ...(options.tolerance ?? {}) };
  const months = Math.min(Math.max(options.months ?? 12, 1), 36);
  const step = Math.min(Math.max(options.stepDays ?? 30, 7), 120);
  const run = await prisma.forecastRun.create({ data: { kind: 'backtest', trigger: 'manual', startedBy: actorId } });
  try {
    const facts = await modelFacts();
    const calendar = calendarOf(facts);
    const now = todayDay();
    const closedAt = new Map(facts.workPackages.filter((item) => item.closedAt).map((item) => [item.id, dayOfStamp(item.closedAt!)]));
    const projectCases: BacktestCase[] = [];
    const workCases: BacktestCase[] = [];
    const cutoffs: string[] = [];
    for (let cutoff = now - months * 30; cutoff <= now - step; cutoff += step) {
      cutoffs.push(isoOf(cutoff));
      const model = trainModel(historyOf(facts.workPackages, cutoff), calendar);
      if (model.trainedOn.items < model.minGroupSize) continue;
      const state = await workFactsAsAt(new Date(`${isoOf(cutoff)}T23:59:59Z`), facts);
      const open = state.filter((item) => !item.isClosed && !item.isMilestone && item.dueDate);
      // Work packages: open and dated then, finished since.
      for (const item of open) {
        const finished = closedAt.get(item.id);
        if (finished === undefined || finished <= cutoff) continue;
        const single: ProjectInput = {
          projectId: item.projectId, name: '', today: cutoff, plannedFinish: dayOf(item.dueDate!), budget: null, spentCost: 0, spentHours: 0, costPerHour: null,
          open: [{ id: item.id, subject: '', group: groupOf(item.typeCategory, item.estimatedHours), due: dayOf(item.dueDate!), estimatedHours: null, spentHours: 0 }],
        };
        const forecast = forecastProject(single, model, calendar, 400);
        workCases.push({ probability: forecast.probabilityOnTime ?? 0, onTime: finished <= dayOf(item.dueDate!) });
      }
      // Projects: all of whose work open then has finished since.
      const byProject = new Map<number, WorkFact[]>();
      for (const item of open) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
      for (const [projectId, items] of byProject) {
        const finishes = items.map((item) => closedAt.get(item.id));
        if (finishes.some((day) => day === undefined || day <= cutoff)) continue;
        const inputs = inputsFor(facts, projectId, state, cutoff);
        if (!inputs) continue;
        const planned = Math.max(...items.map((item) => dayOf(item.dueDate!)));
        const forecast = forecastProject({ ...inputs, plannedFinish: planned }, model, calendar, 600);
        projectCases.push({ probability: forecast.probabilityOnTime ?? 0, onTime: Math.max(...(finishes as number[])) <= planned });
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
    const result = { runId: run.id, cutoffs, tolerance, projects, workPackages, verdict, basis } as BacktestResult;
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

/** The latest back-test, if any. */
export async function latestBacktest(): Promise<BacktestResult | null> {
  const row = await prisma.forecastRun.findFirst({ where: { kind: 'backtest', status: 'done' }, orderBy: { startedAt: 'desc' } });
  return (row?.summary as unknown as BacktestResult | undefined) ?? null;
}

/** The latest forecasting run, for the status line. */
export async function latestRun(): Promise<{ id: string; status: string; startedAt: string; finishedAt: string | null; summary: unknown } | null> {
  const row = await prisma.forecastRun.findFirst({ where: { kind: 'forecast' }, orderBy: { startedAt: 'desc' } });
  return row ? { id: row.id, status: row.status, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, summary: row.summary } : null;
}

