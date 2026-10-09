import { linkId, linkTitle } from '../openproject/client.js';
import { durationToHours } from '../lib/duration.js';
import { classifyPriority, classifyType, type Catalog } from './catalog.js';
import type { OpWorkPackage } from '../openproject/types.js';
import type {
  EpmTask,
  TaskPriority,
  TaskStatusCategory,
  TaskType,
} from '../types/epm.js';

/** Work packages → EpmTask. */

/** Backlogs adds `storyPoints`; it is absent when the plugin is not installed. */
export interface WorkPackageWithPoints extends OpWorkPackage {
  storyPoints?: number | null;
}

export function toEpmTask(
  workPackage: WorkPackageWithPoints,
  catalog: Catalog,
  projectIdentifierById: Map<string, string>,
): EpmTask {
  const links = workPackage._links;

  const statusId = linkId(links, 'status');
  const statusEntry = statusId ? catalog.statusById.get(statusId) : undefined;

  const typeId = linkId(links, 'type');
  const typeEntry = typeId ? catalog.typeById.get(typeId) : undefined;

  const priorityId = linkId(links, 'priority');
  const priorityEntry = priorityId ? catalog.priorityById.get(priorityId) : undefined;

  const projectId = linkId(links, 'project') ?? '';
  const identifier = projectIdentifierById.get(projectId);

  // The upstream status is carried as-is; the category is EPM's grouping of it.
  // A status the catalogue does not know still reports its real name and id —
  // only the category falls back, so an unmapped status is never hidden.
  const status = {
    id: statusId ?? '',
    name: statusEntry?.name ?? linkTitle(links, 'status') ?? 'Unknown',
    isClosed: statusEntry?.isClosed ?? false,
  };
  const statusCategory: TaskStatusCategory = statusEntry?.epm ?? 'todo';
  const typeRef = {
    id: typeId ?? '',
    name: typeEntry?.name ?? linkTitle(links, 'type') ?? 'Unknown',
  };
  const type: TaskType = typeEntry?.epm ?? 'task';

  // Same treatment as status: the upstream priority is carried as-is, and the
  // category is EPM's grouping of it. Without this the UI renamed real values —
  // an instance's "Normal" was shown as "Medium" and "Immediate" as "Critical",
  // and a priority the instance added was not offered at all.
  const priorityRef = {
    id: priorityId ?? '',
    name: priorityEntry?.name ?? linkTitle(links, 'priority') ?? 'Unknown',
  };
  const priority: TaskPriority = priorityEntry?.epm ?? 'medium';

  // Milestones carry a single `date`; everything else has start/due.
  const startDate = workPackage.startDate ?? workPackage.date ?? undefined;
  const dueDate = workPackage.dueDate ?? workPackage.date ?? undefined;

  const version = linkId(links, 'version');

  return {
    id: String(workPackage.id),
    // The UI shows a short key throughout. OpenProject has no such concept, so
    // it is composed from the project identifier and the work package id.
    key: identifier ? `${identifier.slice(0, 6).toUpperCase()}-${workPackage.id}` : `WP-${workPackage.id}`,
    subject: workPackage.subject,
    description: workPackage.description?.raw ?? undefined,
    type,
    status,
    statusCategory,
    typeRef,
    priorityRef,
    priority,
    projectId,
    assigneeId: linkId(links, 'assignee'),
    authorId: linkId(links, 'author') ?? '',
    parentId: linkId(links, 'parent'),
    sprintId: version,
    version: links?.version && !Array.isArray(links.version) ? links.version.title : undefined,
    startDate,
    dueDate,
    estimatedHours: durationToHours(workPackage.estimatedTime),
    spentHours: durationToHours(workPackage.spentTime),
    storyPoints: typeof workPackage.storyPoints === 'number' ? workPackage.storyPoints : undefined,
    labels: [],
    progress: workPackage.percentageDone ?? 0,
    watcherIds: [],
    createdAt: workPackage.createdAt,
    updatedAt: workPackage.updatedAt,
    ...withCustomValues(workPackage as unknown as Record<string, unknown>),
  };
}

/**
 * Custom field values, as a view shows them: numbers and yes/no as they are,
 * formatted text as its source, and a list option, person or version by name.
 * Upstream carries the first kinds as properties and the last as links.
 */
function withCustomValues(workPackage: Record<string, unknown>): { customValues?: Record<string, number | boolean | string> } {
  const values: Record<string, number | boolean | string> = {};
  for (const [field, value] of Object.entries(workPackage)) {
    if (!/^customField\d+$/.test(field) || value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') values[field] = value;
    else if (typeof value === 'object' && 'raw' in value) values[field] = String((value as { raw?: unknown }).raw ?? '');
  }
  const links = (workPackage._links ?? {}) as Record<string, { title?: string } | { title?: string }[] | undefined>;
  for (const [field, link] of Object.entries(links)) {
    if (!/^customField\d+$/.test(field) || !link) continue;
    const titles = (Array.isArray(link) ? link : [link]).map((entry) => entry.title ?? '').filter(Boolean);
    if (titles.length > 0) values[field] = titles.join(', ');
  }
  return Object.keys(values).length > 0 ? { customValues: values } : {};
}

/** Maps EPM filter values onto the OpenProject status/type/priority ids. */
export function expandIds<T extends string>(
  values: T[] | undefined,
  lookup: Map<T, string[]>,
): string[] | undefined {
  if (!values?.length) return undefined;
  const ids = values.flatMap((value) => lookup.get(value) ?? []);
  return ids.length ? ids : undefined;
}

export function isOverdue(task: EpmTask, today: string): boolean {
  // Overdue is a question about progress, so it reads the category rather
  // than the workflow status — 'done' is EPM's notion of complete.
  return Boolean(task.dueDate && task.dueDate < today && task.statusCategory !== 'done');
}
