import { idFromHref, openProject } from '../openproject/client.js';
import { calculatedCustomFieldKeys } from './calculated-fields.js';

/**
 * The task fields a project offers beyond the import's fixed columns, for the
 * template, the export and the import to agree on: its custom fields, by the
 * names an administrator gave them, and its categories.
 *
 * A custom field is offered when the project's form schema says it can be
 * written, and EPM does not work its value out itself: calculated fields
 * (calculated-fields.ts) and the float the schedule writes (critical-path.ts)
 * are left out, as a typed-in value would only be overwritten. Fields that hold
 * several values, or kinds a sheet cannot carry, are left out too.
 */

export type FieldFormat = 'string' | 'text' | 'int' | 'float' | 'bool' | 'date' | 'option' | 'user';

export interface TaskField {
  /** customField<N>. */
  key: string;
  name: string;
  format: FieldFormat;
  /** List fields: option value (lower case) → option id, and back. */
  options: Map<string, string>;
  optionValues: Map<string, string>;
  /** Types the field belongs to: a value given for a task of another type is refused. */
  types: Set<string>;
}

/** The custom fields the schedule writes its float into: worked out for each task, never set by hand. */
export const SCHEDULE_FIELD_NAMES = new Set(['Total float (days)', 'Free float (days)', 'On critical path']);

const FORMATS: Record<string, FieldFormat> = {
  String: 'string',
  Formattable: 'text',
  Integer: 'int',
  Float: 'float',
  Boolean: 'bool',
  Date: 'date',
  CustomOption: 'option',
  User: 'user',
};

interface SchemaEntry {
  type?: string;
  name?: string;
  writable?: boolean;
  _embedded?: { allowedValues?: { id?: number; value?: string; _links?: { self?: { href?: string } } }[] };
  _links?: { allowedValues?: { href?: string } | { href?: string; title?: string }[] };
}

export interface ProjectFields {
  fields: TaskField[];
  /** Category name (lower case) → id. */
  categories: Map<string, string>;
  categoryNames: string[];
  /** Whether Done % can be set: not when the instance derives it from status. */
  progressWritable: boolean;
}

/** The schema of the form for a new task of a type in the project: it lists what can be chosen. */
const forms = new Map<string, Promise<Record<string, SchemaEntry>>>();
function formSchema(projectId: number, typeId: string): Promise<Record<string, SchemaEntry>> {
  const key = `${projectId}-${typeId}`;
  if (!forms.has(key)) {
    forms.set(
      key,
      openProject
        .request<{ _embedded?: { schema?: Record<string, SchemaEntry> } }>(`/projects/${projectId}/work_packages/form`, {
          method: 'POST',
          body: { _links: { type: { href: `/api/v3/types/${typeId}` } } },
        })
        .then((form) => form._embedded?.schema ?? {})
        .catch(() => ({})),
    );
    // Read afresh next time: options change.
    setTimeout(() => forms.delete(key), 60_000).unref?.();
  }
  return forms.get(key)!;
}

/** The project's fields, read from its form schema for each of the given types. */
export async function projectFields(projectId: number, typeIds: string[]): Promise<ProjectFields> {
  const [schemas, categories, calculated] = await Promise.all([
    Promise.all(typeIds.map((typeId) => openProject.request<Record<string, SchemaEntry>>(`/work_packages/schemas/${projectId}-${typeId}`).then((schema) => ({ typeId, schema })).catch(() => null))),
    openProject.getAll<{ id: number; name: string }>(`/projects/${projectId}/categories`, { pageSize: 200 }).catch(() => ({ items: [] as { id: number; name: string }[] })),
    calculatedCustomFieldKeys().catch(() => [] as string[]),
  ]);
  const skip = new Set(calculated);
  const fields = new Map<string, TaskField>();
  let progressWritable = true;
  for (const entry of schemas) {
    if (!entry) continue;
    if ((entry.schema.percentageDone as SchemaEntry | undefined)?.writable === false) progressWritable = false;
    for (const [key, value] of Object.entries(entry.schema)) {
      if (!/^customField\d+$/.test(key) || !value?.writable || skip.has(key) || SCHEDULE_FIELD_NAMES.has(value.name ?? '')) continue;
      const format = FORMATS[value.type ?? ''];
      if (!format || !value.name) continue;
      const field = fields.get(key) ?? { key, name: value.name, format, options: new Map(), optionValues: new Map(), types: new Set<string>() };
      field.types.add(entry.typeId);
      if (format === 'option' && field.options.size === 0) {
        // The schema alone does not list a list's options; the form for a new task of the type does.
        const listed = value._embedded?.allowedValues?.length ? value : ((await formSchema(projectId, entry.typeId))[key] ?? value);
        for (const option of listed._embedded?.allowedValues ?? []) {
          const id = option.id !== undefined ? String(option.id) : idFromHref(option._links?.self?.href);
          if (!id || !option.value) continue;
          field.options.set(option.value.trim().toLowerCase(), id);
          field.optionValues.set(id, option.value);
        }
        const links = listed._links?.allowedValues;
        for (const option of Array.isArray(links) ? links : []) {
          const id = idFromHref(option.href);
          if (!id || !option.title || field.optionValues.has(id)) continue;
          field.options.set(option.title.trim().toLowerCase(), id);
          field.optionValues.set(id, option.title);
        }
      }
      fields.set(key, field);
    }
  }
  return {
    fields: [...fields.values()].sort((a, b) => Number(a.key.slice(11)) - Number(b.key.slice(11))),
    categories: new Map(categories.items.map((category) => [category.name.toLowerCase(), String(category.id)])),
    categoryNames: categories.items.map((category) => category.name),
    progressWritable,
  };
}

/** A work package's value of a field as a sheet shows it; and, for a list or a person, its id. */
export function fieldValue(item: Record<string, unknown>, field: TaskField): { text: string; id: string | null } {
  const links = (item._links ?? {}) as Record<string, { href?: string | null; title?: string } | undefined>;
  if (field.format === 'option' || field.format === 'user') {
    const link = links[field.key];
    return { text: link?.title ?? '', id: idFromHref(link?.href ?? undefined) ?? null };
  }
  const value = item[field.key];
  if (value === null || value === undefined) return { text: '', id: null };
  if (field.format === 'text') return { text: String((value as { raw?: string }).raw ?? ''), id: null };
  if (field.format === 'bool') return { text: value ? 'Yes' : 'No', id: null };
  return { text: String(value), id: null };
}

/** Yes or no, as people write it in a sheet. */
export function parseYesNo(raw: string): boolean | null | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (['yes', 'y', 'true', '1', 'x', 'manual'].includes(value)) return true;
  if (['no', 'n', 'false', '0', 'automatic', 'auto'].includes(value)) return false;
  return undefined;
}
