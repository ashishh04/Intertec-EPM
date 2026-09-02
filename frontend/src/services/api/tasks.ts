import { apiClient } from './client';
import type { TaskRepository } from '../repositories';
import type {
  CreateTaskInput,
  ID,
  EpmTask,
  Paginated,
  TaskFilters,
  UpdateTaskInput,
} from '@/types';

/** Work packages. Filtering and pagination are pushed down to the backend. */
export class ApiTaskRepository implements TaskRepository {
  getTasks(filters: TaskFilters = {}): Promise<Paginated<EpmTask>> {
    return apiClient.get<Paginated<EpmTask>>('/tasks', {
      projectId: filters.projectId,
      assigneeId: filters.assigneeId,
      status: filters.status,
      priority: filters.priority,
      type: filters.type,
      sprintId: filters.sprintId,
      search: filters.search,
      bucket: filters.bucket,
      page: filters.page,
      pageSize: filters.pageSize,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
  }

  getTask(id: ID): Promise<EpmTask> {
    return apiClient.get<EpmTask>(`/tasks/${id}`);
  }

  createTask(input: CreateTaskInput): Promise<EpmTask> {
    return apiClient.post<EpmTask>('/tasks', input);
  }

  updateTask(input: UpdateTaskInput): Promise<EpmTask> {
    const { id, ...patch } = input;
    return apiClient.patch<EpmTask>(`/tasks/${id}`, patch);
  }

  bulkUpdate(ids: ID[], patch: Partial<UpdateTaskInput>): Promise<EpmTask[]> {
    return apiClient.patch<EpmTask[]>('/tasks/bulk', { ids, patch });
  }

  async deleteTasks(ids: ID[]): Promise<void> {
    await apiClient.delete<void>('/tasks/bulk', { ids });
  }
}
