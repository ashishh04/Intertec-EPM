import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/queryKeys';
import { earnedValueService } from '@/services';
import type { EvmSettings, ID } from '@/types';

/**
 * Earned value (BR-301 to BR-303). The dashboard reads the analytics model
 * through the measures; these read and change what it is measured against.
 * A new baseline or new rules change every figure, so they refresh the
 * dashboards too.
 */

export function useEvmSettings(enabled = true) {
  return useQuery({ queryKey: queryKeys.evmSettings(), queryFn: () => earnedValueService.getSettings(), enabled, staleTime: 60_000 });
}

export function useSaveEvmSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: Pick<EvmSettings, 'defaultMethod' | 'methods' | 'unpricedRate'>) => earnedValueService.saveSettings(settings),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.evmSettings() });
      void client.invalidateQueries({ queryKey: ['insights'] });
      void client.invalidateQueries({ queryKey: ['earned-value'] });
    },
  });
}

export function useBaselines(projectId: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.evmBaselines(projectId ?? ''),
    queryFn: () => earnedValueService.listBaselines(projectId!),
    enabled: Boolean(projectId),
  });
}

export function useSetBaseline(projectId: ID) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => earnedValueService.setBaseline(projectId, reason),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.evmBaselines(projectId) });
      void client.invalidateQueries({ queryKey: ['insights'] });
      void client.invalidateQueries({ queryKey: ['earned-value'] });
    },
  });
}

export function useWorkPackageEarnedValue(id: ID | undefined) {
  return useQuery({
    queryKey: queryKeys.workPackageEarnedValue(id ?? ''),
    queryFn: () => earnedValueService.getWorkPackage(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}
