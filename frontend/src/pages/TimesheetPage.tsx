import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { RequestCard } from '@/components/approvals/RequestCard';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TIMESHEET_STATUS } from '@/components/time/TimesheetBar';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { usePersonTimesheet, useReopenTimesheet, useTimesheet, useWithdrawTimesheet } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { formatDateTime, formatHours, formatShortDate } from '@/lib/utils';
import type { TimesheetView } from '@/types';

/**
 * One timesheet (BR-304 to BR-306): its time by project against the bounds, a
 * rejection's reason, and its approval — decided here by whoever is asked. By
 * id, or as a person's timesheet for the period a day falls in, for a manager
 * reading one that has not been submitted yet.
 */
export default function TimesheetPage() {
  const { id, personId } = useParams();
  const [params] = useSearchParams();
  const byId = useTimesheet(id);
  const byPerson = usePersonTimesheet(id ? undefined : personId, params.get('day') ?? undefined);
  const query = id ? byId : byPerson;

  return (
    <div className="space-y-5">
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        errorTitle={t('The timesheet could not be loaded')}
        skeleton={<Skeleton className="h-64 w-full rounded-xl" />}
      >
        {query.data ? <TimesheetDetail view={query.data} /> : null}
      </QueryBoundary>
    </div>
  );
}

function TimesheetDetail({ view }: { view: TimesheetView }) {
  const withdraw = useWithdrawTimesheet();
  const reopen = useReopenTimesheet();
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const { minimum, maximum } = view.bounds;

  return (
    <>
      <PageHeader
        title={t('Timesheet: {name}', { name: view.personName })}
        description={t('{from} to {to}', { from: formatShortDate(view.periodStart), to: formatShortDate(view.periodEnd) })}
        meta={<Badge tone={TIMESHEET_STATUS[view.status].tone}>{TIMESHEET_STATUS[view.status].label}</Badge>}
        actions={
          <>
            {view.can.withdraw && view.id ? (
              <Button
                variant="secondary"
                loading={withdraw.isPending}
                onClick={() =>
                  withdraw.mutate(view.id!, {
                    onSuccess: () => toast.success(t('Timesheet withdrawn: its time can be changed again')),
                    onError: (failure) =>
                      toast.error(t('The timesheet was not withdrawn'), { description: failure instanceof Error ? failure.message : undefined }),
                  })
                }
              >
                <Undo2 className="h-4 w-4" />
                {t('Withdraw')}
              </Button>
            ) : null}
            {view.can.reopen ? (
              <Button variant="secondary" onClick={() => setReopening(true)}>
                {t('Reopen')}
              </Button>
            ) : null}
          </>
        }
      />

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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader variant="compact">
            <CardTitle>{t('Time in the period')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <Figure label={t('Logged')} value={formatHours(view.hours)} />
              <Figure label={t('Available')} value={formatHours(view.available)} />
              <Figure label={t('At least')} value={minimum === null ? '—' : formatHours(minimum)} />
              <Figure label={t('At most')} value={maximum === null ? '—' : formatHours(maximum)} />
            </dl>
            {view.unattributedHours > 0 ? (
              <p className="text-2xs text-muted-foreground">
                {t('{hours} on no work package.', { hours: formatHours(view.unattributedHours) })}
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
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-start text-2xs text-muted-foreground">
                  <th className="py-1.5 text-start font-medium">{t('Project')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Hours')}</th>
                </tr>
              </thead>
              <tbody>
                {view.projects.map((project) => (
                  <tr key={project.projectId} className="border-b border-border/60">
                    <td className="py-1.5" dir="auto">
                      {project.projectName}
                    </td>
                    <td className="py-1.5 text-end font-mono">{formatHours(project.hours)}</td>
                  </tr>
                ))}
                {view.projects.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="py-3 text-2xs text-muted-foreground">
                      {t('Nothing logged in the period.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <p className="text-2xs text-muted-foreground">
              {view.submittedAt ? t('Submitted {when}.', { when: formatDateTime(view.submittedAt) }) : t('Not submitted.')}
              {view.approvedAt ? ` ${t('Approved {when}.', { when: formatDateTime(view.approvedAt) })}` : ''}
            </p>
          </CardContent>
        </Card>
        <div>{view.request ? <RequestCard request={view.request} /> : null}</div>
      </div>

      <Dialog open={reopening} onOpenChange={(open) => !reopen.isPending && setReopening(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Reopen this timesheet?')}</DialogTitle>
            <DialogDescription>{t('It returns to draft and its time unlocks; the person is shown your reason.')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reopen-reason" required>
              {t('Reason')}
            </Label>
            <Textarea id="reopen-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
            {error ? <FieldError>{error}</FieldError> : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setReopening(false)}>
              {t('Cancel')}
            </Button>
            <Button
              loading={reopen.isPending}
              disabled={reason.trim().length < 3}
              onClick={() =>
                reopen.mutate(
                  { id: view.id!, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success(t('Timesheet reopened'));
                      setReopening(false);
                      setReason('');
                    },
                    onError: (failure) => setError(failure instanceof Error ? failure.message : t('It was not reopened.')),
                  },
                )
              }
            >
              {t('Reopen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-medium">{value}</dd>
    </div>
  );
}
