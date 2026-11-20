import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sprintService } from '@/services';
import type { CreateSprintInput } from '@/services/repositories';
import { queryKeys } from '@/lib/queryKeys';
import type { ID, SprintSharing } from '@/types';

/** The sprint list's query, for the hook and for fetching it ahead (AppShell). */
export const sprintsQuery = () => ({
  queryKey: queryKeys.sprints,
  queryFn: () => sprintService.getSprints(),
  staleTime: 120_000,
});

export function useSprints() {
  return useQuery(sprintsQuery());
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

/** Changes who may plan work into a sprint. */
export function useSetSprintSharing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sharing }: { id: ID; sharing: SprintSharing }) => sprintService.setSharing(id, sharing),
    onSuccess: async () => {
      await Promise.all(SPRINT_WRITE_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
    },
  });
}

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
