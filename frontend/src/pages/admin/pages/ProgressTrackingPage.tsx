import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSettingsSection, useUpdateSettingsSection } from '@/hooks/useAdmin';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ApiError } from '@/services/api/client';
import type { AdminSettingField } from '@/types';
import { describeError } from './shared-format';

/**
 * Progress tracking: how % Complete is worked out, and how it adds up.
 *
 * Three settings of the instance's own, served as the `progress-tracking`
 * settings section. Unlike the other settings pages, nothing saves as it is
 * chosen: switching the calculation mode, or how totals are worked out,
 * rewrites existing work packages in the background, and switching to
 * status-based cannot be undone. So the choices are made first, saved once,
 * and the irreversible one is asked about before it happens.
 */

const SECTION = 'progress-tracking';
const MODE = 'workPackageDoneRatio';
const TOTALS = 'totalPercentCompleteMode';
const CLOSED = 'percentCompleteOnStatusClosed';

/** What each choice means, in a sentence. The instance supplies the names. */
const CAPTION: Record<string, string> = {
  get field() { return t('% Complete is typed in freely. If Work is entered, Remaining work is worked out from it.'); },
  get status() { return t('Each status carries a % Complete, so changing the status changes it.'); },
  get work_weighted_average() { return t('Each work package counts by its Work; work packages without Work are left out.'); },
  get simple_average() { return t('Work is ignored: the total is the plain average of the % Complete values below.'); },
  get no_change() { return t('% Complete stays as it was when a work package is closed.'); },
  get set_100p() { return t('A closed work package counts as complete.'); },
};

type Draft = Record<string, string>;

const asDraft = (fields: AdminSettingField[]): Draft =>
  Object.fromEntries(fields.map((field) => [field.key, String(field.value ?? '')]));

export default function ProgressTrackingPage() {
  const query = useSettingsSection(SECTION);
  const update = useUpdateSettingsSection(SECTION);

  const fields = useMemo(() => query.data?.fields ?? [], [query.data]);
  const saved = useMemo(() => asDraft(fields), [fields]);
  const [draft, setDraft] = useState<Draft>({});
  const [confirming, setConfirming] = useState(false);

  // Follows what the instance holds whenever that changes — on load and after
  // a save — so the form never shows a choice that was not kept.
  useEffect(() => setDraft(saved), [saved]);

  if (query.isError && query.error instanceof ApiError && query.error.isNotFound) {
    return (
      <Alert tone="warning" title={t('This instance does not offer this section')}>
        {t('There are no progress settings to change here yet. They appear once the server is updated.')}
      </Alert>
    );
  }

  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => saved[key] !== value));
  const dirty = Object.keys(changes).length > 0;
  const statusBased = draft[MODE] === 'status';
  const modeChanged = MODE in changes;
  const totalsChanged = TOTALS in changes;

  const save = () =>
    update.mutate(changes, {
      onSuccess: () => {
        setConfirming(false);
        toast.success(t('Progress tracking saved'), {
          description:
            modeChanged || totalsChanged
              ? t('Existing work packages are being updated in the background.')
              : undefined,
        });
      },
      onError: (error) => {
        setConfirming(false);
        toast.error(t('That setting was not saved'), { description: describeError(error) });
      },
    });

  return (
    <QueryBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
      errorTitle={t('These settings could not be loaded')}
      skeleton={<ListSkeleton rows={3} height="h-24" />}
    >
      {query.data ? (
        <Card>
          <CardHeader
            actions={
              <>
                <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={!dirty || update.isPending}>
                  {t('Discard')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => (modeChanged || totalsChanged ? setConfirming(true) : save())}
                  disabled={!dirty || update.isPending}
                  loading={update.isPending}
                >
                  {t('Save')}
                </Button>
              </>
            }
          >
            <CardTitle>{query.data.label}</CardTitle>
            <CardDescription>{query.data.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {fields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Choices
                  field={field}
                  value={draft[field.key] ?? ''}
                  disabled={!field.writable || (field.key === CLOSED && statusBased)}
                  note={
                    !field.writable
                      ? t('Set by this instance\'s configuration and cannot be changed here.')
                      : field.key === CLOSED && statusBased
                        ? t('Not used while progress is status-based: the status decides.')
                        : undefined
                  }
                  onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
                />
                {field.key === MODE && modeChanged ? (
                  <Alert tone="warning">
                    {statusBased
                      ? t('Switching to status-based replaces every work package’s % Complete with the value of its status, and Remaining work may be recalculated. This cannot be undone.')
                      : t('Switching to work-based makes % Complete editable again. Values entered for Work or Remaining work are linked to it from then on.')}
                  </Alert>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('Change how progress is worked out?')}
        description={
          modeChanged && statusBased
            ? t('Every work package’s % Complete is replaced with the value of its status. This cannot be undone. The update runs in the background and can take a while on a large instance.')
            : t('Existing work packages are recalculated in the background. This can take a while on a large instance.')
        }
        confirmLabel={t('Save')}
        tone={modeChanged && statusBased ? 'danger' : 'default'}
        pending={update.isPending}
        onConfirm={save}
      />
    </QueryBoundary>
  );
}

/** One setting as a set of choices, each with what it means. */
function Choices({
  field,
  value,
  disabled,
  note,
  onChange,
}: {
  field: AdminSettingField;
  value: string;
  disabled: boolean;
  note?: string;
  onChange: (value: string) => void;
}) {
  const name = `progress-${field.key}`;

  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-xs font-semibold text-foreground">{field.label}</legend>
      {field.help ? <p className="text-2xs text-muted-foreground">{field.help}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {(field.options ?? []).map((option) => {
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
                checked ? 'border-primary/50 bg-primary-soft' : 'border-border hover:bg-muted',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">{option.label}</span>
                {CAPTION[option.value] ? (
                  <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                    {CAPTION[option.value]}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {note ? <p className="text-2xs text-muted-foreground">{note}</p> : null}
    </fieldset>
  );
}
