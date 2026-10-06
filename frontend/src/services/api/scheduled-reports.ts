import { apiClient } from './client';
import type {
  ID,
  ReportRun,
  ReportRunPage,
  ReportSchedule,
  ReportScheduleInput,
  ReportScheduleOptions,
} from '@/types';

/**
 * Scheduled report distribution (BRQ-08). Defining, running and reading the
 * log needs `reports:schedule`; approving outside recipients needs
 * `reports:approve`, from someone other than whoever added them.
 */

export interface ReportRunFilter {
  scheduleId?: ID;
  /** Inclusive calendar days, UTC. */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export class ApiScheduledReportRepository {
  getSchedules(): Promise<ReportSchedule[]> {
    return apiClient.get<ReportSchedule[]>('/reports/schedules');
  }

  getOptions(): Promise<ReportScheduleOptions> {
    return apiClient.get<ReportScheduleOptions>('/reports/schedules/options');
  }

  create(input: ReportScheduleInput): Promise<ReportSchedule> {
    return apiClient.post<ReportSchedule>('/reports/schedules', input);
  }

  update(id: ID, input: ReportScheduleInput): Promise<ReportSchedule> {
    return apiClient.patch<ReportSchedule>(`/reports/schedules/${id}`, input);
  }

  /** A schedule that has run is switched off rather than deleted, to keep its log. */
  remove(id: ID): Promise<{ outcome: 'deleted' | 'deactivated' }> {
    return apiClient.delete(`/reports/schedules/${id}`);
  }

  approve(id: ID): Promise<ReportSchedule> {
    return apiClient.post<ReportSchedule>(`/reports/schedules/${id}/approve`);
  }

  /** Runs it now, outside its timetable; answers with the run. */
  run(id: ID): Promise<ReportRun> {
    return apiClient.request<ReportRun>(`/reports/schedules/${id}/run`, { method: 'POST', timeoutMs: 120_000 });
  }

  getRuns(filter: ReportRunFilter): Promise<ReportRunPage> {
    return apiClient.get<ReportRunPage>('/reports/runs', {
      scheduleId: filter.scheduleId,
      from: filter.from,
      to: filter.to,
      page: filter.page,
      pageSize: filter.pageSize,
    });
  }

  getRun(id: ID): Promise<ReportRun> {
    return apiClient.get<ReportRun>(`/reports/runs/${id}`);
  }

  /** A rendered copy, as it was attached to the email. */
  getFile(runId: ID, artifactId: ID): Promise<Blob> {
    return apiClient.download(`/reports/runs/${runId}/files/${artifactId}`);
  }
}
