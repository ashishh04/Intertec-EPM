import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { integrationService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';

export function useIntegrationStatus() {
  return useQuery({
    queryKey: queryKeys.integrationStatus,
    queryFn: () => integrationService.getStatus(),
    staleTime: 30_000,
  });
}

export function useTriggerSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => integrationService.triggerSync(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.integrationStatus }),
  });
}
