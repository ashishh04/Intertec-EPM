import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectService } from '@/services';
import { apiClient } from '@/services/api/client';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';
import type { HealthOverride, ID } from '@/types';

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
    mutationFn: ({ id, override }: { id: ID; override: HealthOverride }) =>
      projectService.setHealthOverride(id, override),
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
