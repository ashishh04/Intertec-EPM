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

/** OpenProject supplies allowed values embedded, or as a link to fetch. */
function allowedValuesOf(field: SchemaField): AllowedValue[] | undefined {
  const embedded = field._embedded?.allowedValues;
  if (embedded?.length) {
    return embedded
      .map((value) => {
        const id = value.id !== undefined ? String(value.id) : idFromHref(value.href);
        const href = value.href ?? id;
        return id && value.name && href ? { id, name: value.name, href } : undefined;
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

        // Anything with an enumerated set renders as a select, whatever its
        // type — status, type, priority, version, category, user, custom option.
        if (options) {
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
              <div key={name} className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor={`schema-${name}`}>{field.name}</Label>
                  {error ? <FieldError>{error}</FieldError> : null}
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

          default:
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
      })}
    </div>
  );
}
