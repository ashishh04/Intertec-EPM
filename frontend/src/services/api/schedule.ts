import { apiClient } from './client';
import type { ID, ProjectCriticalPath, ScheduleStatus, WorkPackageSchedule } from '@/types';

/**
 * Critical path and float (BRQ-01: BR-101 to BR-104), computed by EPM over the
 * whole network and read with the caller's access to the work.
 */
export class ApiScheduleRepository {
  /** A project's scheduled work with its float, and the relations between it. */
  getProjectCriticalPath(projectId: ID, near?: number): Promise<ProjectCriticalPath> {
    return apiClient.get<ProjectCriticalPath>(`/projects/${projectId}/critical-path`, near === undefined ? {} : { near });
  }

  /** One work package's dates, float and driving relations. */
  getWorkPackageSchedule(id: ID, near?: number): Promise<WorkPackageSchedule> {
    return apiClient.get<WorkPackageSchedule>(`/work-packages/${id}/schedule`, near === undefined ? {} : { near });
  }

  getStatus(): Promise<ScheduleStatus> {
    return apiClient.get<ScheduleStatus>('/schedule/status');
  }

  /** Administrators only (`users:manage`). Waits for the pass on a small network. */
  recalculate(): Promise<ScheduleStatus> {
    return apiClient.post<ScheduleStatus>('/schedule/recalculate');
  }
}
