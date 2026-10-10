import { apiClient } from './client';
import type {
  CapacityCellDetail,
  CapacityGrid,
  CapacityGrouping,
  HrImportPerson,
  HrImportResult,
  HrReconcileResult,
  ID,
  LevellingRunSummary,
  LevellingRunView,
  OverAllocation,
  PersonAvailability,
  ResourceAllocation,
  ResourceRole,
  ResourceSettings,
  ResourceSettingsView,
  TimeOffEntry,
  TimeOffKind,
  WorkPackagePin,
  WorkScheduleRow,
} from '@/types';

/**
 * Resources and capacity (Module 6: BR-110 to BR-112, BR-312 to BR-315).
 *
 * The heatmap, over-allocation and levelling need `resources:plan`; people's
 * availability and roles need `employees:manage`; the thresholds and what is
 * billable need `resources:configure`. The backend says no to anything else.
 */

export interface CapacityQuery {
  from?: string;
  weeks?: number;
  group?: CapacityGrouping;
  teamId?: ID;
  roleId?: ID;
  departmentId?: ID;
  placeholders?: boolean;
}

export interface ScheduleInput {
  effectiveFrom: string;
  hours: number[];
  fraction: number;
}

export interface TimeOffInput {
  startsOn: string;
  endsOn: string;
  hoursPerDay: number | null;
  kind: TimeOffKind;
  note?: string | null;
}

export interface AllocationInput {
  projectId: ID;
  personId?: ID | null;
  placeholderId?: ID | null;
  roleId?: ID | null;
  startsOn: string;
  endsOn: string;
  hoursPerWeek: number;
  note?: string | null;
}

export interface LevellingInput {
  scope: { kind: 'team' | 'role' | 'people'; id?: ID; people?: ID[] };
  keepManual: boolean;
  horizonWeeks: number;
}

export interface HrReconcileInput {
  personId?: ID;
  email?: string;
  from: string;
  to: string;
  availableHours: number;
}

const query = (input: CapacityQuery = {}) => ({
  ...(input.from ? { from: input.from } : {}),
  ...(input.weeks ? { weeks: input.weeks } : {}),
  ...(input.group ? { group: input.group } : {}),
  ...(input.teamId ? { teamId: input.teamId } : {}),
  ...(input.roleId ? { roleId: input.roleId } : {}),
  ...(input.departmentId ? { departmentId: input.departmentId } : {}),
  ...(input.placeholders === false ? { placeholders: 'false' } : {}),
});

/** Writing many work packages one by one takes a while. */
const LONG = 300_000;

export class ApiResourceRepository {
  getSettings(): Promise<ResourceSettingsView> {
    return apiClient.get<ResourceSettingsView>('/resources/settings');
  }

  saveSettings(settings: Pick<ResourceSettings, 'thresholds' | 'hoursPerDay' | 'billableByDefault' | 'nonBillableActivityIds'>): Promise<ResourceSettings> {
    return apiClient.put<ResourceSettings>('/resources/settings', settings);
  }

  listRoles(includeArchived = false): Promise<ResourceRole[]> {
    return apiClient.get<ResourceRole[]>('/resources/roles', includeArchived ? { includeArchived: 'true' } : undefined);
  }

  createRole(input: { name: string; description?: string | null }): Promise<ResourceRole> {
    return apiClient.post<ResourceRole>('/resources/roles', input);
  }

  updateRole(id: ID, input: { name?: string; description?: string | null; archived?: boolean }): Promise<ResourceRole> {
    return apiClient.patch<ResourceRole>(`/resources/roles/${id}`, input);
  }

  setPersonRole(personId: ID, roleId: ID | null): Promise<{ personId: ID; roleId: ID | null }> {
    return apiClient.patch(`/employees/${personId}/role`, { roleId });
  }

  getAvailability(personId: ID, from?: string, weeks?: number): Promise<PersonAvailability> {
    return apiClient.get<PersonAvailability>(`/resources/people/${personId}/availability`, {
      ...(from ? { from } : {}),
      ...(weeks ? { weeks } : {}),
    });
  }

  setSchedule(personId: ID, input: ScheduleInput): Promise<WorkScheduleRow> {
    return apiClient.put<WorkScheduleRow>(`/resources/people/${personId}/schedules`, input);
  }

  deleteSchedule(personId: ID, scheduleId: ID): Promise<void> {
    return apiClient.delete<void>(`/resources/people/${personId}/schedules/${scheduleId}`);
  }

  addTimeOff(personId: ID, input: TimeOffInput): Promise<TimeOffEntry> {
    return apiClient.post<TimeOffEntry>(`/resources/people/${personId}/time-off`, input);
  }

  updateTimeOff(personId: ID, entryId: ID, input: Partial<TimeOffInput>): Promise<TimeOffEntry> {
    return apiClient.patch<TimeOffEntry>(`/resources/people/${personId}/time-off/${entryId}`, input);
  }

  deleteTimeOff(personId: ID, entryId: ID): Promise<void> {
    return apiClient.delete<void>(`/resources/people/${personId}/time-off/${entryId}`);
  }

  importHr(people: HrImportPerson[]): Promise<HrImportResult> {
    return apiClient.request<HrImportResult>('/resources/hr/import', { method: 'POST', body: { people }, timeoutMs: LONG });
  }

  reconcileHr(rows: HrReconcileInput[]): Promise<HrReconcileResult> {
    return apiClient.request<HrReconcileResult>('/resources/hr/reconcile', { method: 'POST', body: { rows }, timeoutMs: LONG });
  }

  listAllocations(filter: { projectId?: ID; personId?: ID; placeholderId?: ID; roleId?: ID } = {}): Promise<ResourceAllocation[]> {
    return apiClient.get<ResourceAllocation[]>('/resources/allocations', { ...filter });
  }

  createAllocation(input: AllocationInput): Promise<ResourceAllocation> {
    return apiClient.post<ResourceAllocation>('/resources/allocations', input);
  }

  updateAllocation(id: ID, input: Partial<AllocationInput>): Promise<ResourceAllocation> {
    return apiClient.patch<ResourceAllocation>(`/resources/allocations/${id}`, input);
  }

  deleteAllocation(id: ID): Promise<void> {
    return apiClient.delete<void>(`/resources/allocations/${id}`);
  }

  getCapacity(input: CapacityQuery): Promise<CapacityGrid> {
    return apiClient.get<CapacityGrid>('/resources/capacity', query(input));
  }

  getCell(key: string, week: string, input: CapacityQuery): Promise<CapacityCellDetail> {
    return apiClient.get<CapacityCellDetail>('/resources/capacity/cell', { ...query(input), key, week });
  }

  getOverAllocations(input: CapacityQuery): Promise<OverAllocation[]> {
    return apiClient.get<OverAllocation[]>('/resources/over-allocations', query(input));
  }

  listLevellingRuns(): Promise<LevellingRunSummary[]> {
    return apiClient.get<LevellingRunSummary[]>('/resources/levelling');
  }

  proposeLevelling(input: LevellingInput): Promise<LevellingRunView> {
    return apiClient.request<LevellingRunView>('/resources/levelling', { method: 'POST', body: input, timeoutMs: LONG });
  }

  getLevellingRun(id: ID): Promise<LevellingRunView> {
    return apiClient.get<LevellingRunView>(`/resources/levelling/${id}`);
  }

  applyLevelling(id: ID): Promise<LevellingRunView> {
    return apiClient.request<LevellingRunView>(`/resources/levelling/${id}/apply`, { method: 'POST', timeoutMs: LONG });
  }

  undoLevelling(id: ID): Promise<LevellingRunView> {
    return apiClient.request<LevellingRunView>(`/resources/levelling/${id}/undo`, { method: 'POST', timeoutMs: LONG });
  }

  discardLevelling(id: ID): Promise<LevellingRunView> {
    return apiClient.post<LevellingRunView>(`/resources/levelling/${id}/discard`);
  }

  getPin(workPackageId: ID): Promise<{ pin: WorkPackagePin | null }> {
    return apiClient.get(`/work-packages/${workPackageId}/pin`);
  }

  pin(workPackageId: ID, reason: string | null): Promise<{ pin: WorkPackagePin }> {
    return apiClient.put(`/work-packages/${workPackageId}/pin`, { reason });
  }

  unpin(workPackageId: ID): Promise<void> {
    return apiClient.delete<void>(`/work-packages/${workPackageId}/pin`);
  }
}
