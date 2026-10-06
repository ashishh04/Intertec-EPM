import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { automationService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import type { AutomationRuleInput, EscalationPolicyInput, ID } from '@/types';

/** Everything here is behind `rules:configure`; callers pass whether they hold it. */

export function useAutomationStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.automationStatus(),
    queryFn: () => automationService.getStatus(),
    enabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useAutomationOptions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.automationOptions(),
    queryFn: () => automationService.getOptions(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useAutomationRules(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.automationRules(), queryFn: () => automationService.getRules(), enabled });
}

export function useSaveAutomationRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: ID; input: AutomationRuleInput }) =>
      id ? automationService.updateRule(id, input) : automationService.createRule(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['automation'] }),
  });
}

export function useDeleteAutomationRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => automationService.deleteRule(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.automationRules() }),
  });
}

/** A dry run is a question, not a change: a mutation only because it is asked on demand. */
export function useDryRunRule() {
  return useMutation({
    mutationFn: ({ rule, windowDays }: { rule: AutomationRuleInput; windowDays: number }) =>
      automationService.dryRunRule(rule, windowDays),
  });
}

export function useRuleFirings(enabled: boolean, ruleId?: ID) {
  return useQuery({
    queryKey: queryKeys.automationFirings(ruleId),
    queryFn: () => automationService.getFirings({ ruleId, limit: 100 }),
    enabled,
    staleTime: 10_000,
  });
}

export function useEscalationPolicies(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.escalationPolicies(),
    queryFn: () => automationService.getPolicies(),
    enabled,
  });
}

export function useSaveEscalationPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: ID; input: EscalationPolicyInput }) =>
      id ? automationService.updatePolicy(id, input) : automationService.createPolicy(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['automation'] }),
  });
}

export function useDeleteEscalationPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => automationService.deletePolicy(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.escalationPolicies() }),
  });
}

export function useDryRunPolicy() {
  return useMutation({
    mutationFn: (policy: EscalationPolicyInput & { id?: ID }) => automationService.dryRunPolicy(policy),
  });
}

export function useEscalations(enabled: boolean, state: 'open' | 'resolved' | 'all') {
  return useQuery({
    queryKey: queryKeys.escalations(state),
    queryFn: () => automationService.getEscalations(state),
    enabled,
    staleTime: 15_000,
  });
}
