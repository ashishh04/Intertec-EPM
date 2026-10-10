import { env } from '../config/env.js';
import { addDays } from '../lib/dates.js';
import { contextConventions, contextLanguage, dateOf, msg, t, type Language } from '../lib/i18n.js';
import { EARNING_METHODS } from './earned-value.js';
import type { ScopeEvaluation } from './earned-value-store.js';
import { workFactsAsAt } from './measure-facts.js';
import { isDelivered, isOpen } from './work-definitions.js';
import {
  bucketsOf,
  contextFor,
  evaluateInContext,
  evmOf,
  measureById,
  measureSeries,
  milestoneOutcome,
  prepare,
  type Bucket,
  type EvaluatedMeasure,
  type MeasureContext,
  type Period,
  type Scope,
  type Shared,
  type Viewer,
} from './measures.js';

/**
 * The executive and PMO dashboards (BR-405).
 *
 * Five views leadership uses in governance forums — portfolio health, delivery,
 * resource utilisation, budget and risk exposure — each built only from the
 * semantic layer: tiles are measures, tables are measures evaluated per row,
 * trends are measures over time. Nothing here counts anything itself, so a
 * figure on one dashboard is the figure on every other.
 *
 * Every dashboard is described as data — tiles, tables of cells with links,
 * series — so the screen, the PDF and the spreadsheet a scheduled report sends
 * all render the same thing. Every row links somewhere: a portfolio, project,
 * department, team or person opens that scope's dashboard, and a work package
 * opens the work package, which is the drill-through.
 *
 * Each is timed against the response target (`EPM_DASHBOARD_TARGET_MS`).
 *
 * Its words — titles, column headings, legends, the few cells that are words
 * rather than data — are written in the language of the request being served,
 * or of the reader a scheduled report is rendered for (`contextLanguage()`),
 * as the measures' own are.
 */

export type DashboardId = 'portfolio-health' | 'delivery' | 'utilisation' | 'budget' | 'earned-value' | 'risk';

export const DASHBOARD_IDS: DashboardId[] = ['portfolio-health', 'delivery', 'utilisation', 'budget', 'earned-value', 'risk'];

export type LinkKind = 'portfolio' | 'project' | 'department' | 'team' | 'person' | 'work_package';

export interface DashboardColumn {
  key: string;
  label: string;
  /** Where the cell is a measure's value, its unit — for formatting. */
  unit?: EvaluatedMeasure['unit'];
  /** The measure behind the column, for its definition. */
  measureId?: string;
}

export interface DashboardRow {
  key: string;
  cells: Record<string, string | number | null>;
  link?: { kind: LinkKind; id: string };
}

export interface DashboardTable {
  id: string;
  title: string;
  description?: string;
  columns: DashboardColumn[];
  rows: DashboardRow[];
}

export interface DashboardSeries {
  id: string;
  title: string;
  measureId: string;
  bucket: Bucket;
  points: { from: string; to: string; value: number | null }[];
  /** With `lines`: what `points` are, for the legend. */
  label?: string;
  /**
   * Further measures drawn on the same axes, over the same buckets — earned
   * value's planned value, earned value and actual cost together.
   */
  lines?: { measureId: string; label: string; points: { from: string; to: string; value: number | null }[] }[];
}

export interface Dashboard {
  id: DashboardId;
  title: string;
  description: string;
  scope: Scope & { name: string };
  period: Period;
  today: string;
  asOf: string | null;
  /** The measures on the tiles, in order. */
  tiles: string[];
  measures: Record<string, EvaluatedMeasure>;
  tables: DashboardTable[];
  series: DashboardSeries[];
  timing: { serverMs: number; targetMs: number; withinTarget: boolean };
}

const TITLES: Record<DashboardId, { title: string; description: string }> = {
  'portfolio-health': {
    title: msg('Portfolio health'),
    description: msg('How every project is doing on the health rules, what is slipping and what is late.'),
  },
  delivery: {
    title: msg('Delivery'),
    description: msg('What was delivered, how fast, and whether milestones were met on their dates.'),
  },
  utilisation: {
    title: msg('Resource utilisation'),
    description: msg('Hours logged against the capacity of the people in scope.'),
  },
  budget: {
    title: msg('Budget'),
    description: msg('Spend against budget and against the budget planned to date.'),
  },
  'earned-value': {
    title: msg('Earned value'),
    description: msg(
      'The work planned by now, the work done and what it cost, each priced by the budget — and what they forecast for schedule and cost.',
    ),
  },
  risk: {
    title: msg('Risk exposure'),
    description: msg('Open risks by severity and project, and how exposure has moved.'),
  },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** "All projects", or the name of the portfolio, project, department, team or person; in `language` where it is a word. */
export function scopeName(shared: Pick<Shared, 'facts'>, scope: Scope, language: Language = contextLanguage()): string {
  const { facts } = shared;
  switch (scope.kind) {
    case 'instance':
      return t(language, 'All projects');
    case 'portfolio':
      return facts.portfolios.get(scope.id ?? '')?.name ?? t(language, 'Portfolio');
    case 'project':
      return facts.projects.get(Number(scope.id))?.name ?? t(language, 'Project');
    case 'department':
      return facts.departments.get(scope.id ?? '')?.name ?? t(language, 'Department');
    case 'team':
      return facts.teams.get(scope.id ?? '')?.name ?? t(language, 'Team');
    case 'person':
      return facts.people.get(Number(scope.id))?.name ?? t(language, 'Person');
    case 'set':
      return t(language, 'Selected projects');
  }
}

/** Measures evaluated per row: one row per scope, one column per measure. */
async function measureTable(
  shared: Shared,
  options: {
    id: string;
    title: string;
    description?: string;
    rows: { key: string; label: string; scope: Scope; link: { kind: LinkKind; id: string } }[];
    measures: string[];
    period: Period;
    today: string;
    firstColumn: string;
  },
): Promise<DashboardTable> {
  const language = contextLanguage();
  const columns: DashboardColumn[] = [
    { key: 'name', label: t(language, options.firstColumn) },
    ...options.measures.map((id) => {
      const measure = measureById(id)!;
      return { key: id, label: t(language, measure.label), unit: measure.unit, measureId: id };
    }),
  ];
  const rows: DashboardRow[] = [];
  for (const row of options.rows) {
    const context = contextFor(shared, row.scope, options.period, options.today);
    const values = await evaluateInContext(options.measures, context);
    rows.push({
      key: row.key,
      link: row.link,
      cells: {
        name: row.label,
        ...Object.fromEntries(options.measures.map((id) => [id, values[id]?.value ?? null])),
      },
    });
  }
  return {
    id: options.id,
    title: t(language, options.title),
    description: options.description === undefined ? undefined : t(language, options.description),
    columns,
    rows,
  };
}

/** A measure over the period's buckets, through the same definitions. */
async function series(context: MeasureContext, id: string, title: string, bucket: Bucket): Promise<DashboardSeries> {
  return { id, title: t(contextLanguage(), title), measureId: id, bucket, points: await measureSeries(context, id, bucket) };
}

/** Weekly buckets for up to six months, monthly beyond. */
const bucketFor = (period: Period): Bucket =>
  Date.parse(period.to) - Date.parse(period.from) > 183 * 86_400_000 ? 'month' : 'week';

const projectRows = (context: MeasureContext) =>
  context.projects
    .filter((project) => project.active || context.scope.kind === 'project')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      scope: { kind: 'project' as const, id: String(project.id) },
      link: { kind: 'project' as const, id: String(project.id) },
    }));

/* -------------------------------------------------------------------------- */
/* The dashboards                                                             */
/* -------------------------------------------------------------------------- */

async function portfolioHealth(shared: Shared, context: MeasureContext): Promise<Partial<Dashboard>> {
  const tiles = ['projects.active', 'health.greenPct', 'projects.atRisk', 'schedule.slipping', 'work.overdue', 'risk.high'];
  const tables: DashboardTable[] = [];

  if (context.scope.kind === 'instance') {
    const portfolios = [...shared.facts.portfolios.values()]
      .filter((portfolio) => portfolio.active)
      .sort((a, b) => a.name.localeCompare(b.name));
    tables.push(
      await measureTable(shared, {
        id: 'portfolios',
        title: msg('Portfolios'),
        firstColumn: msg('Portfolio'),
        rows: portfolios.map((portfolio) => ({
          key: `portfolio:${portfolio.id}`,
          label: portfolio.name,
          scope: { kind: 'portfolio', id: portfolio.id },
          link: { kind: 'portfolio', id: portfolio.id },
        })),
        measures: ['projects.active', 'health.green', 'health.amber', 'health.red', 'work.overdue', 'risk.high', 'budget.consumed'],
        period: context.period,
        today: context.today,
      }),
    );
  }

  const projects = await measureTable(shared, {
    id: 'projects',
    title: msg('Projects'),
    firstColumn: msg('Project'),
    rows: projectRows(context),
    measures: ['schedule.varianceDays', 'work.open', 'work.overdue', 'risk.high', 'budget.consumed'],
    period: context.period,
    today: context.today,
  });
  // Health is a level, not a measure's number: added as its own column.
  projects.columns.splice(1, 0, { key: 'health', label: t(contextLanguage(), 'Health') });
  for (const row of projects.rows) {
    const health = context.health.get(Number(row.link?.id));
    row.cells.health = health?.assessed ? health.overall : null;
  }
  tables.push(projects);

  const bucket = bucketFor(context.period);
  return {
    tiles,
    tables,
    series: [
      await series(context, 'work.overdue', msg('Overdue work'), bucket),
      await series(context, 'work.open', msg('Open work'), bucket),
    ],
    measures: await evaluateInContext([...tiles, 'health.green', 'health.amber', 'health.red'], context),
  };
}

async function delivery(shared: Shared, context: MeasureContext): Promise<Partial<Dashboard>> {
  const tiles = [
    'work.completed',
    'work.throughput',
    'milestones.onTime',
    'milestones.missed',
    'work.leadTime',
    'work.cycleTime',
    'sprint.velocity',
    'schedule.drift',
    'work.churn',
  ];
  const { facts, period, today } = context;
  const language = contextLanguage();

  const milestones = context.work
    .filter((item) => item.isMilestone && item.dueDate !== null && item.dueDate >= period.from && item.dueDate <= period.to)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const outcomeLabel = { met: msg('Met'), missed: msg('Missed'), pending: msg('Not yet due'), excluded: msg('Rejected') } as const;

  const inScope = new Set(context.projects.map((project) => project.id));
  const sprints = [...facts.versions.values()]
    .filter((sprint) => sprint.projectId !== null && inScope.has(sprint.projectId) && sprint.endDate !== null && sprint.endDate >= period.from && sprint.endDate <= period.to)
    .sort((a, b) => (a.endDate ?? '').localeCompare(b.endDate ?? ''));

  const tables: DashboardTable[] = [
    {
      id: 'milestones',
      title: t(language, 'Milestones due in the period'),
      columns: [
        { key: 'name', label: t(language, 'Milestone') },
        { key: 'project', label: t(language, 'Project') },
        { key: 'due', label: t(language, 'Due') },
        { key: 'closed', label: t(language, 'Delivered') },
        { key: 'outcome', label: t(language, 'Outcome') },
      ],
      rows: milestones.map((item) => ({
        key: `wp:${item.id}`,
        link: { kind: 'work_package', id: String(item.id) },
        cells: {
          name: item.subject,
          project: facts.projects.get(item.projectId)?.name ?? '',
          due: item.dueDate,
          closed: item.closedAt ? item.closedAt.slice(0, 10) : null,
          outcome: t(language, outcomeLabel[milestoneOutcome(item, today)]),
        },
      })),
    },
    {
      id: 'sprints',
      title: t(language, 'Sprints ended in the period'),
      columns: [
        { key: 'name', label: t(language, 'Sprint') },
        { key: 'project', label: t(language, 'Project') },
        { key: 'end', label: t(language, 'Ended') },
        { key: 'committed', label: t(language, 'Committed'), unit: 'points' },
        { key: 'delivered', label: t(language, 'Delivered'), unit: 'points' },
      ],
      rows: sprints.map((sprint) => {
        const items = context.work.filter((item) => item.versionId === sprint.id);
        const points = (list: typeof items) => list.reduce((sum, item) => sum + (item.storyPoints ?? 0), 0);
        return {
          key: `sprint:${sprint.id}`,
          link: sprint.projectId !== null ? { kind: 'project', id: String(sprint.projectId) } : undefined,
          cells: {
            name: sprint.name,
            project: sprint.projectId !== null ? (facts.projects.get(sprint.projectId)?.name ?? '') : '',
            end: sprint.endDate,
            committed: sprint.committedPoints ?? points(items),
            delivered: points(items.filter(isDelivered)),
          },
        };
      }),
    },
  ];

  if (context.scope.kind === 'instance' || context.scope.kind === 'portfolio') {
    tables.push(
      await measureTable(shared, {
        id: 'projects',
        title: msg('Projects'),
        firstColumn: msg('Project'),
        rows: projectRows(context),
        measures: ['work.completed', 'work.throughput', 'milestones.onTime', 'work.leadTime', 'work.overdue'],
        period,
        today,
      }),
    );
  }

  const bucket = bucketFor(period);
  return {
    tiles,
    tables,
    series: [
      await series(context, 'work.completed', msg('Delivered'), bucket),
      await series(context, 'work.created', msg('Created'), bucket),
      await series(context, 'work.open', msg('Open work'), bucket),
    ],
    measures: await evaluateInContext(tiles, context),
  };
}

async function utilisation(shared: Shared, context: MeasureContext): Promise<Partial<Dashboard>> {
  const tiles = ['utilisation', 'capacity.weeklyHours', 'time.logged', 'time.uncosted'];
  const { facts, period, today } = context;
  const tables: DashboardTable[] = [];
  const measures = ['capacity.weeklyHours', 'time.logged', 'utilisation'];

  if (context.scope.kind === 'instance') {
    const departments = [...facts.departments.values()].filter((item) => item.active).sort((a, b) => a.name.localeCompare(b.name));
    const teams = [...facts.teams.values()].filter((item) => item.active).sort((a, b) => a.name.localeCompare(b.name));
    tables.push(
      await measureTable(shared, {
        id: 'departments',
        title: msg('Departments'),
        firstColumn: msg('Department'),
        rows: departments.map((item) => ({
          key: `department:${item.id}`,
          label: item.name,
          scope: { kind: 'department', id: item.id },
          link: { kind: 'department', id: item.id },
        })),
        measures,
        period,
        today,
      }),
      await measureTable(shared, {
        id: 'teams',
        title: msg('Teams'),
        firstColumn: msg('Team'),
        rows: teams.map((item) => ({
          key: `team:${item.id}`,
          label: item.name,
          scope: { kind: 'team', id: item.id },
          link: { kind: 'team', id: item.id },
        })),
        measures,
        period,
        today,
      }),
    );
  }

  tables.push(
    await measureTable(shared, {
      id: 'people',
      title: msg('People'),
      firstColumn: msg('Person'),
      rows: [...context.people]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((person) => ({
          key: `person:${person.id}`,
          label: person.name,
          scope: { kind: 'person', id: String(person.id) },
          link: { kind: 'person', id: String(person.id) },
        })),
      measures,
      period,
      today,
    }),
  );

  const bucket = bucketFor(period);
  return {
    tiles,
    tables,
    series: [
      await series(context, 'utilisation', msg('Utilisation'), bucket),
      await series(context, 'time.logged', msg('Hours logged'), bucket),
    ],
    measures: await evaluateInContext(tiles, context),
  };
}

async function budget(shared: Shared, context: MeasureContext): Promise<Partial<Dashboard>> {
  const tiles = ['budget.total', 'cost.actual', 'cost.plannedToDate', 'cost.variance', 'budget.consumed', 'budget.variancePct'];
  const projects = await measureTable(shared, {
    id: 'projects',
    title: msg('Projects with a budget'),
    firstColumn: msg('Project'),
    rows: projectRows(context).filter((row) => (shared.facts.projects.get(Number(row.link.id))?.budget ?? 0) > 0),
    measures: ['budget.total', 'cost.actual', 'cost.plannedToDate', 'cost.variance', 'budget.consumed'],
    period: context.period,
    today: context.today,
  });
  const bucket = bucketFor(context.period);
  return {
    tiles,
    tables: [projects],
    series: [await series(context, 'cost.spent', msg('Spent'), bucket)],
    measures: await evaluateInContext([...tiles, 'time.uncosted'], context),
  };
}

/**
 * Earned value over the period (BR-303): each bucket's figures as at its end,
 * from the work as it stood then, rebuilt from the journals. The bucket under
 * way is measured now; buckets still to come carry the plan alone.
 */
async function earnedValueSeries(context: MeasureContext, bucket: Bucket): Promise<DashboardSeries[]> {
  const point = (slice: { from: string; to: string }, value: number | null) => ({ from: slice.from, to: slice.to, value });
  const pv: DashboardSeries['points'] = [];
  const ev: DashboardSeries['points'] = [];
  const ac: DashboardSeries['points'] = [];
  const spi: DashboardSeries['points'] = [];
  const cpi: DashboardSeries['points'] = [];
  for (const slice of bucketsOf(context.period, bucket)) {
    let result: ScopeEvaluation;
    let ahead = false;
    if (slice.to < context.today) {
      const asAt = (await workFactsAsAt(new Date(`${addDays(slice.to, 1)}T00:00:00.000Z`), context.facts)).filter(context.inScope);
      result = evmOf({ ...context, work: asAt, today: slice.to });
    } else if (slice.from <= context.today) {
      result = evmOf(context);
    } else {
      result = evmOf({ ...context, today: slice.to });
      ahead = true;
    }
    const empty = result.totals.bac === 0 && result.totals.ac === 0;
    pv.push(point(slice, empty ? null : result.totals.pv));
    ev.push(point(slice, empty || ahead ? null : result.totals.ev));
    ac.push(point(slice, empty || ahead ? null : result.totals.ac));
    spi.push(point(slice, ahead ? null : result.totals.spi));
    cpi.push(point(slice, ahead ? null : result.totals.cpi));
  }
  const language = contextLanguage();
  return [
    {
      id: 'evm.curve',
      title: t(language, 'Planned value, earned value and actual cost'),
      measureId: 'evm.pv',
      bucket,
      label: t(language, 'Planned value (PV)'),
      points: pv,
      lines: [
        { measureId: 'evm.ev', label: t(language, 'Earned value (EV)'), points: ev },
        { measureId: 'evm.ac', label: t(language, 'Actual cost (AC)'), points: ac },
      ],
    },
    {
      id: 'evm.indices',
      title: t(language, 'Schedule and cost performance'),
      measureId: 'evm.spi',
      bucket,
      label: t(language, 'Schedule performance (SPI)'),
      points: spi,
      lines: [{ measureId: 'evm.cpi', label: t(language, 'Cost performance (CPI)'), points: cpi }],
    },
  ];
}

async function earnedValue(shared: Shared, context: MeasureContext): Promise<Partial<Dashboard>> {
  const tiles = ['evm.bac', 'evm.pv', 'evm.ev', 'evm.ac', 'evm.sv', 'evm.cv', 'evm.spi', 'evm.cpi', 'evm.eac', 'evm.vac', 'evm.tcpi'];
  const now = evmOf(context);
  const tables: DashboardTable[] = [];
  const language = contextLanguage();

  if (context.scope.kind === 'project') {
    const project = now.projects[0];
    const work = new Map(context.work.map((item) => [item.id, item]));
    const against = project?.measuredAgainst;
    tables.push({
      id: 'work-packages',
      title: t(language, 'Work packages'),
      description:
        against?.kind === 'baseline'
          ? t(
              language,
              'Against baseline {number}, set {date}. Most over cost first.',
              {
                number: against.number,
                // English has always written the day as 2026-09-01 here.
                date: language === 'en' ? against.setAt.slice(0, 10) : dateOf(against.setAt.slice(0, 10)),
              },
              contextConventions(),
            )
          : t(language, 'Against the current plan: no baseline has been set. Most over cost first.'),
      columns: [
        { key: 'name', label: t(language, 'Work package') },
        { key: 'rule', label: t(language, 'Earns by') },
        // The abbreviations are written the same in every language (BR-606 glossary).
        { key: 'bac', label: 'BAC', unit: 'money', measureId: 'evm.bac' },
        { key: 'pv', label: 'PV', unit: 'money', measureId: 'evm.pv' },
        { key: 'ev', label: 'EV', unit: 'money', measureId: 'evm.ev' },
        { key: 'ac', label: 'AC', unit: 'money', measureId: 'evm.ac' },
        { key: 'cv', label: 'CV', unit: 'money', measureId: 'evm.cv' },
        { key: 'spi', label: 'SPI', unit: 'index', measureId: 'evm.spi' },
        { key: 'cpi', label: 'CPI', unit: 'index', measureId: 'evm.cpi' },
      ],
      rows: (project?.evaluation.items ?? [])
        .filter((item) => item.bac !== null && (item.bac > 0 || item.ac > 0))
        .sort((a, b) => (a.cv ?? 0) - (b.cv ?? 0) || a.workPackageId - b.workPackageId)
        .map((item) => {
          const known = work.get(item.workPackageId);
          return {
            key: `wp:${item.workPackageId}`,
            link: { kind: 'work_package' as const, id: String(item.workPackageId) },
            cells: {
              name: known?.subject ?? t(language, 'Work package {id}', { id: item.workPackageId }),
              rule: t(language, EARNING_METHODS[item.method].label),
              bac: item.bac,
              pv: item.pv,
              ev: item.ev,
              ac: item.ac,
              cv: item.cv,
              spi: item.spi,
              cpi: item.cpi,
            },
          };
        }),
    });
  } else {
    const measured = new Set(
      now.projects.filter((project) => project.evaluation.totals.bac > 0 || project.evaluation.totals.ac > 0).map((project) => project.projectId),
    );
    tables.push(
      await measureTable(shared, {
        id: 'projects',
        title: msg('Projects'),
        description: msg('Each project against its baseline, or its current plan where none has been set.'),
        firstColumn: msg('Project'),
        rows: projectRows(context).filter((row) => measured.has(Number(row.link.id))),
        measures: ['evm.bac', 'evm.pv', 'evm.ev', 'evm.ac', 'evm.spi', 'evm.cpi', 'evm.eac', 'evm.vac'],
        period: context.period,
        today: context.today,
      }),
    );
  }

  return {
    tiles,
    tables,
    series: await earnedValueSeries(context, bucketFor(context.period)),
    measures: await evaluateInContext(tiles, context),
  };
}

async function risk(shared: Shared, context: MeasureContext): Promise<Partial<Dashboard>> {
  const tiles = ['risk.open', 'risk.high', 'risk.overdue'];
  const { facts } = context;
  const language = contextLanguage();
  const open = context.work
    .filter((item) => isOpen(item) && context.risk.typeIds.has(item.typeId))
    .sort(
      (a, b) =>
        (facts.priorities.get(b.priorityId ?? -1)?.position ?? 0) - (facts.priorities.get(a.priorityId ?? -1)?.position ?? 0) ||
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
    );

  const bySeverity = new Map<string, number>();
  const noPriority = t(language, 'No priority');
  for (const item of open) {
    const name = item.priorityId !== null ? (facts.priorities.get(item.priorityId)?.name ?? noPriority) : noPriority;
    bySeverity.set(name, (bySeverity.get(name) ?? 0) + 1);
  }

  const tables: DashboardTable[] = [
    {
      id: 'risks',
      title: t(language, 'Open risks'),
      columns: [
        { key: 'name', label: t(language, 'Risk') },
        { key: 'project', label: t(language, 'Project') },
        { key: 'severity', label: t(language, 'Severity') },
        { key: 'owner', label: t(language, 'Assignee') },
        { key: 'due', label: t(language, 'Due') },
      ],
      rows: open.map((item) => ({
        key: `wp:${item.id}`,
        link: { kind: 'work_package', id: String(item.id) },
        cells: {
          name: item.subject,
          project: facts.projects.get(item.projectId)?.name ?? '',
          severity: item.priorityId !== null ? (facts.priorities.get(item.priorityId)?.name ?? null) : null,
          owner: item.assigneeId !== null ? (facts.users.get(item.assigneeId)?.name ?? null) : null,
          due: item.dueDate,
        },
      })),
    },
    {
      id: 'severity',
      title: t(language, 'By severity'),
      columns: [
        { key: 'name', label: t(language, 'Severity') },
        { key: 'count', label: t(language, 'Open risks'), unit: 'count' },
      ],
      rows: [...bySeverity.entries()].map(([name, count]) => ({ key: `severity:${name}`, cells: { name, count } })),
    },
  ];
  if (context.scope.kind === 'instance' || context.scope.kind === 'portfolio') {
    tables.push(
      await measureTable(shared, {
        id: 'projects',
        title: msg('By project'),
        firstColumn: msg('Project'),
        rows: projectRows(context),
        measures: ['risk.open', 'risk.high', 'risk.overdue'],
        period: context.period,
        today: context.today,
      }),
    );
  }

  const bucket = bucketFor(context.period);
  return {
    tiles,
    tables,
    series: [
      await series(context, 'risk.open', msg('Open risks'), bucket),
      await series(context, 'risk.high', msg('High risks'), bucket),
    ],
    measures: await evaluateInContext(tiles, context),
  };
}

/** The dashboards there are, for a menu: in English, as stored and logged. */
export const DASHBOARDS = DASHBOARD_IDS.map((id) => ({ id, ...TITLES[id] }));

/** The dashboards there are, for a menu, in `language`. */
export function dashboardsIn(language: Language): { id: DashboardId; title: string; description: string }[] {
  return DASHBOARD_IDS.map((id) => ({ id, title: t(language, TITLES[id].title), description: t(language, TITLES[id].description) }));
}

const BUILDERS: Record<DashboardId, (shared: Shared, context: MeasureContext) => Promise<Partial<Dashboard>>> = {
  'portfolio-health': portfolioHealth,
  delivery,
  utilisation,
  budget,
  'earned-value': earnedValue,
  risk,
};

/** Builds one dashboard for a scope, a period and a viewer, timed against the target. */
export async function buildDashboard(
  id: DashboardId,
  scope: Scope,
  period: Period,
  viewer: Viewer,
  today: string,
  prepared?: Shared,
): Promise<Dashboard> {
  const startedAt = performance.now();
  const shared = prepared ?? (await prepare(viewer));
  const context = contextFor(shared, scope, period, today);
  const built = await BUILDERS[id](shared, context);
  const serverMs = Math.round(performance.now() - startedAt);
  const language = contextLanguage();

  return {
    id,
    title: t(language, TITLES[id].title),
    description: t(language, TITLES[id].description),
    scope: { ...scope, name: scopeName(shared, scope, language) },
    period,
    today,
    asOf: shared.facts.asOf,
    tiles: built.tiles ?? [],
    measures: built.measures ?? {},
    tables: built.tables ?? [],
    series: built.series ?? [],
    timing: { serverMs, targetMs: env.EPM_DASHBOARD_TARGET_MS, withinTarget: serverMs <= env.EPM_DASHBOARD_TARGET_MS },
  };
}
