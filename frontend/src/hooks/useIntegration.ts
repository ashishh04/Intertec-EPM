import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { integrationService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';

export function useIntegrationStatus(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.integrationStatus,
    queryFn: () => integrationService.getStatus(),
    staleTime: 30_000,
    // The probe reaches upstream, so a caller that only wants it while a dialog
    // is open — and only for someone permitted to read it — can say so.
    enabled: options.enabled ?? true,
  });
}

export function useTriggerSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => integrationService.triggerSync(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.integrationStatus }),
  });
}
