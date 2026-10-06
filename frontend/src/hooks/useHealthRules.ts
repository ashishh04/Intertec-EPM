import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { healthService } from '@/services';
import type { HealthRulesInput } from '@/services/api/health';
import { invalidationGroups, queryKeys } from '@/lib/queryKeys';

/** The health rules in force. Readable by anyone signed in. */
export function useHealthRules() {
  return useQuery({
    queryKey: queryKeys.healthRules(),
    queryFn: () => healthService.getRules(),
    staleTime: 60_000,
  });
}

/** The instance's types and priorities, for the risk selection. Configurers only. */
export function useHealthRuleOptions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.healthRuleOptions(),
    queryFn: () => healthService.getOptions(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useHealthRuleHistory() {
  return useQuery({
    queryKey: queryKeys.healthRuleHistory(),
    queryFn: () => healthService.getHistory(),
    staleTime: 30_000,
  });
}

/** What the draft rules would do, without saving them. */
export function usePreviewHealthRules() {
  return useMutation({
    mutationFn: (rules: HealthRulesInput) => healthService.previewRules(rules),
  });
}

/**
 * Saves the rules as the next version.
 *
 * Every project is recalculated after a save, so everything that shows health
 * is refreshed too — not only the rules themselves.
 */
export function useSaveHealthRules() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (rules: HealthRulesInput) => healthService.saveRules(rules),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.healthRules(), saved);
      void client.invalidateQueries({ queryKey: queryKeys.healthRuleHistory() });
      for (const key of invalidationGroups.projectWrite) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}
