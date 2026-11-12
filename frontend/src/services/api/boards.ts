import { apiClient } from './client';
import type {
  BacklogMoveInput,
  BoardColumnOption,
  BoardInput,
  BoardMoveInput,
  EpmBoard,
  EpmBoardSummary,
  ID,
  Impediment,
  ImpedimentInput,
  ProjectBacklog,
} from '@/types';

/** Boards of every kind, kept by the delivery system as grids of saved views. */
export const boardService = {
  list: (projectId: ID) => apiClient.get<EpmBoardSummary[]>(`/projects/${projectId}/boards`),
  create: (projectId: ID, input: BoardInput) => apiClient.post<EpmBoardSummary>(`/projects/${projectId}/boards`, input),
  get: (id: ID) => apiClient.get<EpmBoard>(`/boards/${id}`),
  rename: (id: ID, name: string) => apiClient.patch<EpmBoardSummary>(`/boards/${id}`, { name }),
  remove: (id: ID) => apiClient.delete<void>(`/boards/${id}`),
  columnOptions: (id: ID, search = '') =>
    apiClient.get<BoardColumnOption[]>(`/boards/${id}/column-options`, search ? { search } : {}),
  addColumn: (id: ID, input: { name?: string; value?: ID }) =>
    apiClient.post<{ queryId: ID; name: string }>(`/boards/${id}/columns`, input),
  removeColumn: (id: ID, queryId: ID) => apiClient.delete<void>(`/boards/${id}/columns/${queryId}`),
  orderColumns: (id: ID, queryIds: ID[]) => apiClient.put<{ ok: true }>(`/boards/${id}/columns/order`, { queryIds }),
  move: (id: ID, input: BoardMoveInput) => apiClient.post<{ ok: true }>(`/boards/${id}/move`, input),
  removeCard: (id: ID, queryId: ID, workPackageId: ID) =>
    apiClient.delete<void>(`/boards/${id}/columns/${queryId}/cards/${workPackageId}`),
};

/** A project's backlog in order, sprint planning, and a sprint's impediments. */
export const backlogService = {
  get: (projectId: ID) => apiClient.get<ProjectBacklog>(`/projects/${projectId}/backlog`),
  move: (projectId: ID, input: BacklogMoveInput) => apiClient.post<{ ok: true }>(`/projects/${projectId}/backlog/move`, input),
  impediments: (sprintId: ID, projectId?: ID) =>
    apiClient.get<Impediment[]>(`/sprints/${sprintId}/impediments`, projectId ? { projectId } : {}),
  raiseImpediment: (sprintId: ID, input: ImpedimentInput & { projectId: ID }) =>
    apiClient.post<Impediment>(`/sprints/${sprintId}/impediments`, input),
};
