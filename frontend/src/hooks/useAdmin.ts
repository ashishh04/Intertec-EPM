import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { adminService } from '@/services';
import type {
  CatalogRowInput,
  GroupInput,
  NonWorkingDayInput,
  PlaceholderUserInput,
  RoleCreateInput,
  RoleUpdateInput,
  SettingsSectionInput,
  UsersSettingsInput,
  WeekDaysInput,
} from '@/services/api/admin';
import type { AdminSettingsSection, ID } from '@/types';

/**
 * Instance administration.
 *
 * One query hook per read and one mutation hook per write, as the design
 * lists them. Reads are reference data that only moves when an administrator
 * edits it, so they are cached for a minute; each mutation invalidates the
 * list it changed and nothing else.
 */

export const adminKeys = {
  all: ['admin'] as const,
  information: ['admin', 'information'] as const,
  configuration: ['admin', 'configuration'] as const,
  roles: ['admin', 'roles'] as const,
  groups: ['admin', 'groups'] as const,
  placeholderUsers: ['admin', 'placeholder-users'] as const,
  types: ['admin', 'types'] as const,
  statuses: ['admin', 'statuses'] as const,
  priorities: ['admin', 'priorities'] as const,
  helpTexts: ['admin', 'help-texts'] as const,
  weekDays: ['admin', 'week-days'] as const,
  nonWorkingDays: ['admin', 'non-working-days'] as const,
  storages: ['admin', 'storages'] as const,
  projects: ['admin', 'projects'] as const,
  news: ['admin', 'news'] as const,
  versions: ['admin', 'versions'] as const,
  usersSettings: ['admin', 'settings', 'users'] as const,
  permissions: ['admin', 'permissions'] as const,
  // Defined in lib/queryKeys.ts with the rest of the app's keys, and re-exposed
  // here so every admin hook still reaches for one object.
  settingsSections: queryKeys.adminSettingsSections,
  settingsSection: queryKeys.adminSettingsSection,
  catalogs: queryKeys.adminCatalogs,
  catalog: queryKeys.adminCatalog,
};

const ADMIN_DATA = { staleTime: 60_000 } as const;

export function useAdminInformation() {
  return useQuery({
    queryKey: adminKeys.information,
    queryFn: () => adminService.getInformation(),
    ...ADMIN_DATA,
  });
}

export function useAdminConfiguration() {
  return useQuery({
    queryKey: adminKeys.configuration,
    queryFn: () => adminService.getConfiguration(),
    ...ADMIN_DATA,
  });
}

export function useAdminRoles() {
  return useQuery({
    queryKey: adminKeys.roles,
    queryFn: () => adminService.getRoles(),
    ...ADMIN_DATA,
  });
}

export function useAdminGroups() {
  return useQuery({
    queryKey: adminKeys.groups,
    queryFn: () => adminService.getGroups(),
    ...ADMIN_DATA,
  });
}

export function useAdminPlaceholderUsers() {
  return useQuery({
    queryKey: adminKeys.placeholderUsers,
    queryFn: () => adminService.getPlaceholderUsers(),
    ...ADMIN_DATA,
  });
}

export function useAdminTypes() {
  return useQuery({
    queryKey: adminKeys.types,
    queryFn: () => adminService.getTypes(),
    ...ADMIN_DATA,
  });
}

export function useAdminStatuses() {
  return useQuery({
    queryKey: adminKeys.statuses,
    queryFn: () => adminService.getStatuses(),
    ...ADMIN_DATA,
  });
}

export function useAdminPriorities() {
  return useQuery({
    queryKey: adminKeys.priorities,
    queryFn: () => adminService.getPriorities(),
    ...ADMIN_DATA,
  });
}

export function useAdminHelpTexts() {
  return useQuery({
    queryKey: adminKeys.helpTexts,
    queryFn: () => adminService.getHelpTexts(),
    ...ADMIN_DATA,
  });
}

export function useWeekDays() {
  return useQuery({
    queryKey: adminKeys.weekDays,
    queryFn: () => adminService.getWeekDays(),
    ...ADMIN_DATA,
  });
}

export function useUpdateWeekDays() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: WeekDaysInput) => adminService.updateWeekDays(input),
    onSuccess: (days) => {
      client.setQueryData(adminKeys.weekDays, days);
      void client.invalidateQueries({ queryKey: adminKeys.weekDays });
    },
  });
}

export function useNonWorkingDays() {
  return useQuery({
    queryKey: adminKeys.nonWorkingDays,
    queryFn: () => adminService.getNonWorkingDays(),
    ...ADMIN_DATA,
  });
}

export function useCreateNonWorkingDay() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: NonWorkingDayInput) => adminService.createNonWorkingDay(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.nonWorkingDays }),
  });
}

export function useDeleteNonWorkingDay() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => adminService.deleteNonWorkingDay(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.nonWorkingDays }),
  });
}

export function useAdminStorages() {
  return useQuery({
    queryKey: adminKeys.storages,
    queryFn: () => adminService.getStorages(),
    ...ADMIN_DATA,
  });
}

export function useAdminProjects() {
  return useQuery({
    queryKey: adminKeys.projects,
    queryFn: () => adminService.getProjects(),
    ...ADMIN_DATA,
  });
}

export function useAdminNews() {
  return useQuery({
    queryKey: adminKeys.news,
    queryFn: () => adminService.getNews(),
    ...ADMIN_DATA,
  });
}

export function useAdminVersions() {
  return useQuery({
    queryKey: adminKeys.versions,
    queryFn: () => adminService.getVersions(),
    ...ADMIN_DATA,
  });
}

// Users settings, groups, placeholder users

export function useUsersSettings() {
  return useQuery({
    queryKey: adminKeys.usersSettings,
    queryFn: () => adminService.getUsersSettings(),
    ...ADMIN_DATA,
  });
}

export function useUpdateUsersSettings() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: Partial<UsersSettingsInput>) => adminService.updateUsersSettings(input),
    onSuccess: (settings) => {
      client.setQueryData(adminKeys.usersSettings, settings);
      void client.invalidateQueries({ queryKey: adminKeys.usersSettings });
    },
  });
}

// Settings sections, described by the instance

/** The sections this instance offers, without their fields. */
export function useSettingsSections() {
  return useQuery({
    queryKey: adminKeys.settingsSections,
    queryFn: () => adminService.getSettingsSections(),
    ...ADMIN_DATA,
  });
}

export function useSettingsSection(id: string) {
  return useQuery({
    queryKey: adminKeys.settingsSection(id),
    queryFn: () => adminService.getSettingsSection(id),
    // A section the instance does not offer will not start existing on a
    // retry, and neither will one an administrator may not read.
    retry: false,
    ...ADMIN_DATA,
  });
}

/**
 * One or more fields of a section, written optimistically so a switch moves
 * under the finger rather than after the round trip, and put back if the
 * instance refuses. The reply is the whole section, so it seeds the cache
 * outright — the instance may have changed more than was asked for.
 */
export function useUpdateSettingsSection(id: string) {
  const client = useQueryClient();
  const key = adminKeys.settingsSection(id);

  // Writes still outstanding. An early reply must not replace what is on
  // screen while a later change is in flight, or that change briefly undoes
  // itself; the last reply is the one that speaks for the section.
  const inFlight = useRef(0);

  return useMutation({
    mutationFn: (patch: SettingsSectionInput) => adminService.updateSettingsSection(id, patch),
    onMutate: async (patch) => {
      inFlight.current += 1;
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<AdminSettingsSection>(key);
      if (previous) client.setQueryData(key, applyPatch(previous, patch));
      return { previous };
    },
    onSuccess: (section) => {
      if (inFlight.current > 1) return;
      client.setQueryData(key, section);
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => {
      inFlight.current = Math.max(0, inFlight.current - 1);
    },
  });
}

/** The section as it will look if the instance accepts the change. */
function applyPatch(section: AdminSettingsSection, patch: SettingsSectionInput): AdminSettingsSection {
  return {
    ...section,
    fields: section.fields.map((field) =>
      field.key in patch ? { ...field, value: patch[field.key] } : field,
    ),
  };
}

// Catalogues, described by the instance

/** The catalogues this instance offers, without their fields or rows. */
export function useCatalogs() {
  return useQuery({
    queryKey: adminKeys.catalogs,
    queryFn: () => adminService.getCatalogs(),
    ...ADMIN_DATA,
  });
}

/**
 * One catalogue: its descriptor and its rows, in one reply. The rows cannot
 * be read without the descriptor that says what their keys mean, so the two
 * are one cache entry rather than two that could disagree.
 */
export function useCatalog(resource: string) {
  return useQuery({
    queryKey: adminKeys.catalog(resource),
    queryFn: () => adminService.getCatalog(resource),
    // A resource this instance does not offer will not start existing on a
    // retry, and neither will one an administrator may not read.
    retry: false,
    ...ADMIN_DATA,
  });
}

export function useCreateCatalogRow(resource: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CatalogRowInput) => adminService.createCatalogRow(resource, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.catalog(resource) }),
  });
}

export function useUpdateCatalogRow(resource: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: CatalogRowInput }) =>
      adminService.updateCatalogRow(resource, id, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.catalog(resource) }),
  });
}

/**
 * Removal, which the instance may refuse: a status still in use, or the one
 * marked default. The refusal arrives as 422 with its own reason, and is left
 * for the caller to show rather than swallowed here.
 */
export function useDeleteCatalogRow(resource: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => adminService.deleteCatalogRow(resource, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.catalog(resource) }),
  });
}

export function useCreateGroup() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: GroupInput) => adminService.createGroup(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useUpdateGroup() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<GroupInput> }) =>
      adminService.updateGroup(id, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useDeleteGroup() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => adminService.deleteGroup(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useCreatePlaceholderUser() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: PlaceholderUserInput) => adminService.createPlaceholderUser(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.placeholderUsers }),
  });
}

export function useDeletePlaceholderUser() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => adminService.deletePlaceholderUser(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.placeholderUsers }),
  });
}

// Roles and permissions

/** The permission catalogue, grouped by module. Changes only with the instance's version. */
export function useAdminPermissions() {
  return useQuery({
    queryKey: adminKeys.permissions,
    queryFn: () => adminService.getPermissions(),
    ...ADMIN_DATA,
  });
}

export function useCreateRole() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: RoleCreateInput) => adminService.createRole(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.roles }),
  });
}

export function useUpdateRole() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: RoleUpdateInput }) =>
      adminService.updateRole(id, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.roles }),
  });
}

export function useDeleteRole() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => adminService.deleteRole(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.roles }),
  });
}
