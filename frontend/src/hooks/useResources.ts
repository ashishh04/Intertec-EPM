import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { resourceService } from '@/services';
import type {
  AllocationInput,
  CapacityQuery,
  HrReconcileInput,
  LevellingInput,
  ScheduleInput,
  TimeOffInput,
} from '@/services/api/resources';
import type { HrImportPerson, ID, ResourceSettings } from '@/types';

/**
 * Resources and capacity (Module 6). Anything that changes availability or
 * demand — a schedule, time off, a booking, levelling — moves every figure
 * here and the utilisation dashboards too, so writes refresh all of them.
 */

export const resourceKeys = {
  all: ['resources'] as const,
  settings: () => ['resources', 'settings'] as const,
  roles: (includeArchived: boolean) => ['resources', 'roles', includeArchived] as const,
  availability: (personId: ID, from?: string, weeks?: number) => ['resources', 'availability', personId, from ?? '', weeks ?? 0] as const,
  allocations: (filter: object) => ['resources', 'allocations', filter] as const,
  capacity: (query: CapacityQuery) => ['resources', 'capacity', query] as const,
  cell: (key: string, week: string, query: CapacityQuery) => ['resources', 'cell', key, week, query] as const,
  over: (query: CapacityQuery) => ['resources', 'over', query] as const,
  runs: () => ['resources', 'levelling'] as const,
  run: (id: ID) => ['resources', 'levelling', id] as const,
  pin: (workPackageId: ID) => ['resources', 'pin', workPackageId] as const,
};

/** After a write: every resource figure, the dashboards built on the same model, and the tasks whose dates moved. */
function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: resourceKeys.all });
    void client.invalidateQueries({ queryKey: ['insights'] });
    void client.invalidateQueries({ queryKey: ['employees'] });
  };
}

export function useResourceSettings(enabled = true) {
  return useQuery({ queryKey: resourceKeys.settings(), queryFn: () => resourceService.getSettings(), enabled, staleTime: 60_000 });
}

export function useSaveResourceSettings() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (settings: Pick<ResourceSettings, 'thresholds' | 'hoursPerDay' | 'billableByDefault' | 'nonBillableActivityIds'>) =>
      resourceService.saveSettings(settings),
    onSuccess: refresh,
  });
}

export function useResourceRoles(includeArchived = false) {
  return useQuery({
    queryKey: resourceKeys.roles(includeArchived),
    queryFn: () => resourceService.listRoles(includeArchived),
    staleTime: 60_000,
  });
}

export function useCreateRole() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: { name: string; description?: string | null }) => resourceService.createRole(input),
    onSuccess: refresh,
  });
}

export function useUpdateRole() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: ID; name?: string; description?: string | null; archived?: boolean }) =>
      resourceService.updateRole(id, input),
    onSuccess: refresh,
  });
}

export function useSetPersonRole() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ personId, roleId }: { personId: ID; roleId: ID | null }) => resourceService.setPersonRole(personId, roleId),
    onSuccess: refresh,
  });
}

export function useAvailability(personId: ID | undefined, from?: string, weeks?: number) {
  return useQuery({
    queryKey: resourceKeys.availability(personId ?? '', from, weeks),
    queryFn: () => resourceService.getAvailability(personId!, from, weeks),
    enabled: Boolean(personId),
  });
}

export function useSetSchedule(personId: ID) {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (input: ScheduleInput) => resourceService.setSchedule(personId, input), onSuccess: refresh });
}

export function useDeleteSchedule(personId: ID) {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (scheduleId: ID) => resourceService.deleteSchedule(personId, scheduleId), onSuccess: refresh });
}

export function useAddTimeOff(personId: ID) {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (input: TimeOffInput) => resourceService.addTimeOff(personId, input), onSuccess: refresh });
}

export function useUpdateTimeOff(personId: ID) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<TimeOffInput> & { id: ID }) => resourceService.updateTimeOff(personId, id, input),
    onSuccess: refresh,
  });
}

export function useDeleteTimeOff(personId: ID) {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (entryId: ID) => resourceService.deleteTimeOff(personId, entryId), onSuccess: refresh });
}

export function useImportHr() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (people: HrImportPerson[]) => resourceService.importHr(people), onSuccess: refresh });
}

/** A check, not a change: a mutation only because it is asked on demand. */
export function useReconcileHr() {
  return useMutation({ mutationFn: (rows: HrReconcileInput[]) => resourceService.reconcileHr(rows) });
}

export function useAllocations(filter: { projectId?: ID; personId?: ID; placeholderId?: ID; roleId?: ID } = {}, enabled = true) {
  return useQuery({
    queryKey: resourceKeys.allocations(filter),
    queryFn: () => resourceService.listAllocations(filter),
    enabled,
  });
}

export function useSaveAllocation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, ...input }: AllocationInput & { id?: ID }) =>
      id ? resourceService.updateAllocation(id, input) : resourceService.createAllocation(input),
    onSuccess: refresh,
  });
}

export function useDeleteAllocation() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: ID) => resourceService.deleteAllocation(id), onSuccess: refresh });
}

export function useCapacity(query: CapacityQuery, enabled = true) {
  return useQuery({
    queryKey: resourceKeys.capacity(query),
    queryFn: () => resourceService.getCapacity(query),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useCapacityCell(key: string | null, week: string | null, query: CapacityQuery) {
  return useQuery({
    queryKey: resourceKeys.cell(key ?? '', week ?? '', query),
    queryFn: () => resourceService.getCell(key!, week!, query),
    enabled: Boolean(key && week),
  });
}

export function useOverAllocations(query: CapacityQuery, enabled = true) {
  return useQuery({ queryKey: resourceKeys.over(query), queryFn: () => resourceService.getOverAllocations(query), enabled });
}

export function useLevellingRuns(enabled = true) {
  return useQuery({ queryKey: resourceKeys.runs(), queryFn: () => resourceService.listLevellingRuns(), enabled });
}

export function useLevellingRun(id: ID | null) {
  return useQuery({ queryKey: resourceKeys.run(id ?? ''), queryFn: () => resourceService.getLevellingRun(id!), enabled: Boolean(id) });
}

/** A proposal changes nothing but is stored, for the preview and to apply later. */
export function useProposeLevelling() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: LevellingInput) => resourceService.proposeLevelling(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: resourceKeys.runs() }),
  });
}

function useLevellingAction(action: (id: ID) => Promise<unknown>) {
  const refresh = useRefresh();
  const client = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSettled: () => {
      refresh();
      void client.invalidateQueries({ queryKey: ['tasks'] });
      void client.invalidateQueries({ queryKey: ['task-timeline'] });
    },
  });
}

export const useApplyLevelling = () => useLevellingAction((id) => resourceService.applyLevelling(id));
export const useUndoLevelling = () => useLevellingAction((id) => resourceService.undoLevelling(id));
export const useDiscardLevelling = () => useLevellingAction((id) => resourceService.discardLevelling(id));

export function useWorkPackagePin(workPackageId: ID | undefined) {
  return useQuery({
    queryKey: resourceKeys.pin(workPackageId ?? ''),
    queryFn: () => resourceService.getPin(workPackageId!),
    enabled: Boolean(workPackageId),
  });
}

export function usePinWorkPackage(workPackageId: ID) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ pinned, reason }: { pinned: boolean; reason?: string | null }): Promise<void> => {
      if (pinned) await resourceService.pin(workPackageId, reason ?? null);
      else await resourceService.unpin(workPackageId);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: resourceKeys.pin(workPackageId) });
      void client.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export type { HrImportPerson };
