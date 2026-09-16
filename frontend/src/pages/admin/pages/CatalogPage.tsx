import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Ellipsis, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useCatalog,
  useCreateCatalogRow,
  useDeleteCatalogRow,
  useUpdateCatalogRow,
} from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { cn, formatNumber, truncate } from '@/lib/utils';
import type { CatalogRowInput } from '@/services/api/admin';
import type { AdminCatalog, AdminCatalogField, AdminCatalogRow } from '@/types';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable, CheckCell, ColorSwatch } from './shared-tables';

/**
 * One administration catalogue — types, statuses, priorities, webhooks, OAuth
 * applications, custom fields — with create, edit and delete.
 *
 * The instance describes each catalogue: its wording, its fields, their types
 * and choices, and for every row whether it would agree to delete it. So this
 * one page is all six, and a field the delivery system gains appears in the
 * table and on the form without anything here being written for it. Nothing
 * below names a column or a form control by hand.
 */

/** A page of rows, matching the other administration tables. */
const PAGE_SIZE = 25;

/**
 * Radix Select cannot carry an empty value, but a catalogue can: "no colour"
 * is the option `''`. This stands in for it inside the control and is unwound
 * before the value is sent. A field with no empty option never matches it, so
 * an unset required choice falls through to the placeholder.
 */
const EMPTY_CHOICE = '__none__';

/** What a write-only field says in place of the value it will not show. */
const WRITE_ONLY_HINT =
  'Stored by the instance but never read back, so it is not shown here. Leave blank to keep the current value.';

export interface CatalogPageProps {
  /** The resource the backend knows the catalogue by, e.g. `statuses`. */
  resource: string;
}

export function CatalogPage({ resource }: CatalogPageProps) {
  const query = useCatalog(resource);
  const remove = useDeleteCatalogRow(resource);

  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminCatalogRow>();
  const [removing, setRemoving] = useState<AdminCatalogRow>();

  const catalog = query.data;
  const rows = useMemo(() => catalog?.rows ?? [], [catalog]);

  // Write-only fields are never read back, so a column for one would be a
  // column of blanks. They stay on the form, where they can be set.
  const columns = useMemo(
    () => (catalog?.fields ?? []).filter((field) => !field.writeOnly),
    [catalog],
  );

  const matches = useMemo(() => searchRows(rows, columns, search), [rows, columns, search]);
  const paging = usePagination(matches, { pageSize: PAGE_SIZE, resetKey: search });

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (row: AdminCatalogRow) => {
    setEditing(row);
    setDialogOpen(true);
  };

  const confirmRemove = () => {
    if (!catalog || !removing) return;
    const target = removing;
    const name = rowTitle(target, catalog.fields);

    remove.mutate(target.id, {
      onSuccess: () => {
        setRemoving(undefined);
        toast.success(`${sentenceCase(catalog.singular)} deleted`, { description: name });
      },
      // The instance refuses with its own reason — "still used by 3 work
      // packages" — which is the only thing that explains the refusal.
      onError: (error) =>
        toast.error(`${sentenceCase(catalog.singular)} was not deleted`, {
          description: describeError(error),
        }),
    });
  };

  const singular = catalog?.singular ?? 'entry';
  const plural = catalog ? pluralOf(catalog.singular) : 'entries';

  return (
    <div className="space-y-4">
      <ListToolbar
        trailing={
          <>
            <ResultCount
              count={matches.length}
              total={rows.length}
              label={singular}
              plural={plural}
            />
            <Button size="sm" onClick={openCreate} disabled={!catalog}>
              <Plus className="h-3.5 w-3.5" />
              New {singular}
            </Button>
          </>
        }
      >
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={`Search ${plural}`}
          aria-label={`Search ${plural}`}
        />
      </ListToolbar>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        errorTitle="Unable to load this catalogue"
        // The column count is the descriptor's, once it has arrived; on a cold
        // load there is nothing yet to be faithful to, so it guesses.
        skeleton={<TableSkeleton columns={columns.length > 0 ? columns.length + 1 : 5} />}
        isEmpty={rows.length === 0}
        empty={
          catalog ? (
            <EmptyState
              icon={Layers}
              title={`No ${plural}`}
              description={catalog.description}
              action={{ label: `New ${singular}`, onClick: openCreate }}
            />
          ) : null
        }
      >
        {catalog ? (
          <AdminTable
            footer={
              <AdminPagination paging={paging} itemLabel={singular} itemLabelPlural={plural} />
            }
          >
            <TableHeader>
              <TableRow>
                {columns.map((field) => (
                  <TableHead key={field.key} numeric={field.type === 'integer'}>
                    {field.label}
                  </TableHead>
                ))}
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paging.items.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((field, index) => (
                    <CatalogCell key={field.key} field={field} row={row} lead={index === 0} />
                  ))}
                  <TableCell className="text-right">
                    <RowActions
                      row={row}
                      name={rowTitle(row, catalog.fields)}
                      onEdit={() => openEdit(row)}
                      onDelete={() => setRemoving(row)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {/* Searched down to nothing, which is not the same as an empty
                  catalogue: the toolbar above still has the term in it. */}
              {matches.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columns.length + 1}
                    className="text-center text-xs text-muted-foreground"
                  >
                    No {plural} match “{search.trim()}”.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </AdminTable>
        ) : null}
      </QueryBoundary>

      {catalog ? (
        <CatalogDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          catalog={catalog}
          row={editing}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={`Delete ${removing && catalog ? rowTitle(removing, catalog.fields) : 'this entry'}?`}
        description={`This ${singular} is removed from the delivery system for everyone who uses it. This cannot be undone.`}
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={confirmRemove}
      />
    </div>
  );
}

export default CatalogPage;

/* ------------------------------------------------------------------------ */
/* One row                                                                   */
/* ------------------------------------------------------------------------ */

/** One cell, rendered by what the descriptor says the field is. */
function CatalogCell({
  field,
  row,
  lead,
}: {
  field: AdminCatalogField;
  row: AdminCatalogRow;
  /** The first column, which carries the row's name and so reads stronger. */
  lead: boolean;
}) {
  const value = row[field.key];

  if (field.type === 'boolean') {
    return (
      <TableCell>
        <CheckCell value={value === true} label={field.label} />
      </TableCell>
    );
  }

  if (field.type === 'integer') {
    return <TableCell numeric>{typeof value === 'number' ? formatNumber(value) : <Dash />}</TableCell>;
  }

  if (field.type === 'enum') {
    const choice = field.options?.find((option) => option.value === asText(value));
    // A colour option carries its hex, so the swatch shows the colour itself
    // rather than only its name.
    if (field.key === 'colorId') {
      return (
        <TableCell>
          <ColorSwatch color={choice?.hex ?? null} name={choice?.label ?? 'None'} />
        </TableCell>
      );
    }
    return <TableCell>{choice?.label ?? <Dash />}</TableCell>;
  }

  const text = asText(value);
  if (!text) {
    return (
      <TableCell>
        <Dash />
      </TableCell>
    );
  }

  return (
    <TableCell className={cn(lead && 'font-medium')}>
      {/* Titled rather than wrapped: a webhook URL is long, and a row that
          grows to three lines loses the shape of the table. */}
      <span className="block max-w-80 truncate" title={text}>
        {truncate(text, 160)}
      </span>
    </TableCell>
  );
}

function Dash() {
  return <span className="text-muted-foreground">{'—'}</span>;
}

/**
 * Edit and delete for one row. A row the instance will not delete keeps the
 * item, disabled, with its reason underneath: a control that silently does
 * nothing is worse than one that says why it cannot.
 */
function RowActions({
  row,
  name,
  onEdit,
  onDelete,
}: {
  row: AdminCatalogRow;
  name: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${name}`}>
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-64">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem destructive={row.deletable} disabled={!row.deletable} onSelect={onDelete}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
        {!row.deletable && row.undeletableReason ? (
          <p className="px-2 pb-1 pt-0.5 text-2xs leading-relaxed text-muted-foreground">
            {row.undeletableReason}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------------ */
/* Create / edit dialog                                                      */
/* ------------------------------------------------------------------------ */

/** What the form holds: a switch is a boolean, everything else is its text. */
type FormValues = Record<string, string | boolean>;

interface CatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: AdminCatalog;
  /** Present when editing. Absent means create. */
  row?: AdminCatalogRow;
}

function CatalogDialog({ open, onOpenChange, catalog, row }: CatalogDialogProps) {
  const isEdit = Boolean(row);
  const create = useCreateCatalogRow(catalog.resource);
  const update = useUpdateCatalogRow(catalog.resource);

  const [values, setValues] = useState<FormValues>(() => initialValues(catalog.fields, row));
  const [problem, setProblem] = useState<string>();

  // Keyed on the id rather than the row itself: the row is a fresh object on
  // every refetch, and depending on it would reset the form mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setValues(initialValues(catalog.fields, row));
    setProblem(undefined);
  }, [open, row?.id, catalog.resource]);

  const pending = create.isPending || update.isPending;

  // A required field left empty is the instance's own rule, so the form holds
  // the submit rather than spending a round trip learning what it knows.
  const incomplete = catalog.fields.some(
    (field) => field.required && !isFilled(field, values[field.key]),
  );

  const set = (key: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [key]: value }));

  const fail = (error: unknown) => setProblem(describeError(error, 'That could not be saved.'));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    if (incomplete) return;

    const input = toInput(catalog.fields, values);
    const noun = sentenceCase(catalog.singular);

    const done = (saved: AdminCatalogRow) => {
      toast.success(`${noun} ${isEdit ? 'updated' : 'created'}`, {
        description: rowTitle(saved, catalog.fields),
      });
      onOpenChange(false);
    };

    if (isEdit && row) {
      update.mutate({ id: row.id, input }, { onSuccess: done, onError: fail });
      return;
    }
    create.mutate(input, { onSuccess: done, onError: fail });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>
              {isEdit ? `Edit ${catalog.singular}` : `New ${catalog.singular}`}
            </DialogTitle>
            <DialogDescription>{catalog.description}</DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll space-y-4 pb-4">
            {/* Beside the fields rather than in a toast: "Name has already been
                taken" is about one box, and it has to be read next to it. */}
            {problem ? <Alert tone="danger">{problem}</Alert> : null}

            {catalog.fields.map((field) => (
              <CatalogField
                key={field.key}
                resource={catalog.resource}
                field={field}
                value={values[field.key]}
                disabled={pending}
                onChange={(next) => set(field.key, next)}
              />
            ))}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={incomplete} loading={pending}>
              {isEdit ? 'Save' : `Create ${catalog.singular}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One labelled control, chosen by the field's declared type. */
function CatalogField({
  resource,
  field,
  value,
  disabled,
  onChange,
}: {
  resource: string;
  field: AdminCatalogField;
  value: string | boolean | undefined;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `catalog-${resource}-${field.key}`;
  const hintId = `${id}-hint`;
  const hint = field.writeOnly
    ? [field.help, WRITE_ONLY_HINT].filter(Boolean).join(' ')
    : field.help;
  const text = typeof value === 'string' ? value : '';

  if (field.type === 'boolean') {
    // The same toggle row as every other switch in the product, so a
    // descriptor-driven boolean does not look like a stray control.
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
        <div className="min-w-0">
          <Label htmlFor={id} required={field.required}>
            {field.label}
          </Label>
          {hint ? <FieldHint className="mt-0.5">{hint}</FieldHint> : null}
        </div>
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required={field.required}>
        {field.label}
      </Label>

      {field.type === 'text' ? (
        <Textarea
          id={id}
          rows={3}
          value={text}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {field.type === 'integer' ? (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          value={text}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {field.type === 'string' ? (
        <Input
          id={id}
          value={text}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {field.type === 'enum' ? (
        <Select
          value={toChoice(text)}
          disabled={disabled}
          onValueChange={(choice) => onChange(fromChoice(choice))}
        >
          <SelectTrigger id={id} aria-describedby={hint ? hintId : undefined}>
            <SelectValue placeholder="Not set" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={toChoice(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Values                                                                    */
/* ------------------------------------------------------------------------ */

function initialValues(fields: AdminCatalogField[], row?: AdminCatalogRow): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.type === 'boolean') {
      values[field.key] = row ? row[field.key] === true : false;
      continue;
    }
    // A write-only field starts empty even when editing: the instance keeps
    // the value but never hands it back, so there is nothing true to show.
    values[field.key] = field.writeOnly ? '' : asText(row?.[field.key]);
  }
  return values;
}

/** The flat map the endpoints take: field key to the value being stored. */
function toInput(fields: AdminCatalogField[], values: FormValues): CatalogRowInput {
  const input: CatalogRowInput = {};

  for (const field of fields) {
    const value = values[field.key];

    if (field.type === 'boolean') {
      input[field.key] = value === true;
      continue;
    }

    const text = typeof value === 'string' ? value.trim() : '';

    // Blank means "leave the stored secret alone". Sending an empty string
    // would wipe a value nobody can read back, and so nobody can retype.
    if (field.writeOnly) {
      if (text) input[field.key] = text;
      continue;
    }

    if (field.type === 'integer') {
      // An emptied number box is "let the instance decide", not "store
      // nothing": the instance refuses a null where it holds a default.
      if (text !== '' && Number.isFinite(Number(text))) input[field.key] = Number(text);
      continue;
    }

    input[field.key] = text;
  }

  return input;
}

function isFilled(field: AdminCatalogField, value: string | boolean | undefined): boolean {
  if (field.type === 'boolean') return true;
  return typeof value === 'string' && value.trim() !== '';
}

/** A row's own name, for buttons and confirmations: its first text field. */
function rowTitle(row: AdminCatalogRow, fields: AdminCatalogField[]): string {
  for (const field of fields) {
    if (field.writeOnly || (field.type !== 'string' && field.type !== 'text')) continue;
    const text = asText(row[field.key]);
    if (text) return text;
  }
  return `#${row.id}`;
}

/** The rows whose text carries what was typed, matched case-insensitively. */
function searchRows(
  rows: AdminCatalogRow[],
  fields: AdminCatalogField[],
  search: string,
): AdminCatalogRow[] {
  const term = search.trim().toLowerCase();
  if (!term) return rows;

  const searchable = fields.filter((field) => field.type === 'string' || field.type === 'text');
  return rows.filter((row) =>
    searchable.some((field) => asText(row[field.key]).toLowerCase().includes(term)),
  );
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function toChoice(value: string): string {
  return value === '' ? EMPTY_CHOICE : value;
}

function fromChoice(choice: string): string {
  return choice === EMPTY_CHOICE ? '' : choice;
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The plural of the instance's noun. The descriptor gives only the singular —
 * "status", "priority", "custom field" — and the rules that get those three
 * right get the other three right too.
 */
function pluralOf(singular: string): string {
  if (/(s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}
