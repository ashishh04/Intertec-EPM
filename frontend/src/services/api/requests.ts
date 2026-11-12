import { apiClient } from './client';
import type {
  ID,
  ProjectGate,
  ProjectRequest,
  ProjectRequestCreation,
  ProjectRequestInput,
  StageGateReview,
} from '@/types';

/** Requests to start a project, decided through an approval chain. */
export const projectRequestService = {
  list: (scope: 'mine' | 'all') => apiClient.get<ProjectRequest[]>('/project-requests', { scope }),
  get: (id: ID) => apiClient.get<ProjectRequest>(`/project-requests/${id}`),
  create: (input: ProjectRequestInput) => apiClient.post<ProjectRequest>('/project-requests', input),
  update: (id: ID, input: ProjectRequestInput) => apiClient.patch<ProjectRequest>(`/project-requests/${id}`, input),
  remove: (id: ID) => apiClient.delete<void>(`/project-requests/${id}`),
  submit: (id: ID) => apiClient.post<ProjectRequest>(`/project-requests/${id}/submit`),
  withdraw: (id: ID) => apiClient.post<ProjectRequest>(`/project-requests/${id}/withdraw`),
  createProject: (id: ID) => apiClient.post<ProjectRequestCreation>(`/project-requests/${id}/create-project`),
  link: (id: ID, projectId: ID) => apiClient.post<ProjectRequest>(`/project-requests/${id}/link`, { projectId }),
};

/** Gate reviews in a project's life cycle. */
export const stageGateService = {
  gates: (projectId: ID) => apiClient.get<ProjectGate[]>(`/projects/${projectId}/gates`),
  request: (projectId: ID, definitionId: ID, gate: 'start' | 'finish', notes?: string) =>
    apiClient.post<StageGateReview>(`/projects/${projectId}/gates/${definitionId}/${gate}/review`, notes ? { notes } : {}),
  get: (id: ID) => apiClient.get<StageGateReview>(`/stage-gate-reviews/${id}`),
  withdraw: (id: ID) => apiClient.post<StageGateReview>(`/stage-gate-reviews/${id}/withdraw`),
};
