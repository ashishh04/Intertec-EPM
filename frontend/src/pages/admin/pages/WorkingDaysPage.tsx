import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ListSkeleton } from '@/components/common/DataTable';
import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAdminConfiguration, useUpdateWeekDays, useWeekDays } from '@/hooks/useAdmin';
import { formatNumber, pluralize } from '@/lib/utils';
import type { AdminWeekDay } from '@/services/api/admin';
import { describeError, isNotImplementedUpstream, valueOr } from './shared-format';
import { ManagedUpstreamNotice } from './shared-notices';

/**
 * Working days and hours, shaped like OpenProject's page of the same name:
 * one switch per week day, the hours and days the instance plans with, and a
 * save that writes all seven days at once.
 */
export default function WorkingDaysPage() {
  const weekDays = useWeekDays();
  const configuration = useAdminConfiguration();
  const update = useUpdateWeekDays();

  // Local edits, keyed by day number. Empty until the list arrives and after
  // every reset, so "dirty" is simply "differs from what the server said".
  const [edits, setEdits] = useState<Record<number, boolean>>({});
  // Set once the instance has refused a write because its API does not offer
  // it. Kept for the rest of the visit so the notice does not flicker away.
  const [managedUpstream, setManagedUpstream] = useState(false);

  const serverDays = useMemo(
    () => [...(weekDays.data ?? [])].sort((a, b) => a.day - b.day),
    [weekDays.data],
  );

  useEffect(() => {
    setEdits({});
  }, [weekDays.data]);

  const days: AdminWeekDay[] = serverDays.map((day) => ({
    ...day,
    working: edits[day.day] ?? day.working,
  }));
  const dirty = days.some((day, index) => day.working !== serverDays[index]?.working);
  const workingCount = days.filter((day) => day.working).length;

  const save = () => {
    update.mutate(
      { days: days.map((day) => ({ day: day.day, working: day.working })) },
      {
        onSuccess: () => {
          setEdits({});
          toast.success('Working days saved', {
            description: `${formatNumber(workingCount)} working ${pluralize(workingCount, 'day')} a week.`,
          });
        },
        onError: (error) => {
          if (isNotImplementedUpstream(error)) setManagedUpstream(true);
          toast.error('Working days were not saved', { description: describeError(error) });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      {managedUpstream ? <ManagedUpstreamNotice shown="values" /> : null}

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Working days</CardTitle>
          <CardDescription>
            The days of the week work is scheduled on. Days switched off are skipped when
            start and finish dates are calculated.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <QueryBoundary
            isLoading={weekDays.isLoading}
            isError={weekDays.isError}
            error={weekDays.error}
            onRetry={() => void weekDays.refetch()}
            errorTitle="Working days could not be loaded"
            skeleton={<ListSkeleton rows={7} height="h-10" />}
          >
            <ul className="divide-y divide-border rounded-lg border border-border">
              {days.map((day) => {
                const id = `working-day-${day.day}`;
                return (
                  <li key={day.day} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <Label htmlFor={id} className="text-xs font-normal">
                      {day.name}
                    </Label>
                    <div className="flex items-center gap-2">
                      <span className="text-2xs text-muted-foreground">
                        {day.working ? 'Working' : 'Not working'}
                      </span>
                      <Switch
                        id={id}
                        checked={day.working}
                        disabled={update.isPending}
                        onCheckedChange={(checked) =>
                          setEdits((current) => ({ ...current, [day.day]: checked }))
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>

            <p className="text-xs text-muted-foreground" aria-live="polite">
              {formatNumber(workingCount)} working {pluralize(workingCount, 'day')}
              {dirty ? ' (unsaved)' : ''}
            </p>

            <Alert tone="warning">
              Changing working days reschedules work packages in the delivery system. Every item
              whose dates fall on a day that stops being a working day is moved, and durations
              are recalculated. This applies to all projects.
            </Alert>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={save} disabled={!dirty} loading={update.isPending}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEdits({})}
                disabled={!dirty || update.isPending}
              >
                Reset
              </Button>
            </div>
          </QueryBoundary>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Hours and days</CardTitle>
          <CardDescription>
            What one day and one month mean when durations are converted. Read from the
            configuration; changed centrally.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <QueryBoundary
            isLoading={configuration.isLoading}
            isError={configuration.isError}
            error={configuration.error}
            onRetry={() => void configuration.refetch()}
            errorTitle="Configuration could not be loaded"
            skeleton={<ListSkeleton rows={2} height="h-10" />}
          >
            <FactList
              facts={[
                { label: 'Hours per day', value: valueOr(configuration.data?.hoursPerDay, 'Not set') },
                { label: 'Days per month', value: valueOr(configuration.data?.daysPerMonth, 'Not set') },
              ]}
            />
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
