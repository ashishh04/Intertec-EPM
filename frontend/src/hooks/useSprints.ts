import { useQuery } from '@tanstack/react-query';
import { sprintService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { ID } from '@/types';

export function useSprints() {
  return useQuery({
    queryKey: queryKeys.sprints,
    queryFn: () => sprintService.getSprints(),
    staleTime: 120_000,
  });
}

export function useSprint(id?: ID) {
  return useQuery({
    queryKey: queryKeys.sprint(id ?? 'unknown'),
    queryFn: () => sprintService.getSprint(id!),
    enabled: Boolean(id),
    staleTime: 120_000,
  });
}

export function useActiveSprint() {
  return useQuery({
    queryKey: queryKeys.activeSprint,
    queryFn: () => sprintService.getActiveSprint(),
    staleTime: 120_000,
  });
}
