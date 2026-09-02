import { apiClient } from './client';
import type { IntegrationRepository } from '../repositories';
import type { IntegrationStatus } from '@/types';

/**
 * Integration health only. Credentials and tokens are never returned by the
 * backend and must never be rendered by the frontend.
 */
export class ApiIntegrationRepository implements IntegrationRepository {
  getStatus(): Promise<IntegrationStatus> {
    return apiClient.get<IntegrationStatus>('/integrations/status');
  }

  triggerSync(): Promise<IntegrationStatus> {
    return apiClient.post<IntegrationStatus>('/integrations/status/sync');
  }
}
