import { openProject, linkId } from '../openproject/client.js';
import { referenceCache } from '../lib/cache.js';
import type { OpPriority, OpStatus, OpType } from '../openproject/types.js';
import type { TaskPriority, TaskStatus, TaskType } from '../types/epm.js';

/**
 * Reference-data translation.
 *
 * OpenProject's statuses, types and priorities are instance-configurable; the
 * EPM contract fixes them at 6, 6 and 4. This module owns that collapse.
 *
 * Matching is by name, with a structural fallback (`isClosed`, `isMilestone`,
 * position) so an unrecognised value degrades sensibly instead of throwing.
 * Names are matched case-insensitively and trimmed.
 */

/* -------------------------------------------------------------------------- */
/* Statuses                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_BY_NAME: Record<string, TaskStatus> = {
  // Not started
  'new': 'todo',
  'in specification': 'todo',
  'specified': 'todo',
  'confirmed': 'todo',
  'scheduled': 'todo',
  'to be scheduled': 'backlog',

  // Underway
  'in progress': 'in_progress',
  'in development': 'in_progress',
  'developed': 'in_progress',

  // Awaiting verification
  'in testing': 'review',
  'tested': 'review',
  'in review': 'review',
  'review': 'review',

  // Stalled. "Test failed" needs someone to act before work continues, which
  // is what the board's Blocked column is for.
  'on hold': 'blocked',
  'test failed': 'blocked',
  'blocked': 'blocked',

  // Finished
  'closed': 'done',
  'done': 'done',

  // Closed in OpenProject but NOT delivered. Mapping this to `done` would count
  // abandoned work as completed and inflate every completion and velocity
  // figure in the app, so it is reported as blocked instead.
  'rejected': 'blocked',
};

export interface StatusCatalogEntry {
  id: string;
  name: string;
  isClosed: boolean;
  epm: TaskStatus;
}

export function classifyStatus(status: { name: string; isClosed: boolean }): TaskStatus {
  const mapped = STATUS_BY_NAME[status.name.trim().toLowerCase()];
  if (mapped) return mapped;
  return status.isClosed ? 'done' : 'todo';
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

const TYPE_BY_NAME: Record<string, TaskType> = {
  task: 'task',
  subtask: 'task',
  'user story': 'feature',
  feature: 'feature',
  bug: 'bug',
  defect: 'bug',
  epic: 'epic',
  // A summary task exists to group children, which is what an epic is in the
  // EPM model.
  'summary task': 'epic',
  phase: 'epic',
  milestone: 'milestone',
  support: 'support',
  'service request': 'support',
  incident: 'support',
};

export function classifyType(type: { name: string; isMilestone: boolean }): TaskType {
  if (type.isMilestone) return 'milestone';
  return TYPE_BY_NAME[type.name.trim().toLowerCase()] ?? 'task';
}

/* -------------------------------------------------------------------------- */
/* Priorities                                                                  */
/* -------------------------------------------------------------------------- */

const PRIORITY_BY_NAME: Record<string, TaskPriority> = {
  low: 'low',
  normal: 'medium',
  medium: 'medium',
  high: 'high',
  immediate: 'critical',
  critical: 'critical',
  urgent: 'critical',
};

export function classifyPriority(priority: { name: string }): TaskPriority {
  return PRIORITY_BY_NAME[priority.name.trim().toLowerCase()] ?? 'medium';
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

export interface Catalog {
  statusById: Map<string, StatusCatalogEntry>;
  typeById: Map<string, { id: string; name: string; epm: TaskType }>;
  priorityById: Map<string, { id: string; name: string; epm: TaskPriority }>;
  /** EPM status -> the OpenProject status ids that collapse into it. */
  statusIdsByEpm: Map<TaskStatus, string[]>;
  priorityIdsByEpm: Map<TaskPriority, string[]>;
  typeIdsByEpm: Map<TaskType, string[]>;
}

async function loadCatalog(signal?: AbortSignal): Promise<Catalog> {
  const [statuses, types, priorities] = await Promise.all([
    openProject.getAll<OpStatus>('/statuses', { pageSize: 200 }, { signal }),
    openProject.getAll<OpType>('/types', { pageSize: 200 }, { signal }),
    openProject.getAll<OpPriority>('/priorities', { pageSize: 200 }, { signal }),
  ]);

  const statusById = new Map<string, StatusCatalogEntry>();
  const statusIdsByEpm = new Map<TaskStatus, string[]>();
  for (const status of statuses.items) {
    const epm = classifyStatus(status);
    const id = String(status.id);
    statusById.set(id, { id, name: status.name, isClosed: status.isClosed, epm });
    statusIdsByEpm.set(epm, [...(statusIdsByEpm.get(epm) ?? []), id]);
  }

  const typeById = new Map<string, { id: string; name: string; epm: TaskType }>();
  const typeIdsByEpm = new Map<TaskType, string[]>();
  for (const type of types.items) {
    const epm = classifyType(type);
    const id = String(type.id);
    typeById.set(id, { id, name: type.name, epm });
    typeIdsByEpm.set(epm, [...(typeIdsByEpm.get(epm) ?? []), id]);
  }

  const priorityById = new Map<string, { id: string; name: string; epm: TaskPriority }>();
  const priorityIdsByEpm = new Map<TaskPriority, string[]>();
  for (const priority of priorities.items) {
    const epm = classifyPriority(priority);
    const id = String(priority.id);
    priorityById.set(id, { id, name: priority.name, epm });
    priorityIdsByEpm.set(epm, [...(priorityIdsByEpm.get(epm) ?? []), id]);
  }

  return { statusById, typeById, priorityById, statusIdsByEpm, priorityIdsByEpm, typeIdsByEpm };
}

export function getCatalog(signal?: AbortSignal): Promise<Catalog> {
  return referenceCache.get('catalog', () => loadCatalog(signal));
}
