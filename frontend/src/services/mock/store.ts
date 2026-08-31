/**
 * Mutable in-memory store backing the mock repositories.
 *
 * Mutations made through the UI (creating a task, moving a board card, marking
 * a notification read) persist for the lifetime of the page so the prototype
 * behaves like a real application, then reset on reload.
 */

import * as seed from '@/mocks/data';
import type {
  ActivityEntry,
  Milestone,
  NexusDocument,
  NexusNotification,
  NexusProject,
  NexusSprint,
  NexusTask,
  NexusTeam,
  NexusUser,
  TaskComment,
  TeamMemberWorkload,
} from '@/types';

export interface MockStore {
  users: NexusUser[];
  projects: NexusProject[];
  tasks: NexusTask[];
  milestones: Milestone[];
  sprints: NexusSprint[];
  teams: NexusTeam[];
  workloads: TeamMemberWorkload[];
  comments: TaskComment[];
  activity: ActivityEntry[];
  notifications: NexusNotification[];
  documents: NexusDocument[];
}

export const store: MockStore = {
  users: [...seed.users],
  projects: [...seed.projects],
  tasks: [...seed.tasks],
  milestones: [...seed.milestones],
  sprints: [...seed.sprints],
  teams: [...seed.teams],
  workloads: [...seed.workloads],
  comments: [...seed.comments],
  activity: [...seed.activity],
  notifications: [...seed.notifications],
  documents: [...seed.documents],
};

export const CURRENT_USER_ID = seed.DEMO_USER_ID;

/** Simulated backend latency so loading and skeleton states are exercised. */
export function delay<T>(value: T, ms = 220 + Math.random() * 180): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Deep-ish clone so callers cannot mutate the store by reference. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

let idCounter = 9000;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function nextTaskKey(): string {
  const highest = store.tasks.reduce((max, task) => {
    const numeric = Number.parseInt(task.key.split('-')[1] ?? '0', 10);
    return Number.isNaN(numeric) ? max : Math.max(max, numeric);
  }, 0);
  return `OP-${highest + 1}`;
}

/** Records an activity entry for a store mutation, keeping timelines believable. */
export function recordActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
  store.activity.unshift({
    ...entry,
    id: nextId('act'),
    timestamp: new Date().toISOString(),
  });
}

/** Recomputes the derived task counters on a project after a mutation. */
export function refreshProjectCounters(projectId: string): void {
  const project = store.projects.find((item) => item.id === projectId);
  if (!project) return;
  const projectTasks = store.tasks.filter((task) => task.projectId === projectId);
  project.taskCount = projectTasks.length;
  project.completedTaskCount = projectTasks.filter((task) => task.status === 'done').length;
  project.updatedAt = new Date().toISOString();
}
