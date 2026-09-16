import { openProject, linkId, linkTitle, type OpFilter } from '../openproject/client.js';
import { aggregateCache, userScopedKey } from '../lib/cache.js';
import { optional, prisma } from '../db/prisma.js';
import type { HalCollection, OpProject } from '../openproject/types.js';
import type {
  HealthDimension,
  HealthLevel,
  HealthOverride,
  ID,
  EpmProject,
  ProjectHealth,
  ProjectStatus,
  TaskPriority,
} from '../types/epm.js';

/**
 * Projects → EpmProject.
 *
 * The contract asks for per-project task counts, progress, health and risk.
 * OpenProject stores none of those, but it can group work packages server-side,
 * so all of them are derived from three grouped queries rather than one query
 * per project.
 */

interface GroupedCount {
  count: number;
  _links?: { valueLink?: { href: string }[] };
  value?: string | null;
}

interface GroupedCollection extends HalCollection<unknown> {
  groups?: GroupedCount[];
}

/** One request returns the counts for every project at once. */
async function countsByProject(
  filters: OpFilter[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const collection = await openProject.getCollection<unknown>(
    '/work_packages',
    { filters, groupBy: 'project', pageSize: 1 },
    signal,
  );

  const counts = new Map<string, number>();
  for (const group of (collection as GroupedCollection).groups ?? []) {
    const href = group._links?.valueLink?.[0]?.href;
    const id = href?.split('/').pop();
    if (id) counts.set(id, group.count);
  }
  return counts;
}

export interface ProjectAggregates {
  total: Map<string, number>;
  completed: Map<string, number>;
  overdue: Map<string, number>;
}

async function loadAggregates(signal?: AbortSignal): Promise<ProjectAggregates> {
  const [total, completed, overdue] = await Promise.all([
    // `filters: []` is required — omitting it makes OpenProject count only open
    // work packages, which silently excludes everything closed.
    countsByProject([], signal),
    countsByProject([{ field: 'status', operator: 'c', values: [] }], signal),
    countsByProject(
      [
        { field: 'status', operator: 'o', values: [] },
        { field: 'dueDate', operator: '<t-', values: ['0'] },
      ],
      signal,
    ).catch(() => new Map<string, number>()),
  ]);

  return { total, completed, overdue };
}

export function getProjectAggregates(signal?: AbortSignal): Promise<ProjectAggregates> {
  // Counted from work packages fetched on the caller's token, so the totals
  // already reflect their permissions — the key has to say whose they are.
  return aggregateCache.get(userScopedKey('project-aggregates'), () => loadAggregates(signal));
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

function worst(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'healthy';
}

function band(ratio: number, warning: number, critical: number): HealthLevel {
  if (ratio >= critical) return 'critical';
  if (ratio >= warning) return 'warning';
  return 'healthy';
}

/**
 * Where each dimension turns.
 *
 * Named rather than inline so every rule can be read and quoted. They live here
 * rather than in configuration because nothing has asked to tune them yet, and
 * five constants do not justify a settings subsystem — when that changes, they
 * are already in one place.
 */
export const HEALTH_THRESHOLDS = {
  /** Share of work packages already overdue. */
  scheduleWarning: 0.1,
  scheduleCritical: 0.25,
  /** Share of work packages still open. */
  scopeWarning: 0.6,
  scopeCritical: 0.85,
  /** Open work still outstanding once the due date has passed. */
  scopePastDue: 0.1,
  /** Overdue work read as a symptom of under-resourcing. */
  resourcesWarning: 0.15,
  resourcesCritical: 0.35,
} as const;

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * Health is computed from delivery signals OpenProject does expose. Each
 * dimension states what it actually measures — none of them are guesses, and
 * a project with no work packages reports healthy rather than alarming.
 */
export interface HealthComputation {
  health: ProjectHealth;
  /** One plain sentence per dimension, naming the figures it came from. */
  reasons: Record<HealthDimension, string>;
}

export function computeHealth(input: {
  total: number;
  completed: number;
  overdue: number;
  dueDate?: string;
  today: string;
}): HealthComputation {
  const { total, completed, overdue, dueDate, today } = input;
  const t = HEALTH_THRESHOLDS;

  // No work packages means nothing to judge. Reported healthy rather than
  // alarming about an empty project, and said so in the reason, so it does not
  // read as a clean bill of health.
  if (total === 0) {
    const nothing = 'This project has no work packages, so there is nothing to measure.';
    return {
      health: {
        scope: 'healthy',
        schedule: 'healthy',
        resources: 'healthy',
        budget: 'healthy',
        overall: 'healthy',
      },
      reasons: {
        scope: nothing,
        schedule: nothing,
        resources: nothing,
        budget: nothing,
        overall: nothing,
      },
    };
  }

  // Both denominators are `total`, which is non-zero here, so neither ratio can
  // divide by zero or produce NaN.
  const overdueRatio = overdue / total;
  const openRatio = (total - completed) / total;
  const open = total - completed;

  // Schedule: how much of the work is already late.
  const schedule = band(overdueRatio, t.scheduleWarning, t.scheduleCritical);

  // Scope: how much remains open, escalated once the due date has passed with
  // work still outstanding.
  const pastDue = Boolean(dueDate && dueDate < today);
  const scope =
    pastDue && openRatio > t.scopePastDue
      ? 'critical'
      : band(openRatio, t.scopeWarning, t.scopeCritical);

  // Resources: overdue work is the observable symptom of under-resourcing.
  // Capacity is deliberately not an input — it is measured in hours and the
  // demand signal here is a count of work packages, so relating the two would
  // need an invented hours-per-task constant.
  const resources = band(overdueRatio, t.resourcesWarning, t.resourcesCritical);

  // Budget has no OpenProject source on this instance; it is reported as
  // healthy rather than fabricated, and is the clearest candidate for an
  // override until a real figure exists.
  const budget: HealthLevel = 'healthy';

  const health = {
    scope,
    schedule,
    resources,
    budget,
    overall: worst([scope, schedule, resources, budget]),
  };

  return {
    health,
    reasons: {
      schedule: `${overdue} of ${total} work packages are overdue (${percent(overdueRatio)}).`,
      scope: pastDue
        ? `The due date has passed with ${open} of ${total} work packages still open (${percent(openRatio)}).`
        : `${open} of ${total} work packages are still open (${percent(openRatio)}).`,
      resources: `${overdue} of ${total} work packages are overdue (${percent(overdueRatio)}), read as a resourcing signal.`,
      budget: 'No budget figures are recorded for this project, so budget is not assessed.',
      overall: `The worst of the four dimensions, which is ${health.overall}.`,
    },
  };
}

/**
 * Applies an override to a calculated result.
 *
 * A pinned dimension replaces the calculated one, and `overall` is then
 * recomputed from the effective values rather than the calculated ones —
 * pinning `schedule` to healthy is meant to move the headline. `overall` can
 * itself be pinned, which takes precedence over that recomputation.
 */
export function effectiveHealth(
  calculated: ProjectHealth,
  override: HealthOverride | undefined,
): ProjectHealth {
  if (!override || Object.keys(override).length === 0) return calculated;

  const scope = override.scope ?? calculated.scope;
  const schedule = override.schedule ?? calculated.schedule;
  const resources = override.resources ?? calculated.resources;
  const budget = override.budget ?? calculated.budget;

  return {
    scope,
    schedule,
    resources,
    budget,
    overall: override.overall ?? worst([scope, schedule, resources, budget]),
  };
}

export const HEALTH_DIMENSIONS: HealthDimension[] = [
  'scope',
  'schedule',
  'resources',
  'budget',
  'overall',
];
export const HEALTH_LEVELS: HealthLevel[] = ['healthy', 'warning', 'critical'];

/**
 * Reads an override out of the overlay JSON column.
 *
 * The column is `Json?`, so its contents are whatever was last written and are
 * validated rather than trusted. An unknown key or level is dropped instead of
 * failing the read — a bad row must not take a project page down — and the
 * write path rejects both, so nothing valid ever arrives here malformed.
 */
export function parseHealthOverride(value: unknown): HealthOverride | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const parsed: HealthOverride = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (!HEALTH_DIMENSIONS.includes(key as HealthDimension)) continue;
    if (!HEALTH_LEVELS.includes(level as HealthLevel)) continue;
    parsed[key as HealthDimension] = level as HealthLevel;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function deriveStatus(input: {
  active: boolean;
  total: number;
  completed: number;
  overdue: number;
  health: ProjectHealth;
}): ProjectStatus {
  const { active, total, completed, overdue, health } = input;
  if (!active) return 'paused';
  if (total > 0 && completed === total) return 'completed';
  if (health.schedule === 'critical') return 'delayed';
  if (overdue > 0 || health.overall === 'warning') return 'at_risk';
  return 'on_track';
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

export interface ProjectOverlay {
  /** Legacy free text, used only when a project has no linked portfolio. */
  portfolio?: string | null;
  portfolioId?: string | null;
  /** The linked portfolio, whose name supersedes the free text above. */
  portfolioRef?: { name: string } | null;
  budgetTotal?: number | null;
  budgetUsed?: number | null;
  healthOverride?: unknown;
  /** EPM's own owner. Upstream has no project owner field at all. */
  ownerId?: string | null;
}

export function toEpmProject(
  project: OpProject,
  aggregates: ProjectAggregates,
  options: { memberIds?: ID[]; overlay?: ProjectOverlay; today: string },
): EpmProject {
  const id = String(project.id);
  // Archiving is a PATCH, so it rides on the update affordance; deletion has
  // its own and is absent unless the caller may actually perform it.
  const links = project._links;
  const can = {
    archive: Boolean(links && Object.hasOwn(links, 'updateImmediately')),
    remove: Boolean(links && Object.hasOwn(links, 'delete')),
  };
  const total = aggregates.total.get(id) ?? 0;
  const completed = aggregates.completed.get(id) ?? 0;
  const overdue = aggregates.overdue.get(id) ?? 0;

  const dueDate = undefined;
  const { health: calculated, reasons } = computeHealth({
    total,
    completed,
    overdue,
    dueDate,
    today: options.today,
  });

  const override = parseHealthOverride(options.overlay?.healthOverride);
  // Effective health: what the rules said, with any pinned dimension replaced.
  const health = effectiveHealth(calculated, override);

  return {
    id,
    identifier: project.identifier,
    name: project.name,
    description: project.description?.raw ?? undefined,
    status: deriveStatus({ active: project.active, total, completed, overdue, health }),
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    // EPM's, not upstream's: an OpenProject project has no owner attribute and
    // publishes no `responsible` link, so this read as empty for every project
    // and there was no way to set it.
    ownerId: options.overlay?.ownerId ?? '',
    memberIds: options.memberIds ?? [],
    startDate: undefined,
    dueDate,
    // OpenProject has no project-level priority.
    priority: 'medium' as TaskPriority,
    health,
    healthCalculated: calculated,
    healthOverride: override,
    healthReasons: reasons,
    taskCount: total,
    completedTaskCount: completed,
    openRiskCount: overdue,
    // The link is authoritative. The free-text column is a fallback for a
    // deployment that populated it before portfolios existed; this one never
    // did. Neither is invented — an unassigned project reports nothing.
    portfolio: options.overlay?.portfolioRef?.name ?? options.overlay?.portfolio ?? '',
    portfolioId: options.overlay?.portfolioId ?? undefined,
    // Upstream's hierarchy, read from the resource's own link rather than
    // stored here. A project whose parent the caller cannot see reports no
    // parent at all: OpenProject omits the href, and inventing one would name
    // a project they are not allowed to know about.
    parentId: linkId(links, 'parent'),
    parentName: linkTitle(links, 'parent'),
    can,
    budgetUsed: options.overlay?.budgetUsed ?? 0,
    budgetTotal: options.overlay?.budgetTotal ?? 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function getProjectOverlays(): Promise<Map<string, ProjectOverlay>> {
  const rows = await optional(
    () =>
      prisma.projectProfile.findMany({
        include: { portfolioRef: { select: { name: true } } },
      }),
    [],
  );
  return new Map(rows.map((row) => [row.openProjectId, row as ProjectOverlay]));
}

/**
 * Every project's health override, by project id.
 *
 * Loaded in one query so the dashboard and reports honour the same pins the
 * project pages do — otherwise the dashboard would count a project as at risk
 * while its own page showed it pinned healthy. `optional` because a missing
 * overlay database costs the pins, not the page.
 */
export async function loadHealthOverrides(): Promise<Map<string, HealthOverride>> {
  const rows = await optional(
    () => prisma.projectProfile.findMany({ select: { openProjectId: true, healthOverride: true } }),
    [] as { openProjectId: string; healthOverride: unknown }[],
  );

  const overrides = new Map<string, HealthOverride>();
  for (const row of rows) {
    const parsed = parseHealthOverride(row.healthOverride);
    if (parsed) overrides.set(row.openProjectId, parsed);
  }

  return overrides;
}
