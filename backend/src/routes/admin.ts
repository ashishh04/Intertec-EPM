import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject, idFromHref, linkTitle } from '../openproject/client.js';
import type { HalCollection, HalLink, HalLinks } from '../openproject/types.js';
// Shared with the frontend rather than restated here: a section's shape is
// what the browser renders from, so both sides read it from one declaration.
import type {
  AdminCatalog,
  AdminCatalogSummary,
  AdminSettingsSection,
  AdminSettingsSectionSummary,
} from '../types/epm.js';

/**
 * Administration.
 *
 * The read side of docs/administration-design.md: what an administrator sees
 * on each live page of EPM's Administration area. Everything here is
 * OpenProject's own data, passed through with ids as strings and dates as ISO
 * strings; EPM stores nothing of its own.
 *
 * Every route is guarded on `users:manage`. Instance administration has no
 * capability of its own upstream, and managing users is the closest signal
 * OpenProject publishes for "this person administers the instance".
 *
 * Writes go two ways. Working days, non-working days, groups and placeholder
 * users are written through API v3. The users settings, the permission
 * catalogue and roles have no API upstream at all; they come from the
 * EPM-only `/epm_admin/*` endpoints that `backend/openproject/zzz_epm_admin_api.rb`
 * mounts into the instance (docs/administration-design.md, "Users and
 * permissions"). Everything else that OpenProject exposes only in its own
 * admin UI is described by the frontend rather than edited here.
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

export interface UsersSettings {
  defaultLanguage: string;
  availableLanguages: { code: string; label: string }[];
  /** IANA name; null means "the browser's". */
  userDefaultTimezone: string | null;
  /** IANA names, in OpenProject's UTC-offset order. */
  availableTimezones: string[];
  defaultAutoHidePopups: boolean;
  /** e.g. 'firstname_lastname' */
  userFormat: string;
  /** The label is the caller's own name in that format. */
  userFormatOptions: { value: string; label: string }[];
  usersDeletableByAdmins: boolean;
  usersDeletableBySelf: boolean;
  consentRequired: boolean;
  /** Language code → markdown. */
  consentInfo: Record<string, string>;
  /** ISO, the last time consent was reset; null when never. */
  consentTime: string | null;
  consentDeclineMail: string;
  /**
   * Keys of `UsersSettingsInput` the instance pins through environment or
   * configuration.yml (OpenProject disables those fields in its own form).
   * Sending one back unchanged is accepted; changing it is refused with 422.
   */
  readOnlySettings: (keyof UsersSettingsInput)[];
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
  /** true sets consent_time to now. */
  resetConsentTime: boolean;
  consentDeclineMail: string;
}

export interface AdminPermission {
  name: string;
  label: string;
  explanation: string | null;
  /** Grantable to global roles (and only to them). */
  global: boolean;
}

export interface AdminPermissionModule {
  /** 'project' for the module-less permissions. */
  id: string;
  label: string;
  permissions: AdminPermission[];
}

export type AdminRoleKind = 'project' | 'global' | 'work_package' | 'project_query';

export interface AdminRole {
  id: string;
  name: string;
  builtin: boolean;
  position: number;
  kind: AdminRoleKind;
  permissions: string[];
}

export interface AdminGroupMember {
  id: string;
  name: string;
}

export interface AdminGroup {
  id: string;
  name: string;
  memberCount: number;
  members: AdminGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminPlaceholderUser {
  id: string;
  name: string;
  createdAt: string;
}

export interface AdminType {
  id: string;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isMilestone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminStatus {
  id: string;
  name: string;
  color: string;
  position: number;
  isClosed: boolean;
  isDefault: boolean;
  isReadonly: boolean;
  defaultDoneRatio: number | null;
}

export interface AdminPriority {
  id: string;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface AdminHelpText {
  id: string;
  attribute: string;
  attributeCaption: string;
  scope: string;
  helpText: string;
}

export interface AdminWeekDay {
  day: number;
  name: string;
  working: boolean;
}

export interface AdminNonWorkingDay {
  id: string;
  name: string;
  date: string;
}

export interface AdminStorage {
  id: string;
  name: string;
  type: string;
  host: string;
  createdAt: string;
}

export interface AdminProject {
  id: string;
  identifier: string;
  name: string;
  active: boolean;
  public: boolean;
  createdAt: string;
  updatedAt: string;
  parentName: string;
}

export interface AdminNews {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  projectName: string;
  authorName: string;
}

export interface AdminVersion {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  sharing: string;
  projectName: string;
}

/* ---------------------------------------------------------------------------
 * Upstream shapes — only the fields read here.
 * ------------------------------------------------------------------------- */

interface OpRoot {
  instanceName?: string;
  coreVersion?: string;
}

interface OpConfiguration {
  hostName?: string;
  perPageOptions?: number[];
  maximumAttachmentFileSize?: number;
  dateFormat?: string | null;
  timeFormat?: string | null;
  durationFormat?: string;
  userDefaultTimezone?: string | null;
  startOfWeek?: number | null;
  hoursPerDay?: number;
  daysPerMonth?: number;
  allowedLinkProtocols?: string[];
  activeFeatureFlags?: string[];
}

interface OpNamed {
  id: number;
  name: string;
  _links?: HalLinks;
}

interface OpTimestamped extends OpNamed {
  createdAt?: string;
  updatedAt?: string;
}

interface OpGroup extends OpTimestamped {
  _links?: HalLinks & { members?: HalLink[] };
}

interface OpTypeResource extends OpTimestamped {
  color?: string;
  position?: number;
  isDefault?: boolean;
  isMilestone?: boolean;
}

interface OpStatusResource extends OpNamed {
  color?: string;
  position?: number;
  isClosed?: boolean;
  isDefault?: boolean;
  isReadonly?: boolean;
  defaultDoneRatio?: number | null;
}

interface OpPriorityResource extends OpNamed {
  color?: string;
  position?: number;
  isDefault?: boolean;
  isActive?: boolean;
}

interface OpHelpText {
  id: number;
  attribute?: string;
  attributeCaption?: string;
  scope?: string;
  helpText?: { raw?: string; html?: string } | string;
}

interface OpWeekDay {
  day: number;
  name?: string;
  working?: boolean;
}

interface OpNonWorkingDay {
  id: number;
  name?: string;
  date?: string;
}

interface OpStorage extends OpTimestamped {
  _links?: HalLinks & { type?: { href?: string | null; title?: string }; origin?: { href?: string | null } };
}

interface OpProjectResource extends OpTimestamped {
  identifier?: string;
  active?: boolean;
  public?: boolean;
}

interface OpNews {
  id: number;
  title?: string;
  summary?: string;
  createdAt?: string;
  _links?: HalLinks;
}

interface OpVersion extends OpNamed {
  status?: string;
  startDate?: string | null;
  endDate?: string | null;
  sharing?: string;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** The un-paginated collections: one GET, no offset/pageSize to negotiate. */
async function collection<T>(request: FastifyRequest, path: string): Promise<T[]> {
  const result = await openProject.request<HalCollection<T>>(path, {
    signal: requestSignal(request),
  });
  return result._embedded?.elements ?? [];
}

/** The paginated collections, walked to the end. */
async function all<T>(request: FastifyRequest, path: string): Promise<T[]> {
  const { items } = await openProject.getAll<T>(
    path,
    { pageSize: 100 },
    { signal: requestSignal(request) },
  );
  return items;
}

/**
 * Turns an upstream refusal of a calendar write into an answer that is true.
 *
 * A 422 becomes EPM's own validation error, message intact: OpenProject's
 * message is the one that says *which* day or date it refused and why.
 *
 * A 404 is not "no such day". OpenProject's API documentation describes
 * `PATCH /days/week`, `POST /days/non_working` and `DELETE /days/non_working`,
 * but the server mounts only the reads for them (checked against 15.5.1:
 * `lib/api/v3/days/week_api.rb` and `non_working_days_api.rb` define `get`
 * alone), so a write to those paths falls through to the API's not-found
 * handler. Reported as 501 rather than 404 because the calendar exists — it is
 * the operation the instance does not offer — and the message says where the
 * change can still be made.
 */
function rethrowWriteFailure(what: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof OpenProjectError) {
      if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
      if (error.upstreamStatus === 404) {
        throw new EpmError(
          501,
          'UPSTREAM_ERROR',
          `This OpenProject version does not allow ${what} to be changed through its API. Change it in OpenProject's own administration under Calendars and dates.`,
        );
      }
    }
    throw error;
  };
}

/**
 * A call to the EPM-only endpoints the initializer mounts under `/epm_admin`.
 *
 * Same client, same credential (the caller's token, so the instance applies
 * its own administrator check to the real person), only the prefix differs.
 * The instance answers `{ message }` on refusals, which the client already
 * surfaces as the error message; here the status is made to mean what it
 * means for this caller: 422 is a refused change, 404 a missing role, and
 * 403 says the caller manages users but is not an instance administrator,
 * which is the one case `users:manage` cannot tell apart on its own.
 */
async function instance<T>(
  request: FastifyRequest,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  try {
    return await openProject.request<T>(`/epm_admin${path}`, {
      ...options,
      root: true,
      signal: requestSignal(request),
    });
  } catch (error) {
    if (error instanceof OpenProjectError) {
      if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
      if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
      if (error.upstreamStatus === 404) throw EpmError.notFound('That role');
    }
    throw error;
  }
}

/**
 * Turns an upstream refusal of a group or placeholder-user write into EPM's
 * own error, message intact. A 402 or 403 on placeholder users is OpenProject
 * saying the feature needs the Enterprise edition, which for the caller is a
 * refused request rather than an integration fault, so it is reported as a
 * validation error carrying OpenProject's explanation.
 */
function rethrowPrincipalFailure(what: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof OpenProjectError) {
      if ([422, 402, 403].includes(error.upstreamStatus)) throw EpmError.validation(error.message);
      if (error.upstreamStatus === 404) throw EpmError.notFound(what);
    }
    throw error;
  };
}

const memberLinks = (group: OpGroup): HalLink[] => {
  const members = group._links?.members;
  return Array.isArray(members) ? members : [];
};

const toGroup = (group: OpGroup): AdminGroup => {
  const members = memberLinks(group).flatMap<AdminGroupMember>((link) => {
    const id = idFromHref(link.href);
    return id ? [{ id, name: str(link.title) }] : [];
  });
  return {
    id: String(group.id),
    name: group.name,
    memberCount: members.length,
    members,
    createdAt: str(group.createdAt),
    updatedAt: str(group.updatedAt),
  };
};

const toPlaceholderUser = (user: OpTimestamped): AdminPlaceholderUser => ({
  id: String(user.id),
  name: user.name,
  createdAt: str(user.createdAt),
});

/** The `_links.members` OpenProject expects when creating or updating a group. */
const memberHrefs = (ids: string[]) => ids.map((id) => ({ href: `/api/v3/users/${id}` }));

const toWeekDay = (day: OpWeekDay): AdminWeekDay => ({
  day: day.day,
  name: str(day.name),
  working: Boolean(day.working),
});

const toNonWorkingDay = (day: OpNonWorkingDay): AdminNonWorkingDay => ({
  id: String(day.id),
  name: str(day.name),
  date: str(day.date),
});

const toProject = (project: OpProjectResource): AdminProject => ({
  id: String(project.id),
  identifier: str(project.identifier),
  name: project.name,
  active: Boolean(project.active),
  public: Boolean(project.public),
  createdAt: str(project.createdAt),
  updatedAt: str(project.updatedAt),
  parentName: linkTitle(project._links, 'parent') ?? '',
});

async function weekDays(request: FastifyRequest): Promise<AdminWeekDay[]> {
  const days = await collection<OpWeekDay>(request, '/days/week');
  return days.map(toWeekDay).sort((a, b) => a.day - b.day);
}

/* ---------------------------------------------------------------------------
 * Request bodies
 * ------------------------------------------------------------------------- */

const weekDaysBody = z.object({
  days: z
    .array(
      z.object({
        day: z.number().int().min(1).max(7),
        working: z.boolean(),
      }),
    )
    .min(1),
});

const nonWorkingDayBody = z.object({
  name: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD form.'),
});

const numericId = z.string().regex(/^\d+$/, 'Expected a numeric id.');

/** Partial<UsersSettingsInput>; the instance validates the values themselves. */
const usersSettingsBody = z.object({
  defaultLanguage: z.string().trim().min(1).optional(),
  userDefaultTimezone: z.string().trim().nullable().optional(),
  defaultAutoHidePopups: z.boolean().optional(),
  userFormat: z.string().trim().min(1).optional(),
  usersDeletableByAdmins: z.boolean().optional(),
  usersDeletableBySelf: z.boolean().optional(),
  consentRequired: z.boolean().optional(),
  consentInfo: z.record(z.string(), z.string()).optional(),
  resetConsentTime: z.boolean().optional(),
  consentDeclineMail: z.string().trim().optional(),
});

/**
 * A section update is a partial map of field key to value. The shape is bounded
 * here; the instance validates the values themselves, because it is the only
 * side that knows which settings it pins and what each one accepts.
 */
/** A catalogue row is a flat map of field key to value; the instance validates. */
const catalogBody = z.record(
  z.string().trim().min(1),
  z.union([z.boolean(), z.number(), z.string(), z.null()]),
);

const sectionBody = z.record(
  z.string().trim().min(1),
  z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]),
);

const permissionNames = z.array(z.string().trim().min(1));

const roleCreateBody = z.object({
  name: z.string().trim().min(1),
  global: z.boolean().default(false),
  copyWorkflowFromRoleId: numericId.optional(),
  permissions: permissionNames.default([]),
});

const roleUpdateBody = z.object({
  name: z.string().trim().min(1).optional(),
  permissions: permissionNames.optional(),
});

const groupCreateBody = z.object({
  name: z.string().trim().min(1),
  memberIds: z.array(numericId).optional(),
});

const groupUpdateBody = z.object({
  name: z.string().trim().min(1).optional(),
  memberIds: z.array(numericId).optional(),
});

const placeholderUserBody = z.object({
  name: z.string().trim().min(1),
});

/* ---------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------- */

export const adminRoutes: FastifyPluginAsync = async (app) => {
  /** The instance itself: name, version, host, and what is switched on. */
  app.get('/admin/information', async (request): Promise<AdminInformation> => {
    await guard.require(request, 'users:manage');
    const signal = requestSignal(request);

    const [root, configuration] = await Promise.all([
      openProject.request<OpRoot>('/', { signal }),
      openProject.request<OpConfiguration>('/configuration', { signal }),
    ]);

    return {
      instanceName: str(root.instanceName),
      coreVersion: str(root.coreVersion),
      hostName: str(configuration.hostName),
      apiVersion: 'v3',
      activeFeatureFlags: configuration.activeFeatureFlags ?? [],
    };
  });

  /** The instance-wide settings OpenProject publishes read-only. */
  app.get('/admin/configuration', async (request): Promise<AdminConfiguration> => {
    await guard.require(request, 'users:manage');

    const c = await openProject.request<OpConfiguration>('/configuration', {
      signal: requestSignal(request),
    });

    return {
      hostName: str(c.hostName),
      perPageOptions: c.perPageOptions ?? [],
      maximumAttachmentFileSize: c.maximumAttachmentFileSize ?? 0,
      dateFormat: c.dateFormat ?? null,
      timeFormat: c.timeFormat ?? null,
      durationFormat: str(c.durationFormat),
      userDefaultTimezone: c.userDefaultTimezone ?? null,
      startOfWeek: c.startOfWeek ?? null,
      hoursPerDay: c.hoursPerDay ?? 0,
      daysPerMonth: c.daysPerMonth ?? 0,
      allowedLinkProtocols: c.allowedLinkProtocols ?? [],
      activeFeatureFlags: c.activeFeatureFlags ?? [],
    };
  });

  /* -------------------------------------------------------------- catalogues */

  /**
   * The catalogues OpenProject reads through API v3 but never lets anyone
   * write: types, statuses, priorities, custom fields, webhooks and OAuth
   * applications. `zzz_epm_admin_catalog.rb` serves them as a field descriptor
   * plus rows, so one page in the browser renders all six.
   */
  app.get('/admin/catalog', async (request): Promise<AdminCatalogSummary[]> => {
    await guard.require(request, 'users:manage');
    const body = await instance<{ catalogues: AdminCatalogSummary[] }>(request, '/catalog');
    return body.catalogues;
  });

  app.get<{ Params: { resource: string } }>('/admin/catalog/:resource', async (request) => {
    await guard.require(request, 'users:manage');
    return instance<AdminCatalog>(request, `/catalog/${encodeURIComponent(request.params.resource)}`);
  });

  app.post<{ Params: { resource: string }; Body: unknown }>(
    '/admin/catalog/:resource',
    async (request, reply) => {
      await guard.require(request, 'users:manage');
      const body = catalogBody.parse(request.body ?? {});
      const created = await instance<Record<string, unknown>>(
        request,
        `/catalog/${encodeURIComponent(request.params.resource)}`,
        { method: 'POST', body },
      );
      reply.code(201);
      return created;
    },
  );

  app.patch<{ Params: { resource: string; id: string }; Body: unknown }>(
    '/admin/catalog/:resource/:id',
    async (request) => {
      await guard.require(request, 'users:manage');
      const body = catalogBody.parse(request.body ?? {});
      return instance<Record<string, unknown>>(
        request,
        `/catalog/${encodeURIComponent(request.params.resource)}/${encodeURIComponent(request.params.id)}`,
        { method: 'PATCH', body },
      );
    },
  );

  /** 422 with the instance's own reason when the row is still in use. */
  app.delete<{ Params: { resource: string; id: string } }>(
    '/admin/catalog/:resource/:id',
    async (request, reply) => {
      await guard.require(request, 'users:manage');
      await instance<void>(
        request,
        `/catalog/${encodeURIComponent(request.params.resource)}/${encodeURIComponent(request.params.id)}`,
        { method: 'DELETE' },
      );
      reply.code(204);
    },
  );

  /* --------------------------------------------------------- settings sections */

  /**
   * The settings areas OpenProject exposes only as HTML forms, served by
   * `zzz_epm_admin_settings.rb` as field descriptors.
   *
   * EPM does not restate what each section contains: the instance describes
   * its own fields, their types and their choices, so a section that gains a
   * setting upstream gains it here without a change on either side of this
   * route.
   */
  app.get('/admin/sections', async (request): Promise<AdminSettingsSectionSummary[]> => {
    await guard.require(request, 'users:manage');
    const body = await instance<{ sections: AdminSettingsSectionSummary[] }>(request, '/sections');
    return body.sections;
  });

  app.get<{ Params: { id: string } }>('/admin/sections/:id', async (request) => {
    await guard.require(request, 'users:manage');
    return instance<AdminSettingsSection>(request, `/sections/${encodeURIComponent(request.params.id)}`);
  });

  /**
   * Partial update. The reply is the section as the instance now holds it, so
   * a value the instance normalised or refused is visible without a re-read.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/admin/sections/:id',
    async (request): Promise<AdminSettingsSection> => {
      await guard.require(request, 'users:manage');
      const body = sectionBody.parse(request.body ?? {});
      return instance<AdminSettingsSection>(
        request,
        `/sections/${encodeURIComponent(request.params.id)}`,
        { method: 'PATCH', body },
      );
    },
  );

  /* ----------------------------------------------------------- users settings */

  app.get('/admin/settings/users', async (request): Promise<UsersSettings> => {
    await guard.require(request, 'users:manage');
    return instance<UsersSettings>(request, '/settings/users');
  });

  /** Partial update; the reply is the whole object as the instance now holds it. */
  app.patch<{ Body: unknown }>('/admin/settings/users', async (request): Promise<UsersSettings> => {
    await guard.require(request, 'users:manage');
    const body = usersSettingsBody.parse(request.body ?? {});
    return instance<UsersSettings>(request, '/settings/users', { method: 'PATCH', body });
  });

  /* -------------------------------------------------------------- permissions */

  /** Every permission a role can be given, grouped as OpenProject's role form groups them. */
  app.get('/admin/permissions', async (request): Promise<AdminPermissionModule[]> => {
    await guard.require(request, 'users:manage');
    return instance<AdminPermissionModule[]>(request, '/permissions');
  });

  /* -------------------------------------------------------------------- roles */

  app.get('/admin/roles', async (request): Promise<AdminRole[]> => {
    await guard.require(request, 'users:manage');
    return instance<AdminRole[]>(request, '/roles');
  });

  app.post<{ Body: unknown }>('/admin/roles', async (request, reply): Promise<AdminRole> => {
    await guard.require(request, 'users:manage');
    const body = roleCreateBody.parse(request.body ?? {});

    const created = await instance<AdminRole>(request, '/roles', { method: 'POST', body });
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/admin/roles/:id',
    async (request): Promise<AdminRole> => {
      await guard.require(request, 'users:manage');
      const { id } = request.params;
      if (!/^\d+$/.test(id)) throw EpmError.notFound('That role');
      const body = roleUpdateBody.parse(request.body ?? {});

      return instance<AdminRole>(request, `/roles/${id}`, { method: 'PATCH', body });
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/roles/:id', async (request, reply) => {
    await guard.require(request, 'users:manage');
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That role');

    await instance<void>(request, `/roles/${id}`, { method: 'DELETE' });
    reply.code(204);
  });

  /* ------------------------------------------------------------------- groups */

  /** Groups with their members, resolved from the group's `members` links. */
  app.get('/admin/groups', async (request): Promise<AdminGroup[]> => {
    await guard.require(request, 'users:manage');
    const groups = await all<OpGroup>(request, '/groups');
    return groups.map(toGroup);
  });

  app.post<{ Body: unknown }>('/admin/groups', async (request, reply): Promise<AdminGroup> => {
    await guard.require(request, 'users:manage');
    const { name, memberIds } = groupCreateBody.parse(request.body ?? {});

    const created = await openProject
      .request<OpGroup>('/groups', {
        method: 'POST',
        body: {
          name,
          ...(memberIds ? { _links: { members: memberHrefs(memberIds) } } : {}),
        },
        signal: requestSignal(request),
      })
      .catch(rethrowPrincipalFailure('That group'));

    reply.code(201);
    return toGroup(created);
  });

  /** Renames a group and/or replaces its membership with `memberIds`. */
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/admin/groups/:id',
    async (request): Promise<AdminGroup> => {
      await guard.require(request, 'users:manage');
      const { id } = request.params;
      if (!/^\d+$/.test(id)) throw EpmError.notFound('That group');
      const { name, memberIds } = groupUpdateBody.parse(request.body ?? {});

      const updated = await openProject
        .request<OpGroup>(`/groups/${id}`, {
          method: 'PATCH',
          body: {
            ...(name !== undefined ? { name } : {}),
            ...(memberIds ? { _links: { members: memberHrefs(memberIds) } } : {}),
          },
          signal: requestSignal(request),
        })
        .catch(rethrowPrincipalFailure('That group'));

      return toGroup(updated);
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/groups/:id', async (request, reply) => {
    await guard.require(request, 'users:manage');
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That group');

    await openProject
      .request<void>(`/groups/${id}`, { method: 'DELETE', signal: requestSignal(request) })
      .catch(rethrowPrincipalFailure('That group'));

    reply.code(204);
  });

  /* -------------------------------------------------------- placeholder users */

  app.get('/admin/placeholder-users', async (request): Promise<AdminPlaceholderUser[]> => {
    await guard.require(request, 'users:manage');
    const users = await all<OpTimestamped>(request, '/placeholder_users');
    return users.map(toPlaceholderUser);
  });

  /**
   * Creates a placeholder user. On a Community instance OpenProject refuses
   * this as an Enterprise feature; that refusal reaches the caller as a 422
   * carrying OpenProject's own explanation.
   */
  app.post<{ Body: unknown }>(
    '/admin/placeholder-users',
    async (request, reply): Promise<AdminPlaceholderUser> => {
      await guard.require(request, 'users:manage');
      const { name } = placeholderUserBody.parse(request.body ?? {});

      const created = await openProject
        .request<OpTimestamped>('/placeholder_users', {
          method: 'POST',
          body: { name },
          signal: requestSignal(request),
        })
        .catch(rethrowPrincipalFailure('That placeholder user'));

      reply.code(201);
      return toPlaceholderUser(created);
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/placeholder-users/:id', async (request, reply) => {
    await guard.require(request, 'users:manage');
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That placeholder user');

    await openProject
      .request<void>(`/placeholder_users/${id}`, { method: 'DELETE', signal: requestSignal(request) })
      .catch(rethrowPrincipalFailure('That placeholder user'));

    reply.code(204);
  });

  app.get('/admin/types', async (request): Promise<AdminType[]> => {
    await guard.require(request, 'users:manage');
    const types = await all<OpTypeResource>(request, '/types');

    return types
      .map<AdminType>((type) => ({
        id: String(type.id),
        name: type.name,
        color: str(type.color),
        position: type.position ?? 0,
        isDefault: Boolean(type.isDefault),
        isMilestone: Boolean(type.isMilestone),
        createdAt: str(type.createdAt),
        updatedAt: str(type.updatedAt),
      }))
      .sort(byPosition);
  });

  app.get('/admin/statuses', async (request): Promise<AdminStatus[]> => {
    await guard.require(request, 'users:manage');
    const statuses = await all<OpStatusResource>(request, '/statuses');

    return statuses
      .map<AdminStatus>((status) => ({
        id: String(status.id),
        name: status.name,
        color: str(status.color),
        position: status.position ?? 0,
        isClosed: Boolean(status.isClosed),
        isDefault: Boolean(status.isDefault),
        isReadonly: Boolean(status.isReadonly),
        defaultDoneRatio:
          typeof status.defaultDoneRatio === 'number' ? status.defaultDoneRatio : null,
      }))
      .sort(byPosition);
  });

  app.get('/admin/priorities', async (request): Promise<AdminPriority[]> => {
    await guard.require(request, 'users:manage');
    const priorities = await all<OpPriorityResource>(request, '/priorities');

    return priorities
      .map<AdminPriority>((priority) => ({
        id: String(priority.id),
        name: priority.name,
        color: str(priority.color),
        position: priority.position ?? 0,
        isDefault: Boolean(priority.isDefault),
        isActive: priority.isActive ?? true,
      }))
      .sort(byPosition);
  });

  /** Attribute help texts. The text is the raw (markdown) form. */
  app.get('/admin/help-texts', async (request): Promise<AdminHelpText[]> => {
    await guard.require(request, 'users:manage');
    const helpTexts = await collection<OpHelpText>(request, '/help_texts');

    return helpTexts.map((entry) => ({
      id: String(entry.id),
      attribute: str(entry.attribute),
      attributeCaption: str(entry.attributeCaption),
      scope: str(entry.scope),
      helpText:
        typeof entry.helpText === 'string' ? entry.helpText : str(entry.helpText?.raw),
    }));
  });

  app.get('/admin/week-days', async (request): Promise<AdminWeekDay[]> => {
    await guard.require(request, 'users:manage');
    return weekDays(request);
  });

  /**
   * Sets which days of the week are working days.
   *
   * Written in the shape OpenProject documents for `PATCH /days/week`: the
   * changed days embedded as elements. The reply is a fresh read rather than
   * the PATCH response, so the caller sees exactly what the instance now holds.
   */
  app.patch<{ Body: unknown }>('/admin/week-days', async (request): Promise<AdminWeekDay[]> => {
    await guard.require(request, 'users:manage');
    const { days } = weekDaysBody.parse(request.body ?? {});

    await openProject
      .request<unknown>('/days/week', {
        method: 'PATCH',
        body: { _embedded: { elements: days.map(({ day, working }) => ({ day, working })) } },
        signal: requestSignal(request),
      })
      .catch(rethrowWriteFailure('working days'));

    return weekDays(request);
  });

  app.get('/admin/non-working-days', async (request): Promise<AdminNonWorkingDay[]> => {
    await guard.require(request, 'users:manage');
    const days = await collection<OpNonWorkingDay>(request, '/days/non_working');
    return days.map(toNonWorkingDay).sort((a, b) => a.date.localeCompare(b.date));
  });

  app.post<{ Body: unknown }>(
    '/admin/non-working-days',
    async (request, reply): Promise<AdminNonWorkingDay> => {
      await guard.require(request, 'users:manage');
      const { name, date } = nonWorkingDayBody.parse(request.body ?? {});

      const created = await openProject
        .request<OpNonWorkingDay>('/days/non_working', {
          method: 'POST',
          body: { name, date },
          signal: requestSignal(request),
        })
        .catch(rethrowWriteFailure('non-working days'));

      reply.code(201);
      return toNonWorkingDay(created);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/non-working-days/:id',
    async (request, reply) => {
      await guard.require(request, 'users:manage');
      const { id } = request.params;
      if (!/^\d+$/.test(id)) throw EpmError.notFound('That non-working day');

      await openProject
        .request<void>(`/days/non_working/${id}`, {
          method: 'DELETE',
          signal: requestSignal(request),
        })
        .catch(rethrowWriteFailure('non-working days'));

      reply.code(204);
    },
  );

  /** External file storages. Type is the storage type's title; host its origin. */
  app.get('/admin/storages', async (request): Promise<AdminStorage[]> => {
    await guard.require(request, 'users:manage');
    const storages = await collection<OpStorage>(request, '/storages');

    return storages.map((storage) => ({
      id: String(storage.id),
      name: storage.name,
      type: str(storage._links?.type?.title),
      host: str(storage._links?.origin?.href),
      createdAt: str(storage.createdAt),
    }));
  });

  /**
   * Every project, archived ones included.
   *
   * OpenProject's default listing is the visible set, and whether an archived
   * project counts as visible has varied between versions. Rather than depend
   * on that, the archived ones are asked for explicitly with `active = f` and
   * merged in, de-duplicated by id — harmless when the default already had
   * them, and the only way to get them when it did not.
   */
  app.get('/admin/projects', async (request): Promise<AdminProject[]> => {
    await guard.require(request, 'users:manage');
    const signal = requestSignal(request);

    const [visible, archived] = await Promise.all([
      openProject.getAll<OpProjectResource>('/projects', { pageSize: 100 }, { signal }),
      openProject.getAll<OpProjectResource>(
        '/projects',
        { pageSize: 100, filters: [{ field: 'active', operator: '=', values: ['f'] }] },
        { signal },
      ),
    ]);

    const byId = new Map<string, AdminProject>();
    for (const project of [...visible.items, ...archived.items]) {
      const mapped = toProject(project);
      if (!byId.has(mapped.id)) byId.set(mapped.id, mapped);
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** News across every project, newest first. */
  app.get('/admin/news', async (request): Promise<AdminNews[]> => {
    await guard.require(request, 'users:manage');
    const news = await all<OpNews>(request, '/news');

    return news
      .map<AdminNews>((entry) => ({
        id: String(entry.id),
        title: str(entry.title),
        summary: str(entry.summary),
        createdAt: str(entry.createdAt),
        projectName: linkTitle(entry._links, 'project') ?? '',
        authorName: linkTitle(entry._links, 'author') ?? '',
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  /** Versions across every project — EPM's sprints, from the instance's view. */
  app.get('/admin/versions', async (request): Promise<AdminVersion[]> => {
    await guard.require(request, 'users:manage');
    const versions = await all<OpVersion>(request, '/versions');

    return versions.map((version) => ({
      id: String(version.id),
      name: version.name,
      status: str(version.status),
      startDate: version.startDate ?? null,
      endDate: version.endDate ?? null,
      sharing: str(version.sharing),
      projectName: linkTitle(version._links, 'definingProject') ?? '',
    }));
  });
};
