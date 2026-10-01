import { apiClient } from './client';
import type {
  AdminCatalog,
  AdminCatalogRow,
  AdminCatalogSummary,
  AdminSettingField,
  AdminSettingsSection,
  AdminSettingsSectionSummary,
  ID,
} from '@/types';

/**
 * Instance administration, read through the EPM backend.
 *
 * Shapes follow docs/administration-design.md exactly. Ids are strings and
 * dates are ISO strings; the backend does the flattening of OpenProject's
 * HAL resources so nothing here knows about `_links` or `_embedded`.
 */

export interface AdminInformation {
  instanceName: string;
  coreVersion: string;
  hostName: string;
  apiVersion: 'v3';
  activeFeatureFlags: string[];
}

export interface AdminConfiguration {
  hostName: string;
  perPageOptions: number[];
  maximumAttachmentFileSize: number;
  dateFormat: string | null;
  timeFormat: string | null;
  durationFormat: string;
  userDefaultTimezone: string | null;
  startOfWeek: number | null;
  hoursPerDay: number;
  daysPerMonth: number;
  allowedLinkProtocols: string[];
  activeFeatureFlags: string[];
}

// Roles and permissions

export type AdminRoleKind = 'project' | 'global' | 'work_package' | 'project_query';

export interface AdminRole {
  id: ID;
  name: string;
  /** Built-in roles (Non member, Anonymous) keep their name and cannot be deleted. */
  builtin: boolean;
  position: number;
  kind: AdminRoleKind;
  /** Permission names, as listed in `AdminPermissionModule.permissions[].name`. */
  permissions: string[];
}

export interface AdminPermission {
  name: string;
  label: string;
  explanation: string | null;
  /** True when the permission is grantable to a global role. */
  global: boolean;
  /**
   * The role kinds this permission may actually be given to, as the instance's
   * own role contract reports them. Older instances that predate this field
   * omit it; see `permissionAppliesTo` for the fallback.
   */
  grantTo?: AdminRoleKind[];
}

/**
 * Enterprise-gated features, keyed by feature name (`placeholderUsers`).
 *
 * Asked before offering the action rather than discovered by attempting it:
 * on a Community instance creating a placeholder user can only ever fail.
 */
export interface AdminEnterprise {
  active: boolean;
  allows: Record<string, boolean>;
}

export interface AdminPermissionModule {
  /** 'project' for the module-less core permissions. */
  id: string;
  label: string;
  permissions: AdminPermission[];
}

export interface RoleCreateInput {
  name: string;
  global: boolean;
  copyWorkflowFromRoleId?: ID;
  permissions: string[];
}

export interface RoleUpdateInput {
  name?: string;
  permissions?: string[];
}

export interface AdminGroup {
  id: ID;
  name: string;
  memberCount: number;
  members: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminPlaceholderUser {
  id: ID;
  name: string;
  createdAt: string;
}

export interface AdminType {
  id: ID;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isMilestone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminStatus {
  id: ID;
  name: string;
  color: string;
  position: number;
  isClosed: boolean;
  isDefault: boolean;
  isReadonly: boolean;
  defaultDoneRatio: number | null;
}

export interface AdminPriority {
  id: ID;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface AdminHelpText {
  id: ID;
  attribute: string;
  attributeCaption: string;
  scope: string;
  helpText: string;
}

export interface AdminWeekDay {
  /** 1 = Monday … 7 = Sunday, as OpenProject numbers them. */
  day: number;
  name: string;
  working: boolean;
}

export interface WeekDaysInput {
  days: { day: number; working: boolean }[];
}

export interface AdminNonWorkingDay {
  id: ID;
  name: string;
  /** ISO date, e.g. 2026-12-25. */
  date: string;
}

export interface NonWorkingDayInput {
  name: string;
  date: string;
}

export interface AdminStorage {
  id: ID;
  name: string;
  type: string;
  host: string;
  createdAt: string;
}

export interface AdminProject {
  id: ID;
  identifier: string;
  name: string;
  active: boolean;
  public: boolean;
  createdAt: string;
  updatedAt: string;
  parentName: string | null;
}

export interface AdminNews {
  id: ID;
  title: string;
  summary: string;
  createdAt: string;
  projectName: string;
  authorName: string;
}

export interface AdminVersion {
  id: ID;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  sharing: string;
  projectName: string;
}

// Users settings, groups, placeholder users

/** The instance's user settings, as OpenProject's "Users settings" page shows them. */
export interface UsersSettings {
  defaultLanguage: string;
  availableLanguages: { code: string; label: string }[];
  /** IANA name, or null for the browser's default. */
  userDefaultTimezone: string | null;
  /** IANA names. */
  availableTimezones: string[];
  defaultAutoHidePopups: boolean;
  /** e.g. 'firstname_lastname'. */
  userFormat: string;
  /** Label is the caller's own name written in that format. */
  userFormatOptions: { value: string; label: string }[];
  usersDeletableByAdmins: boolean;
  usersDeletableBySelf: boolean;
  consentRequired: boolean;
  /** Language code to markdown. */
  consentInfo: Record<string, string>;
  /** ISO, the last time consent was reset; null when never. */
  consentTime: string | null;
  consentDeclineMail: string;
}

export interface UsersSettingsInput {
  defaultLanguage: string;
  userDefaultTimezone: string | null;
  defaultAutoHidePopups: boolean;
  userFormat: string;
  usersDeletableByAdmins: boolean;
  usersDeletableBySelf: boolean;
  consentRequired: boolean;
  consentInfo: Record<string, string>;
  /** True sets the consent time to now, so every user has to consent again. */
  resetConsentTime: boolean;
  consentDeclineMail: string;
}

// Settings sections, described by the instance

/**
 * A change to one or more fields of a section: field key to new value, in
 * whatever shape that field's `type` says it takes. Only the keys being
 * changed are sent; the instance leaves the rest alone.
 */
export type SettingsSectionInput = Record<string, AdminSettingField['value']>;

// Catalogues, described by the instance

/**
 * A row being created or changed: field key to value, in whatever shape that
 * field's `type` takes. A change carries only the keys being changed, and a
 * write-only field is left out when it is to keep the value it already has.
 */
export type CatalogRowInput = Record<string, string | number | boolean>;

export interface GroupInput {
  name: string;
  memberIds?: string[];
}

export interface PlaceholderUserInput {
  name: string;
}

export class ApiAdminRepository {
  getInformation(): Promise<AdminInformation> {
    return apiClient.get<AdminInformation>('/admin/information');
  }

  getConfiguration(): Promise<AdminConfiguration> {
    return apiClient.get<AdminConfiguration>('/admin/configuration');
  }

  getRoles(): Promise<AdminRole[]> {
    return apiClient.get<AdminRole[]>('/admin/roles');
  }

  // Roles and permissions

  /** The permission catalogue, grouped by module in the instance's order. */
  getEnterprise(): Promise<AdminEnterprise> {
    return apiClient.get<AdminEnterprise>('/admin/enterprise');
  }

  getPermissions(): Promise<AdminPermissionModule[]> {
    return apiClient.get<AdminPermissionModule[]>('/admin/permissions');
  }

  createRole(input: RoleCreateInput): Promise<AdminRole> {
    return apiClient.post<AdminRole>('/admin/roles', input);
  }

  updateRole(id: ID, input: RoleUpdateInput): Promise<AdminRole> {
    return apiClient.patch<AdminRole>(`/admin/roles/${id}`, input);
  }

  deleteRole(id: ID): Promise<void> {
    return apiClient.delete<void>(`/admin/roles/${id}`);
  }

  getGroups(): Promise<AdminGroup[]> {
    return apiClient.get<AdminGroup[]>('/admin/groups');
  }

  getPlaceholderUsers(): Promise<AdminPlaceholderUser[]> {
    return apiClient.get<AdminPlaceholderUser[]>('/admin/placeholder-users');
  }

  getTypes(): Promise<AdminType[]> {
    return apiClient.get<AdminType[]>('/admin/types');
  }

  getStatuses(): Promise<AdminStatus[]> {
    return apiClient.get<AdminStatus[]>('/admin/statuses');
  }

  getPriorities(): Promise<AdminPriority[]> {
    return apiClient.get<AdminPriority[]>('/admin/priorities');
  }

  getHelpTexts(): Promise<AdminHelpText[]> {
    return apiClient.get<AdminHelpText[]>('/admin/help-texts');
  }

  getWeekDays(): Promise<AdminWeekDay[]> {
    return apiClient.get<AdminWeekDay[]>('/admin/week-days');
  }

  updateWeekDays(input: WeekDaysInput): Promise<AdminWeekDay[]> {
    return apiClient.patch<AdminWeekDay[]>('/admin/week-days', input);
  }

  getNonWorkingDays(): Promise<AdminNonWorkingDay[]> {
    return apiClient.get<AdminNonWorkingDay[]>('/admin/non-working-days');
  }

  createNonWorkingDay(input: NonWorkingDayInput): Promise<AdminNonWorkingDay> {
    return apiClient.post<AdminNonWorkingDay>('/admin/non-working-days', input);
  }

  deleteNonWorkingDay(id: ID): Promise<void> {
    return apiClient.delete<void>(`/admin/non-working-days/${id}`);
  }

  getStorages(): Promise<AdminStorage[]> {
    return apiClient.get<AdminStorage[]>('/admin/storages');
  }

  /** Every project, archived ones included. */
  getProjects(): Promise<AdminProject[]> {
    return apiClient.get<AdminProject[]>('/admin/projects');
  }

  getNews(): Promise<AdminNews[]> {
    return apiClient.get<AdminNews[]>('/admin/news');
  }

  getVersions(): Promise<AdminVersion[]> {
    return apiClient.get<AdminVersion[]>('/admin/versions');
  }

  // Users settings, groups, placeholder users

  getUsersSettings(): Promise<UsersSettings> {
    return apiClient.get<UsersSettings>('/admin/settings/users');
  }

  updateUsersSettings(input: Partial<UsersSettingsInput>): Promise<UsersSettings> {
    return apiClient.patch<UsersSettings>('/admin/settings/users', input);
  }

  // Settings sections, described by the instance

  /** The sections this instance offers, without their fields. */
  getSettingsSections(): Promise<AdminSettingsSectionSummary[]> {
    return apiClient.get<AdminSettingsSectionSummary[]>('/admin/sections');
  }

  /** 404 when the instance has no settings under that heading. */
  getSettingsSection(id: string): Promise<AdminSettingsSection> {
    return apiClient.get<AdminSettingsSection>(`/admin/sections/${id}`);
  }

  /** The reply is the whole section as the instance now holds it. */
  updateSettingsSection(id: string, patch: SettingsSectionInput): Promise<AdminSettingsSection> {
    return apiClient.patch<AdminSettingsSection>(`/admin/sections/${id}`, patch);
  }

  // Catalogues, described by the instance

  /** The catalogues this instance offers, without their fields or rows. */
  getCatalogs(): Promise<AdminCatalogSummary[]> {
    return apiClient.get<AdminCatalogSummary[]>('/admin/catalog');
  }

  /** Descriptor and rows together: the rows are only readable through it. */
  getCatalog(resource: string): Promise<AdminCatalog> {
    return apiClient.get<AdminCatalog>(`/admin/catalog/${resource}`);
  }

  createCatalogRow(resource: string, input: CatalogRowInput): Promise<AdminCatalogRow> {
    return apiClient.post<AdminCatalogRow>(`/admin/catalog/${resource}`, input);
  }

  updateCatalogRow(
    resource: string,
    id: ID,
    input: CatalogRowInput,
  ): Promise<AdminCatalogRow> {
    return apiClient.patch<AdminCatalogRow>(`/admin/catalog/${resource}/${id}`, input);
  }

  /** 422 when the instance refuses, with its own reason as the message. */
  deleteCatalogRow(resource: string, id: ID): Promise<void> {
    return apiClient.delete<void>(`/admin/catalog/${resource}/${id}`);
  }

  createGroup(input: GroupInput): Promise<AdminGroup> {
    return apiClient.post<AdminGroup>('/admin/groups', input);
  }

  updateGroup(id: ID, input: Partial<GroupInput>): Promise<AdminGroup> {
    return apiClient.patch<AdminGroup>(`/admin/groups/${id}`, input);
  }

  deleteGroup(id: ID): Promise<void> {
    return apiClient.delete<void>(`/admin/groups/${id}`);
  }

  createPlaceholderUser(input: PlaceholderUserInput): Promise<AdminPlaceholderUser> {
    return apiClient.post<AdminPlaceholderUser>('/admin/placeholder-users', input);
  }

  deletePlaceholderUser(id: ID): Promise<void> {
    return apiClient.delete<void>(`/admin/placeholder-users/${id}`);
  }
}
