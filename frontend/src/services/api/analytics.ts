import { apiClient } from './client';

/**
 * Analytics — history.
 *
 * Two different claims travel separately and are never mixed in one figure:
 * `current` is computed live from EPM and OpenProject, `history` is read from
 * recorded snapshots. A client that shows both must say which is which.
 */

export interface TrendPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface Trend {
  metric: string;
  scopeType: string;
  scopeId?: string;
  /**
   * As recorded. A day nobody captured is a gap, not a zero — points are never
   * interpolated, because a value nobody measured is not a value.
   */
  points: TrendPoint[];
}

export interface AnalyticsOverview {
  /** Computed live. */
  current: {
    projectsTotal: number;
    projectsActive: number;
    health: { healthy: number; warning: number; critical: number };
    portfolios: number;
    capacityHours: number;
  };
  /** How much history exists, so "none yet" reads differently from "flat". */
  history: {
    days: number;
    firstSnapshot?: string;
    lastSnapshot?: string;
    records: number;
  };
}

export interface TrendQuery {
  metrics: string[];
  scopeType?: string;
  scopeId?: string;
  days?: number;
}

export class ApiAnalyticsRepository {
  overview(): Promise<AnalyticsOverview> {
    return apiClient.get<AnalyticsOverview>('/analytics/overview');
  }

  trends(query: TrendQuery): Promise<Trend[]> {
    return apiClient.get<Trend[]>('/analytics/trends', {
      metrics: query.metrics.join(','),
      ...(query.scopeType ? { scopeType: query.scopeType } : {}),
      ...(query.scopeId ? { scopeId: query.scopeId } : {}),
      ...(query.days ? { days: String(query.days) } : {}),
    });
  }

  /** Captures today. Idempotent — running it twice overwrites rather than doubles. */
  captureSnapshot(): Promise<{
    sampledOn: string;
    records: number;
    scopes: { instance: number; portfolio: number; team: number; department: number };
  }> {
    return apiClient.post('/analytics/snapshots');
  }
}
