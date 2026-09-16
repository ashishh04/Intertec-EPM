import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sprintService } from '@/services';
import type { CreateSprintInput } from '@/services/repositories';
import { queryKeys } from '@/lib/queryKeys';
import type { ID } from '@/types';

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

/**
 * Everything that reads a sprint: the list, the active one, and the boards
 * and dashboard tiles that summarise it. Invalidated together after any write
 * so a new or completed sprint is visible everywhere on the next paint.
 */
const SPRINT_WRITE_KEYS = [['sprints'], ['tasks'], ['dashboard'], ['reports']] as const;

export function useCreateSprint() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSprintInput) => sprintService.createSprint(input),
    onSuccess: async () => {
      await Promise.all(SPRINT_WRITE_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
    },
  });
}

export function useSetSprintState() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, state }: { id: ID; state: 'active' | 'completed' }) =>
      sprintService.setSprintState(id, state),
    onSuccess: async () => {
      await Promise.all(SPRINT_WRITE_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
    },
  });
}
