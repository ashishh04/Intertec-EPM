import { apiClient } from './client';
import type { ID, Paginated, StatusReport, StatusReportInput } from '@/types';

/** Status reports on projects and portfolios, written by their managers. */
export class ApiStatusReportRepository {
  list(scopeKind: 'project' | 'portfolio', scopeId: ID, page = 1, pageSize = 10): Promise<Paginated<StatusReport>> {
    return apiClient.get<Paginated<StatusReport>>('/status-reports', { scopeKind, scopeId, page, pageSize });
  }

  create(input: StatusReportInput): Promise<StatusReport> {
    return apiClient.post<StatusReport>('/status-reports', input);
  }

  update(id: ID, input: Partial<Omit<StatusReportInput, 'scopeKind' | 'scopeId'>>): Promise<StatusReport> {
    return apiClient.patch<StatusReport>(`/status-reports/${id}`, input);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/status-reports/${id}`);
  }
}

export const statusReportService = new ApiStatusReportRepository();
