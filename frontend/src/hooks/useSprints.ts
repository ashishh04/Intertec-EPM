import { useQuery } from '@tanstack/react-query';
import { sprintService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';

export function useSprints() {
  return useQuery({
    queryKey: queryKeys.sprints,
    queryFn: () => sprintService.getSprints(),
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
