import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { MultiSelect } from '@/components/common/MultiSelect';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { BAND_CELL, BAND_LABEL } from '@/components/resources/bands';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useResourceSettings, useSaveResourceSettings } from '@/hooks/useResources';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { cn, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { describeError } from './shared-format';

interface Draft {
  under: string;
  full: string;
  over: string;
  hoursPerDay: string;
  billableByDefault: boolean;
  nonBillableActivityIds: string[];
}

/**
 * The resource rules (BR-110, BR-314, BR-315): where the heatmap's colours
 * change, how long a standard working day is, and what counts as billable
 * time. Policy for every utilisation figure, so it needs `resources:configure`;
 * each save is a version, journalled.
 */
export default function ResourceRulesPage() {
  const { can } = useAuth();
  const configure = can('resources:configure');
  const view = useResourceSettings();
  const save = useSaveResourceSettings();
  const users = useUserMap();
  const [draft, setDraft] = useState<Draft>();

  useEffect(() => {
    if (!view.data) return;
    const { settings } = view.data;
    setDraft({
      under: String(settings.thresholds.under),
      full: String(settings.thresholds.full),
      over: String(settings.thresholds.over),
      hoursPerDay: String(settings.hoursPerDay),
      billableByDefault: settings.billableByDefault,
      nonBillableActivityIds: [...settings.nonBillableActivityIds],
    });
  }, [view.data]);

  const activities = useMemo(() => view.data?.activities ?? [], [view.data]);
  const numbers = draft ? { under: Number(draft.under), full: Number(draft.full), over: Number(draft.over), hoursPerDay: Number(draft.hoursPerDay) } : null;
  const problem =
    numbers && !(numbers.under >= 0 && numbers.under <= numbers.full && numbers.full <= numbers.over && numbers.over <= 500)
      ? t('The thresholds must rise: spare below full, full up to over, and over no more than 500%.')
      : numbers && !(numbers.hoursPerDay > 0 && numbers.hoursPerDay <= 24)
        ? t('A working day is between 0 and 24 hours.')
        : null;
  const settings = view.data?.settings;

  const submit = () => {
    if (!draft || !numbers || problem) return;
    save.mutate(
      {
        thresholds: { under: numbers.under, full: numbers.full, over: numbers.over },
        hoursPerDay: numbers.hoursPerDay,
        billableByDefault: draft.billableByDefault,
        nonBillableActivityIds: draft.nonBillableActivityIds,
      },
      {
        onSuccess: (saved) => toast.success(t('Resource rules version {version} saved', { version: saved.version })),
        onError: (error) => toast.error(t('The rules were not saved'), { description: describeError(error) }),
      },
    );
  };

  return (
    <div className="space-y-4">
      {!configure ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('Changing these needs the resource rules permission (resources:configure).')}
        </Alert>
      ) : null}
      <QueryBoundary
        isLoading={view.isLoading}
        isError={view.isError}
        error={view.error}
        onRetry={() => void view.refetch()}
        errorTitle={t('The resource rules could not be loaded')}
        skeleton={<ListSkeleton rows={5} />}
      >
        {draft && numbers ? (
          <>
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Heatmap thresholds')}</CardTitle>
                <CardDescription>{t('Load as a share of the hours available. Over-allocation itself is always more than 100%.')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <div className="grid grid-cols-3 gap-3 sm:max-w-md">
                  {(['under', 'full', 'over'] as const).map((key) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`threshold-${key}`}>
                        {key === 'under' ? t('Spare below') : key === 'full' ? t('Full above') : t('Over above')}
                      </Label>
                      <Input
                        id={`threshold-${key}`}
                        inputMode="decimal"
                        value={draft[key]}
                        disabled={!configure}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-2xs">
                  {(['under', 'healthy', 'full', 'over'] as const).map((band) => (
                    <span key={band} className={cn('rounded-sm px-2 py-1', BAND_CELL[band])}>
                      {BAND_LABEL[band]}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('A working day')}</CardTitle>
                <CardDescription>{t('The hours of a standard day: the pattern a new work schedule starts from.')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-4">
                <Label htmlFor="hours-per-day">{t('Hours in a working day')}</Label>
                <Input id="hours-per-day" inputMode="decimal" className="w-32" value={draft.hoursPerDay} disabled={!configure} onChange={(event) => setDraft({ ...draft, hoursPerDay: event.target.value })} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Billable time')}</CardTitle>
                <CardDescription>
                  {t('Time is billable when its project is — marked on the project’s plan, or else by the default here — and its activity is not one of those below.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="billable-default">{t('A project nobody has marked')}</Label>
                  <Select
                    value={draft.billableByDefault ? 'yes' : 'no'}
                    disabled={!configure}
                    onValueChange={(value) => setDraft({ ...draft, billableByDefault: value === 'yes' })}
                  >
                    <SelectTrigger id="billable-default" className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">{t('Is billable')}</SelectItem>
                      <SelectItem value="no">{t('Is not billable')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('Activities that are never billable')}</Label>
                  <MultiSelect
                    label={t('Activities that are never billable')}
                    options={activities}
                    selected={activities.filter((activity) => draft.nonBillableActivityIds.includes(activity.id))}
                    onChange={(selected) => setDraft({ ...draft, nonBillableActivityIds: selected.map((entry) => entry.id) })}
                    disabled={!configure || activities.length === 0}
                    placeholder={activities.length === 0 ? t('No activity has been logged yet') : t('None')}
                  />
                  {activities.length === 0 ? <FieldHint>{t('Activities appear here once time has been logged with them.')}</FieldHint> : null}
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-2xs text-muted-foreground">
                {settings && settings.version > 0
                  ? t('Version {version}, saved {when} by {who}.', {
                      version: settings.version,
                      when: settings.updatedAt ? formatDateTime(settings.updatedAt) : '',
                      who: users.get(settings.updatedBy ?? '')?.name ?? t('someone'),
                    })
                  : t('The defaults: nothing has been saved yet.')}
              </p>
              {configure ? (
                <div className="flex items-center gap-3">
                  {problem ? <FieldError>{problem}</FieldError> : null}
                  <Button size="sm" disabled={Boolean(problem)} loading={save.isPending} onClick={submit}>
                    {t('Save')}
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </QueryBoundary>
    </div>
  );
}
