import { apiClient } from './client';
import type { AuditEvent, HealthLevel, HealthRuleOptions, HealthRules, ID, ProjectHealth } from '@/types';

/** What the rules editor sends: the rules without their version bookkeeping. */
export type HealthRulesInput = Omit<HealthRules, 'version' | 'updatedAt' | 'updatedBy'>;

export interface HealthRulesPreview {
  projects: {
    projectId: ID;
    projectName: string;
    current: ProjectHealth;
    preview: ProjectHealth;
    explanation: string;
    changed: boolean;
    stored: HealthLevel | null;
  }[];
  changed: number;
  note?: string;
}

/**
 * The health rules (BR-204). EPM-owned policy, so outside the OpenProject-
 * backed repository contract, like teams and departments.
 */
export class ApiHealthRepository {
  getRules(): Promise<HealthRules> {
    return apiClient.get<HealthRules>('/health/rules');
  }

  getOptions(): Promise<HealthRuleOptions> {
    return apiClient.get<HealthRuleOptions>('/health/rules/options');
  }

  /** Saves the rules as the next version; every project is then recalculated. */
  saveRules(rules: HealthRulesInput): Promise<HealthRules> {
    return apiClient.put<HealthRules>('/health/rules', rules);
  }

  /** What the rules would do, without saving them. */
  previewRules(rules: HealthRulesInput): Promise<HealthRulesPreview> {
    return apiClient.post<HealthRulesPreview>('/health/rules/preview', rules);
  }

  /** Every saved version, newest first, as journal entries. */
  getHistory(): Promise<AuditEvent[]> {
    return apiClient.get<AuditEvent[]>('/health/rules/history');
  }
}
