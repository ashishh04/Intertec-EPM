import { useMemo } from 'react';
import { Input, Textarea } from '@/components/ui/input';
import { Label, FieldError, FieldHint } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { writableFields, type SchemaField, type FormResult } from '@/services/api/forms';
import { useAllowedValues } from '@/hooks/useCatalog';

/** Sentinel for "no value", since a select cannot hold an empty string. */
const NONE = '__none__';

/**
 * Renders a form from an OpenProject schema.
 *
 * Every writable field an instance defines appears here, in OpenProject's own
 * grouping — including custom fields, which arrive as ordinary schema entries
 * and so need no code of their own. Adding a custom field in OpenProject's
 * administration makes it appear here with no change to this file.
 */

interface SchemaFormProps {
  form?: FormResult;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (field: string, value: unknown) => void;
  isLoading?: boolean;
  /** Render only these attributes, in this order. Defaults to all writable. */
  only?: string[];
  /** Never render these, e.g. a project fixed by context. */
  exclude?: string[];
  className?: string;
}

/** A HAL resource value is `{ href }`; a scalar is itself. */
function hrefOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'href' in value) {
    return (value as { href?: string }).href ?? undefined;
  }
  return undefined;
}

function idFromHref(href?: string): string | undefined {
  return href?.split('/').filter(Boolean).pop();
}

interface AllowedValue {
  id: string;
  name: string;
  href: string;
}

/**
 * The options a field offers, when the schema carries them.
 *
 * Three shapes, all of which appear on this instance:
 *
 * - **embedded** — the full resources. Their href is at `_links.self.href`,
 *   *not* a top-level `href`. Reading the wrong one produced a bare id where a
 *   link was required: saving a project status sent `on_track` and upstream
 *   answered "a link like /api/v3/project_statuses/:id is expected".
 * - **an array of links** — href and title directly.
 * - **a single link to fetch** — handled by the caller, not here; `assignee`,
 *   `responsible` and a project's `parent` are all this kind.
 */
function allowedValuesOf(field: SchemaField): AllowedValue[] | undefined {
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
function allowedValuesHref(field: SchemaField): string | undefined {
  const linked = field._links?.allowedValues as { href?: string } | undefined;
  if (!linked || Array.isArray(linked)) return undefined;
  return typeof linked.href === 'string' ? linked.href : undefined;
}

/** A resource value's own label, for showing what is set without a picker. */
function titleOf(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const record = value as { title?: string; name?: string };
    return record.title ?? record.name;
  }
  return undefined;
}

/**
 * A picker whose options the schema publishes as a link rather than inline.
 *
 * Fetched lazily and cached by href: a user list can be large, and several
 * fields on one form point at the same collection.
 */
function FetchedSelect({
  name,
  field,
  error,
  href,
  value,
  onChange,
}: {
  name: string;
  field: SchemaField;
  error?: string;
  href: string;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
}) {
  const options = useAllowedValues(href);
  const current = hrefOf(value) ?? '';
  const list = options.data ?? [];

  return (
    <FieldRow name={name} field={field} error={error}>
      <Select
        value={current}
        onValueChange={(next) => onChange(name, next === NONE ? null : { href: next })}
        disabled={options.isLoading}
      >
        <SelectTrigger id={`schema-${name}`} aria-invalid={Boolean(error)}>
          <SelectValue
            placeholder={
              options.isLoading ? 'Loading…' : `Select ${field.name.toLowerCase()}`
            }
          />
        </SelectTrigger>
        <SelectContent>
          {/* Clearing has to be possible: these fields are optional, and a
              picker with no empty choice cannot be undone. */}
          {field.required ? null : <SelectItem value={NONE}>None</SelectItem>}
          {list.map((option) => (
            <SelectItem key={option.href} value={option.href}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!options.isLoading && list.length === 0 ? (
        <FieldHint>Nothing to choose from.</FieldHint>
      ) : null}
    </FieldRow>
  );
}

function FieldRow({
  name,
  field,
  error,
  children,
}: {
  name: string;
  field: SchemaField;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`schema-${name}`} required={field.required}>
        {field.name}
      </Label>
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

export function SchemaForm({
  form,
  values,
  errors,
  onChange,
  isLoading,
  only,
  exclude,
  className,
}: SchemaFormProps) {
  const fields = useMemo(() => {
    if (!form) return [];
    let entries = writableFields(form.schema);

    if (only?.length) {
      const order = new Map(only.map((key, index) => [key, index]));
      entries = entries
        .filter(([key]) => order.has(key))
        .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }
    if (exclude?.length) entries = entries.filter(([key]) => !exclude.includes(key));

    return entries;
  }, [form, only, exclude]);

  if (isLoading && !form) {
    return (
      <div className={cn('space-y-4', className)}>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!form) return null;

  return (
    <div className={cn('space-y-4', className)}>
      {fields.map(([name, field]) => {
        const error = errors[name];
        const links = values._links as Record<string, unknown> | undefined;
        const raw = values[name] ?? links?.[name];
        const options = allowedValuesOf(field);

        // Options the schema publishes as a link rather than inline. Fetched
        // through the backend, which is why `assignee`, `responsible` and a
        // project's `parent` are pickers now instead of text boxes showing
        // "[object Object]".
        const fetchHref = options ? undefined : allowedValuesHref(field);
        if (fetchHref) {
          return (
            <FetchedSelect
              key={name}
              name={name}
              field={field}
              error={error}
              href={fetchHref}
              value={raw}
              onChange={onChange}
            />
          );
        }

        // Anything with an enumerated set renders as a select, whatever its
        // type — status, type, priority, version, category, user, custom option.
        if (options?.length) {
          const current = idFromHref(hrefOf(raw)) ?? (raw == null ? '' : String(raw));
          return (
            <FieldRow key={name} name={name} field={field} error={error}>
              <Select
                value={current}
                onValueChange={(next) => {
                  const chosen = options.find((option) => option.id === next);
                  onChange(name, chosen ? { href: chosen.href } : next);
                }}
              >
                <SelectTrigger id={`schema-${name}`} aria-invalid={Boolean(error)}>
                  <SelectValue placeholder={`Select ${field.name.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          );
        }

        switch (field.type) {
          case 'Boolean':
            return (
              // The same toggle row as every other switch in the product, so a
              // schema-driven boolean does not look like a stray control.
              <div
                key={name}
                className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <Label htmlFor={`schema-${name}`} required={field.required}>
                    {field.name}
                  </Label>
                  {error ? <FieldError className="mt-0.5">{error}</FieldError> : null}
                </div>
                <Switch
                  id={`schema-${name}`}
                  checked={Boolean(raw)}
                  onCheckedChange={(checked) => onChange(name, checked)}
                />
              </div>
            );

          case 'Formattable': {
            const text =
              raw && typeof raw === 'object' && 'raw' in raw
                ? String((raw as { raw?: string }).raw ?? '')
                : String(raw ?? '');
            return (
              <FieldRow key={name} name={name} field={field} error={error}>
                <Textarea
                  id={`schema-${name}`}
                  rows={4}
                  value={text}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => onChange(name, { raw: event.target.value })}
                />
              </FieldRow>
            );
          }

          case 'Integer':
          case 'Float':
            return (
              <FieldRow key={name} name={name} field={field} error={error}>
                <Input
                  id={`schema-${name}`}
                  type="number"
                  value={raw == null ? '' : String(raw)}
                  aria-invalid={Boolean(error)}
                  onChange={(event) =>
                    onChange(name, event.target.value === '' ? null : Number(event.target.value))
                  }
                />
              </FieldRow>
            );

          case 'Date':
          case 'DateTime':
            return (
              <FieldRow key={name} name={name} field={field} error={error}>
                <Input
                  id={`schema-${name}`}
                  type="date"
                  value={raw ? String(raw).slice(0, 10) : ''}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => onChange(name, event.target.value || null)}
                />
              </FieldRow>
            );

          case 'Duration':
            return (
              <FieldRow key={name} name={name} field={field} error={error}>
                <Input
                  id={`schema-${name}`}
                  placeholder="e.g. PT8H"
                  value={raw == null ? '' : String(raw)}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => onChange(name, event.target.value || null)}
                />
                <FieldHint>ISO 8601 duration, e.g. PT8H for eight hours.</FieldHint>
              </FieldRow>
            );

          default: {
            // A resource value is a link, and `String()` on one gives
            // "[object Object]". Where the schema offered no way to pick — a
            // work package parent, for instance — show what is set and say it
            // is not editable here, rather than inviting an edit that would
            // send nonsense.
            if (raw !== null && typeof raw === 'object') {
              return (
                <FieldRow key={name} name={name} field={field} error={error}>
                  <Input
                    id={`schema-${name}`}
                    readOnly
                    value={titleOf(raw) ?? 'Set elsewhere'}
                    className="text-muted-foreground"
                  />
                  <FieldHint>Not editable here.</FieldHint>
                </FieldRow>
              );
            }

            return (
              <FieldRow key={name} name={name} field={field} error={error}>
                <Input
                  id={`schema-${name}`}
                  value={raw == null ? '' : String(raw)}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => onChange(name, event.target.value)}
                />
              </FieldRow>
            );
          }
        }
      })}
    </div>
  );
}
