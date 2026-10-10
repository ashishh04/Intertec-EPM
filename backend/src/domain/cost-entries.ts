import { prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError } from '../lib/errors.js';
import { contextLanguage, t } from '../lib/i18n.js';
import { linkId, linkTitle, openProject, type OpFilter } from '../openproject/client.js';
import type { OpTimeEntry } from '../openproject/types.js';
import { labourCost, roundMoney } from './costs.js';
import { modelFacts } from './measure-facts.js';
import { evaluateMeasures, measureById, type Period, type Viewer } from './measures.js';

/**
 * The priced time entries behind a cost figure, for one project (BR-202): the
 * last step of the drill from a portfolio's budget variance, through its
 * projects, to the entries that made the cost — with every other cost recorded
 * on the project beside them, OpenProject unit costs and approved expense
 * claims (Module 10), as the analytics model holds them.
 *
 * Read with the caller's own session, so OpenProject decides which entries
 * they may see — as the Time & Costs report does — and priced by the one
 * labour cost rule. Never more than OpenProject would show them; when that is
 * less than the figure was made from, the totals say so.
 */

export interface CostEntry {
  id: string;
  kind: 'time' | 'cost';
  spentOn: string;
  hours: number;
  userId: string;
  userName: string;
  workPackageId?: string;
  workPackageSubject?: string;
  activity?: string;
  /** Hours × the person's rate; null when they have none, as the figure treats them. */
  cost: number | null;
}

export interface CostEntries {
  measure: { id: string; label: string };
  project: { id: string; name: string };
  /** The days the entries cover; both null for every entry to date. */
  window: { from: string | null; to: string | null };
  entries: CostEntry[];
  total: number;
  page: number;
  pageSize: number;
  totals: { hours: number; costedHours: number; uncostedHours: number; cost: number; otherCost: number };
  /** The cost the figure was made from, for this project, and whether these entries add up to it. */
  figure: { actual: number | null; matches: boolean };
}

/** OpenProject pages of a hundred; a project with more time than this is paged, not truncated silently. */
const MAX_PAGES = 50;

export async function costEntries(
  measureId: string,
  projectId: string,
  period: Period,
  viewer: Viewer,
  today: string,
  page: number,
  pageSize: number,
): Promise<CostEntries> {
  const measure = measureById(measureId);
  if (!measure?.entries) throw EpmError.badRequest('That figure is not made of logged time.');
  const inPeriod = measure.entries === 'in-period';

  const filters: OpFilter[] = [{ field: 'project', operator: '=', values: [projectId] }];
  if (inPeriod) filters.push({ field: 'spent_on', operator: '<>d', values: [period.from, period.to] });

  const [collection, rates, facts, evaluation] = await Promise.all([
    openProject.getAll<OpTimeEntry>('/time_entries', { filters, sortBy: [['spentOn', 'desc']] }, { maxPages: MAX_PAGES }),
    prisma.userProfile
      .findMany({ where: { hourlyRate: { not: null } }, select: { openProjectId: true, hourlyRate: true } })
      .catch(() => []),
    modelFacts(),
    evaluateMeasures([inPeriod ? 'cost.spent' : 'cost.actual'], { kind: 'project', id: projectId }, period, viewer, today),
  ]);
  const rateOf = new Map(rates.map((row) => [row.openProjectId, row.hourlyRate ?? 0]));

  const logged: CostEntry[] = collection.items.map((entry) => {
    const links = entry._links ?? {};
    const userId = linkId(links, 'user') ?? '';
    const hours = durationToHours(entry.hours) ?? 0;
    const rate = rateOf.get(userId);
    return {
      id: String(entry.id),
      kind: 'time' as const,
      spentOn: entry.spentOn,
      hours,
      userId,
      userName: facts.users.get(Number(userId))?.name ?? linkTitle(links, 'user') ?? `User ${userId}`,
      workPackageId: linkId(links, 'workPackage'),
      workPackageSubject: linkTitle(links, 'workPackage'),
      activity: linkTitle(links, 'activity'),
      cost: rate === undefined || hours <= 0 ? null : labourCost(hours, rate),
    };
  });

  // Every other cost on the project, in the window: OpenProject unit costs,
  // approved expense claims among them.
  const subjects = new Map(facts.workPackages.map((work) => [work.id, work.subject]));
  const others: CostEntry[] = facts.costs
    .filter((entry) => entry.projectId === Number(projectId) && (!inPeriod || (entry.spentOn >= period.from && entry.spentOn <= period.to)))
    .map((entry) => ({
      id: `cost-${entry.id}`,
      kind: 'cost' as const,
      spentOn: entry.spentOn,
      hours: 0,
      userId: entry.userId === null ? '' : String(entry.userId),
      userName: entry.userId === null ? '' : facts.users.get(entry.userId)?.name ?? `User ${entry.userId}`,
      workPackageId: entry.workPackageId === null ? undefined : String(entry.workPackageId),
      workPackageSubject: entry.workPackageId === null ? undefined : subjects.get(entry.workPackageId),
      activity: entry.costType ?? undefined,
      cost: roundMoney(entry.amount),
    }));
  const entries = [...logged, ...others].sort((a, b) => b.spentOn.localeCompare(a.spentOn));

  let hours = 0;
  let costedHours = 0;
  let uncostedHours = 0;
  let cost = 0;
  let otherCost = 0;
  for (const entry of entries) {
    if (entry.kind === 'cost') {
      otherCost += entry.cost ?? 0;
      continue;
    }
    if (entry.hours <= 0) continue;
    hours += entry.hours;
    if (entry.cost === null) uncostedHours += entry.hours;
    else {
      costedHours += entry.hours;
      cost += entry.cost;
    }
  }
  const actual = evaluation.measures[inPeriod ? 'cost.spent' : 'cost.actual']?.value ?? null;
  const size = Math.min(Math.max(pageSize, 1), 200);
  const current = Math.min(Math.max(page, 1), Math.max(1, Math.ceil(entries.length / size)));

  return {
    measure: { id: measure.id, label: t(contextLanguage(), measure.label) },
    project: { id: projectId, name: facts.projects.get(Number(projectId))?.name ?? `Project ${projectId}` },
    window: inPeriod ? { from: period.from, to: period.to } : { from: null, to: null },
    entries: entries.slice((current - 1) * size, current * size),
    total: entries.length,
    page: current,
    pageSize: size,
    totals: {
      hours: roundMoney(hours),
      costedHours: roundMoney(costedHours),
      uncostedHours: roundMoney(uncostedHours),
      cost: roundMoney(cost + otherCost),
      otherCost: roundMoney(otherCost),
    },
    figure: { actual, matches: actual !== null && Math.abs(actual - roundMoney(cost + otherCost)) < 0.005 },
  };
}
