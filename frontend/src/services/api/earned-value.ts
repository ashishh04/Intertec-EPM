import { apiClient } from './client';
import type { EvmBaseline, EvmSettings, EvmSettingsView, ID, WorkPackageEarnedValue } from '@/types';

/**
 * Earned value (BRQ-12: BR-301 to BR-303). The figures themselves are
 * measures, on the Earned value dashboard; here are the earning rules, each
 * project's baselines and one work package's figures.
 */
export class ApiEarnedValueRepository {
  getSettings(): Promise<EvmSettingsView> {
    return apiClient.get<EvmSettingsView>('/earned-value/settings');
  }

  /** Needs `evm:configure`. Saved as a new version and journalled. */
  saveSettings(settings: Pick<EvmSettings, 'defaultMethod' | 'methods' | 'unpricedRate'>): Promise<EvmSettings> {
    return apiClient.put<EvmSettings>('/earned-value/settings', settings);
  }

  listBaselines(projectId: ID): Promise<EvmBaseline[]> {
    return apiClient.get<EvmBaseline[]>(`/projects/${projectId}/baselines`);
  }

  /** Needs `project:edit` in the project. */
  setBaseline(projectId: ID, reason?: string): Promise<EvmBaseline> {
    return apiClient.post<EvmBaseline>(`/projects/${projectId}/baselines`, reason ? { reason } : {});
  }

  getWorkPackage(id: ID): Promise<WorkPackageEarnedValue> {
    return apiClient.get<WorkPackageEarnedValue>(`/work-packages/${id}/earned-value`);
  }
}
