import { Link } from 'react-router-dom';
import { AlertTriangle, Lock, Send, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSubmitTimesheet, useWithdrawTimesheet } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { formatHours, formatShortDate } from '@/lib/utils';
import type { TimesheetStatus, TimesheetView } from '@/types';

export const TIMESHEET_STATUS: Record<TimesheetStatus, { label: string; tone: 'neutral' | 'primary' | 'success' }> = {
  draft: { get label() { return t('Draft'); }, tone: 'neutral' },
  submitted: { get label() { return t('Submitted'); }, tone: 'primary' },
  approved: { get label() { return t('Approved'); }, tone: 'success' },
};

/**
 * The timesheet for the week on screen (BR-304, BR-305): its hours against the
 * bounds, what stops it being submitted, a rejection's reason, and submitting
 * or withdrawing it. Submitted or approved, its time is locked.
 */
export function TimesheetBar({ view, loading, day }: { view?: TimesheetView; loading: boolean; day: string }) {
  const submit = useSubmitTimesheet();
  const withdraw = useWithdrawTimesheet();
  if (loading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (!view) return null;

  const { minimum, maximum } = view.bounds;
  const bounds =
    minimum !== null && maximum !== null
      ? t('{min} to {max} needed', { min: formatHours(minimum), max: formatHours(maximum) })
      : minimum !== null
        ? t('at least {min} needed', { min: formatHours(minimum) })
        : maximum !== null
          ? t('at most {max} allowed', { max: formatHours(maximum) })
          : null;

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TIMESHEET_STATUS[view.status].tone}>{TIMESHEET_STATUS[view.status].label}</Badge>
            {view.can.submit ? (
              <Button
                size="sm"
                loading={submit.isPending}
                onClick={() =>
                  submit.mutate(day, {
                    onSuccess: () => toast.success(t('Timesheet submitted for approval')),
                    onError: (error) =>
                      toast.error(t('The timesheet was not submitted'), { description: error instanceof Error ? error.message : undefined }),
                  })
                }
              >
                <Send className="h-3.5 w-3.5" />
                {t('Submit timesheet')}
              </Button>
            ) : null}
            {view.can.withdraw && view.id ? (
              <Button
                size="sm"
                variant="secondary"
                loading={withdraw.isPending}
                onClick={() =>
                  withdraw.mutate(view.id!, {
                    onSuccess: () => toast.success(t('Timesheet withdrawn: its time can be changed again')),
                    onError: (error) =>
                      toast.error(t('The timesheet was not withdrawn'), { description: error instanceof Error ? error.message : undefined }),
                  })
                }
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t('Withdraw')}
              </Button>
            ) : null}
            {view.id ? (
              <Button size="sm" variant="ghost" asChild>
                <Link to={`/timesheets/${view.id}`}>{t('Open')}</Link>
              </Button>
            ) : null}
          </div>
        }
      >
        <CardTitle className="flex items-center gap-2">
          {view.locked ? <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label={t('Locked by its timesheet')} /> : null}
          {t('Timesheet for {from} to {to}', { from: formatShortDate(view.periodStart), to: formatShortDate(view.periodEnd) })}
        </CardTitle>
        <CardDescription className="text-2xs">
          {t('{hours} logged of {available} available', { hours: formatHours(view.hours), available: formatHours(view.available) })}
          {bounds ? ` · ${bounds}` : ''}
        </CardDescription>
      </CardHeader>
      {view.rejection || view.reopened || view.problems.length > 0 || view.locked ? (
        <CardContent className="space-y-2 p-4 pt-0">
          {view.rejection ? (
            <Alert tone="danger" title={t('Rejected by {name}', { name: view.rejection.byName ?? t('Someone no longer listed') })}>
              <span dir="auto">{view.rejection.reason}</span>
            </Alert>
          ) : null}
          {view.reopened && view.status === 'draft' ? (
            <Alert tone="warning" title={t('Reopened by {name}', { name: view.reopened.byName ?? t('Someone no longer listed') })}>
              <span dir="auto">{view.reopened.reason}</span>
            </Alert>
          ) : null}
          {view.locked ? (
            <p className="text-2xs text-muted-foreground">
              {view.status === 'approved'
                ? t('Approved: its time is locked. Whoever manages timesheets can reopen it.')
                : t('Submitted: its time is locked until it is decided, or until you withdraw it.')}
            </p>
          ) : null}
          {view.status === 'draft'
            ? view.problems.map((problem) => (
                <p key={problem} className="flex items-start gap-1.5 text-2xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span>{problem}</span>
                </p>
              ))
            : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
