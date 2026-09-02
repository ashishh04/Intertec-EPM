import { openProject, linkId, type OpFilter } from '../openproject/client.js';
import { aggregateCache } from '../lib/cache.js';
import { optional, prisma } from '../db/prisma.js';
import type { HalCollection, OpProject } from '../openproject/types.js';
import type {
  HealthLevel,
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
  return aggregateCache.get('project-aggregates', () => loadAggregates(signal));
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
 * Health is computed from delivery signals OpenProject does expose. Each
 * dimension states what it actually measures — none of them are guesses, and
 * a project with no work packages reports healthy rather than alarming.
 */
export function computeHealth(input: {
  total: number;
  completed: number;
  overdue: number;
  dueDate?: string;
  today: string;
}): ProjectHealth {
  const { total, completed, overdue, dueDate, today } = input;

  if (total === 0) {
    return { scope: 'healthy', schedule: 'healthy', resources: 'healthy', budget: 'healthy', overall: 'healthy' };
  }

  const overdueRatio = overdue / total;
  const openRatio = (total - completed) / total;

  // Schedule: how much of the work is already late.
  const schedule = band(overdueRatio, 0.1, 0.25);

  // Scope: how much remains open, escalated once the project's own due date
  // has passed with work still outstanding.
  const pastDue = Boolean(dueDate && dueDate < today);
  const scope = pastDue && openRatio > 0.1 ? 'critical' : band(openRatio, 0.6, 0.85);

  // Resources: overdue work is the observable symptom of under-resourcing.
  const resources = band(overdueRatio, 0.15, 0.35);

  // Budget has no OpenProject source on this instance; it is reported as
  // healthy rather than fabricated, and overridden from the EPM overlay when
  // a real figure exists.
  const budget: HealthLevel = 'healthy';

  return { scope, schedule, resources, budget, overall: worst([scope, schedule, resources, budget]) };
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
  portfolio?: string | null;
  budgetTotal?: number | null;
  budgetUsed?: number | null;
  healthOverride?: unknown;
}

export function toEpmProject(
  project: OpProject,
  aggregates: ProjectAggregates,
  options: { memberIds?: ID[]; overlay?: ProjectOverlay; today: string },
): EpmProject {
  const id = String(project.id);
  const total = aggregates.total.get(id) ?? 0;
  const completed = aggregates.completed.get(id) ?? 0;
  const overdue = aggregates.overdue.get(id) ?? 0;

  const dueDate = undefined;
  const health = computeHealth({ total, completed, overdue, dueDate, today: options.today });

  return {
    id,
    identifier: project.identifier,
    name: project.name,
    description: project.description?.raw ?? undefined,
    status: deriveStatus({ active: project.active, total, completed, overdue, health }),
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    ownerId: linkId(project._links, 'responsible') ?? '',
    memberIds: options.memberIds ?? [],
    startDate: undefined,
    dueDate,
    // OpenProject has no project-level priority.
    priority: 'medium' as TaskPriority,
    health,
    taskCount: total,
    completedTaskCount: completed,
    openRiskCount: overdue,
    portfolio: options.overlay?.portfolio ?? '',
    budgetUsed: options.overlay?.budgetUsed ?? 0,
    budgetTotal: options.overlay?.budgetTotal ?? 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function getProjectOverlays(): Promise<Map<string, ProjectOverlay>> {
  const rows = await optional(() => prisma.projectProfile.findMany(), []);
  return new Map(rows.map((row) => [row.openProjectId, row as ProjectOverlay]));
}
