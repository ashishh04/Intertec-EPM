import type { EpmSprint, ID, SprintState } from '@/types';

/**
 * Which sprint a page opens on, and in what order a picker lists them — one
 * rule for the Agile page and a project's Sprint tab, so the two agree.
 */

const RANK: Record<SprintState, number> = { active: 0, planned: 1, completed: 2 };

/** Running first, then planned, then finished; the newest first within each. */
export function orderSprints(sprints: readonly EpmSprint[]): EpmSprint[] {
  return [...sprints].sort(
    (a, b) => RANK[a.state] - RANK[b.state] || b.startDate.localeCompare(a.startDate) || b.endDate.localeCompare(a.endDate),
  );
}

/**
 * The sprint to show when none is asked for: the one running that started
 * last (where sprints overlap, the newest is the current one); else the next
 * to start; else the one that finished last; else whatever there is.
 */
export function defaultSprint(sprints: readonly EpmSprint[]): EpmSprint | undefined {
  const running = sprints.filter((sprint) => sprint.state === 'active');
  if (running.length > 0) return [...running].sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  // A planned sprint with no dates is a backlog: it comes after any that is dated.
  const planned = sprints.filter((sprint) => sprint.state === 'planned');
  const dated = planned.filter((sprint) => !isBacklog(sprint));
  if (dated.length > 0) return [...dated].sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  const finished = sprints.filter((sprint) => sprint.state === 'completed');
  if (finished.length > 0) return [...finished].sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
  return planned[0] ?? sprints[0];
}

/**
 * A project's sprints: the ones it defines, and any shared into it that holds
 * its work. Not every sprint shared with every project — a sprint of another
 * project's, shared across the instance, is not this project's until its work
 * is in it.
 */
export function sprintsOfProject(sprints: readonly EpmSprint[], projectId: ID | undefined): EpmSprint[] {
  if (!projectId) return [];
  return sprints.filter(
    (sprint) => sprint.projectIds.includes(projectId) || (sprint.workProjectIds ?? []).includes(projectId),
  );
}

/**
 * Whether a sprint is an undated backlog. The server gives an undated version
 * today's date for both ends, and a dated sprint starting today is running,
 * not planned — so "planned, one day long, not in the future" is a backlog.
 */
function isBacklog(sprint: EpmSprint): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return sprint.state === 'planned' && sprint.startDate === sprint.endDate && sprint.startDate <= today;
}
