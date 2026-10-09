import { addDays, daysBetween, startOfIsoWeek } from '../lib/dates.js';
import type { HealthLevel } from '../types/epm.js';
import { roundMoney } from './costs.js';
import { budgetVariancePct, healthViews, plannedBudgetToDate } from './health.js';
import { getHealthRules, resolveRiskSelection } from './health-rules.js';
import {
  dueDateChanges,
  modelFacts,
  startedAt,
  workFactsAsAt,
  type ModelFacts,
  type PersonFact,
  type ProjectFact,
  type TimeFact,
  type WorkFact,
} from './measure-facts.js';
import { isDelivered, isDueSoon, isOpen, isOverdue } from './work-definitions.js';

/**
 * The semantic layer (BR-404): every measure EPM reports, defined once.
 *
 * Each measure is a name, a unit, a sentence saying exactly what it counts,
 * and the function that counts it — over the analytics model's facts, for a
 * scope, a period and a viewer. Dashboards, reports, the executive view,
 * scheduled reports and the daily values a BI tool reads all call
 * `evaluateMeasures`; none computes a figure of its own. So the same measure
 * asked from two places, of the same scope, period and person, is the same
 * number: the same rows, at the same refresh, through the same function.
 *
 * What a measure counts is limited to what the viewer can see: the projects in
 * which they may read work packages. Health and cost are per project, so a
 * project a person can see contributes the same to their figures as to anyone
 * else's.
 *
 * A measure whose members are things — work packages, projects, people —
 * lists them as well as counting them, which is the drill-through: the number
 * on a dashboard opens on exactly the items behind it.
 */

/* -------------------------------------------------------------------------- */
/* Scope, period, viewer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `set` is the projects a saved portfolio view selects (BR-203): always given
 * with the set as `within`, measured exactly as a portfolio is. Internal — it
 * is not a scope anyone names in a request.
 */
export type ScopeKind = 'instance' | 'portfolio' | 'project' | 'department' | 'team' | 'person' | 'set';

export interface Scope {
  kind: ScopeKind;
  /** The portfolio, project, department, team or person; absent for the instance and a set. */
  id?: string;
}

export interface Period {
  /** First day, inclusive, `YYYY-MM-DD`. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export interface Viewer {
  /** Projects in which this person may read work packages. */
  visibleProjectIds: Set<number>;
}

export type MeasureUnit = 'count' | 'percent' | 'hours' | 'money' | 'days' | 'perWeek' | 'points';
export type MemberKind = 'work_package' | 'project' | 'person';

const PROJECT_SCOPES: ScopeKind[] = ['instance', 'portfolio', 'project'];
const ALL_SCOPES: ScopeKind[] = ['instance', 'portfolio', 'project', 'department', 'team', 'person'];

export interface HealthFact {
  overall: HealthLevel;
  assessed: boolean;
  scheduleVarianceDays: number | null;
  budgetVariancePct: number | null;
}

/** Everything a measure may read, already narrowed to the scope and the viewer. */
export interface MeasureContext {
  scope: Scope;
  period: Period;
  today: string;
  facts: ModelFacts;
  /** Projects in scope the viewer can see; active ones only, except a single project asked for by id. */
  projects: ProjectFact[];
  /** Work in scope the viewer can see. */
  work: WorkFact[];
  /** Whether a work package is in scope — for work rebuilt as at another time, too. */
  inScope(work: WorkFact): boolean;
  /** People in scope. */
  people: PersonFact[];
  /** Time on the projects in scope — or, for people scopes, by the people in scope on visible projects. */
  time: TimeFact[];
  /** All time by the people in scope on projects the viewer can see — what utilisation divides. */
  peopleTime: TimeFact[];
  health: Map<number, HealthFact>;
  risk: { typeIds: Set<number>; highPriorityIds: Set<number>; configured: boolean };
  visibleProjectIds: Set<number>;
}

export interface MeasureValue {
  value: number | null;
  /** Why the value is absent, or what it leaves out. */
  note?: string;
  /** Ids of the work packages, projects or people behind the value. */
  members?: number[];
  /** Further figures the value was made from, by name. */
  parts?: Record<string, number | null>;
}

/**
 * How a figure for several projects is made from each project's own (BR-201):
 * `sum` adds them, `max` takes the largest, `ratio` divides summed parts. A
 * portfolio's figure is checked against this roll-up of its project rows, so a
 * total that does not add up is found rather than shown.
 */
export interface Rollup {
  rule: 'sum' | 'max' | 'ratio';
  /** In words, for the person reading the figure. */
  describe: string;
  from(values: MeasureValue[]): number | null;
}

const sumRollup: Rollup = {
  rule: 'sum',
  describe: 'The projects’ figures added together.',
  from: (values) => {
    const present = values.filter((value) => value.value !== null);
    return present.length === 0 ? null : roundMoney(present.reduce((sum, value) => sum + (value.value ?? 0), 0));
  },
};

const maxRollup: Rollup = {
  rule: 'max',
  describe: 'The largest of the projects’ figures.',
  from: (values) => {
    const present = values.map((value) => value.value).filter((value): value is number => value !== null);
    return present.length === 0 ? null : Math.max(...present);
  },
};

/** A share of summed parts: the parts of every project added, then divided. */
function ratioRollup(numerator: string[], denominator: string[], describe: string): Rollup {
  const total = (values: MeasureValue[], names: string[]) =>
    values.reduce((sum, value) => sum + names.reduce((part, name) => part + (value.parts?.[name] ?? 0), 0), 0);
  return {
    rule: 'ratio',
    describe,
    from: (values) => pct(total(values, numerator), total(values, denominator)),
  };
}

export interface MeasureDefinition {
  id: string;
  label: string;
  unit: MeasureUnit;
  /** Exactly what is counted — shown beside the figure, and published to BI tools. */
  definition: string;
  scopes: ScopeKind[];
  /** Whether it reads the period, or describes now. */
  usesPeriod: boolean;
  memberKind?: MemberKind;
  /** How a series over time is built: per period bucket, or the state as at each bucket's end. */
  trend?: 'period' | 'asAt';
  /** Raised when the definition changes, so a stored daily value says which one made it. */
  version: number;
  /** How a set of projects' figure is made from each project's. Absent: not one to add up. */
  rollup?: Rollup;
  /**
   * Money made of logged time: the drill-through ends at the priced time
   * entries behind it (BR-202) — those to date, or those in the period.
   */
  entries?: 'to-date' | 'in-period';
  compute(context: MeasureContext): MeasureValue | Promise<MeasureValue>;
}

/* -------------------------------------------------------------------------- */
/* Small rules the definitions share                                          */
/* -------------------------------------------------------------------------- */

const dayOf = (instant: string | null): string | null => (instant ? instant.slice(0, 10) : null);
const inPeriod = (day: string | null, period: Period): boolean => day !== null && day >= period.from && day <= period.to;
const round1 = (value: number) => Math.round(value * 10) / 10;
const pct = (part: number, whole: number): number | null => (whole > 0 ? round1((part / whole) * 100) : null);

/** Weeks in a period: its days over seven. */
export function weeksIn(period: Period): number {
  return Math.max(daysBetween(period.from, period.to), 1) / 7;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Days between two instants, to one decimal. */
const daysBetweenInstants = (from: string, to: string) => round1((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Delivered within the period, on the day it was closed. */
const deliveredIn = (work: WorkFact, period: Period) => isDelivered(work) && inPeriod(dayOf(work.closedAt), period);

/** A milestone's outcome against its date, judged today. */
export function milestoneOutcome(work: WorkFact, today: string): 'met' | 'missed' | 'pending' | 'excluded' {
  if (!work.isMilestone || !work.dueDate) return 'excluded';
  if (isDelivered(work)) {
    const closed = dayOf(work.closedAt);
    return closed !== null && closed <= work.dueDate ? 'met' : 'missed';
  }
  // Closed without being delivered — rejected — is not a delivery to judge.
  if (work.isClosed) return 'excluded';
  return work.dueDate < today ? 'missed' : 'pending';
}

const isRisk = (work: WorkFact, context: MeasureContext) => context.risk.typeIds.has(work.typeId);
const isHighRisk = (work: WorkFact, context: MeasureContext) =>
  isRisk(work, context) && work.priorityId !== null && context.risk.highPriorityIds.has(work.priorityId);

const budgeted = (context: MeasureContext) => context.projects.filter((project) => (project.budget ?? 0) > 0);

function costOf(time: TimeFact[]): { cost: number; costedHours: number; uncostedHours: number } {
  let cost = 0;
  let costedHours = 0;
  let uncostedHours = 0;
  for (const entry of time) {
    if (entry.hours <= 0) continue;
    if (entry.cost === null) uncostedHours += entry.hours;
    else {
      cost += entry.cost;
      costedHours += entry.hours;
    }
  }
  return { cost: roundMoney(cost), costedHours: roundMoney(costedHours), uncostedHours: roundMoney(uncostedHours) };
}

/** Cost to date and planned to date, over budgeted projects only. */
function budgetPosition(context: MeasureContext) {
  const projects = budgeted(context);
  const ids = new Set(projects.map((project) => project.id));
  const spent = costOf(context.time.filter((entry) => entry.projectId !== null && ids.has(entry.projectId)));
  let budget = 0;
  let planned = 0;
  for (const project of projects) {
    budget += project.budget!;
    // Rounded per project and then added, as cost is per entry: a set's figure
    // is then exactly the sum of its projects' figures, to the cent.
    planned += roundMoney(plannedBudgetToDate(project.budget!, project.plannedStart, project.plannedFinish, context.today).planned);
  }
  return { projects, budget: roundMoney(budget), planned: roundMoney(planned), ...spent };
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

const workIds = (work: WorkFact[]) => work.map((item) => item.id);

/** How far ahead "coming up" looks for milestones. */
export const MILESTONE_HORIZON_DAYS = 30;

export const MEASURES: MeasureDefinition[] = [
  /* ------------------------------------------------------------------ work */
  {
    id: 'work.total',
    label: 'Work packages',
    unit: 'count',
    definition: 'Work packages in scope, in any status.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    trend: 'asAt',
    version: 1,
    rollup: sumRollup,
    compute: ({ work }) => ({ value: work.length, members: workIds(work) }),
  },
  {
    id: 'work.open',
    label: 'Open work',
    unit: 'count',
    definition: 'Work packages not in a closed status.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    trend: 'asAt',
    version: 1,
    rollup: sumRollup,
    compute: ({ work }) => {
      const open = work.filter(isOpen);
      return { value: open.length, members: workIds(open) };
    },
  },
  {
    id: 'work.overdue',
    label: 'Overdue',
    unit: 'count',
    definition: 'Open work packages due before today (UTC). Work due today is due, not overdue.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    trend: 'asAt',
    version: 1,
    rollup: sumRollup,
    compute: ({ work, today }) => {
      const overdue = work.filter((item) => isOverdue(item, today));
      return { value: overdue.length, members: workIds(overdue) };
    },
  },
  {
    id: 'work.dueSoon',
    label: 'Due in the next 7 days',
    unit: 'count',
    definition: 'Open work packages due today or in the next six days.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    version: 1,
    rollup: sumRollup,
    compute: ({ work, today }) => {
      const soon = work.filter((item) => isDueSoon(item, today));
      return { value: soon.length, members: workIds(soon) };
    },
  },
  {
    id: 'work.progress',
    label: 'Progress',
    unit: 'percent',
    definition:
      'Share of work packages in a closed status, of all in scope. Rejected work counts as closed: it is no longer to be done.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    version: 1,
    rollup: ratioRollup(['closed'], ['total'], 'Closed work of all work, both added across the projects.'),
    compute: ({ work }) => {
      const closed = work.filter((item) => item.isClosed).length;
      return { value: pct(closed, work.length), parts: { closed, total: work.length } };
    },
  },
  {
    id: 'work.completed',
    label: 'Delivered',
    unit: 'count',
    definition:
      'Work packages delivered in the period: closed in a status EPM reads as done — not Rejected — counted on the day they were closed.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'work_package',
    trend: 'period',
    version: 1,
    rollup: sumRollup,
    compute: ({ work, period }) => {
      const delivered = work.filter((item) => deliveredIn(item, period));
      return { value: delivered.length, members: workIds(delivered) };
    },
  },
  {
    id: 'work.created',
    label: 'Created',
    unit: 'count',
    definition: 'Work packages created in the period.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'work_package',
    trend: 'period',
    version: 1,
    rollup: sumRollup,
    compute: ({ work, period }) => {
      const created = work.filter((item) => inPeriod(dayOf(item.createdAt), period));
      return { value: created.length, members: workIds(created) };
    },
  },
  {
    id: 'work.pointsDelivered',
    label: 'Points delivered',
    unit: 'points',
    definition: 'Story points of the work delivered in the period.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    compute: ({ work, period }) => ({
      value: work.filter((item) => deliveredIn(item, period)).reduce((sum, item) => sum + (item.storyPoints ?? 0), 0),
    }),
  },
  {
    id: 'work.throughput',
    label: 'Throughput',
    unit: 'perWeek',
    definition: 'Work packages delivered per week in the period: those delivered, over the days in the period divided by seven.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    compute: ({ work, period }) => {
      const delivered = work.filter((item) => deliveredIn(item, period)).length;
      return { value: round1(delivered / weeksIn(period)), parts: { delivered, weeks: round1(weeksIn(period)) } };
    },
  },
  {
    id: 'work.leadTime',
    label: 'Lead time',
    unit: 'days',
    definition: 'Median days from creation to closing, for work delivered in the period.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    compute: ({ work, period }) => {
      const delivered = work.filter((item) => deliveredIn(item, period) && item.createdAt && item.closedAt);
      const value = median(delivered.map((item) => daysBetweenInstants(item.createdAt!, item.closedAt!)));
      return value === null
        ? { value: null, note: 'Nothing was delivered in the period.' }
        : { value: round1(value), parts: { delivered: delivered.length } };
    },
  },
  {
    id: 'work.cycleTime',
    label: 'Cycle time',
    unit: 'days',
    definition:
      'Median days from first leaving a not-started status to closing, for work delivered in the period, from each work package’s history.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    compute: async ({ work, period }) => {
      const delivered = work.filter((item) => deliveredIn(item, period) && item.closedAt);
      const started = await startedAt(workIds(delivered));
      const value = median(
        delivered.map((item) => daysBetweenInstants(started.get(item.id) ?? item.closedAt!, item.closedAt!)),
      );
      return value === null
        ? { value: null, note: 'Nothing was delivered in the period.' }
        : { value: round1(value), parts: { delivered: delivered.length } };
    },
  },
  {
    id: 'work.churn',
    label: 'Date changes',
    unit: 'count',
    definition: 'Changes made to work packages’ due dates during the period, from their history.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'work_package',
    trend: 'period',
    version: 1,
    compute: async ({ work, period }) => {
      const inScope = new Set(workIds(work));
      const changes = (await dueDateChanges(period.from, period.to)).filter((change) => inScope.has(change.workPackageId));
      return { value: changes.length, members: [...new Set(changes.map((change) => change.workPackageId))] };
    },
  },
  {
    id: 'schedule.drift',
    label: 'Date drift',
    unit: 'days',
    definition:
      'Average days the due dates of open work moved during the period: the due date now, minus the due date at the start of the period, over open work that had a due date at both times. Positive is later.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'work_package',
    version: 1,
    compute: async ({ work, period, facts }) => {
      const before = new Map(
        (await workFactsAsAt(new Date(`${period.from}T00:00:00.000Z`), facts)).map((item) => [item.id, item.dueDate]),
      );
      const moved: number[] = [];
      const members: number[] = [];
      for (const item of work) {
        const then = before.get(item.id);
        if (!isOpen(item) || !item.dueDate || !then) continue;
        const shift = item.dueDate >= then ? daysBetween(then, item.dueDate) - 1 : -(daysBetween(item.dueDate, then) - 1);
        moved.push(shift);
        if (shift !== 0) members.push(item.id);
      }
      return moved.length === 0
        ? { value: null, note: 'No open work had a due date at both times.' }
        : { value: round1(moved.reduce((sum, shift) => sum + shift, 0) / moved.length), members, parts: { compared: moved.length } };
    },
  },

  /* ------------------------------------------------------------ milestones */
  {
    id: 'milestones.onTime',
    label: 'Milestones on time',
    unit: 'percent',
    definition:
      'Of the milestones due in the period that are decided — delivered, or still open past their date — the share delivered on or before their date. Milestones not yet due, and rejected ones, are left out.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'work_package',
    trend: 'period',
    version: 1,
    rollup: ratioRollup(['met'], ['met', 'missed'], 'Milestones met of those decided, both added across the projects.'),
    compute: ({ work, period, today }) => {
      const due = work.filter((item) => item.isMilestone && inPeriod(item.dueDate, period));
      const met = due.filter((item) => milestoneOutcome(item, today) === 'met');
      const missed = due.filter((item) => milestoneOutcome(item, today) === 'missed');
      const decided = met.length + missed.length;
      return decided === 0
        ? { value: null, note: 'No milestone due in the period has been decided yet.', members: workIds(due) }
        : { value: pct(met.length, decided), members: workIds([...met, ...missed]), parts: { met: met.length, missed: missed.length } };
    },
  },
  {
    id: 'milestones.upcoming',
    label: 'Milestones coming up',
    unit: 'count',
    definition: `Open milestones due today or in the next ${MILESTONE_HORIZON_DAYS - 1} days.`,
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    version: 1,
    rollup: sumRollup,
    compute: ({ work, today }) => {
      const horizon = addDays(today, MILESTONE_HORIZON_DAYS - 1);
      const upcoming = work.filter(
        (item) => item.isMilestone && isOpen(item) && item.dueDate !== null && item.dueDate >= today && item.dueDate <= horizon,
      );
      return { value: upcoming.length, members: workIds(upcoming) };
    },
  },
  {
    id: 'milestones.missed',
    label: 'Milestones missed',
    unit: 'count',
    definition: 'Milestones due in the period that were delivered after their date, or are still open past it.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'work_package',
    trend: 'period',
    version: 1,
    rollup: sumRollup,
    compute: ({ work, period, today }) => {
      const missed = work.filter(
        (item) => item.isMilestone && inPeriod(item.dueDate, period) && milestoneOutcome(item, today) === 'missed',
      );
      return { value: missed.length, members: workIds(missed) };
    },
  },

  /* -------------------------------------------------------------- schedule */
  {
    id: 'schedule.varianceDays',
    label: 'Schedule variance',
    unit: 'days',
    definition:
      'Calendar days from the planned finish to the forecast finish, from each project’s stored health; positive is late. For more than one project, the latest of them.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    memberKind: 'project',
    version: 1,
    rollup: maxRollup,
    compute: ({ projects, health }) => {
      const measured = projects
        .map((project) => ({ project, days: health.get(project.id)?.scheduleVarianceDays ?? null }))
        .filter((entry): entry is { project: ProjectFact; days: number } => entry.days !== null);
      if (measured.length === 0) return { value: null, note: 'No project in scope has a measured schedule variance.' };
      const worst = measured.reduce((a, b) => (b.days > a.days ? b : a));
      return { value: worst.days, members: measured.map((entry) => entry.project.id), parts: { measured: measured.length } };
    },
  },
  {
    id: 'schedule.slipping',
    label: 'Projects slipping',
    unit: 'count',
    definition: 'Active projects whose forecast finish is after their planned finish, from each project’s stored health.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    memberKind: 'project',
    version: 1,
    rollup: sumRollup,
    compute: ({ projects, health }) => {
      const slipping = projects.filter((project) => (health.get(project.id)?.scheduleVarianceDays ?? 0) > 0);
      return { value: slipping.length, members: slipping.map((project) => project.id) };
    },
  },

  /* ---------------------------------------------------------------- health */
  {
    id: 'projects.active',
    label: 'Active projects',
    unit: 'count',
    definition: 'Active projects in scope.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    memberKind: 'project',
    version: 1,
    rollup: sumRollup,
    compute: ({ projects }) => {
      const active = projects.filter((project) => project.active);
      return { value: active.length, members: active.map((project) => project.id) };
    },
  },
  ...(['healthy', 'warning', 'critical'] as const).map(
    (level): MeasureDefinition => ({
      id: `health.${level === 'healthy' ? 'green' : level === 'warning' ? 'amber' : 'red'}`,
      label: `Projects ${level === 'healthy' ? 'green' : level === 'warning' ? 'amber' : 'red'}`,
      unit: 'count',
      definition: `Active projects whose effective overall health — calculated by the health rules, with any override in force — is ${
        level === 'healthy' ? 'green' : level === 'warning' ? 'amber' : 'red'
      }.`,
      scopes: PROJECT_SCOPES,
      usesPeriod: false,
      memberKind: 'project',
      version: 1,
      rollup: sumRollup,
      compute: ({ projects, health }) => {
        const matching = projects.filter(
          (project) => project.active && health.get(project.id)?.assessed && health.get(project.id)?.overall === level,
        );
        return { value: matching.length, members: matching.map((project) => project.id) };
      },
    }),
  ),
  {
    id: 'health.greenPct',
    label: 'Portfolio health',
    unit: 'percent',
    definition: 'Share of active, assessed projects whose effective overall health is green.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    version: 1,
    rollup: ratioRollup(['green'], ['assessed'], 'Green projects of assessed ones, both added across the projects.'),
    compute: ({ projects, health }) => {
      const assessed = projects.filter((project) => project.active && health.get(project.id)?.assessed);
      const green = assessed.filter((project) => health.get(project.id)?.overall === 'healthy').length;
      return assessed.length === 0
        ? { value: null, note: 'No active project in scope has been assessed.' }
        : { value: pct(green, assessed.length), parts: { green, assessed: assessed.length } };
    },
  },
  {
    id: 'projects.atRisk',
    label: 'Projects at risk',
    unit: 'count',
    definition: 'Active projects whose effective overall health is amber or red.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    memberKind: 'project',
    version: 1,
    rollup: sumRollup,
    compute: ({ projects, health }) => {
      const atRisk = projects.filter((project) => {
        const fact = health.get(project.id);
        return project.active && fact?.assessed && fact.overall !== 'healthy';
      });
      return { value: atRisk.length, members: atRisk.map((project) => project.id) };
    },
  },

  /* ---------------------------------------------------------------- risks */
  {
    id: 'risk.open',
    label: 'Open risks',
    unit: 'count',
    definition:
      'Open work packages of a risk type — the types chosen in the health rules, or any type named Risk.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    trend: 'asAt',
    version: 1,
    rollup: sumRollup,
    compute: (context) => {
      if (!context.risk.configured) return { value: null, note: 'No type on this instance is a risk type.' };
      const open = context.work.filter((item) => isOpen(item) && isRisk(item, context));
      return { value: open.length, members: workIds(open) };
    },
  },
  {
    id: 'risk.high',
    label: 'High risks',
    unit: 'count',
    definition:
      'Open risks at a high priority — the priorities chosen in the health rules, or High and above. What the health risk criterion counts.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    trend: 'asAt',
    version: 1,
    rollup: sumRollup,
    compute: (context) => {
      if (!context.risk.configured) return { value: null, note: 'No type on this instance is a risk type.' };
      const high = context.work.filter((item) => isOpen(item) && isHighRisk(item, context));
      return { value: high.length, members: workIds(high) };
    },
  },
  {
    id: 'risk.overdue',
    label: 'Risks past their date',
    unit: 'count',
    definition: 'Open risks due before today: mitigations that have not happened when they were meant to.',
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'work_package',
    version: 1,
    rollup: sumRollup,
    compute: (context) => {
      if (!context.risk.configured) return { value: null, note: 'No type on this instance is a risk type.' };
      const late = context.work.filter((item) => isRisk(item, context) && isOverdue(item, context.today));
      return { value: late.length, members: workIds(late) };
    },
  },

  /* ----------------------------------------------------------- budget/cost */
  {
    id: 'budget.total',
    label: 'Budget',
    unit: 'money',
    definition: 'The approved budgets of the active projects in scope that have one, added together.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    memberKind: 'project',
    version: 1,
    rollup: sumRollup,
    compute: (context) => {
      const projects = budgeted(context);
      return {
        value: roundMoney(projects.reduce((sum, project) => sum + project.budget!, 0)),
        members: projects.map((project) => project.id),
      };
    },
  },
  {
    id: 'cost.actual',
    label: 'Actual cost',
    unit: 'money',
    definition:
      'Labour cost to date: every hour logged on the projects in scope, at the hourly rate of the person who logged it. Hours from people without a rate are not costed, and are counted separately.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    version: 1,
    rollup: sumRollup,
    entries: 'to-date',
    compute: ({ time }) => {
      const spent = costOf(time);
      return {
        value: spent.cost,
        parts: { costedHours: spent.costedHours, uncostedHours: spent.uncostedHours },
        note: spent.uncostedHours > 0 ? `${spent.uncostedHours} hours logged by people with no hourly rate are not costed.` : undefined,
      };
    },
  },
  {
    id: 'cost.spent',
    label: 'Spent in period',
    unit: 'money',
    definition:
      'Labour cost of the hours logged in the period on the projects in scope, at the hourly rate of the person who logged them.',
    scopes: PROJECT_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    rollup: sumRollup,
    entries: 'in-period',
    compute: ({ time, period }) => {
      const spent = costOf(time.filter((entry) => inPeriod(entry.spentOn, period)));
      return { value: spent.cost, parts: { costedHours: spent.costedHours, uncostedHours: spent.uncostedHours } };
    },
  },
  {
    id: 'cost.plannedToDate',
    label: 'Planned to date',
    unit: 'money',
    definition:
      'Budget planned to be spent by today: each budgeted project’s budget phased evenly from its planned start to its planned finish — all of it where no plan is set.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    version: 1,
    rollup: sumRollup,
    compute: (context) => {
      const position = budgetPosition(context);
      return position.projects.length === 0
        ? { value: null, note: 'No active project in scope has a budget.' }
        : { value: position.planned, parts: { budget: roundMoney(position.budget) } };
    },
  },
  {
    id: 'cost.variance',
    label: 'Cost variance',
    unit: 'money',
    definition:
      'Planned to date minus actual cost, over the budgeted projects in scope: positive is under plan, negative over.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    version: 1,
    rollup: sumRollup,
    entries: 'to-date',
    compute: (context) => {
      const position = budgetPosition(context);
      return position.projects.length === 0
        ? { value: null, note: 'No active project in scope has a budget.' }
        : {
            value: roundMoney(position.planned - position.cost),
            parts: { planned: position.planned, actual: position.cost, uncostedHours: position.uncostedHours },
          };
    },
  },
  {
    id: 'budget.variancePct',
    label: 'Budget variance',
    unit: 'percent',
    definition:
      'Actual cost minus planned to date, as a share of the budget, over the budgeted projects in scope — the figure the health budget criterion judges. Positive is over plan.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    version: 1,
    rollup: {
      rule: 'ratio',
      describe: 'Actual cost minus planned to date, of the budgets — each added across the projects.',
      from: (values) => {
        const sum = (name: string) => values.reduce((total, value) => total + (value.parts?.[name] ?? 0), 0);
        return sum('budget') > 0 ? budgetVariancePct(roundMoney(sum('actual')), roundMoney(sum('planned')), roundMoney(sum('budget'))) : null;
      },
    },
    entries: 'to-date',
    compute: (context) => {
      const position = budgetPosition(context);
      return position.budget <= 0
        ? { value: null, note: 'No active project in scope has a budget.' }
        : {
            value: budgetVariancePct(position.cost, position.planned, position.budget),
            parts: { actual: position.cost, planned: position.planned, budget: position.budget },
          };
    },
  },
  {
    id: 'budget.consumed',
    label: 'Budget consumed',
    unit: 'percent',
    definition: 'Actual cost of the budgeted projects in scope as a share of their budgets.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    memberKind: 'project',
    version: 1,
    rollup: ratioRollup(['actual'], ['budget'], 'Actual cost of the budgets, both added across the projects.'),
    entries: 'to-date',
    compute: (context) => {
      const position = budgetPosition(context);
      return position.budget <= 0
        ? { value: null, note: 'No active project in scope has a budget.' }
        : {
            value: pct(position.cost, position.budget),
            members: position.projects.map((project) => project.id),
            parts: { actual: position.cost, budget: roundMoney(position.budget) },
          };
    },
  },

  /* --------------------------------------------------------- people, time */
  {
    id: 'capacity.weeklyHours',
    label: 'Weekly capacity',
    unit: 'hours',
    definition: `Hours a week the people in scope can work: each person’s capacity, ${40} where none is set.`,
    scopes: ALL_SCOPES,
    usesPeriod: false,
    memberKind: 'person',
    version: 1,
    compute: ({ people }) => ({
      value: roundMoney(people.reduce((sum, person) => sum + person.weeklyCapacityHours, 0)),
      members: people.map((person) => person.id),
    }),
  },
  {
    id: 'time.logged',
    label: 'Hours logged',
    unit: 'hours',
    definition:
      'Hours logged in the period on the projects in scope — or, for a department, team or person, by the people in scope.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    compute: ({ time, period }) => ({
      value: roundMoney(time.filter((entry) => inPeriod(entry.spentOn, period)).reduce((sum, entry) => sum + entry.hours, 0)),
    }),
  },
  {
    id: 'time.uncosted',
    label: 'Uncosted hours',
    unit: 'hours',
    definition: 'Hours logged in the period by people with no hourly rate, which no cost figure includes.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    version: 1,
    compute: ({ time, period }) => ({
      value: roundMoney(
        time.filter((entry) => inPeriod(entry.spentOn, period) && entry.cost === null).reduce((sum, entry) => sum + entry.hours, 0),
      ),
    }),
  },
  {
    id: 'utilisation',
    label: 'Utilisation',
    unit: 'percent',
    definition:
      'Hours the people in scope logged in the period, on projects you can see, as a share of their capacity for the period: weekly capacity times the days in the period divided by seven.',
    scopes: ALL_SCOPES,
    usesPeriod: true,
    memberKind: 'person',
    trend: 'period',
    version: 1,
    compute: ({ people, peopleTime, period }) => {
      const capacity = people.reduce((sum, person) => sum + person.weeklyCapacityHours, 0) * weeksIn(period);
      const logged = peopleTime
        .filter((entry) => inPeriod(entry.spentOn, period))
        .reduce((sum, entry) => sum + entry.hours, 0);
      return capacity <= 0
        ? { value: null, note: 'Nobody in scope has capacity.' }
        : {
            value: pct(logged, capacity),
            members: people.map((person) => person.id),
            parts: { logged: roundMoney(logged), capacity: roundMoney(capacity) },
          };
    },
  },

  /* ---------------------------------------------------------------- agile */
  {
    id: 'sprint.velocity',
    label: 'Velocity',
    unit: 'points',
    definition:
      'Average story points delivered per sprint, over the sprints in scope that ended in the period: the points of each sprint’s delivered work.',
    scopes: PROJECT_SCOPES,
    usesPeriod: true,
    trend: 'period',
    version: 1,
    compute: ({ work, facts, period, projects }) => {
      const inScope = new Set(projects.map((project) => project.id));
      const sprints = [...facts.versions.values()].filter(
        (version) => version.projectId !== null && inScope.has(version.projectId) && inPeriod(version.endDate, period),
      );
      if (sprints.length === 0) return { value: null, note: 'No sprint in scope ended in the period.' };
      const points = sprints.map((sprint) =>
        work
          .filter((item) => item.versionId === sprint.id && isDelivered(item))
          .reduce((sum, item) => sum + (item.storyPoints ?? 0), 0),
      );
      return {
        value: round1(points.reduce((sum, value) => sum + value, 0) / sprints.length),
        parts: { sprints: sprints.length },
      };
    },
  },
  {
    id: 'sprint.progress',
    label: 'Sprint progress',
    unit: 'percent',
    definition:
      'For the sprints in scope under way today: delivered story points as a share of committed points — the figure recorded when the sprint started, or the sprint’s total points where none was.',
    scopes: PROJECT_SCOPES,
    usesPeriod: false,
    version: 1,
    compute: ({ work, facts, projects, today }) => {
      const inScope = new Set(projects.map((project) => project.id));
      const running = [...facts.versions.values()].filter(
        (version) =>
          version.projectId !== null &&
          inScope.has(version.projectId) &&
          version.status === 'open' &&
          version.startDate !== null &&
          version.endDate !== null &&
          version.startDate <= today &&
          version.endDate >= today,
      );
      if (running.length === 0) return { value: null, note: 'No sprint in scope is under way.' };
      let delivered = 0;
      let committed = 0;
      for (const sprint of running) {
        const items = work.filter((item) => item.versionId === sprint.id);
        delivered += items.filter(isDelivered).reduce((sum, item) => sum + (item.storyPoints ?? 0), 0);
        committed += sprint.committedPoints ?? items.reduce((sum, item) => sum + (item.storyPoints ?? 0), 0);
      }
      return committed <= 0
        ? { value: null, note: 'The sprints under way have no points.' }
        : { value: pct(delivered, committed), parts: { delivered, committed, sprints: running.length } };
    },
  },
];

const BY_ID = new Map(MEASURES.map((measure) => [measure.id, measure]));

export function measureById(id: string): MeasureDefinition | undefined {
  return BY_ID.get(id);
}

/** The catalogue as data: what the API and the BI catalogue publish. */
export function catalogue() {
  return MEASURES.map(({ compute: _compute, rollup, ...definition }) => ({
    ...definition,
    ...(rollup ? { rollup: { rule: rollup.rule, describe: rollup.describe } } : {}),
  }));
}

/* -------------------------------------------------------------------------- */
/* Building a context                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What every scope a viewer asks about shares: the model, the risk selection,
 * and the stored health of every project they can see. Read once, then any
 * number of scopes are measured from it — a dashboard of thirty rows reads
 * health once, not thirty times.
 */
export interface Shared {
  facts: ModelFacts;
  viewer: Viewer;
  health: Map<number, HealthFact>;
  risk: MeasureContext['risk'];
}

export async function prepare(viewer: Viewer): Promise<Shared> {
  const facts = await modelFacts();
  const visible = [...facts.projects.values()].filter((project) => viewer.visibleProjectIds.has(project.id));
  const [health, risk] = await Promise.all([healthFacts(visible), riskSelection()]);
  return { facts, viewer, health, risk };
}

async function healthFacts(projects: ProjectFact[]): Promise<Map<number, HealthFact>> {
  const views = await healthViews(projects.map((project) => ({ id: project.id, active: project.active })));
  const result = new Map<number, HealthFact>();
  for (const [id, view] of views) {
    const criterion = (name: string) => view.detail.criteria.find((entry) => entry.criterion === name)?.value ?? null;
    result.set(Number(id), {
      overall: view.effective.overall,
      assessed: view.detail.ruleVersion > 0,
      scheduleVarianceDays: criterion('schedule'),
      budgetVariancePct: criterion('budget'),
    });
  }
  return result;
}

async function riskSelection(): Promise<MeasureContext['risk']> {
  const rules = await getHealthRules();
  const selection = await resolveRiskSelection(rules);
  return {
    typeIds: new Set(selection.typeIds.map(Number)),
    highPriorityIds: new Set(selection.priorityIds.map(Number)),
    configured: selection.typeIds.length > 0,
  };
}

/**
 * Narrows the model to a scope and a viewer.
 *
 * Project scopes (instance, portfolio, project) measure the work and time of
 * active projects — an archived project is not delivering — except a single
 * project asked for by id, which is measured whatever its state. People scopes
 * (department, team, person) measure the work assigned to those people and
 * the time they logged, in projects the viewer can see.
 */
export async function buildContext(scope: Scope, period: Period, viewer: Viewer, today: string): Promise<MeasureContext> {
  return contextFor(await prepare(viewer), scope, period, today);
}

/**
 * `within`, when given, narrows any scope to those projects as well — a team's
 * work in one portfolio, say.
 */
export function contextFor(
  shared: Shared,
  scope: Scope,
  period: Period,
  today: string,
  within?: Set<number>,
): MeasureContext {
  const { facts, viewer } = shared;
  const visible = within
    ? new Set([...viewer.visibleProjectIds].filter((id) => within.has(id)))
    : viewer.visibleProjectIds;
  const allVisible = [...facts.projects.values()].filter((project) => visible.has(project.id));
  const activeVisible = allVisible.filter((project) => project.active);
  const activePeople = [...facts.people.values()].filter((person) => person.status === 'active');

  let projects: ProjectFact[];
  let people: PersonFact[];
  let byPeople = false;

  switch (scope.kind) {
    case 'instance':
      projects = activeVisible;
      people = activePeople;
      break;
    case 'portfolio':
      projects = activeVisible.filter((project) => project.portfolioId === scope.id);
      people = membersOf(projects, facts, activePeople);
      break;
    case 'set':
      // The projects come from `within`; a set is otherwise a portfolio.
      projects = activeVisible;
      people = membersOf(projects, facts, activePeople);
      break;
    case 'project':
      projects = allVisible.filter((project) => String(project.id) === scope.id);
      people = membersOf(projects, facts, activePeople);
      break;
    case 'department':
      people = activePeople.filter((person) => person.departmentId === scope.id);
      projects = activeVisible;
      byPeople = true;
      break;
    case 'team':
      people = activePeople.filter((person) => person.teamId === scope.id);
      projects = activeVisible;
      byPeople = true;
      break;
    case 'person':
      people = activePeople.filter((person) => String(person.id) === scope.id);
      projects = activeVisible;
      byPeople = true;
      break;
  }

  const projectIds = new Set(projects.map((project) => project.id));
  const personIds = new Set(people.map((person) => person.id));
  const visibleIds = new Set(allVisible.map((project) => project.id));

  const inScope = (item: WorkFact) =>
    projectIds.has(item.projectId) && (!byPeople || (item.assigneeId !== null && personIds.has(item.assigneeId)));
  const work = facts.workPackages.filter(inScope);
  const peopleTime = facts.time.filter(
    (entry) =>
      entry.userId !== null && personIds.has(entry.userId) && entry.projectId !== null && visibleIds.has(entry.projectId),
  );
  const time = byPeople
    ? peopleTime
    : facts.time.filter((entry) => entry.projectId !== null && projectIds.has(entry.projectId));

  const health = new Map([...shared.health].filter(([id]) => projectIds.has(id)));

  return {
    scope,
    period,
    today,
    facts,
    projects: byPeople ? [] : projects,
    work,
    inScope,
    people,
    time,
    peopleTime,
    health,
    risk: shared.risk,
    visibleProjectIds: visible,
  };
}

function membersOf(projects: ProjectFact[], facts: ModelFacts, people: PersonFact[]): PersonFact[] {
  const ids = new Set<number>();
  for (const project of projects) for (const id of facts.members.get(project.id) ?? []) ids.add(id);
  return people.filter((person) => ids.has(person.id));
}

/* -------------------------------------------------------------------------- */
/* Evaluating                                                                 */
/* -------------------------------------------------------------------------- */

export interface EvaluatedMeasure extends MeasureValue {
  id: string;
  label: string;
  unit: MeasureUnit;
  definition: string;
  memberKind?: MemberKind;
  /** False when the measure has no meaning for this kind of scope. */
  applicable: boolean;
}

export interface Evaluation {
  scope: Scope;
  period: Period;
  today: string;
  /** When the model's data was read. */
  asOf: string | null;
  measures: Record<string, EvaluatedMeasure>;
}

export async function evaluateInContext(ids: string[], context: MeasureContext): Promise<Record<string, EvaluatedMeasure>> {
  const result: Record<string, EvaluatedMeasure> = {};
  for (const id of ids) {
    const measure = BY_ID.get(id);
    if (!measure) continue;
    const base = {
      id,
      label: measure.label,
      unit: measure.unit,
      definition: measure.definition,
      memberKind: measure.memberKind,
    };
    const kind = context.scope.kind === 'set' ? 'portfolio' : context.scope.kind;
    if (!measure.scopes.includes(kind)) {
      result[id] = { ...base, value: null, applicable: false, note: `Not measured for a ${context.scope.kind}.` };
      continue;
    }
    result[id] = { ...base, ...(await measure.compute(context)), applicable: true };
  }
  return result;
}

/** Evaluates measures for a scope, a period and a viewer. Unknown ids are skipped. */
export async function evaluateMeasures(
  ids: string[],
  scope: Scope,
  period: Period,
  viewer: Viewer,
  today: string,
): Promise<Evaluation> {
  const context = await buildContext(scope, period, viewer, today);
  return {
    scope,
    period,
    today,
    asOf: context.facts.asOf,
    measures: await evaluateInContext(ids, context),
  };
}

/* -------------------------------------------------------------------------- */
/* Drill-through                                                              */
/* -------------------------------------------------------------------------- */

export interface WorkMember {
  id: number;
  subject: string;
  projectId: number;
  projectName: string;
  type: string;
  status: string;
  statusCategory: string;
  priority: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  dueDate: string | null;
  closedAt: string | null;
  isMilestone: boolean;
  /** A word about why it is here, where the measure has one: `met`, `missed`, `late 3d`. */
  flag?: string;
}

export interface ProjectMember {
  id: number;
  name: string;
  identifier: string | null;
  portfolioId: string | null;
  health: HealthLevel | null;
  scheduleVarianceDays: number | null;
  budget: number | null;
}

export interface PersonMember {
  id: number;
  name: string;
  departmentId: string | null;
  teamId: string | null;
  weeklyCapacityHours: number;
  loggedHours: number;
  utilisation: number | null;
}

export type Members =
  | { kind: 'work_package'; items: WorkMember[] }
  | { kind: 'project'; items: ProjectMember[] }
  | { kind: 'person'; items: PersonMember[] };

/** The items behind a measure's value, in the same scope, period and view. */
export async function measureMembers(
  id: string,
  scope: Scope,
  period: Period,
  viewer: Viewer,
  today: string,
): Promise<{ measure: EvaluatedMeasure; asOf: string | null; members: Members } | null> {
  const measure = BY_ID.get(id);
  if (!measure?.memberKind) return null;
  const context = await buildContext(scope, period, viewer, today);
  const evaluated = (await evaluateInContext([id], context))[id]!;
  const ids = new Set(evaluated.members ?? []);
  const { facts } = context;

  if (measure.memberKind === 'work_package') {
    const items = context.facts.workPackages
      .filter((item) => ids.has(item.id) && context.visibleProjectIds.has(item.projectId))
      .map((item): WorkMember => {
        const outcome = item.isMilestone ? milestoneOutcome(item, today) : undefined;
        const late = isOverdue(item, today) && item.dueDate ? daysBetween(item.dueDate, today) - 1 : 0;
        return {
          id: item.id,
          subject: item.subject,
          projectId: item.projectId,
          projectName: facts.projects.get(item.projectId)?.name ?? `Project ${item.projectId}`,
          type: facts.types.get(item.typeId)?.name ?? '',
          status: facts.statuses.get(item.statusId)?.name ?? '',
          statusCategory: item.statusCategory,
          priority: item.priorityId !== null ? (facts.priorities.get(item.priorityId)?.name ?? null) : null,
          assigneeId: item.assigneeId,
          assigneeName: item.assigneeId !== null ? (facts.users.get(item.assigneeId)?.name ?? null) : null,
          dueDate: item.dueDate,
          closedAt: item.closedAt,
          isMilestone: item.isMilestone,
          flag: outcome === 'met' || outcome === 'missed' ? outcome : late > 0 ? `late ${late}d` : undefined,
        };
      })
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id - b.id);
    return { measure: evaluated, asOf: facts.asOf, members: { kind: 'work_package', items } };
  }

  if (measure.memberKind === 'project') {
    const items = context.projects
      .filter((project) => ids.has(project.id))
      .map((project): ProjectMember => {
        const health = context.health.get(project.id);
        return {
          id: project.id,
          name: project.name,
          identifier: project.identifier,
          portfolioId: project.portfolioId,
          health: health?.assessed ? health.overall : null,
          scheduleVarianceDays: health?.scheduleVarianceDays ?? null,
          budget: project.budget,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { measure: evaluated, asOf: facts.asOf, members: { kind: 'project', items } };
  }

  const weeks = weeksIn(period);
  const items = context.people
    .filter((person) => ids.has(person.id))
    .map((person): PersonMember => {
      const logged = context.peopleTime
        .filter((entry) => entry.userId === person.id && inPeriod(entry.spentOn, period))
        .reduce((sum, entry) => sum + entry.hours, 0);
      return {
        id: person.id,
        name: person.name,
        departmentId: person.departmentId,
        teamId: person.teamId,
        weeklyCapacityHours: person.weeklyCapacityHours,
        loggedHours: roundMoney(logged),
        utilisation: pct(logged, person.weeklyCapacityHours * weeks),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { measure: evaluated, asOf: facts.asOf, members: { kind: 'person', items } };
}

/* -------------------------------------------------------------------------- */
/* Series                                                                     */
/* -------------------------------------------------------------------------- */

export type Bucket = 'week' | 'month';

/** The period's buckets: ISO weeks, or calendar months, clipped to the period. */
export function bucketsOf(period: Period, bucket: Bucket): Period[] {
  const out: Period[] = [];
  let start = bucket === 'week' ? startOfIsoWeek(period.from) : `${period.from.slice(0, 7)}-01`;
  while (start <= period.to) {
    let end: string;
    if (bucket === 'week') end = addDays(start, 6);
    else {
      const [year, month] = start.split('-').map(Number) as [number, number];
      end = addDays(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10), -1);
    }
    out.push({ from: start < period.from ? period.from : start, to: end > period.to ? period.to : end });
    start = addDays(end, 1);
  }
  return out;
}

export interface TrendPoint {
  from: string;
  to: string;
  value: number | null;
}

/**
 * A measure over time, in a context. Period measures are evaluated on each
 * bucket; state measures — open, overdue, risks — on the work as it stood at
 * the end of each bucket's last day, rebuilt from the journals and judged on
 * that day. The same definition either way.
 */
export async function measureSeries(context: MeasureContext, id: string, bucket: Bucket): Promise<TrendPoint[]> {
  const measure = BY_ID.get(id);
  if (!measure?.trend) return [];
  const points: TrendPoint[] = [];
  for (const slice of bucketsOf(context.period, bucket)) {
    if (measure.trend === 'period') {
      points.push({ ...slice, value: (await measure.compute({ ...context, period: slice })).value });
      continue;
    }
    // A bucket that has not ended is measured now.
    if (slice.to >= context.today) {
      points.push({ ...slice, value: (await measure.compute(context)).value });
      continue;
    }
    const asAt = (await workFactsAsAt(new Date(`${addDays(slice.to, 1)}T00:00:00.000Z`), context.facts)).filter(
      context.inScope,
    );
    points.push({ ...slice, value: (await measure.compute({ ...context, work: asAt, today: slice.to })).value });
  }
  return points;
}

/** A measure's series for a scope, a period and a viewer. */
export async function measureTrend(
  id: string,
  scope: Scope,
  period: Period,
  bucket: Bucket,
  viewer: Viewer,
  today: string,
): Promise<{ measure: Omit<MeasureDefinition, 'compute'>; asOf: string | null; points: TrendPoint[] } | null> {
  const measure = BY_ID.get(id);
  if (!measure?.trend) return null;
  const { compute: _compute, ...definition } = measure;
  const context = await buildContext(scope, period, viewer, today);
  return { measure: definition, asOf: context.facts.asOf, points: await measureSeries(context, id, bucket) };
}
