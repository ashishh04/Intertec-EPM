import { prisma } from '../db/prisma.js';
import { rollups } from './employees.js';
import type { EpmPortfolio } from './portfolios.js';
import type { EpmProject, HealthLevel } from '../types/epm.js';

/**
 * Analytics — history.
 *
 * Everything EPM already reports is today: the dashboard, the reports page, the
 * executive view. This adds the one thing none of them can answer, which is how
 * any of it changed. Current state is deliberately left where it is rather than
 * recomputed here, so there is never a second answer to the same question.
 *
 * Nothing is recalculated. Health comes from the effective value the project
 * mapping already produced, capacity from the employee rollups, and portfolio
 * figures from the portfolio contract — this module counts what those say and
 * writes it down.
 */

export type ScopeType = 'instance' | 'user' | 'portfolio' | 'team' | 'department';

export interface TrendPoint {
  /** The day, as `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface Trend {
  metric: string;
  scopeType: ScopeType;
  scopeId?: string;
  points: TrendPoint[];
}

export interface SnapshotCoverage {
  /** How many distinct days have ever been captured. */
  days: number;
  firstSnapshot?: string;
  lastSnapshot?: string;
  /** Total rows, across every scope and metric. */
  records: number;
}

export interface SnapshotResult {
  sampledOn: string;
  /** Rows written or overwritten. Rerunning the same day reports the same count. */
  records: number;
  scopes: { instance: number; portfolio: number; team: number; department: number };
}

/** A metric to write, before it is given a date. */
interface Sample {
  scopeType: ScopeType;
  /** The empty string for `instance`, which has no id. See the schema note. */
  scopeId: string;
  metric: string;
  value: number;
}

/**
 * The instance scope has no id. Stored as the empty string rather than null,
 * because Postgres treats NULLs as distinct in a unique index — a nullable
 * scopeId would let every run insert a second copy instead of overwriting.
 */
const INSTANCE = '';

/** Midnight UTC for a `@db.Date` column, so a day is a day everywhere. */
function dayOf(date: Date): Date {
  return new Date(date.toISOString().slice(0, 10));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Everything worth recording about the instance and its org structure, today.
 *
 * Projects are passed in rather than fetched, so this makes no OpenProject
 * request of its own and can only ever measure what the caller could see.
 */
export async function collectSamples(projects: EpmProject[], portfolios: EpmPortfolio[]): Promise<Sample[]> {
  const samples: Sample[] = [];

  const active = projects.filter((project) => project.status !== 'paused');

  samples.push(
    { scopeType: 'instance', scopeId: INSTANCE, metric: 'projects.total', value: projects.length },
    { scopeType: 'instance', scopeId: INSTANCE, metric: 'projects.active', value: active.length },
  );

  // Health of active projects only: an archived project's health is not a
  // statement about how delivery is going.
  const levels: HealthLevel[] = ['healthy', 'warning', 'critical'];
  for (const level of levels) {
    samples.push({
      scopeType: 'instance',
      scopeId: INSTANCE,
      metric: `health.${level}`,
      // The effective value — a pinned dimension counts where it was pinned,
      // exactly as every other surface reports it.
      value: active.filter((project) => project.health.overall === level).length,
    });
  }

  // Org-level figures come from the same rollups the live pages use.
  const { byTeam, byDepartment } = await rollups(new AbortController().signal);

  let mappedPeople = 0;
  let mappedCapacity = 0;
  const counted = new Set<string>();

  const profiles = await prisma.userProfile.findMany({
    where: { OR: [{ teamId: { not: null } }, { departmentId: { not: null } }] },
    select: { openProjectId: true, hoursCapacity: true },
  });
  for (const profile of profiles) {
    if (counted.has(profile.openProjectId)) continue;
    counted.add(profile.openProjectId);
    mappedPeople += 1;
    mappedCapacity += profile.hoursCapacity;
  }

  samples.push(
    { scopeType: 'instance', scopeId: INSTANCE, metric: 'employees.mapped', value: mappedPeople },
    {
      scopeType: 'instance',
      scopeId: INSTANCE,
      // Rounded: float addition leaves 37.5 + 37.5 + 0.1 as 75.10000000000001.
      metric: 'capacity.hours',
      value: Math.round(mappedCapacity * 100) / 100,
    },
  );

  // Teams and departments, including archived ones — archiving is a visibility
  // decision and their people are still there, which is what the live rollups
  // already assume.
  for (const [teamId, rollup] of byTeam) {
    samples.push(
      { scopeType: 'team', scopeId: teamId, metric: 'members', value: rollup.memberCount },
      { scopeType: 'team', scopeId: teamId, metric: 'capacity.hours', value: rollup.capacityHours },
    );
  }
  for (const [departmentId, rollup] of byDepartment) {
    samples.push(
      { scopeType: 'department', scopeId: departmentId, metric: 'members', value: rollup.memberCount },
      {
        scopeType: 'department',
        scopeId: departmentId,
        metric: 'capacity.hours',
        value: rollup.capacityHours,
      },
    );
  }

  // Portfolios reuse their own contract, distinct-people rule included.
  for (const portfolio of portfolios) {
    samples.push(
      { scopeType: 'portfolio', scopeId: portfolio.id, metric: 'projects.total', value: portfolio.projectCount },
      { scopeType: 'portfolio', scopeId: portfolio.id, metric: 'projects.active', value: portfolio.activeProjectCount },
      { scopeType: 'portfolio', scopeId: portfolio.id, metric: 'members', value: portfolio.memberCount },
      { scopeType: 'portfolio', scopeId: portfolio.id, metric: 'capacity.hours', value: portfolio.capacityHours },
    );
    for (const level of levels) {
      samples.push({
        scopeType: 'portfolio',
        scopeId: portfolio.id,
        metric: `health.${level}`,
        value: portfolio.health[level],
      });
    }
  }

  // Workload and allocation are deliberately absent. `value` cannot hold the
  // null that allocation uses for zero capacity, and a daily sample of a weekly
  // running total would sawtooth — climbing through each week and collapsing
  // every Monday. See docs/analytics-design.md.
  return samples;
}

/**
 * Writes today's samples.
 *
 * One transaction, so a partial day never lands, and an upsert per row, so
 * running it twice on the same day overwrites rather than doubling. The count
 * returned is therefore the same on a rerun.
 */
export async function captureSnapshot(
  projects: EpmProject[],
  portfolios: EpmPortfolio[],
  when = new Date(),
): Promise<SnapshotResult> {
  const samples = await collectSamples(projects, portfolios);
  const sampledOn = dayOf(when);

  await prisma.$transaction(
    samples.map((sample) =>
      prisma.metricSnapshot.upsert({
        where: {
          scopeType_scopeId_sampledOn_metric: {
            scopeType: sample.scopeType,
            scopeId: sample.scopeId,
            sampledOn,
            metric: sample.metric,
          },
        },
        create: { ...sample, sampledOn },
        update: { value: sample.value },
      }),
    ),
  );

  const count = (type: ScopeType) => samples.filter((sample) => sample.scopeType === type).length;

  return {
    sampledOn: iso(sampledOn),
    records: samples.length,
    scopes: {
      instance: count('instance'),
      portfolio: count('portfolio'),
      team: count('team'),
      department: count('department'),
    },
  };
}

/** How much history exists, so the UI can tell "none yet" from "a flat line". */
export async function coverage(): Promise<SnapshotCoverage> {
  const [records, first, last, distinct] = await Promise.all([
    prisma.metricSnapshot.count(),
    prisma.metricSnapshot.findFirst({ orderBy: { sampledOn: 'asc' }, select: { sampledOn: true } }),
    prisma.metricSnapshot.findFirst({ orderBy: { sampledOn: 'desc' }, select: { sampledOn: true } }),
    prisma.metricSnapshot.findMany({ distinct: ['sampledOn'], select: { sampledOn: true } }),
  ]);

  return {
    days: distinct.length,
    firstSnapshot: first ? iso(first.sampledOn) : undefined,
    lastSnapshot: last ? iso(last.sampledOn) : undefined,
    records,
  };
}

/**
 * A metric series.
 *
 * Points come back as recorded. A day nobody captured is a gap, not a zero and
 * not an interpolation — inventing a value for it would be exactly the
 * fabrication this feature exists to avoid.
 */
export async function trends(options: {
  metrics: string[];
  scopeType: ScopeType;
  scopeId?: string;
  days: number;
}): Promise<Trend[]> {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - options.days);

  const rows = await prisma.metricSnapshot.findMany({
    where: {
      metric: { in: options.metrics },
      scopeType: options.scopeType,
      scopeId: options.scopeId ?? INSTANCE,
      sampledOn: { gte: dayOf(from) },
    },
    orderBy: { sampledOn: 'asc' },
    select: { metric: true, sampledOn: true, value: true },
  });

  const byMetric = new Map<string, TrendPoint[]>();
  for (const metric of options.metrics) byMetric.set(metric, []);

  for (const row of rows) {
    byMetric.get(row.metric)?.push({ date: iso(row.sampledOn), value: row.value });
  }

  return options.metrics.map((metric) => ({
    metric,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    points: byMetric.get(metric) ?? [],
  }));
}
