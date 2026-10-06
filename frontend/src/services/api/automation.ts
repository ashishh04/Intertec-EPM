import { apiClient } from './client';
import type {
  AutomationOptions,
  AutomationRule,
  AutomationRuleInput,
  AutomationStatus,
  EscalationDryRunResult,
  EscalationPolicy,
  EscalationPolicyInput,
  EscalationView,
  ID,
  RuleDryRunResult,
  RuleFiringView,
} from '@/types';

/**
 * Rules and escalation (BRQ-10). EPM-owned, behind `rules:configure`, like the
 * approval chains.
 */
export class ApiAutomationRepository {
  getStatus(): Promise<AutomationStatus> {
    return apiClient.get<AutomationStatus>('/automation/status');
  }

  getOptions(): Promise<AutomationOptions> {
    return apiClient.get<AutomationOptions>('/automation/options');
  }

  /* rules */
  getRules(): Promise<AutomationRule[]> {
    return apiClient.get<AutomationRule[]>('/automation/rules');
  }

  createRule(input: AutomationRuleInput): Promise<AutomationRule> {
    return apiClient.post<AutomationRule>('/automation/rules', input);
  }

  updateRule(id: ID, input: AutomationRuleInput): Promise<AutomationRule> {
    return apiClient.patch<AutomationRule>(`/automation/rules/${id}`, input);
  }

  deleteRule(id: ID): Promise<void> {
    return apiClient.delete<void>(`/automation/rules/${id}`);
  }

  dryRunRule(rule: AutomationRuleInput, windowDays: number): Promise<RuleDryRunResult> {
    return apiClient.post<RuleDryRunResult>('/automation/rules/dry-run', { rule, windowDays });
  }

  getFirings(query: { ruleId?: ID; limit?: number } = {}): Promise<RuleFiringView[]> {
    const params = new URLSearchParams();
    if (query.ruleId) params.set('ruleId', query.ruleId);
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return apiClient.get<RuleFiringView[]>(`/automation/firings${suffix ? `?${suffix}` : ''}`);
  }

  /* escalation */
  getPolicies(): Promise<EscalationPolicy[]> {
    return apiClient.get<EscalationPolicy[]>('/automation/escalation-policies');
  }

  createPolicy(input: EscalationPolicyInput): Promise<EscalationPolicy> {
    return apiClient.post<EscalationPolicy>('/automation/escalation-policies', input);
  }

  updatePolicy(id: ID, input: EscalationPolicyInput): Promise<EscalationPolicy> {
    return apiClient.patch<EscalationPolicy>(`/automation/escalation-policies/${id}`, input);
  }

  deletePolicy(id: ID): Promise<void> {
    return apiClient.delete<void>(`/automation/escalation-policies/${id}`);
  }

  dryRunPolicy(policy: EscalationPolicyInput & { id?: ID }): Promise<EscalationDryRunResult> {
    return apiClient.post<EscalationDryRunResult>('/automation/escalation-policies/dry-run', { policy });
  }

  getEscalations(state: 'open' | 'resolved' | 'all' = 'open'): Promise<EscalationView[]> {
    return apiClient.get<EscalationView[]>(`/automation/escalations?state=${state}`);
  }
}
