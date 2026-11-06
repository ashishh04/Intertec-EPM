import { useEffect, useMemo, useRef, useState } from 'react';
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
import { ComboSelect } from '@/components/common/ComboSelect';
import { MultiSelect } from '@/components/common/MultiSelect';
import { useDebounce } from '@/hooks/useDebounce';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { durationToNumber, durationUnitFor, numberToDuration } from '@/lib/duration';
import {
  allowedValuesHref,
  allowedValuesOf,
  calculatedFields,
  idFromHref,
  writableFields,
  type AllowedValue,
  type SchemaField,
  type FormResult,
} from '@/services/api/forms';
import { useAllowedValues } from '@/hooks/useCatalog';
import { formatCalculatedValue } from '@/components/calculated/format';

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
  /**
   * Render OpenProject's own attribute groups as headed sections — People,
   * Estimates and progress, Details, and any group an administrator has added.
   * Off by default: a short curated form reads better as one list.
   */
  grouped?: boolean;
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

/** A resource value's own label, for showing what is set without a picker. */
function titleOf(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const record = value as { title?: string; name?: string };
    return record.title ?? record.name;
  }
  return undefined;
}

/**
 * A duration, collected as a number and stored as ISO 8601.
 *
 * The unit is the attribute's, not a constant: a work package's `duration` is
 * working days and everything else here is hours of effort. Asking for the ISO
 * string and hinting "e.g. PT8H" at both meant a perfectly reasonable
 * "PT1H30M" typed into `duration` truncated to zero days, and OpenProject
 * answered "Duration must be greater than 0" without ever saying it wanted
 * days.
 *
 * The text is held locally while it is being typed. Round-tripping every
 * keystroke through the ISO form ate the decimal point — "7." is not a number,
 * so it normalised back to "7" and the field could not be made to say 7.5. A
 * value that changes underneath us (a server default, a reset) is still
 * adopted; only what the user is in the middle of typing is left alone.
 */
function DurationField({
  id,
  attribute,
  value,
  invalid,
  onChange,
}: {
  id: string;
  attribute: string;
  value: unknown;
  invalid: boolean;
  onChange: (value: string | null) => void;
}) {
  const unit = durationUnitFor(attribute);
  const external = durationToNumber(value, unit);

  const [text, setText] = useState(() => (external == null ? '' : String(external)));
  const known = useRef(external);

  useEffect(() => {
    if (external === known.current) return;
    known.current = external;
    setText(external == null ? '' : String(external));
  }, [external]);

  const handle = (next: string) => {
    setText(next);

    const parsed = next.trim() === '' ? NaN : Number(next);
    const iso = Number.isFinite(parsed) ? (numberToDuration(parsed, unit) ?? null) : null;

    // Remember what we just sent, so the echo does not count as an outside
    // change and overwrite the half-typed text above.
    known.current = durationToNumber(iso, unit);
    onChange(iso);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          placeholder={unit === 'days' ? '3' : '7.5'}
          value={text}
          aria-invalid={invalid}
          aria-describedby={`${id}-unit`}
          onChange={(event) => handle(event.target.value)}
        />
        <span id={`${id}-unit`} className="shrink-0 text-xs text-muted-foreground">
          {unit === 'days' ? t('working days') : t('hours')}
        </span>
      </div>
      <FieldHint>
        {unit === 'days'
          ? t('Whole working days on the schedule.')
          : t('Hours of effort. Quarters are fine, e.g. 7.5.')}
      </FieldHint>
    </>
  );
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
              options.isLoading ? t('Loading…') : t('Select {field}', { field: field.name.toLowerCase() })
            }
          />
        </SelectTrigger>
        <SelectContent>
          {/* Clearing has to be possible: these fields are optional, and a
              picker with no empty choice cannot be undone. */}
          {field.required ? null : <SelectItem value={NONE}>{t('None')}</SelectItem>}
          {list.map((option) => (
            <SelectItem key={option.href} value={option.href}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!options.isLoading && list.length === 0 ? (
        <FieldHint>{t('Nothing to choose from.')}</FieldHint>
      ) : null}
    </FieldRow>
  );
}

/**
 * A field that points at a work package: a task's parent.
 *
 * Its options are every work package it could take, in every project, of which
 * upstream sends the first ten: never the ones anybody was after. So it offers the
 * project's own, and is searched when there are more than one page of them.
 */
function WorkPackageField({
  name,
  field,
  error,
  href,
  projectId,
  value,
  onChange,
}: {
  name: string;
  field: SchemaField;
  error?: string;
  href: string;
  projectId?: string;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
}) {
  const [term, setTerm] = useState('');
  const search = useDebounce(term.trim(), 250);
  const narrowed = useMemo(() => {
    const [path, query] = href.split('?');
    const params = new URLSearchParams(query);
    params.set('pageSize', '50');
    if (projectId) params.set('filters', JSON.stringify([{ project: { operator: '=', values: [projectId] } }]));
    if (search) params.set('query', search);
    return `${path}?${params.toString()}`;
  }, [href, projectId, search]);

  const candidates = useAllowedValues(narrowed);
  const current = hrefOf(value);
  const options = (candidates.data ?? []).map((option) => ({ id: option.href, name: option.name, hint: `#${option.id}` }));
  // What is set stays readable whichever page or search it is outside of.
  if (current && !options.some((option) => option.id === current)) {
    options.unshift({ id: current, name: titleOf(value) ?? `#${idFromHref(current)}`, hint: `#${idFromHref(current)}` });
  }

  return (
    <FieldRow name={name} field={field} error={error}>
      <ComboSelect
        id={`schema-${name}`}
        label={field.name}
        options={options}
        value={current}
        onChange={(next) => onChange(name, { href: next ?? null })}
        onSearch={setTerm}
        clearable={!field.required}
        placeholder={t('Select {field}', { field: field.name.toLowerCase() })}
        emptyLabel={candidates.isLoading ? t('Loading…') : t('Nothing to choose from.')}
      />
    </FieldRow>
  );
}

/**
 * A field that holds a list of links — target versions where a work package
 * may have several, a multi-select custom field — chosen as a list and written
 * as one.
 *
 * As a one-link picker it showed nothing for the list it was given, and what
 * it wrote, one link, upstream cannot read where it wants a list: choosing a
 * target version made the save fail.
 */
function ManyField({
  name,
  field,
  error,
  options,
  href,
  value,
  onChange,
}: {
  name: string;
  field: SchemaField;
  error?: string;
  /** Inline options, or else `href` to fetch them from. */
  options?: AllowedValue[];
  href?: string;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
}) {
  const fetched = useAllowedValues(options ? undefined : href);
  const list = options ?? fetched.data ?? [];
  const nameOf = (link: string) => list.find((option) => option.href === link)?.name;
  const selected = (Array.isArray(value) ? (value as { href?: string | null; title?: string }[]) : [])
    .filter((link): link is { href: string; title?: string } => typeof link?.href === 'string')
    .map((link) => ({ id: link.href, name: link.title ?? nameOf(link.href) ?? idFromHref(link.href) ?? link.href }));

  return (
    <FieldRow name={name} field={field} error={error}>
      <MultiSelect
        label={field.name}
        options={list.map((option) => ({ id: option.href, name: option.name }))}
        selected={selected}
        onChange={(next) => onChange(name, next.map((option) => ({ href: option.id })))}
        placeholder={t('Select {field}', { field: field.name.toLowerCase() })}
        disabled={!options && fetched.isLoading}
      />
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

/**
 * A calculated field (BR-406): its value and formula, read-only. EPM works it
 * out after every change, and refuses a value typed for it.
 */
function CalculatedRow({ name, field }: { name: string; field: SchemaField }) {
  const calculated = field.calculated!;
  return (
    <FieldRow name={name} field={{ ...field, required: false }}>
      <Input
        id={`schema-${name}`}
        readOnly
        dir="auto"
        value={formatCalculatedValue(calculated.resultType, calculated.value)}
        className="text-muted-foreground"
      />
      <FieldHint>
        {t('Calculated by EPM from its formula; it cannot be set by hand.')}{' '}
        <span className="font-mono" dir="ltr">
          {calculated.expression}
        </span>
      </FieldHint>
    </FieldRow>
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
  grouped,
  className,
}: SchemaFormProps) {
  const fields = useMemo(() => {
    if (!form) return [];
    // Calculated fields too, read-only: EPM works them out (BR-406).
    let entries = [...writableFields(form.schema), ...calculatedFields(form.schema)];

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

  const renderField = ([name, field]: [string, SchemaField]) => {
    if (field.calculated) return <CalculatedRow key={name} name={name} field={field} />;
    const error = errors[name];
    const links = values._links as Record<string, unknown> | undefined;
    const given = values[name] ?? links?.[name];
    const options = allowedValuesOf(field);

    // Options the schema publishes as a link rather than inline. Fetched
    // through the backend, which is why `assignee`, `responsible` and a
    // project's `parent` are pickers now instead of text boxes showing
    // "[object Object]".
    const fetchHref = options ? undefined : allowedValuesHref(field);

    /*
     * A list of links (`[]Version`, `[]CustomOption`…) is read and written as a
     * list. Where the schema says it holds one at most — target versions while
     * a work package may have only one version (`options.multiple: false`) — it
     * is chosen as one value below, and still written as a list of it.
     */
    const many = String(field.type).startsWith('[]');
    if (many && field.options?.multiple !== false && (options || fetchHref)) {
      return (
        <ManyField
          key={name}
          name={name}
          field={field}
          error={error}
          options={options}
          href={fetchHref}
          value={given}
          onChange={onChange}
        />
      );
    }
    const raw = many && Array.isArray(given) ? given[0] : given;
    const change = many
      ? (key: string, value: unknown) => onChange(key, value === null || value === undefined ? [] : [value])
      : onChange;

    if (field.type === 'WorkPackage' && fetchHref) {
      return (
        <WorkPackageField
          key={name}
          name={name}
          field={field}
          error={error}
          href={fetchHref}
          projectId={idFromHref(hrefOf(links?.project))}
          value={raw}
          onChange={onChange}
        />
      );
    }

    if (fetchHref) {
      return (
        <FetchedSelect
          key={name}
          name={name}
          field={field}
          error={error}
          href={fetchHref}
          value={raw}
          onChange={change}
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
              change(name, chosen ? { href: chosen.href } : next);
            }}
          >
            <SelectTrigger id={`schema-${name}`} aria-invalid={Boolean(error)}>
              <SelectValue placeholder={t('Select {field}', { field: field.name.toLowerCase() })} />
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

      /*
       * Collected as a number, stored as ISO 8601.
       *
       * The unit is the field's, not a constant: a work package's
       * `duration` is working days and everything else here is hours.
       * Asking for the ISO string and hinting "e.g. PT8H" at both meant a
       * perfectly reasonable "PT1H30M" typed into `duration` truncated to
       * zero days, and OpenProject answered "Duration must be greater
       * than 0" with no indication that the field wanted days.
       */
      case 'Duration':
        return (
          <FieldRow key={name} name={name} field={field} error={error}>
            <DurationField
              id={`schema-${name}`}
              attribute={name}
              value={raw}
              invalid={Boolean(error)}
              onChange={(next) => onChange(name, next)}
            />
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
                value={titleOf(raw) ?? t('Set elsewhere')}
                className="text-muted-foreground"
              />
              <FieldHint>{t('Not editable here.')}</FieldHint>
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
  };

  if (!grouped) {
    return <div className={cn('space-y-4', className)}>{fields.map(renderField)}</div>;
  }

  /*
   * OpenProject's own grouping, in its own order.
   *
   * The schema names the group each attribute belongs to — People, Estimates
   * and progress, Details, and anything an administrator has added — so the
   * full view reads the way the same work package reads upstream instead of
   * as one long undifferentiated column. Fields with no group (custom ones
   * often have none) collect at the end under "Other".
   */
  const groups: { label: string; fields: [string, SchemaField][] }[] = [];
  for (const entry of fields) {
    const label = entry[1].attributeGroup?.trim() || t('Other');
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.fields.push(entry);
    else groups.push({ label, fields: [entry] });
  }

  return (
    <div className={cn('space-y-6', className)}>
      {groups.map((group) => (
        <section key={group.label} className="space-y-4">
          <h3 className="epm-eyebrow border-b border-border pb-1.5">{group.label}</h3>
          {group.fields.map(renderField)}
        </section>
      ))}
    </div>
  );
}
