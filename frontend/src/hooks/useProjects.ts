import { useQuery } from '@tanstack/react-query';
import { projectService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID } from '@/types';

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

export function useProjectMilestones(id?: ID) {
  return useQuery({
    queryKey: queryKeys.projectMilestones(id ?? 'unknown'),
    queryFn: () => projectService.getMilestones(id!),
    enabled: Boolean(id),
    staleTime: 120_000,
  });
}

