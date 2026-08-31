import { apiClient } from './client';
import type { TaskRepository } from '../repositories';
import type {
  CreateTaskInput,
  ID,
  NexusTask,
  Paginated,
  TaskComment,
  TaskFilters,
  UpdateTaskInput,
} from '@/types';

/** Work packages. Filtering and pagination are pushed down to the backend. */
export class ApiTaskRepository implements TaskRepository {
  getTasks(filters: TaskFilters = {}): Promise<Paginated<NexusTask>> {
    return apiClient.get<Paginated<NexusTask>>('/tasks', {
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

  getTask(id: ID): Promise<NexusTask> {
    return apiClient.get<NexusTask>(`/tasks/${id}`);
  }

  getComments(taskId: ID): Promise<TaskComment[]> {
    return apiClient.get<TaskComment[]>(`/tasks/${taskId}/comments`);
  }

  addComment(taskId: ID, body: string): Promise<TaskComment> {
    return apiClient.post<TaskComment>(`/tasks/${taskId}/comments`, { body });
  }

  createTask(input: CreateTaskInput): Promise<NexusTask> {
    return apiClient.post<NexusTask>('/tasks', input);
  }

  updateTask(input: UpdateTaskInput): Promise<NexusTask> {
    const { id, ...patch } = input;
    return apiClient.patch<NexusTask>(`/tasks/${id}`, patch);
  }

  bulkUpdate(ids: ID[], patch: Partial<UpdateTaskInput>): Promise<NexusTask[]> {
    return apiClient.patch<NexusTask[]>('/tasks/bulk', { ids, patch });
  }

  async deleteTasks(ids: ID[]): Promise<void> {
    await apiClient.delete<void>('/tasks/bulk', { ids });
  }
}
