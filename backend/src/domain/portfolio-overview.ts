import type { HealthLevel } from '../types/epm.js';
import { daysBetween } from '../lib/dates.js';
import { modelFacts } from './measure-facts.js';
import {
  contextFor,
  evaluateInContext,
  measureById,
  prepare,
  type EvaluatedMeasure,
  type MeasureValue,
  type Period,
  type Scope,
  type Viewer,
} from './measures.js';
import { isOpen } from './work-definitions.js';

/**
 * A portfolio, or the projects a saved view selects, in one view (BR-201).
 *
 * Every figure is a measure of the semantic layer, for the whole set and for
 * each project in it, from the same rows: status (health), schedule variance,
 * budget consumption, open risks and where the milestones stand. Each set
 * figure is checked against the roll-up of its project rows — a sum, the
 * largest, or a share of summed parts — and the view says whether they agree,
 * so an aggregate that does not add up is found rather than shown.
 *
 * Built for the person asking: projects in the set they cannot see are left
 * out and counted, never an error (BR-203).
 */

/** The figures a set is summarised by, and the columns its project rows can show. */
export const OVERVIEW_MEASURES = [
  'projects.active',
  'health.green',
  'health.amber',
  'health.red',
  'health.greenPct',
  'projects.atRisk',
  'schedule.varianceDays',
  'schedule.slipping',
  'budget.total',
  'cost.actual',
  'cost.plannedToDate',
  'cost.variance',
  'budget.consumed',
  'budget.variancePct',
  'risk.open',
  'risk.high',
  'milestones.onTime',
  'milestones.missed',
  'milestones.upcoming',
  'work.open',
  'work.overdue',
  'work.progress',
] as const;

export type OverviewMeasureId = (typeof OVERVIEW_MEASURES)[number];

/** What a project row can show: its health, and any of the overview's measures. */
export const OVERVIEW_COLUMNS = ['health', ...OVERVIEW_MEASURES] as const;
export type OverviewColumn = (typeof OVERVIEW_COLUMNS)[number];

/** The columns a set shows unless a saved view says otherwise. */
export const DEFAULT_COLUMNS: OverviewColumn[] = [
  'health',
  'schedule.varianceDays',
  'budget.consumed',
  'cost.variance',
  'risk.open',
  'milestones.missed',
  'milestones.upcoming',
  'work.overdue',
  'work.progress',
];

export interface ProjectSet {
  kind: 'portfolio' | 'view';
  id: string;
  name: string;
  /** The active projects the set selects, before anyone's access is applied. */
  projectIds: number[];
  /** Only projects whose effective health is one of these; empty for all. */
  health?: HealthLevel[];
}

export interface OverviewFigure {
  value: number | null;
  parts?: Record<string, number | null>;
  note?: string;
}

export interface OverviewProject {
  id: number;
  name: string;
  identifier: string | null;
  portfolioId: string | null;
  /** Effective overall health; null until assessed. */
  health: HealthLevel | null;
  figures: Record<string, OverviewFigure>;
  /** The next open milestone: the earliest due, which may already be past. */
  nextMilestone: { id: number; subject: string; dueDate: string; daysToGo: number } | null;
}

export interface ReconciliationLine {
  measureId: string;
  rule: 'sum' | 'max' | 'ratio';
  /** The figure for the whole set. */
  aggregate: number | null;
  /** The same figure made from the project rows by the measure's roll-up. */
  fromProjects: number | null;
  matches: boolean;
}

export interface PortfolioOverview {
  set: {
    kind: ProjectSet['kind'];
    id: string;
    name: string;
    /** Active projects the set selects. */
    projects: number;
    /** Of those, shown to this person. */
    shown: number;
    /** Left out because this person cannot see them. */
    hidden: number;
    /** Left out by the set's health filter. */
    filtered: number;
  };
  period: Period;
  today: string;
  asOf: string | null;
  /** Each figure for the whole set, with what it counts; members are not included (drill per project). */
  measures: Record<string, Omit<EvaluatedMeasure, 'members'>>;
  projects: OverviewProject[];
  reconciliation: ReconciliationLine[];
  /** Every set figure agrees with its project rows. */
  reconciled: boolean;
}

const sameFigure = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.0001;

const withoutMembers = ({ members: _members, ...rest }: EvaluatedMeasure) => rest;

/** The projects of a portfolio as a set: its active projects. */
export async function portfolioSet(portfolioId: string): Promise<ProjectSet | null> {
  const facts = await modelFacts();
  const portfolio = facts.portfolios.get(portfolioId);
  if (!portfolio) return null;
  return {
    kind: 'portfolio',
    id: portfolioId,
    name: portfolio.name,
    projectIds: [...facts.projects.values()]
      .filter((project) => project.active && project.portfolioId === portfolioId)
      .map((project) => project.id),
  };
}

export async function portfolioOverview(set: ProjectSet, viewer: Viewer, period: Period, today: string): Promise<PortfolioOverview> {
  const shared = await prepare(viewer);
  const { facts } = shared;
  const selected = [...new Set(set.projectIds)].filter((id) => facts.projects.get(id)?.active);
  const visible = selected.filter((id) => viewer.visibleProjectIds.has(id));
  const filter = new Set(set.health ?? []);
  const shown = filter.size === 0 ? visible : visible.filter((id) => {
    const health = shared.health.get(id);
    return Boolean(health?.assessed && filter.has(health.overall));
  });

  const ids = [...OVERVIEW_MEASURES];
  const scope: Scope = set.kind === 'portfolio' ? { kind: 'portfolio', id: set.id } : { kind: 'set' };
  const aggregate = await evaluateInContext(ids, contextFor(shared, scope, period, today, new Set(shown)));

  const projects: OverviewProject[] = [];
  const rows: Record<string, MeasureValue>[] = [];
  for (const id of shown) {
    const project = facts.projects.get(id)!;
    const context = contextFor(shared, { kind: 'project', id: String(id) }, period, today);
    const values = await evaluateInContext(ids, context);
    rows.push(values);

    const next = context.work
      .filter((item) => item.isMilestone && isOpen(item) && item.dueDate !== null)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.id - b.id)[0];
    const health = shared.health.get(id);
    projects.push({
      id,
      name: project.name,
      identifier: project.identifier,
      portfolioId: project.portfolioId,
      health: health?.assessed ? health.overall : null,
      figures: Object.fromEntries(
        Object.entries(values).map(([measureId, value]) => [
          measureId,
          { value: value.value, ...(value.parts ? { parts: value.parts } : {}), ...(value.note ? { note: value.note } : {}) },
        ]),
      ),
      nextMilestone: next
        ? {
            id: next.id,
            subject: next.subject,
            dueDate: next.dueDate!,
            daysToGo: next.dueDate! >= today ? daysBetween(today, next.dueDate!) - 1 : -(daysBetween(next.dueDate!, today) - 1),
          }
        : null,
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));

  const reconciliation: ReconciliationLine[] = [];
  for (const measureId of ids) {
    const rollup = measureById(measureId)?.rollup;
    if (!rollup) continue;
    const fromProjects = rollup.from(rows.map((row) => row[measureId]!));
    const value = aggregate[measureId]?.value ?? null;
    // A set with no projects shown has nothing to add up: its counts are nought
    // and there are no rows to disagree with them.
    reconciliation.push({ measureId, rule: rollup.rule, aggregate: value, fromProjects, matches: rows.length === 0 || sameFigure(value, fromProjects) });
  }

  return {
    set: {
      kind: set.kind,
      id: set.id,
      name: set.name,
      projects: selected.length,
      shown: shown.length,
      hidden: selected.length - visible.length,
      filtered: visible.length - shown.length,
    },
    period,
    today,
    asOf: facts.asOf,
    measures: Object.fromEntries(Object.entries(aggregate).map(([id, value]) => [id, withoutMembers(value)])),
    projects,
    reconciliation,
    reconciled: reconciliation.every((line) => line.matches),
  };
}
