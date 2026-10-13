import { apportion, fromCents, monthEnd, monthOf, monthsBetween, toCents } from './finance.js';

/**
 * Scenario figures (Module 7: BR-221, BR-222), pure so a control example can
 * check them: each project's open work and budget moved by the scenario's
 * shift, spread over working days (Monday to Friday) and added up by month —
 * capacity demand and spend — with the milestones where the shift puts them
 * and a strategic score.
 */

export interface ScenarioProjectInput {
  projectId: number;
  included: boolean;
  priority: number;
  shiftMonths: number;
  shiftDays: number;
  budget: number | null;
  start: string | null;
  finish: string | null;
}

export interface ScenarioWorkInput {
  workPackageId: number;
  projectId: number;
  subject: string;
  remainingHours: number;
  start: string | null;
  due: string | null;
  isMilestone: boolean;
}

export interface Profile {
  months: { month: string; capacity: number; demand: number; spend: number }[];
  totals: { demand: number; spend: number; capacity: number };
  milestones: { workPackageId: string; projectId: string; subject: string; date: string }[];
  strategicScore: number;
  undatedHours: number;
}

/** A day moved by whole months (the day of the month kept where it exists), then by days. */
export function shiftDate(day: string, months: number, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();
  const moved = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), Math.min(date, lastDay)));
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

const isWeekday = (day: string) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());

/** Working days (Monday to Friday) from one day to another, both counted. */
export function weekdays(first: string, last: string): number {
  let count = 0;
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += 86_400_000) {
    if (isWeekday(new Date(at).toISOString().slice(0, 10))) count += 1;
  }
  return count;
}

/** An amount spread over the working days of a span, by month, the parts summing to it exactly. */
function spreadByMonth(amount: number, first: string, last: string): Map<string, number> {
  const [from, to] = first <= last ? [first, last] : [last, first];
  const months = monthsBetween(from, to);
  const weights = months.map((month) => {
    const start = month < from ? from : month;
    const end = monthEnd(month) > to ? to : monthEnd(month);
    return weekdays(start, end);
  });
  // A span with no working day: by calendar month, evenly.
  const parts = apportion(amount, weights.some((weight) => weight > 0) ? weights : weights.map(() => 1));
  return new Map(months.map((month, index) => [month, parts[index]!]));
}

/**
 * The profile of a scenario: open hours and budget by month, as moved, against
 * the capacity of the people in it — `weeklyCapacity` hours a week, five
 * working days. Undated work falls in no month and is counted apart.
 */
export function scenarioProfile(projects: ScenarioProjectInput[], work: ScenarioWorkInput[], weeklyCapacity: number): Profile {
  const demand = new Map<string, number>();
  const spend = new Map<string, number>();
  const milestones: Profile['milestones'] = [];
  let undated = 0;
  const add = (into: Map<string, number>, parts: Map<string, number>) => {
    for (const [month, value] of parts) into.set(month, (into.get(month) ?? 0) + toCents(value));
  };
  const byId = new Map(projects.map((project) => [project.projectId, project]));
  for (const item of work) {
    const project = byId.get(item.projectId);
    if (!project?.included) continue;
    const move = (day: string | null) => (day ? shiftDate(day, project.shiftMonths, project.shiftDays) : null);
    if (item.isMilestone) {
      const date = move(item.due ?? item.start);
      if (date) milestones.push({ workPackageId: String(item.workPackageId), projectId: String(item.projectId), subject: item.subject, date });
    }
    if (!(item.remainingHours > 0)) continue;
    const start = move(item.start ?? item.due);
    const due = move(item.due ?? item.start);
    if (!start || !due) {
      undated += item.remainingHours;
      continue;
    }
    add(demand, spreadByMonth(item.remainingHours, start, due));
  }
  for (const project of projects) {
    if (!project.included || !project.budget) continue;
    const workDates = work
      .filter((item) => item.projectId === project.projectId)
      .flatMap((item) => [item.start, item.due])
      .filter((day): day is string => Boolean(day))
      .sort();
    const first = project.start ?? workDates[0] ?? null;
    const last = project.finish ?? workDates.at(-1) ?? null;
    if (!first || !last) continue;
    add(spend, spreadByMonth(project.budget, shiftDate(first, project.shiftMonths, project.shiftDays), shiftDate(last, project.shiftMonths, project.shiftDays)));
  }
  const keys = [...demand.keys(), ...spend.keys(), ...milestones.map((milestone) => monthOf(milestone.date))].sort();
  const months = keys.length > 0 ? monthsBetween(keys[0]!, keys.at(-1)!) : [];
  const rows = months.map((month) => ({
    month,
    capacity: Math.round((weeklyCapacity * weekdays(month, monthEnd(month))) / 5 * 100) / 100,
    demand: fromCents(demand.get(month) ?? 0),
    spend: fromCents(spend.get(month) ?? 0),
  }));
  return {
    months: rows,
    totals: {
      demand: fromCents(rows.reduce((sum, row) => sum + toCents(row.demand), 0)),
      spend: fromCents(rows.reduce((sum, row) => sum + toCents(row.spend), 0)),
      capacity: fromCents(rows.reduce((sum, row) => sum + toCents(row.capacity), 0)),
    },
    milestones: milestones.sort((a, b) => a.date.localeCompare(b.date)),
    strategicScore: projects.filter((project) => project.included).reduce((sum, project) => sum + project.priority, 0),
    undatedHours: Math.round(undated * 100) / 100,
  };
}
