import { useMemo, useRef, useState } from 'react';
import { Calculator, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { formatCalculatedValue, RESULT_TYPE_LABELS } from '@/components/calculated/format';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { MultiSelect } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTypes } from '@/hooks/useCatalog';
import {
  useCalculatedFields,
  useCalculatedStatus,
  useDeleteCalculatedField,
  useFormulaReference,
  useFormulaValidation,
  useRecalculateCalculatedFields,
  useSaveCalculatedField,
  useSetCalculatedFieldActive,
} from '@/hooks/useCalculatedFields';
import { useProjects } from '@/hooks/useProjects';
import { formatLocalNumber, msg, t } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type {
  CalculatedField,
  CalculatedFieldInput,
  CalculatedFieldValidation,
  CalculatedResultType,
  FormulaReference,
  ID,
} from '@/types';
import { describeError } from './shared-format';

/**
 * Calculated fields (BR-406 to BR-408): formulas over a work package — its own
 * fields, its custom fields, other calculated fields, its children — that EPM
 * works out after every change and writes into an OpenProject field each, so
 * every view can show, filter, group and sum them. Defining one needs
 * `fields:configure`; each change is journalled. A formula is checked as it is
 * typed — syntax, types, references, circles and its size — and can be tried
 * on any work package before it is saved.
 */

const RESULT_TYPES: CalculatedResultType[] = ['number', 'date', 'text', 'boolean'];
const KEY_PATTERN = /^[a-z][A-Za-z0-9_]{1,39}$/;
/** Examples in formula syntax, which is the same in every language. */
const KEY_EXAMPLE = 'remainingEffort';
const FORMULA_EXAMPLE = 'ROUND(estimatedHours - spentHours, 1)';

interface Draft extends CalculatedFieldInput {
  description: string;
  decimals: number;
  projectIds: ID[];
  typeIds: ID[];
}

const blankDraft = (): Draft => ({
  key: '',
  name: '',
  description: '',
  resultType: 'number',
  expression: '',
  decimals: 2,
  projectIds: [],
  typeIds: [],
});

const toDraft = (field: CalculatedField): Draft => ({
  key: field.key,
  name: field.name,
  description: field.description ?? '',
  resultType: field.resultType,
  expression: field.expression,
  decimals: field.format.decimals ?? 2,
  projectIds: field.projectIds,
  typeIds: field.typeIds,
});

/** A key from a name, where the name is in Latin letters: "Total work" → "totalWork". */
function suggestKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase())).join('');
  return /^[a-z]/.test(key) ? key.slice(0, 40) : '';
}

export default function CalculatedFieldsPage() {
  const { can } = useAuth();
  const mayConfigure = can('fields:configure');
  const fields = useCalculatedFields();
  const projects = useProjects();
  const types = useTypes();
  const setActive = useSetCalculatedFieldActive();
  const remove = useDeleteCalculatedField();
  const save = useSaveCalculatedField();
  const [editing, setEditing] = useState<{ field?: CalculatedField }>();
  const [deleting, setDeleting] = useState<CalculatedField>();

  const projectName = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project.name])), [projects.data]);
  const typeName = useMemo(() => new Map((types.data ?? []).map((type) => [String(type.id), type.name])), [types.data]);

  const scopeOf = (field: CalculatedField) => {
    const inProjects =
      field.projectIds.length === 0
        ? t('Every project')
        : t('{count, plural, one {# project} other {# projects}}: {names}', {
            count: field.projectIds.length,
            names: field.projectIds.map((id) => projectName.get(id) ?? `#${id}`).join(', '),
          });
    const ofTypes =
      field.typeIds.length === 0
        ? t('every type')
        : field.typeIds.map((id) => typeName.get(id) ?? `#${id}`).join(', ');
    return t('{projects} · {types}', { projects: inProjects, types: ofTypes });
  };

  return (
    <div className="space-y-4">
      {!mayConfigure ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('Defining calculated fields needs the calculated fields permission (fields:configure).')}
        </Alert>
      ) : null}

      <PassesCard mayConfigure={mayConfigure} />

      <Card>
        <CardHeader
          variant="compact"
          actions={
            mayConfigure ? (
              <Button size="sm" onClick={() => setEditing({})}>
                <Plus className="h-3.5 w-3.5" />
                {t('New calculated field')}
              </Button>
            ) : undefined
          }
        >
          <CardTitle>{t('Calculated fields')}</CardTitle>
          <CardDescription>
            {t(
              'Each is worked out by EPM on every work package it applies to, after every change, and appears in every view as a field of its own: a column to show, filter, group and sum. Nobody can type over one.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryBoundary
            isLoading={fields.isLoading}
            isError={fields.isError}
            error={fields.error}
            onRetry={() => void fields.refetch()}
            errorTitle={t('The calculated fields could not be loaded')}
            skeleton={<ListSkeleton rows={3} />}
            isEmpty={(fields.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={Calculator}
                title={t('No calculated fields yet')}
                description={t('A calculated field turns a formula — remaining hours, days late, a roll-up of the children — into a field every view can use.')}
              />
            }
          >
            <ul className="divide-y divide-border" data-testid="calculated-fields">
              {(fields.data ?? []).map((field) => (
                <li key={field.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span dir="auto">{field.name}</span>
                      <Badge tone="neutral" size="sm">
                        {RESULT_TYPE_LABELS[field.resultType]}
                      </Badge>
                      <Badge tone={field.active ? 'success' : 'neutral'} size="sm">
                        {field.active ? t('On') : t('Off')}
                      </Badge>
                    </p>
                    <p className="truncate font-mono text-2xs text-foreground" dir="ltr" title={field.expression}>
                      <span className="text-muted-foreground">{field.key} =</span> {field.expression}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {scopeOf(field)}
                      {field.stats
                        ? ` · ${t('{values, plural, one {# value} other {# values}}, {empty, number} empty', {
                            values: field.stats.values,
                            empty: field.stats.empty,
                          })}`
                        : ''}
                    </p>
                  </div>
                  {mayConfigure ? (
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setEditing({ field })}>
                        {t('Edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={setActive.isPending}
                        onClick={() =>
                          setActive.mutate(
                            { id: field.id, active: !field.active },
                            {
                              onSuccess: () =>
                                toast.success(field.active ? t('{name} switched off', { name: field.name }) : t('{name} switched on', { name: field.name })),
                              onError: (error) => toast.error(t('That did not work'), { description: describeError(error) }),
                            },
                          )
                        }
                      >
                        {field.active ? t('Switch off') : t('Switch on')}
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={t('Delete {name}', { name: field.name })} onClick={() => setDeleting(field)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </QueryBoundary>
        </CardContent>
      </Card>

      {editing ? (
        <FieldEditor
          field={editing.field}
          projects={(projects.data ?? []).map((project) => ({ id: project.id, name: project.name }))}
          types={(types.data ?? []).map((type) => ({ id: String(type.id), name: type.name }))}
          saving={save.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(input) =>
            save.mutate(
              { id: editing.field?.id, input },
              {
                onSuccess: () => {
                  toast.success(editing.field ? t('Calculated field saved') : t('Calculated field defined'), {
                    description: t('Its values are being worked out, and reach every view in a few seconds.'),
                  });
                  setEditing(undefined);
                },
                onError: (error) => toast.error(t('The calculated field was not saved'), { description: describeError(error) }),
              },
            )
          }
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={deleting ? t('Delete {name}?', { name: deleting.name }) : ''}
        description={t(
          'Its values and the field that holds them go with it, and views that show it lose the column. A field another reads cannot be deleted. This cannot be undone.',
        )}
        confirmLabel={t('Delete')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success(t('{name} deleted', { name: deleting.name }));
              setDeleting(undefined);
            },
            onError: (error) => toast.error(t('It could not be deleted'), { description: describeError(error) }),
          })
        }
      />
    </div>
  );
}

/** How the passes are going, and "Recalculate now". */
function PassesCard({ mayConfigure }: { mayConfigure: boolean }) {
  const status = useCalculatedStatus();
  const recalculate = useRecalculateCalculatedFields();
  const last = status.data?.lastCompleted;
  const failed = status.data?.lastRun && status.data.lastRun.status === 'failed' ? status.data.lastRun : undefined;

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          mayConfigure ? (
            <Button
              size="sm"
              variant="secondary"
              loading={recalculate.isPending}
              onClick={() =>
                recalculate.mutate(undefined, {
                  onSuccess: (result) =>
                    toast.success(result.pending ? t('Recalculation started') : t('Every calculated field recalculated')),
                  onError: (error) => toast.error(t('The recalculation did not start'), { description: describeError(error) }),
                })
              }
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('Recalculate now')}
            </Button>
          ) : undefined
        }
      >
        <CardTitle>{t('How values are kept')}</CardTitle>
        <CardDescription>
          {status.data
            ? status.data.enabled
              ? t(
                  'Worked out after every change made through EPM, and checked every {seconds, number} seconds for changes made elsewhere — and when the day turns, for formulas that read TODAY().',
                  { seconds: status.data.checkSeconds },
                )
              : t('Calculated fields are switched off on this server: values are not recalculated.')
            : t('Loading…')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 pt-2 text-2xs text-muted-foreground">
        {last ? (
          <p>
            {t(
              'Last worked out {when}: {fields, plural, one {# field} other {# fields}} over {workPackages, number} work packages, {values, number} values, in {ms, number} ms.',
              {
                when: formatRelative(last.finishedAt ?? last.startedAt),
                fields: last.fields,
                workPackages: last.workPackages,
                values: last.evaluated,
                ms: last.durationMs ?? 0,
              },
            )}
            {status.data?.pending ? ` ${t('Another is on its way.')}` : ''}
          </p>
        ) : (
          <p>{t('Not worked out yet.')}</p>
        )}
        {last?.mirrorError ? <p className="text-danger">{last.mirrorError}</p> : null}
        {failed ? <p className="text-danger">{t('The last pass failed: {error}', { error: failed.error ?? '' })}</p> : null}
      </CardContent>
    </Card>
  );
}

/** The phrases the reference shows beside the editor. */
const RULES = [
  msg('A value can be missing: a field nobody filled in, a division by nought. Arithmetic or a comparison with a missing value has none either; COALESCE and IF are how a formula decides otherwise.'),
  msg('The child aggregations skip children with no value; COUNT_CHILDREN counts them all. A field may roll itself up: SUM_CHILDREN of its own key adds up the whole tree.'),
  msg('A formula may read other calculated fields by their keys, but not in a circle; that is refused when it is saved.'),
  msg('Text goes in single or double quotes. Conditions combine with and, or and not.'),
];

function FieldEditor({
  field,
  projects,
  types,
  saving,
  onClose,
  onSave,
}: {
  field?: CalculatedField;
  projects: { id: ID; name: string }[];
  types: { id: ID; name: string }[];
  saving: boolean;
  onClose: () => void;
  onSave: (input: CalculatedFieldInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => (field ? toDraft(field) : blankDraft()));
  const [keyTouched, setKeyTouched] = useState(Boolean(field));
  const [previewId, setPreviewId] = useState('');
  const formula = useRef<HTMLTextAreaElement>(null);
  const reference = useFormulaReference();
  const set = (patch: Partial<Draft>) => setDraft((was) => ({ ...was, ...patch }));

  const previewWorkPackage = /^\d+$/.test(previewId.trim()) ? previewId.trim() : undefined;
  const validation = useFormulaValidation({
    id: field?.id,
    key: KEY_PATTERN.test(draft.key) ? draft.key : undefined,
    name: draft.name || undefined,
    resultType: draft.resultType,
    expression: draft.expression,
    projectIds: draft.projectIds,
    typeIds: draft.typeIds,
    workPackageId: previewWorkPackage,
  });
  const result = validation.data;
  const checked = validation.current;

  const keyProblem = !draft.key ? t('A key is needed: formulas refer to the field by it.') : KEY_PATTERN.test(draft.key) ? null : t('A key starts with a lower-case letter and has 2 to 40 letters, digits or underscores.');
  const nameProblem = draft.name.trim() ? null : t('A calculated field needs a name.');
  const ready = !keyProblem && !nameProblem && draft.expression.trim() !== '' && checked && result?.ok === true;

  /** Puts `text` where the cursor is in the formula. */
  const insert = (text: string) => {
    const area = formula.current;
    const at = area?.selectionStart ?? draft.expression.length;
    const to = area?.selectionEnd ?? at;
    const next = draft.expression.slice(0, at) + text + draft.expression.slice(to);
    set({ expression: next });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const submit = () =>
    onSave({
      key: draft.key,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      resultType: draft.resultType,
      expression: draft.expression,
      format: draft.resultType === 'number' ? { decimals: draft.decimals } : undefined,
      projectIds: draft.projectIds,
      typeIds: draft.typeIds,
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{field ? t('Edit {name}', { name: field.name }) : t('New calculated field')}</DialogTitle>
          <DialogDescription>
            {t('Checked as you type. Saved, it is worked out on every work package it applies to and appears in every view.')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[70vh] gap-5 overflow-y-auto pe-1 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="calc-name" required>
                  {t('Name')}
                </Label>
                <Input
                  id="calc-name"
                  value={draft.name}
                  maxLength={80}
                  dir="auto"
                  invalid={Boolean(nameProblem) && draft.name !== ''}
                  placeholder={t('e.g. Remaining effort')}
                  onChange={(event) =>
                    set({ name: event.target.value, ...(keyTouched ? {} : { key: suggestKey(event.target.value) }) })
                  }
                />
                <FieldHint>{t('Also the name of its column in views.')}</FieldHint>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="calc-key" required>
                  {t('Key')}
                </Label>
                <Input
                  id="calc-key"
                  value={draft.key}
                  maxLength={40}
                  dir="ltr"
                  className="font-mono"
                  disabled={Boolean(field)}
                  invalid={Boolean(keyProblem) && keyTouched}
                  placeholder={KEY_EXAMPLE}
                  onChange={(event) => {
                    setKeyTouched(true);
                    set({ key: event.target.value.trim() });
                  }}
                />
                {keyProblem && keyTouched && !field ? (
                  <FieldError>{keyProblem}</FieldError>
                ) : (
                  <FieldHint>{field ? t('Fixed: formulas refer to the field by it.') : t('How formulas refer to it. Fixed once saved.')}</FieldHint>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="calc-type">{t('Gives')}</Label>
                <Select value={draft.resultType} onValueChange={(value) => set({ resultType: value as CalculatedResultType })} disabled={Boolean(field)}>
                  <SelectTrigger id="calc-type" className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESULT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {RESULT_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {field ? <FieldHint>{t('Fixed once saved.')}</FieldHint> : null}
              </div>
              {draft.resultType === 'number' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="calc-decimals">{t('Decimal places')}</Label>
                  <Select value={String(draft.decimals)} onValueChange={(value) => set({ decimals: Number(value) })}>
                    <SelectTrigger id="calc-decimals" className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map((places) => (
                        <SelectItem key={places} value={String(places)}>
                          {formatLocalNumber(places)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldHint>{t('How views show it, and what filters and sums see.')}</FieldHint>
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="calc-formula" required>
                {t('Formula')}
              </Label>
              <Textarea
                id="calc-formula"
                ref={formula}
                rows={4}
                dir="ltr"
                spellCheck={false}
                className="font-mono text-xs"
                value={draft.expression}
                invalid={checked && result?.ok === false}
                placeholder={FORMULA_EXAMPLE}
                onChange={(event) => set({ expression: event.target.value })}
              />
              <FormulaVerdict expression={draft.expression} validation={result} checking={!checked} />
            </div>

            <div className="space-y-1.5 rounded-lg border border-dashed border-border p-3">
              <Label htmlFor="calc-preview">{t('Try it on a work package')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">#</span>
                <Input
                  id="calc-preview"
                  inputMode="numeric"
                  dir="ltr"
                  className="h-8 w-32 text-xs"
                  value={previewId}
                  placeholder="1234"
                  onChange={(event) => setPreviewId(event.target.value)}
                />
              </div>
              {previewWorkPackage && result?.ok && result.preview ? (
                <div className="text-xs" data-testid="calc-preview">
                  {result.preview.value === null ? (
                    <p>
                      {t('No value on #{id}: {reason}', {
                        id: result.preview.workPackageId,
                        reason: result.preview.reason ?? t('nothing to work it out from.'),
                      })}
                    </p>
                  ) : (
                    <p>
                      {t('On #{id} it gives {value}.', {
                        id: result.preview.workPackageId,
                        value: formatCalculatedValue(draft.resultType, result.preview.value, draft.decimals),
                      })}
                    </p>
                  )}
                  {!result.preview.inScope ? (
                    <p className="text-2xs text-muted-foreground">{t('That work package is outside the field’s projects or types, so it will hold no value; shown as if it applied.')}</p>
                  ) : null}
                </div>
              ) : previewWorkPackage && validation.isError ? (
                <FieldError>{describeError(validation.error)}</FieldError>
              ) : (
                <FieldHint>{t('Worked out with that work package’s values now, and its children’s, without saving anything.')}</FieldHint>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('Projects')}</Label>
                <MultiSelect
                  label={t('Projects')}
                  options={projects}
                  selected={projects.filter((project) => draft.projectIds.includes(project.id))}
                  onChange={(selected) => set({ projectIds: selected.map((project) => project.id) })}
                  placeholder={t('Every project')}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('Types')}</Label>
                <MultiSelect
                  label={t('Types')}
                  options={types}
                  selected={types.filter((type) => draft.typeIds.includes(type.id))}
                  onChange={(selected) => set({ typeIds: selected.map((type) => type.id) })}
                  placeholder={t('Every type')}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="calc-description">{t('Description')}</Label>
              <Textarea
                id="calc-description"
                rows={2}
                maxLength={500}
                dir="auto"
                value={draft.description}
                onChange={(event) => set({ description: event.target.value })}
              />
            </div>
          </div>

          <FormulaHelp reference={reference.data} onInsert={insert} loading={reference.isLoading} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button loading={saving} disabled={!ready} onClick={submit}>
            {field ? t('Save') : t('Define field')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the check found: the problem and where, or what the formula gives and how big it is. */
function FormulaVerdict({
  expression,
  validation,
  checking,
}: {
  expression: string;
  validation?: CalculatedFieldValidation;
  checking: boolean;
}) {
  if (!expression.trim()) return <FieldHint>{t('Type a formula; the reference beside it lists what it can use.')}</FieldHint>;
  if (!validation) return <FieldHint>{t('Checking…')}</FieldHint>;
  if (!validation.ok && validation.error) {
    const { start, end, message } = validation.error;
    const stop = Math.max(end, start + 1);
    return (
      <div className="space-y-1" data-testid="calc-error">
        <FieldError>{message}</FieldError>
        <pre dir="ltr" className="whitespace-pre-wrap break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-2xs text-foreground">
          {expression.slice(0, start)}
          <mark className="rounded-sm bg-danger/20 text-danger">{expression.slice(start, stop) || ' '}</mark>
          {expression.slice(stop)}
        </pre>
      </div>
    );
  }
  const complexity = validation.complexity;
  return (
    <FieldHint data-testid="calc-ok">
      {checking ? `${t('Checking…')} ` : ''}
      {validation.type && complexity
        ? t('Gives {type}. {nodes, number} of {maxNodes, number} parts, {depth, number} of {maxDepth, number} levels deep.', {
            type: RESULT_TYPE_LABELS[validation.type].toLowerCase(),
            nodes: complexity.nodes,
            maxNodes: validation.limits.nodes,
            depth: complexity.depth,
            maxDepth: validation.limits.depth,
          })
        : null}
    </FieldHint>
  );
}

/** The reference beside the editor: click a name to put it in the formula. */
function FormulaHelp({ reference, onInsert, loading }: { reference?: FormulaReference; onInsert: (text: string) => void; loading: boolean }) {
  const [filter, setFilter] = useState('');
  const matches = (text: string) => !filter.trim() || text.toLowerCase().includes(filter.trim().toLowerCase());
  const chip = 'cursor-pointer rounded px-1 font-mono text-2xs text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2';

  return (
    <aside className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-2xs" aria-label={t('What a formula can use')}>
      <p className="text-xs font-semibold">{t('What a formula can use')}</p>
      <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('Find…')} className="h-7 text-2xs" />
      {loading || !reference ? (
        <p className="text-muted-foreground">{t('Loading…')}</p>
      ) : (
        <>
          <section className="space-y-1">
            <p className="font-medium">{t('Fields of the work package')}</p>
            <ul className="space-y-1">
              {reference.attributes.filter((one) => matches(one.name + one.description)).map((one) => (
                <li key={one.name}>
                  <button type="button" className={chip} dir="ltr" onClick={() => onInsert(one.name)}>
                    {one.name}
                  </button>{' '}
                  <span className="text-muted-foreground">
                    {RESULT_TYPE_LABELS[one.type]} · {one.description}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {reference.calculated.length > 0 ? (
            <section className="space-y-1">
              <p className="font-medium">{t('Other calculated fields')}</p>
              <ul className="space-y-1">
                {reference.calculated.filter((one) => matches(one.key + one.name)).map((one) => (
                  <li key={one.key}>
                    <button type="button" className={chip} dir="ltr" onClick={() => onInsert(one.key)}>
                      {one.key}
                    </button>{' '}
                    <span className="text-muted-foreground" dir="auto">
                      {one.name}
                      {one.active ? '' : ` (${t('off')})`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {reference.customFields.length > 0 ? (
            <section className="space-y-1">
              <p className="font-medium">{t('Custom fields')}</p>
              <ul className="space-y-1">
                {reference.customFields.filter((one) => matches(one.name + one.label)).map((one) => (
                  <li key={one.name}>
                    {one.type ? (
                      <button type="button" className={chip} dir="ltr" onClick={() => onInsert(one.name)}>
                        {one.name}
                      </button>
                    ) : (
                      <span className="px-1 font-mono text-muted-foreground" dir="ltr">
                        {one.name}
                      </span>
                    )}{' '}
                    <span className="text-muted-foreground" dir="auto">
                      {one.label} · {one.type ? RESULT_TYPE_LABELS[one.type] : t('cannot be read')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="space-y-1">
            <p className="font-medium">{t('Functions')}</p>
            <ul className="space-y-1.5">
              {reference.functions.filter((one) => matches(one.name + one.description)).map((one) => (
                <li key={one.name}>
                  <button type="button" className={chip} dir="ltr" onClick={() => onInsert(`${one.name}(`)}>
                    {one.signature}
                  </button>
                  <span className="block ps-1 text-muted-foreground">{one.description}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-1">
            <p className="font-medium">{t('Operators')}</p>
            <p className="font-mono text-muted-foreground" dir="ltr">
              + - * / = != &lt; &lt;= &gt; &gt;= and or not
            </p>
          </section>
          <section className="space-y-1">
            <p className="font-medium">{t('Rules')}</p>
            <ul className="list-disc space-y-1 ps-4 text-muted-foreground">
              {RULES.map((rule) => (
                <li key={rule}>{t(rule)}</li>
              ))}
              <li>
                {t('At most {nodes, number} parts, {depth, number} levels deep and {aggregations, number} child aggregations inside one another.', {
                  nodes: reference.limits.nodes,
                  depth: reference.limits.depth,
                  aggregations: reference.limits.aggregations,
                })}
              </li>
            </ul>
          </section>
        </>
      )}
    </aside>
  );
}
