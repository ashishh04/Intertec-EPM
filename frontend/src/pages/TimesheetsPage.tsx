import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { TIMESHEET_STATUS, TimesheetBar } from '@/components/time/TimesheetBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMyTimesheet, useTimesheetHistory, useTimesheetOverview } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { cn, formatDateTime, formatHours, formatShortDate, toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { TimesheetOverviewQuery } from '@/services/api/timesheets';

const STATUSES = ['outstanding', 'submitted', 'approved', 'rejected'] as const;
type StatusFilter = (typeof STATUSES)[number] | 'all';

const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Timesheets (BR-304 to BR-306): your own, period by period; and, for a team
 * lead, a department manager or whoever manages timesheets, everyone's for a
 * period — submitted, approved, rejected, and outstanding: expected and not in.
 */
export default function TimesheetsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = toISODateOnly(new Date());
  const [day, setDay] = useState(() => params.get('day') ?? addDays(today, -7));
  const [status, setStatus] = useState<StatusFilter>('outstanding');
  const query: TimesheetOverviewQuery = { day, ...(status === 'all' ? {} : { status }) };
  const overview = useTimesheetOverview(query);
  const peopleAllowed = can('timesheets:manage') || overview.isSuccess;
  const tab = params.get('tab') === 'people' && peopleAllowed ? 'people' : 'mine';

  return (
    <div className="space-y-5">
      <PageHeader title={t('Timesheets')} description={t('Time submitted for approval, period by period, and what is still outstanding.')} />
      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList variant="underline">
          <TabsTrigger value="mine" variant="underline">
            {t('My timesheets')}
          </TabsTrigger>
          {peopleAllowed ? (
            <TabsTrigger value="people" variant="underline">
              {t('People')}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="mine" className="mt-4 space-y-4">
          <MyTimesheets today={today} />
        </TabsContent>
        <TabsContent value="people" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
              <Button variant="ghost" size="icon-sm" aria-label={t('Previous period')} onClick={() => setDay(addDays(overview.data?.periodStart ?? day, -1))}>
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
              </Button>
              <span className="min-w-40 px-2 text-center text-2xs">
                {overview.data ? t('{from} to {to}', { from: formatShortDate(overview.data.periodStart), to: formatShortDate(overview.data.periodEnd) }) : '…'}
              </span>
              <Button variant="ghost" size="icon-sm" aria-label={t('Next period')} onClick={() => setDay(addDays(overview.data?.periodEnd ?? day, 1))}>
                <ChevronRight className="h-4 w-4 rtl:rotate-180" />
              </Button>
            </div>
            {(['all', ...STATUSES] as const).map((value) => (
              <Button key={value} size="sm" variant={status === value ? 'default' : 'secondary'} onClick={() => setStatus(value)}>
                {value === 'all'
                  ? t('Everyone')
                  : value === 'outstanding'
                    ? t('Outstanding ({count})', { count: overview.data?.counts.outstanding ?? 0 })
                    : value === 'submitted'
                      ? t('Submitted ({count})', { count: overview.data?.counts.submitted ?? 0 })
                      : value === 'approved'
                        ? t('Approved ({count})', { count: overview.data?.counts.approved ?? 0 })
                        : t('Rejected ({count})', { count: overview.data?.counts.rejected ?? 0 })}
              </Button>
            ))}
          </div>
          <QueryBoundary
            isLoading={overview.isLoading}
            isError={overview.isError}
            error={overview.error}
            onRetry={() => void overview.refetch()}
            errorTitle={t('The timesheets could not be loaded')}
            skeleton={<ListSkeleton rows={6} />}
          >
            {overview.data ? (
              <Card>
                <CardContent className="p-0">
                  {!overview.data.closed ? (
                    <p className="border-b border-border px-4 py-2 text-2xs text-muted-foreground">
                      {t('This period has not ended: nobody is outstanding yet.')}
                    </p>
                  ) : null}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-2xs text-muted-foreground">
                        <th className="px-4 py-2 text-start font-medium">{t('Person')}</th>
                        <th className="px-4 py-2 text-start font-medium">{t('Status')}</th>
                        <th className="px-4 py-2 text-end font-medium">{t('Logged')}</th>
                        <th className="px-4 py-2 text-end font-medium">{t('Available')}</th>
                        <th className="px-4 py-2 text-start font-medium">{t('Submitted')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.data.rows.map((row) => (
                        <tr key={row.personId} className="border-b border-border/60">
                          <td className="px-4 py-2">
                            <Link
                              to={row.timesheetId ? `/timesheets/${row.timesheetId}` : `/timesheets/people/${row.personId}?day=${overview.data!.periodStart}`}
                              className="hover:text-primary"
                              dir="auto"
                            >
                              {row.personName}
                            </Link>
                          </td>
                          <td className="px-4 py-2">
                            {row.status === 'missing' ? (
                              <Badge tone={row.outstanding ? 'danger' : 'neutral'}>{row.outstanding ? t('Outstanding') : t('Not submitted')}</Badge>
                            ) : (
                              <Badge tone={row.rejected ? 'danger' : TIMESHEET_STATUS[row.status].tone}>
                                {row.rejected ? t('Rejected') : TIMESHEET_STATUS[row.status].label}
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-2 text-end font-mono">{formatHours(row.hours)}</td>
                          <td className={cn('px-4 py-2 text-end font-mono', row.available === 0 && 'text-muted-foreground')}>{formatHours(row.available)}</td>
                          <td className="px-4 py-2 text-2xs text-muted-foreground">{row.submittedAt ? formatDateTime(row.submittedAt) : '—'}</td>
                        </tr>
                      ))}
                      {overview.data.rows.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-4 text-2xs text-muted-foreground">
                            {t('Nobody here.')}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ) : null}
          </QueryBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MyTimesheets({ today }: { today: string }) {
  const current = useMyTimesheet(today);
  const history = useTimesheetHistory();
  const rows = useMemo(() => history.data ?? [], [history.data]);
  return (
    <>
      <TimesheetBar view={current.data} loading={current.isLoading} day={today} />
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Earlier timesheets')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <QueryBoundary
            isLoading={history.isLoading}
            isError={history.isError}
            error={history.error}
            onRetry={() => void history.refetch()}
            errorTitle={t('Your timesheets could not be loaded')}
            skeleton={<ListSkeleton rows={4} />}
          >
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-2xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">{t('Period')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('Status')}</th>
                  <th className="px-4 py-2 text-end font-medium">{t('Hours')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('Submitted')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="px-4 py-2">
                      <Link to={`/timesheets/${row.id}`} className="hover:text-primary">
                        {t('{from} to {to}', { from: formatShortDate(row.periodStart), to: formatShortDate(row.periodEnd) })}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={row.rejected ? 'danger' : TIMESHEET_STATUS[row.status].tone}>
                        {row.rejected ? t('Rejected') : TIMESHEET_STATUS[row.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-end font-mono">{row.hours === null ? '—' : formatHours(row.hours)}</td>
                    <td className="px-4 py-2 text-2xs text-muted-foreground">{row.submittedAt ? formatDateTime(row.submittedAt) : '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-4 text-2xs text-muted-foreground">
                      {t('You have not submitted a timesheet yet.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </QueryBoundary>
        </CardContent>
      </Card>
    </>
  );
}
