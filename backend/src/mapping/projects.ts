import { openProject, linkId, linkTitle, type OpFilter } from '../openproject/client.js';
import { OPEN_FILTER, OVERDUE_DUE_FILTER } from '../domain/work-definitions.js';
import { aggregateCache, userScopedKey } from '../lib/cache.js';
import { optional, prisma } from '../db/prisma.js';
import type { HalCollection, OpProject } from '../openproject/types.js';
import type {
  HealthOverrideRecord,
  ID,
  EpmProject,
  ProjectHealth,
  ProjectHealthDetail,
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
export async function countsByProject(
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

/**
 * Every project the caller can see.
 *
 * One cached read, shared by everything that needs the list — and that is most
 * of the product: the task routes alone walked `/projects` six different ways to
 * turn a project id into an identifier, once per request, and the dashboard and
 * reports each walked it again. On an instance with a few hundred projects that
 * is the single most repeated upstream call in the system, for a list that
 * changes when somebody creates a project and not otherwise.
 *
 * On `aggregateCache` rather than `referenceCache` deliberately: that cache is
 * cleared wholesale after any successful write, which is exactly the moment this
 * list can change. So a newly created project appears on the next read rather
 * than up to a TTL later.
 */
export async function listProjects(signal?: AbortSignal): Promise<OpProject[]> {
  const key = userScopedKey('projects:all');
  const read = () => aggregateCache.get(key, async () => (await openProject.getAll<OpProject>('/projects', { pageSize: 200 }, { signal })).items);
  // A failed read is not cached: an empty list stored for everyone would show
  // "no projects" on every page until it expired. Concurrent callers share the
  // first caller's read, so one cancelled request fails the others too — those
  // still waiting read again on their own.
  try {
    return await read();
  } catch {
    if (signal?.aborted) return [];
    return read().catch(() => []);
  }
}

/** Project id → identifier, for the task key shown throughout the UI. */
export async function projectIdentifiers(signal?: AbortSignal): Promise<Map<string, string>> {
  return new Map((await listProjects(signal)).map((p) => [String(p.id), p.identifier]));
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
    countsByProject([OPEN_FILTER, OVERDUE_DUE_FILTER], signal).catch(() => new Map<string, number>()),
  ]);

  return { total, completed, overdue };
}

export function getProjectAggregates(signal?: AbortSignal): Promise<ProjectAggregates> {
  // Counted from work packages fetched on the caller's token, so the totals
  // already reflect their permissions — the key has to say whose they are.
  return aggregateCache.get(userScopedKey('project-aggregates'), () => loadAggregates(signal));
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
  /** EPM's own owner. Upstream has no project owner field at all. */
  ownerId?: string | null;
  plannedStart?: Date | null;
  plannedFinish?: Date | null;
  billable?: boolean | null;
  timesheetApproval?: boolean | null;
  timezone?: string | null;
}

/**
 * A project's health as the project read needs it.
 *
 * Calculated once per project by `domain/health.ts` and stored; this mapping
 * only presents it. Health used to be computed here, on every read, from
 * whatever the viewer could see — so two people could be shown two different
 * values for the same project, and nothing could be journalled.
 */
export interface ProjectHealthView {
  calculated: ProjectHealth;
  /** `calculated` with the override in force applied. */
  effective: ProjectHealth;
  detail: ProjectHealthDetail;
  override?: HealthOverrideRecord;
  forecastFinish?: string;
  /** Actual cost to date; absent when it could not be read. */
  cost?: { cost: number; uncostedHours: number };
  /** Open work packages of a risk type, any priority. */
  openRisks: number;
}

/**
 * The delivery status shown beside a project, read from its effective health.
 *
 * It used to be worked out from schedule and overdue counts separately, so a
 * project could be red overall and still say "on track". Now it cannot
 * disagree with its own health: red on schedule is delayed, anything not green
 * overall is at risk.
 */
function deriveStatus(input: {
  active: boolean;
  total: number;
  completed: number;
  health: ProjectHealth;
}): ProjectStatus {
  const { active, total, completed, health } = input;
  if (!active) return 'paused';
  if (total > 0 && completed === total) return 'completed';
  if (health.schedule === 'critical') return 'delayed';
  if (health.overall !== 'healthy') return 'at_risk';
  return 'on_track';
}

const isoDay = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : undefined);

export function toEpmProject(
  project: OpProject,
  aggregates: ProjectAggregates,
  options: { memberIds?: ID[]; overlay?: ProjectOverlay; health: ProjectHealthView },
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
  const { health } = options;

  return {
    id,
    identifier: project.identifier,
    name: project.name,
    description: project.description?.raw ?? undefined,
    status: deriveStatus({ active: project.active, total, completed, health: health.effective }),
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    // EPM's, not upstream's: an OpenProject project has no owner attribute and
    // publishes no `responsible` link, so this read as empty for every project
    // and there was no way to set it.
    ownerId: options.overlay?.ownerId ?? '',
    memberIds: options.memberIds ?? [],
    // EPM's own planned dates: upstream projects have none.
    startDate: isoDay(options.overlay?.plannedStart),
    dueDate: isoDay(options.overlay?.plannedFinish),
    forecastFinish: health.forecastFinish,
    // OpenProject has no project-level priority.
    priority: 'medium' as TaskPriority,
    health: health.effective,
    healthCalculated: health.calculated,
    healthOverride: health.override,
    healthDetail: health.detail,
    taskCount: total,
    completedTaskCount: completed,
    // Real risks now: open work packages of a risk type. It used to be the
    // overdue count under another name.
    openRiskCount: health.openRisks,
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
    // Calculated from logged time, never typed in.
    budgetUsed: health.cost?.cost ?? 0,
    uncostedHours: health.cost?.uncostedHours ?? 0,
    budgetTotal: options.overlay?.budgetTotal ?? 0,
    billable: options.overlay?.billable ?? null,
    timesheetApproval: options.overlay?.timesheetApproval ?? null,
    timezone: options.overlay?.timezone ?? null,
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
