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

  timeEntryForm(payload?: Record<string, unknown>): Promise<FormResult> {
    return apiClient.post<FormResult>('/forms/time-entries', { payload });
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
