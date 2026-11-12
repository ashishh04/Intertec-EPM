import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidationGroups } from '@/lib/queryKeys';
import { programService, projectSettingsService } from '@/services/api/project-settings';
import type { ID, ProgramInput, ProjectCopyInput } from '@/types';

/** A project's modules, attributes, template flag, life cycle and roadmap; copying; and programs. */

const settingsKey = (id: ID, what: string) => ['project-settings', id, what] as const;

function useProjectWriteInvalidation() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['project-settings'] });
    for (const key of invalidationGroups.projectWrite) void client.invalidateQueries({ queryKey: key });
  };
}

/** What the reader may do in a project, answered by its roles and modules there. */
export function useProjectAbilities(id?: ID) {
  return useQuery({
    queryKey: settingsKey(id ?? 'unknown', 'abilities'),
    queryFn: () => projectSettingsService.abilities(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useProjectModules(id?: ID) {
  return useQuery({
    queryKey: settingsKey(id ?? 'unknown', 'modules'),
    queryFn: () => projectSettingsService.modules(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useSetProjectModules(id: ID) {
  const settle = useProjectWriteInvalidation();
  return useMutation({ mutationFn: (enabled: string[]) => projectSettingsService.setModules(id, enabled), onSuccess: settle });
}

export function useProjectAttributes(id?: ID) {
  return useQuery({
    queryKey: settingsKey(id ?? 'unknown', 'attributes'),
    queryFn: () => projectSettingsService.attributes(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useSetAttributeEnabled(id: ID) {
  const settle = useProjectWriteInvalidation();
  return useMutation({
    mutationFn: ({ customFieldId, enabled }: { customFieldId: ID; enabled: boolean }) =>
      projectSettingsService.setAttributeEnabled(id, customFieldId, enabled),
    onSuccess: settle,
  });
}

export function useSetTemplate(id: ID) {
  const settle = useProjectWriteInvalidation();
  return useMutation({ mutationFn: (templated: boolean) => projectSettingsService.setTemplate(id, templated), onSuccess: settle });
}

export function useCopyProject() {
  return useMutation({
    mutationFn: ({ templateId, input }: { templateId: ID; input: ProjectCopyInput }) => projectSettingsService.copy(templateId, input),
  });
}

/** Follows a copy until it finishes: every two seconds while it runs. */
export function useCopyJob(jobId?: ID) {
  const settle = useProjectWriteInvalidation();
  return useQuery({
    queryKey: ['project-copy', jobId ?? 'none'],
    queryFn: async () => {
      const job = await projectSettingsService.copyJob(jobId!);
      if (job.status === 'success') settle();
      return job;
    },
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'in_queue' || status === 'in_process' || status === undefined ? 2000 : false;
    },
  });
}

export function useProjectPhases(id?: ID) {
  return useQuery({
    queryKey: settingsKey(id ?? 'unknown', 'phases'),
    queryFn: () => projectSettingsService.phases(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useSetProjectPhase(id: ID) {
  const settle = useProjectWriteInvalidation();
  return useMutation({
    mutationFn: ({ definitionId, input }: { definitionId: ID; input: { active?: boolean; startDate?: string | null; finishDate?: string | null } }) =>
      projectSettingsService.setPhase(id, definitionId, input),
    onSuccess: settle,
  });
}

export function useRoadmap(id?: ID) {
  return useQuery({
    queryKey: settingsKey(id ?? 'unknown', 'roadmap'),
    queryFn: () => projectSettingsService.roadmap(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Programs                                                                   */
/* -------------------------------------------------------------------------- */

export function usePrograms(includeInactive = false) {
  return useQuery({ queryKey: ['programs', 'list', includeInactive], queryFn: () => programService.list(includeInactive), staleTime: 60_000 });
}

export function useProgram(id?: ID) {
  return useQuery({ queryKey: ['programs', 'detail', id ?? 'unknown'], queryFn: () => programService.get(id!), enabled: Boolean(id), staleTime: 30_000 });
}

export function useProgramMutations() {
  const client = useQueryClient();
  const settle = () => {
    void client.invalidateQueries({ queryKey: ['programs'] });
    for (const key of invalidationGroups.projectWrite) void client.invalidateQueries({ queryKey: key });
  };
  return {
    create: useMutation({ mutationFn: (input: ProgramInput) => programService.create(input), onSuccess: settle }),
    update: useMutation({ mutationFn: ({ id, input }: { id: ID; input: Partial<ProgramInput> }) => programService.update(id, input), onSuccess: settle }),
    setActive: useMutation({ mutationFn: ({ id, active }: { id: ID; active: boolean }) => (active ? programService.restore(id) : programService.archive(id)), onSuccess: settle }),
    remove: useMutation({ mutationFn: (id: ID) => programService.remove(id), onSuccess: settle }),
    setProjectProgram: useMutation({
      mutationFn: ({ projectId, programId }: { projectId: ID; programId: ID | null }) => programService.setProjectProgram(projectId, programId),
      onSuccess: settle,
    }),
  };
}
