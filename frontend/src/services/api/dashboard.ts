import { apiClient } from './client';
import type { DashboardRepository } from '../repositories';
import type { ActivityEntry, CalendarEvent, DashboardMetrics, ID } from '@/types';

export class ApiDashboardRepository implements DashboardRepository {
  getMetrics(): Promise<DashboardMetrics> {
    return apiClient.get<DashboardMetrics>('/dashboard/metrics');
  }

  getActivity(params: { projectId?: ID; limit?: number } = {}): Promise<ActivityEntry[]> {
    return apiClient.get<ActivityEntry[]>('/activity', params);
  }

  getCalendarEvents(params: { from: string; to: string }): Promise<CalendarEvent[]> {
    return apiClient.get<CalendarEvent[]>('/calendar/events', params);
  }
}
