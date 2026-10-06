import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectService } from '@/services';
import { apiClient } from '@/services/api/client';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { HealthOverride, ID, ProjectPlanInput } from '@/types';

export function useProjects(params?: { search?: string; status?: string[] }) {
  return useQuery({
    queryKey: queryKeys.projects(params),
    queryFn: () => projectService.getProjects(params),
    staleTime: 60_000,
  });
}

export function useProject(id?: ID) {
  return useQuery({
    queryKey: queryKeys.project(id ?? 'unknown'),
    queryFn: () => projectService.getProject(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

/**
 * Sets who is accountable for a project.
 *
 * EPM's own field, so this invalidates the project reads rather than anything
 * upstream — and the dashboard, which counts projects by owner.
 */
export function useSetProjectOwner() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (vars: { id: ID; ownerId: string }) =>
      apiClient.patch<{ id: ID; ownerId: string }>(`/projects/${vars.id}/owner`, {
        ownerId: vars.ownerId,
      }),
    onSuccess: () => {
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * The projects directly beneath this one.
 *
 * Scoped under the project's own key so it clears with the rest of that
 * project's reads whenever the hierarchy is edited.
 */
export function useProjectChildren(id?: ID) {
  return useQuery({
    queryKey: queryKeys.projectChildren(id ?? 'unknown'),
    queryFn: () => projectService.getChildren(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

/**
 * Moves a project under another, or to the top level.
 *
 * Invalidates every project read rather than the two projects involved: the
 * move changes what sits beneath the old parent as well as the new one, and
 * the grid, dashboard and reports all render the hierarchy.
 */
export function useSetProjectParent() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, parentId }: { id: ID; parentId: string }) =>
      projectService.setParent(id, parentId),
    onSuccess: () => {
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useProjectMilestones(id?: ID) {
  return useQuery({
    queryKey: queryKeys.projectMilestones(id ?? 'unknown'),
    queryFn: () => projectService.getMilestones(id!),
    enabled: Boolean(id),
    staleTime: 120_000,
  });
}


/**
 * Pins health dimensions on a project.
 *
 * Invalidates more than the project itself: effective health feeds the projects
 * grid, the dashboard at-risk count and the reports portfolio matrix, and a pin
 * that showed on one screen but not the others would be worse than none.
 */
export function useSetHealthOverride() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, levels, reason }: { id: ID; levels: HealthOverride; reason?: string }) =>
      projectService.setHealthOverride(id, { levels, reason }),
    onSuccess: (_project, { id }) => {
      void client.invalidateQueries({ queryKey: queryKeys.project(id) });
      // The same set any project write invalidates: effective health feeds the
      // grid, the dashboard at-risk count and the reports matrix, and a pin
      // visible on one screen but not the others is worse than none.
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * Sets a project's planned dates and budget.
 *
 * The answer is already recalculated, so it is written straight into the
 * project's cache: the health card shows what the new plan means the moment
 * the dialog closes, rather than after a refetch.
 */
export function useUpdateProjectPlan() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, plan }: { id: ID; plan: ProjectPlanInput }) => projectService.updatePlan(id, plan),
    onSuccess: (project, { id }) => {
      if (project) client.setQueryData(queryKeys.project(id), project);
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** Recalculates one project's health now. */
export function useRecalculateHealth() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => projectService.recalculateHealth(id),
    onSuccess: (project, id) => {
      if (project) client.setQueryData(queryKeys.project(id), project);
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * What EPM recorded about a project, newest first.
 *
 * Keyed beneath the project, so every project write refreshes it — an
 * override saved in the dialog appears here without anything asking.
 */
export function useProjectJournal(id?: ID, params: { limit?: number; action?: string } = {}) {
  return useQuery({
    queryKey: [...queryKeys.projectJournal(id ?? 'unknown'), params],
    queryFn: () => projectService.getJournal(id!, params),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}
