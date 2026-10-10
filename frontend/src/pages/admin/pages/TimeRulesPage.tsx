import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSaveTimeSettings, useTimeSettings } from '@/hooks/useTimesheets';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { TimeSettings } from '@/types';
import { describeError } from './shared-format';

type Draft = Pick<TimeSettings, 'timesheets' | 'policies' | 'expenses'>;

/**
 * The time and expense rules (Module 10): the timesheet period and the hours a
 * timesheet may be submitted with (BR-304), reminders for outstanding ones
 * (BR-306), the time logging policies (BR-317) and the receipt threshold
 * (BR-307). Policy for everyone, so it needs `time:configure`; each save is a
 * version, journalled.
 */
export default function TimeRulesPage() {
  const { can } = useAuth();
  const configure = can('time:configure');
  const view = useTimeSettings();
  const save = useSaveTimeSettings();
  const users = useUserMap();
  const [draft, setDraft] = useState<Draft>();

  useEffect(() => {
    if (!view.data) return;
    const { timesheets, policies, expenses } = view.data.settings;
    setDraft(structuredClone({ timesheets, policies, expenses }));
  }, [view.data]);

  const settings = view.data?.settings;
  const names = view.data?.policyNames;
  const set = (change: (next: Draft) => void) =>
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      change(next);
      return next;
    });
  const number = (value: string) => (value.trim() === '' ? null : Number(value));

  return (
    <div className="space-y-4">
      {!configure ? (
        <Alert tone="neutral" title={t('Read only')}>
          {t('Changing these needs the time and expense rules permission (time:configure).')}
        </Alert>
      ) : null}
      <QueryBoundary
        isLoading={view.isLoading}
        isError={view.isError}
        error={view.error}
        onRetry={() => void view.refetch()}
        errorTitle={t('The time and expense rules could not be loaded')}
        skeleton={<ListSkeleton rows={6} />}
      >
        {draft && names ? (
          <>
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Timesheets')}</CardTitle>
                <CardDescription>{t('A person submits their time for a period; it is approved by their line manager and then the owners of the projects it is on, and locked meanwhile.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ts-period">{t('Period')}</Label>
                  <Select value={draft.timesheets.period} disabled={!configure} onValueChange={(value) => set((next) => void (next.timesheets.period = value as 'week' | 'month'))}>
                    <SelectTrigger id="ts-period" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="week">{t('A week, Monday to Sunday')}</SelectItem>
                      <SelectItem value="month">{t('A calendar month')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-minimum">{t('The fewest hours')}</Label>
                  <div className="flex gap-2">
                    <Select
                      value={draft.timesheets.minimum.basis}
                      disabled={!configure}
                      onValueChange={(value) => set((next) => void (next.timesheets.minimum.basis = value as 'available' | 'fixed' | 'none'))}
                    >
                      <SelectTrigger id="ts-minimum" className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">{t('The hours they were available')}</SelectItem>
                        <SelectItem value="fixed">{t('A fixed number')}</SelectItem>
                        <SelectItem value="none">{t('No minimum')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {draft.timesheets.minimum.basis === 'fixed' ? (
                      <Input
                        aria-label={t('The fewest hours')}
                        className="w-24"
                        inputMode="decimal"
                        disabled={!configure}
                        value={draft.timesheets.minimum.hours ?? ''}
                        onChange={(event) => set((next) => void (next.timesheets.minimum.hours = number(event.target.value)))}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-maximum">{t('The most hours')}</Label>
                  <div className="flex gap-2">
                    <Select
                      value={draft.timesheets.maximum.basis}
                      disabled={!configure}
                      onValueChange={(value) => set((next) => void (next.timesheets.maximum.basis = value as 'fixed' | 'none'))}
                    >
                      <SelectTrigger id="ts-maximum" className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fixed">{t('A fixed number')}</SelectItem>
                        <SelectItem value="none">{t('No maximum')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {draft.timesheets.maximum.basis === 'fixed' ? (
                      <Input
                        aria-label={t('The most hours')}
                        className="w-24"
                        inputMode="decimal"
                        disabled={!configure}
                        value={draft.timesheets.maximum.hours ?? ''}
                        onChange={(event) => set((next) => void (next.timesheets.maximum.hours = number(event.target.value)))}
                      />
                    ) : null}
                  </div>
                </div>
                <Toggle
                  id="ts-wp"
                  label={t('Every hour is on a work package, not just a project')}
                  checked={draft.timesheets.requireWorkPackage}
                  disabled={!configure}
                  onChange={(value) => set((next) => void (next.timesheets.requireWorkPackage = value))}
                />
                <Toggle
                  id="ts-reminders"
                  label={t('Remind people whose timesheet for a period that has ended is not in')}
                  checked={draft.timesheets.reminders}
                  disabled={!configure}
                  onChange={(value) => set((next) => void (next.timesheets.reminders = value))}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Time logging policies')}</CardTitle>
                <CardDescription>{t('An entry that breaks a policy that is on is refused, and the policy is named.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Toggle
                    id="p-daily"
                    label={names.maxDailyHours}
                    checked={draft.policies.maxDailyHours.active}
                    disabled={!configure}
                    onChange={(value) => set((next) => void (next.policies.maxDailyHours.active = value))}
                  />
                  <Input
                    aria-label={names.maxDailyHours}
                    className="w-24"
                    inputMode="decimal"
                    disabled={!configure || !draft.policies.maxDailyHours.active}
                    value={draft.policies.maxDailyHours.hours}
                    onChange={(event) => set((next) => void (next.policies.maxDailyHours.hours = Number(event.target.value)))}
                  />
                </div>
                <div className="space-y-2">
                  <Toggle
                    id="p-back"
                    label={names.backdating}
                    checked={draft.policies.backdating.active}
                    disabled={!configure}
                    onChange={(value) => set((next) => void (next.policies.backdating.active = value))}
                  />
                  <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <Input
                      aria-label={names.backdating}
                      className="w-24"
                      inputMode="numeric"
                      disabled={!configure || !draft.policies.backdating.active}
                      value={draft.policies.backdating.days}
                      onChange={(event) => set((next) => void (next.policies.backdating.days = Number(event.target.value)))}
                    />
                    {t('days back at most')}
                  </div>
                </div>
                <Toggle
                  id="p-activity"
                  label={names.mandatoryActivity}
                  checked={draft.policies.mandatoryActivity.active}
                  disabled={!configure}
                  onChange={(value) => set((next) => void (next.policies.mandatoryActivity.active = value))}
                />
                <Toggle
                  id="p-closed"
                  label={names.closedWorkPackages}
                  checked={draft.policies.closedWorkPackages.active}
                  disabled={!configure}
                  onChange={(value) => set((next) => void (next.policies.closedWorkPackages.active = value))}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Expense claims')}</CardTitle>
                <CardDescription>{t('A claim above the threshold needs a receipt before it can be submitted.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ex-threshold">{t('Receipt needed above')}</Label>
                  <Input
                    id="ex-threshold"
                    className="w-32"
                    inputMode="decimal"
                    disabled={!configure}
                    value={draft.expenses.receiptThreshold}
                    onChange={(event) => set((next) => void (next.expenses.receiptThreshold = Number(event.target.value)))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ex-currency">{t('Currency')}</Label>
                  <Input
                    id="ex-currency"
                    className="w-24 uppercase"
                    maxLength={3}
                    disabled={!configure}
                    value={draft.expenses.currency}
                    onChange={(event) => set((next) => void (next.expenses.currency = event.target.value.toUpperCase()))}
                  />
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
                <Button
                  size="sm"
                  loading={save.isPending}
                  onClick={() =>
                    save.mutate(draft, {
                      onSuccess: (saved) => toast.success(t('Time and expense rules version {version} saved', { version: saved.version })),
                      onError: (error) => toast.error(t('The rules were not saved'), { description: describeError(error) }),
                    })
                  }
                >
                  {t('Save')}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function Toggle({ id, label, checked, disabled, onChange }: { id: string; label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}
