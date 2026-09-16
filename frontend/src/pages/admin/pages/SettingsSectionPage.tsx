import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useSettingsSection, useUpdateSettingsSection } from '@/hooks/useAdmin';
import { cn } from '@/lib/utils';
import { ApiError } from '@/services/api/client';
import type { AdminSettingField, AdminSettingOption } from '@/types';
import { describeError } from './shared-format';

/**
 * One instance settings section, rendered from what the instance says about
 * itself.
 *
 * The backend returns each field's type, current value, choices and whether
 * it will accept a change, so this one page is every settings section: a
 * setting added upstream appears here without a page being written for it,
 * and nine near-identical files never exist. The heading is the instance's
 * own wording rather than EPM's copy of it, because the instance is what the
 * administrator is actually editing.
 *
 * Every change is written on its own, optimistically. Free text and numbers
 * wait for a pause in typing; a switch or a choice saves at once.
 */

/** Long enough that a typed word is one request, short enough to feel saved. */
const SAVE_DEBOUNCE_MS = 600;

/**
 * Radix Select cannot carry an empty value, but an instance can: "no managed
 * repository vendor" is the option `''`. This stands in for it inside the
 * control and is unwound before the value is sent.
 */
const EMPTY_CHOICE = '__none__';

/** What a `writable: false` field says instead of letting itself be edited. */
const PINNED_HINT = "Set by this instance's configuration and cannot be changed here.";

export interface SettingsSectionPageProps {
  /** The section id the backend knows it by, e.g. `authentication`. */
  section: string;
}

export function SettingsSectionPage({ section }: SettingsSectionPageProps) {
  const query = useSettingsSection(section);
  const update = useUpdateSettingsSection(section);

  // "Saved" is a confirmation rather than a state, so it clears itself; left
  // up, it would still be claiming a save that happened minutes ago.
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 2500);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  // A section this instance does not offer is not a failure of EPM's: an
  // older or differently configured instance simply has nothing to show.
  if (query.isError && query.error instanceof ApiError && query.error.isNotFound) {
    return (
      <Alert tone="warning" title="This instance does not offer this section">
        The delivery system behind EPM has no settings under this heading, so there is nothing
        to change here.
      </Alert>
    );
  }

  const save = (key: string, value: AdminSettingField['value']) =>
    update.mutate(
      { [key]: value },
      {
        onSuccess: () => setJustSaved(true),
        onError: (error) =>
          toast.error('That setting was not saved', { description: describeError(error) }),
      },
    );

  return (
    <QueryBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
      errorTitle="These settings could not be loaded"
      skeleton={<ListSkeleton rows={4} height="h-14" />}
    >
      {query.data ? (
        <Card>
          <CardHeader
            variant="compact"
            actions={<SaveState saving={update.isPending} saved={justSaved} />}
          >
            <CardTitle>{query.data.label}</CardTitle>
            <CardDescription>{query.data.description}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {query.data.fields.map((field) => (
                <SettingRow
                  key={field.key}
                  section={section}
                  field={field}
                  onChange={(value) => save(field.key, value)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </QueryBoundary>
  );
}

/** The header's quiet running commentary on writes, for eyes and for readers. */
function SaveState({ saving, saved }: { saving: boolean; saved: boolean }) {
  if (!saving && !saved) return null;
  return (
    <span className="text-2xs text-muted-foreground" aria-live="polite">
      {saving ? 'Saving…' : 'Saved'}
    </span>
  );
}

/* ------------------------------------------------------------------------ */
/* One setting                                                               */
/* ------------------------------------------------------------------------ */

interface SettingRowProps {
  section: string;
  field: AdminSettingField;
  onChange: (value: AdminSettingField['value']) => void;
}

/**
 * Label and explanation on the left, control on the right — the row every
 * settings page in EPM uses. A tall control (free text, or fifty languages)
 * has nowhere to sit in a right-hand column, so those rows stack instead.
 */
function SettingRow({ section, field, onChange }: SettingRowProps) {
  const id = `setting-${section}-${field.key}`;
  const hintId = `${id}-hint`;
  const stacked = field.type === 'text' || field.type === 'multi_enum';

  return (
    <div
      className={cn(
        'px-4 py-3',
        stacked ? 'flex flex-col gap-2' : 'flex items-center justify-between gap-4',
      )}
    >
      <div className={cn('min-w-0 space-y-0.5', !field.writable && 'opacity-70')}>
        <Label htmlFor={id}>{field.label}</Label>
        {field.help ? <FieldHint id={hintId}>{field.help}</FieldHint> : null}
        {/* Shown rather than hidden: a setting that has quietly vanished is
            harder to explain than one that says why it will not move. */}
        {field.writable ? null : <FieldHint>{PINNED_HINT}</FieldHint>}
      </div>
      <div className={stacked ? 'min-w-0' : 'shrink-0'}>
        <SettingControl
          id={id}
          describedBy={field.help ? hintId : undefined}
          field={field}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

interface ControlProps {
  id: string;
  describedBy?: string;
  field: AdminSettingField;
  onChange: (value: AdminSettingField['value']) => void;
}

function SettingControl({ id, describedBy, field, onChange }: ControlProps) {
  const disabled = !field.writable;

  switch (field.type) {
    case 'boolean':
      return (
        <Switch
          id={id}
          checked={field.value === true}
          disabled={disabled}
          aria-describedby={describedBy}
          onCheckedChange={(checked) => onChange(checked)}
        />
      );

    case 'integer':
      return (
        <DebouncedField
          value={asText(field.value)}
          onCommit={(text) => commitNumber(text, onChange)}
        >
          {(draft, setDraft) => (
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              className="h-8 w-28 text-xs"
              value={draft}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </DebouncedField>
      );

    case 'string':
      return (
        <DebouncedField value={asText(field.value)} onCommit={onChange}>
          {(draft, setDraft) => (
            <Input
              id={id}
              className="h-8 w-full text-xs sm:w-72"
              value={draft}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </DebouncedField>
      );

    case 'text':
      return (
        <DebouncedField value={asText(field.value)} onCommit={onChange}>
          {(draft, setDraft) => (
            <Textarea
              id={id}
              rows={4}
              spellCheck={false}
              className="min-h-24 w-full font-mono text-xs"
              value={draft}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </DebouncedField>
      );

    case 'enum':
      return (
        <Select
          value={toChoice(asText(field.value))}
          disabled={disabled}
          onValueChange={(choice) => onChange(fromChoice(choice))}
        >
          <SelectTrigger id={id} size="sm" className="w-56" aria-describedby={describedBy}>
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
      );

    case 'multi_enum':
      return (
        <MultiChoice
          id={id}
          describedBy={describedBy}
          options={field.options ?? []}
          selected={asList(field.value)}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}

/**
 * Every choice as a checkbox, in a box that scrolls. Available languages runs
 * to fifty-odd entries, and a list that long pushes the rest of the section
 * off the screen if it is allowed to grow.
 */
function MultiChoice({
  id,
  describedBy,
  options,
  selected,
  disabled,
  onChange,
}: {
  id: string;
  describedBy?: string;
  options: AdminSettingOption[];
  selected: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  const toggle = (value: string, checked: boolean) =>
    // Rebuilt in the instance's own ordering, so a saved list does not come
    // back reshuffled into the order the boxes happened to be clicked.
    onChange(
      options
        .filter((option) => (option.value === value ? checked : selected.includes(option.value)))
        .map((option) => option.value),
    );

  return (
    <div
      id={id}
      role="group"
      aria-describedby={describedBy}
      className="epm-scroll relative max-h-56 overflow-y-auto rounded-lg border border-border p-2"
    >
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((option) => (
          <Label
            key={option.value}
            className={cn('flex min-w-0 items-center gap-2 font-normal', disabled && 'opacity-70')}
          >
            <Checkbox
              checked={selected.includes(option.value)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(option.value, checked === true)}
            />
            <span className="truncate">{option.label}</span>
          </Label>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Typing without a request per keystroke                                    */
/* ------------------------------------------------------------------------ */

/**
 * Holds what has been typed and commits it once typing pauses. The draft
 * follows the server's value whenever that changes, which after an optimistic
 * save is the value just committed, so the box never jumps under the cursor.
 */
function DebouncedField({
  value,
  onCommit,
  children,
}: {
  value: string;
  onCommit: (value: string) => void;
  children: (draft: string, setDraft: (next: string) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState(value);

  // Read through a ref so a fresh `onCommit` identity on every render does not
  // restart the timer and push the save further away with each keystroke.
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => commit.current(draft), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, value]);

  return <>{children(draft, setDraft)}</>;
}

/* ------------------------------------------------------------------------ */
/* Values                                                                    */
/* ------------------------------------------------------------------------ */

/** An emptied number box is someone mid-edit, not a request to store nothing. */
function commitNumber(text: string, onChange: (value: number) => void) {
  const parsed = Number(text);
  if (text.trim() === '' || !Number.isFinite(parsed)) return;
  onChange(parsed);
}

function asText(value: AdminSettingField['value']): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function asList(value: AdminSettingField['value']): string[] {
  return Array.isArray(value) ? value : [];
}

function toChoice(value: string): string {
  return value === '' ? EMPTY_CHOICE : value;
}

function fromChoice(choice: string): string {
  return choice === EMPTY_CHOICE ? '' : choice;
}
