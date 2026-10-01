import { apiClient } from './client';
import type { ID } from '@/types';

/**
 * OpenProject Form endpoints.
 *
 * A Form is OpenProject describing one of its own resources: which fields
 * exist, which are writable, what values each permits, and what is currently
 * invalid. Rendering from it is how the UI covers every field an instance
 * defines — custom fields included, with no code of their own.
 *
 * Posting a partial payload returns the same schema with `errors` populated.
 * Validation therefore lives in OpenProject, never restated here.
 */

export type SchemaFieldType =
  | 'String'
  | 'Formattable'
  | 'Integer'
  | 'Float'
  | 'Duration'
  | 'Boolean'
  | 'Date'
  | 'DateTime'
  | 'User'
  | 'Status'
  | 'Type'
  | 'Priority'
  | 'Version'
  | 'Category'
  | 'Project'
  | 'CustomOption'
  | (string & {});

export interface SchemaField {
  type: SchemaFieldType;
  name: string;
  required?: boolean;
  hasDefault?: boolean;
  writable?: boolean;
  /** Groups fields the way OpenProject groups them in its own form. */
  attributeGroup?: string;
  location?: string;
  options?: Record<string, unknown>;
  _embedded?: { allowedValues?: { id?: number; name?: string; href?: string }[] };
  _links?: {
    allowedValues?: { href: string; title?: string }[] | { href: string };
  };
}

export interface FormResult {
  schema: Record<string, SchemaField | unknown>;
  payload: Record<string, unknown>;
  /** Attribute -> message. Empty when the payload is valid. */
  errors: Record<string, string>;
  /** Absent while the payload is invalid or the caller may not commit. */
  commit?: { href: string; method: string };
}

export class ApiFormRepository {
  /**
   * `typeId` is passed as an id rather than a link: the type decides which
   * fields the schema has, so it is chosen before anything else, and building
   * the link is the backend's job.
   */
  workPackageCreateForm(
    projectId: ID,
    payload?: Record<string, unknown>,
    typeId?: ID,
  ): Promise<FormResult> {
    return apiClient.post<FormResult>('/forms/work-packages', { projectId, typeId, payload });
  }

  workPackageEditForm(id: ID, payload?: Record<string, unknown>): Promise<FormResult> {
    return apiClient.post<FormResult>(`/forms/work-packages/${id}`, { payload });
  }

  projectCreateForm(payload?: Record<string, unknown>): Promise<FormResult> {
    return apiClient.post<FormResult>('/forms/projects', { payload });
  }

  projectEditForm(id: ID, payload?: Record<string, unknown>): Promise<FormResult> {
    return apiClient.post<FormResult>(`/forms/projects/${id}`, { payload });
  }

  membershipForm(payload?: Record<string, unknown>): Promise<FormResult> {
    return apiClient.post<FormResult>('/forms/memberships', { payload });
  }

  /**
   * Schema for logging time, with the activities this project allows.
   *
   * A work package implies its project, so either scope is enough. The call
   * also answers whether this person may log time at all — EPM has no
   * capability for it, so OpenProject decides and refuses with its own reason.
   */
  timeEntryForm(
    scope: { projectId?: ID; workPackageId?: ID } = {},
    payload?: Record<string, unknown>,
  ): Promise<FormResult> {
    return apiClient.post<FormResult>('/forms/time-entries', { ...scope, payload });
  }
}

/** Writable fields in OpenProject's own grouping and order. */
export function writableFields(schema: FormResult['schema']): [string, SchemaField][] {
  return Object.entries(schema)
    .filter((entry): entry is [string, SchemaField] => {
      const [key, field] = entry;
      return (
        key !== '_type' &&
        key !== '_links' &&
        typeof field === 'object' &&
        field !== null &&
        (field as SchemaField).writable === true
      );
    })
    .sort(([, a], [, b]) => (a.attributeGroup ?? '').localeCompare(b.attributeGroup ?? ''));
}

export interface AllowedValue {
  id: ID;
  name: string;
  href: string;
}

/** The trailing id of a HAL self link. */
export function idFromHref(href?: string): string | undefined {
  return href?.split('/').filter(Boolean).pop();
}

/**
 * The options a schema field offers, when it carries them inline.
 *
 * Three shapes, all of which appear on this instance:
 *
 * - **embedded** — the full resources. Their href is at `_links.self.href`,
 *   *not* a top-level `href`. Reading the wrong one produced a bare id where a
 *   link was required: saving a project status sent `on_track` and upstream
 *   answered "a link like /api/v3/project_statuses/:id is expected".
 * - **an array of links** — href and title directly.
 * - **a single link to fetch** — not handled here; `assignee`, `responsible`
 *   and a project's `parent` are all this kind. See `allowedValuesHref`.
 */
export function allowedValuesOf(field: SchemaField): AllowedValue[] | undefined {
  const embedded = field._embedded?.allowedValues;
  if (embedded?.length) {
    return embedded
      .map((value) => {
        const record = value as unknown as {
          id?: unknown;
          name?: string;
          value?: string;
          href?: string;
          _links?: { self?: { href?: string } };
        };
        const href = record._links?.self?.href ?? record.href;
        const id = record.id !== undefined ? String(record.id) : idFromHref(href);
        // A custom option labels itself `value`; everything else uses `name`.
        // Requiring `name` dropped every option of a list custom field, which
        // is why "EPM Test Severity" rendered as an empty dropdown.
        const label = record.name ?? record.value;
        return id && label && href ? { id, name: label, href } : undefined;
      })
      .filter((value): value is AllowedValue => Boolean(value));
  }

  const linked = field._links?.allowedValues;
  if (Array.isArray(linked) && linked.length) {
    return linked
      .map((link) => {
        const id = idFromHref(link.href);
        return id ? { id, name: link.title ?? id, href: link.href } : undefined;
      })
      .filter((value): value is AllowedValue => Boolean(value));
  }

  return undefined;
}

/** The href to fetch options from, where the schema offers one instead. */
export function allowedValuesHref(field: SchemaField): string | undefined {
  const linked = field._links?.allowedValues as { href?: string } | undefined;
  if (!linked || Array.isArray(linked)) return undefined;
  return typeof linked.href === 'string' ? linked.href : undefined;
}

/** One writable field off a form, when the schema defines it. */
export function schemaField(
  form: FormResult | undefined,
  name: string,
): SchemaField | undefined {
  const field = form?.schema?.[name];
  return field && typeof field === 'object' ? (field as SchemaField) : undefined;
}

/** Full-fidelity work package writes, bypassing the normalized task model. */
export class ApiWorkPackageRepository {
  /** `typeId` is linked by the backend; the browser never builds the URL. */
  create(projectId: ID, payload: Record<string, unknown>, typeId?: ID) {
    return apiClient.post<{ id: ID; subject: string; lockVersion: number }>('/work-packages', {
      projectId,
      typeId,
      payload,
    });
  }

  update(id: ID, payload: Record<string, unknown>) {
    return apiClient.patch<{ id: ID; subject: string; lockVersion: number }>(
      `/work-packages/${id}`,
      { payload },
    );
  }
}

/** Full-fidelity project writes, bypassing the normalized project model. */
export class ApiProjectWriteRepository {
  create(payload: Record<string, unknown>) {
    return apiClient.post<{ id: ID; name: string }>('/projects', { payload });
  }

  update(id: ID, payload: Record<string, unknown>) {
    return apiClient.patch<{ id: ID; name: string }>(`/projects/${id}`, { payload });
  }

  archive(id: ID) {
    return apiClient.patch<{ id: ID; name: string; active: boolean }>(`/projects/${id}/archive`);
  }

  /** Undoes an archive. Reversible, unlike `remove`. */
  restore(id: ID) {
    return apiClient.patch<{ id: ID; name: string; active: boolean }>(`/projects/${id}/restore`);
  }

  /** Permanent, and takes every work package in the project with it. */
  remove(id: ID) {
    return apiClient.delete<void>(`/projects/${id}`);
  }
}
