import { apiClient } from './client';
import type { ReportRepository } from '../repositories';
import type {
  DeliveryTrendPoint,
  ExecutiveInsights,
  ReportFilters,
  StatusDistribution,
  TimeEntrySummary,
} from '@/types';

/** Reporting aggregates are computed server-side, never in the browser. */
export class ApiReportRepository implements ReportRepository {
  private params(filters: ReportFilters = {}) {
    return {
      from: filters.from,
      to: filters.to,
      projectId: filters.projectId,
      teamId: filters.teamId,
      status: filters.status,
    };
  }

  getDeliveryTrends(filters?: ReportFilters): Promise<DeliveryTrendPoint[]> {
    return apiClient.get<DeliveryTrendPoint[]>('/reports/delivery-trends', this.params(filters));
  }

  getStatusDistribution(filters?: ReportFilters): Promise<StatusDistribution[]> {
    return apiClient.get<StatusDistribution[]>('/reports/status-distribution', this.params(filters));
  }

  getExecutiveInsights(filters?: ReportFilters): Promise<ExecutiveInsights> {
    return apiClient.get<ExecutiveInsights>('/reports/executive-insights', this.params(filters));
  }

  getTimeSummary(filters?: ReportFilters): Promise<TimeEntrySummary[]> {
    return apiClient.get<TimeEntrySummary[]>('/reports/time-summary', this.params(filters));
  }
}
