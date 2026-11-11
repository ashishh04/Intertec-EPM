import { apiClient } from './client';
import type {
  EpmProgram,
  EpmProject,
  ID,
  ProgramInput,
  ProjectAttributes,
  ProjectCopyInput,
  ProjectCopyJob,
  ProjectModules,
  ProjectPhases,
  RoadmapVersion,
} from '@/types';

/**
 * A project's settings (modules, attributes, template flag, life cycle), its
 * roadmap, copying a project, and programs.
 */
export const projectSettingsService = {
  modules: (id: ID) => apiClient.get<ProjectModules>(`/projects/${id}/modules`),
  setModules: (id: ID, enabled: string[]) => apiClient.patch<ProjectModules>(`/projects/${id}/modules`, { enabled }),
  attributes: (id: ID) => apiClient.get<ProjectAttributes>(`/projects/${id}/attributes`),
  setAttributeEnabled: (id: ID, customFieldId: ID, enabled: boolean) =>
    apiClient.patch<{ ok: true }>(`/projects/${id}/attributes/enabled`, { customFieldId, enabled }),
  setTemplate: (id: ID, templated: boolean) => apiClient.patch<{ templated: boolean }>(`/projects/${id}/template`, { templated }),
  copy: (id: ID, input: ProjectCopyInput) => apiClient.post<ProjectCopyJob>(`/projects/${id}/copy`, input),
  copyJob: (jobId: ID) => apiClient.get<ProjectCopyJob>(`/projects/copy-jobs/${jobId}`),
  phases: (id: ID) => apiClient.get<ProjectPhases>(`/projects/${id}/phases`),
  setPhase: (id: ID, definitionId: ID, input: { active?: boolean; startDate?: string | null; finishDate?: string | null }) =>
    apiClient.patch<ProjectPhases>(`/projects/${id}/phases/${definitionId}`, input),
  roadmap: (id: ID) => apiClient.get<RoadmapVersion[]>(`/projects/${id}/roadmap`),
};

export const programService = {
  list: (includeInactive = false) => apiClient.get<EpmProgram[]>('/programs', includeInactive ? { includeInactive: 'true' } : {}),
  get: (id: ID) => apiClient.get<EpmProgram & { projects: EpmProject[] }>(`/programs/${id}`),
  create: (input: ProgramInput) => apiClient.post<EpmProgram>('/programs', input),
  update: (id: ID, input: Partial<ProgramInput>) => apiClient.patch<EpmProgram>(`/programs/${id}`, input),
  archive: (id: ID) => apiClient.patch<EpmProgram>(`/programs/${id}/archive`),
  restore: (id: ID) => apiClient.patch<EpmProgram>(`/programs/${id}/restore`),
  remove: (id: ID) => apiClient.delete<void>(`/programs/${id}`),
  setProjectProgram: (projectId: ID, programId: ID | null) =>
    apiClient.patch<{ programId: ID | null }>(`/projects/${projectId}/program`, { programId }),
};
