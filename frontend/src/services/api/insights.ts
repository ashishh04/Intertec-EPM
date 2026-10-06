import { apiClient } from './client';
import type {
  AnalyticsAccessCheck,
  AnalyticsModelStatus,
  AnalyticsRefreshRun,
  AnalyticsRefreshRunPage,
  Dashboard,
  DashboardId,
  MeasureEvaluation,
  MeasureInfo,
  MeasureMembersResult,
  MeasurePeriod,
  MeasureTrend,
  ReconstructionCheck,
  StateAsAt,
  WorkPackageCapture,
  WorkPackageCapturePage,
} from '@/types';

/**
 * The semantic layer, the dashboards built on it, and the analytics model's
 * administration (BRQ-05). Measures and dashboards are open to anyone signed in
 * and scoped to what they can see; the model is behind `analytics:manage`.
 *
 * A scope travels as one string — `instance`, `portfolio:<id>`, `project:<id>`,
 * `department:<id>`, `team:<id>` or `person:<id>` — so a link can carry it.
 */

export interface InsightQuery {
  scope?: string;
  from?: string;
  to?: string;
}

const params = (query: InsightQuery = {}) => ({
  ...(query.scope && query.scope !== 'instance' ? { scope: query.scope } : {}),
  ...(query.from ? { from: query.from } : {}),
  ...(query.to ? { to: query.to } : {}),
});

export class ApiInsightsRepository {
  getMeasures(): Promise<MeasureInfo[]> {
    return apiClient.get<MeasureInfo[]>('/measures');
  }

  getValues(ids: string[], query?: InsightQuery): Promise<MeasureEvaluation> {
    return apiClient.get<MeasureEvaluation>('/measures/values', { ids: ids.join(','), ...params(query) });
  }

  getMembers(id: string, query?: InsightQuery): Promise<MeasureMembersResult> {
    return apiClient.get<MeasureMembersResult>(`/measures/${encodeURIComponent(id)}/members`, params(query));
  }

  getTrend(id: string, query?: InsightQuery & { bucket?: 'week' | 'month' }): Promise<MeasureTrend> {
    return apiClient.get<MeasureTrend>(`/measures/${encodeURIComponent(id)}/trend`, {
      ...params(query),
      ...(query?.bucket ? { bucket: query.bucket } : {}),
    });
  }

  getDashboards(): Promise<{ id: DashboardId; title: string; description: string }[]> {
    return apiClient.get('/dashboards');
  }

  getDashboard(id: DashboardId, query?: InsightQuery): Promise<Dashboard> {
    return apiClient.get<Dashboard>(`/dashboards/${id}`, params(query));
  }

  /** The dashboard as a PDF or an Excel workbook: the same figures, for the same person. */
  exportDashboard(id: DashboardId, format: 'pdf' | 'xlsx', query?: InsightQuery): Promise<Blob> {
    return apiClient.download(`/dashboards/${id}/export`, { format, ...params(query) });
  }

  getStateAsAt(at: string, scope?: string): Promise<StateAsAt> {
    return apiClient.get<StateAsAt>('/analytics/history/state', { at, ...(scope ? { scope } : {}) });
  }

  /* --------------------------------------------------- the model (admin) */

  getModelStatus(): Promise<AnalyticsModelStatus> {
    return apiClient.get<AnalyticsModelStatus>('/analytics/model');
  }

  getRefreshRuns(query: { page: number; pageSize: number; kind?: 'full' | 'incremental' }): Promise<AnalyticsRefreshRunPage> {
    return apiClient.get<AnalyticsRefreshRunPage>('/analytics/model/runs', {
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...(query.kind ? { kind: query.kind } : {}),
    });
  }

  /** Starts a refresh; the run appears in the log when it ends. */
  refresh(kind: 'full' | 'incremental'): Promise<{ accepted: boolean } | AnalyticsRefreshRun> {
    return apiClient.post('/analytics/model/refresh', { kind });
  }

  getCaptures(query: { page: number; pageSize: number }): Promise<WorkPackageCapturePage> {
    return apiClient.get<WorkPackageCapturePage>('/analytics/history/captures', {
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
  }

  capture(): Promise<WorkPackageCapture> {
    return apiClient.post<WorkPackageCapture>('/analytics/history/captures');
  }

  compare(captureId: string): Promise<ReconstructionCheck> {
    return apiClient.get<ReconstructionCheck>(`/analytics/history/captures/${captureId}/compare`);
  }

  getAccess(): Promise<AnalyticsAccessCheck> {
    return apiClient.get<AnalyticsAccessCheck>('/analytics/access');
  }
}

/** A period as the query carries it. */
export function periodQuery(period: MeasurePeriod | undefined): Pick<InsightQuery, 'from' | 'to'> {
  return period ? { from: period.from, to: period.to } : {};
}
