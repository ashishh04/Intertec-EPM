import { apiClient } from './client';
import type {
  ID,
  RecurrencePreview,
  RecurrenceRule,
  SeriesGenerationResult,
  TaskSeries,
  TaskSeriesDetail,
  TaskSeriesInput,
  WorkPackageSeriesLink,
} from '@/types';

/**
 * Recurring tasks (BRQ-02: BR-105 to BR-107): a template work package, the
 * rule its occurrences follow, and the tasks made for them. Read with
 * `task:view` in the project; made and changed with `task:edit` there.
 */
export class ApiTaskSeriesRepository {
  /** A project's recurring work, active first. */
  listForProject(projectId: ID): Promise<TaskSeries[]> {
    return apiClient.get<TaskSeries[]>(`/projects/${projectId}/task-series`);
  }

  get(id: ID): Promise<TaskSeriesDetail> {
    return apiClient.get<TaskSeriesDetail>(`/task-series/${id}`);
  }

  /** What a work package is to a series: its template, one of its tasks, or neither. */
  forWorkPackage(workPackageId: ID): Promise<WorkPackageSeriesLink> {
    return apiClient.get<WorkPackageSeriesLink>(`/work-packages/${workPackageId}/series`);
  }

  /** A rule's next dates and its words. Saves nothing. */
  preview(rule: RecurrenceRule, limit = 8): Promise<RecurrencePreview> {
    return apiClient.post<RecurrencePreview>('/task-series/preview', { rule, limit });
  }

  /** Makes the work package the template of a new series. */
  create(workPackageId: ID, input: TaskSeriesInput): Promise<TaskSeriesDetail> {
    return apiClient.post<TaskSeriesDetail>(`/work-packages/${workPackageId}/series`, input);
  }

  /** A new rule, lead time or duration: a new version. Tasks already made are left as they are. */
  update(id: ID, input: TaskSeriesInput): Promise<TaskSeriesDetail> {
    return apiClient.patch<TaskSeriesDetail>(`/task-series/${id}`, input);
  }

  /** Pause, resume or cancel. Cancelling is final. */
  move(id: ID, move: 'pause' | 'resume' | 'cancel'): Promise<TaskSeriesDetail> {
    return apiClient.post<TaskSeriesDetail>(`/task-series/${id}/${move}`);
  }

  /** Makes the series' due tasks now rather than at the next run. */
  generate(id: ID): Promise<SeriesGenerationResult> {
    return apiClient.post<SeriesGenerationResult>(`/task-series/${id}/generate`);
  }
}
