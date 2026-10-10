import { apiClient } from './client';
import type { ID, TimeSettings, TimesheetOverview, TimesheetSummary, TimesheetView } from '@/types';

/**
 * Timesheets and the time rules (Module 10: BR-304 to BR-306, BR-317).
 *
 * Everyone reads their own timesheet and submits it; a team lead or department
 * manager reads their people's; `timesheets:manage` reads everyone's and
 * reopens approved ones; `time:configure` changes the rules. The backend says
 * no to anything else.
 */

export interface TimeSettingsView {
  settings: TimeSettings;
  /** Each policy's name, in the reader's language. */
  policyNames: Record<keyof TimeSettings['policies'], string>;
}

export interface TimesheetOverviewQuery {
  day?: string;
  status?: 'submitted' | 'approved' | 'rejected' | 'outstanding';
  teamId?: ID;
  departmentId?: ID;
  projectId?: ID;
}

export class ApiTimesheetRepository {
  getSettings(): Promise<TimeSettingsView> {
    return apiClient.get<TimeSettingsView>('/time/settings');
  }

  saveSettings(settings: Pick<TimeSettings, 'timesheets' | 'policies' | 'expenses'>): Promise<TimeSettings> {
    return apiClient.put<TimeSettings>('/time/settings', settings);
  }

  mine(day?: string): Promise<TimesheetView> {
    return apiClient.get<TimesheetView>('/timesheets/mine', day ? { day } : undefined);
  }

  history(): Promise<TimesheetSummary[]> {
    return apiClient.get<TimesheetSummary[]>('/timesheets/history');
  }

  ofPerson(personId: ID, day?: string): Promise<TimesheetView> {
    return apiClient.get<TimesheetView>(`/timesheets/people/${personId}`, day ? { day } : undefined);
  }

  get(id: ID): Promise<TimesheetView> {
    return apiClient.get<TimesheetView>(`/timesheets/${id}`);
  }

  overview(query: TimesheetOverviewQuery): Promise<TimesheetOverview> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) if (value) params[key] = String(value);
    return apiClient.get<TimesheetOverview>('/timesheets/overview', params);
  }

  submit(day: string): Promise<TimesheetView> {
    return apiClient.post<TimesheetView>('/timesheets/submit', { day });
  }

  withdraw(id: ID): Promise<TimesheetView> {
    return apiClient.post<TimesheetView>(`/timesheets/${id}/withdraw`);
  }

  reopen(id: ID, reason: string): Promise<TimesheetView> {
    return apiClient.post<TimesheetView>(`/timesheets/${id}/reopen`, { reason });
  }
}
