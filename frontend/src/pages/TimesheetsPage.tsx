import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ListSkeleton } from '@/components/common/DataTable';
import { Pagination } from '@/components/common/Pagination';
import { TIMESHEET_STATUS, TimesheetBar } from '@/components/time/TimesheetBar';
import { TimesheetEntries } from '@/components/time/TimesheetEntries';
import { TimeEntryDialog } from '@/components/time/TimeEntryDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePagination } from '@/hooks/usePagination';
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
  // People opens on the current period and everyone in it, so time logged this
  // week shows at once. It opened on last week's outstanding list, where
  // nothing logged this week can appear: last week is one click back, and the
  // Delivery Manager's Overview lists who still owes it.
  const [day, setDay] = useState(() => params.get('day') ?? today);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const query: TimesheetOverviewQuery = { day, ...(status === 'all' ? {} : { status }) };
  const overview = useTimesheetOverview(query);
  // Narrowed by name here: the period's list is already in hand.
  const needle = search.trim().toLowerCase();
  const peopleRows = useMemo(
    () => (overview.data?.rows ?? []).filter((row) => !needle || row.personName.toLowerCase().includes(needle)),
    [overview.data, needle],
  );
  // A page at a time: a whole organisation's people is hundreds of rows.
  const peoplePage = usePagination(peopleRows, { pageSize: 25, resetKey: `${day}:${status}:${needle}` });
  const peopleAllowed = can('timesheets:manage') || can('timesheets:view') || overview.isSuccess;
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
            <div className="ms-auto w-full sm:w-56">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('Search people…')}
                aria-label={t('Search people')}
                className="h-8 text-xs"
              />
            </div>
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
                      {peoplePage.items.map((row) => (
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
                      {peopleRows.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-4 text-2xs text-muted-foreground">
                            {t('Nobody here.')}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  {peopleRows.length > 0 ? (
                    <Pagination
                      page={peoplePage.page}
                      pageSize={peoplePage.pageSize}
                      total={peoplePage.total}
                      onPageChange={peoplePage.setPage}
                      onPageSizeChange={peoplePage.setPageSize}
                      pageSizeOptions={[10, 25, 50, 100]}
                      itemLabel={t('person')}
                      itemLabelPlural={t('people')}
                    />
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
          </QueryBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The reader's own timesheet, any period: moved back and forth like the People
 * tab, so last week's — forgotten, or rejected — can be opened, filled in and
 * submitted here. It used to show the current period only, and the list below
 * holds only timesheets already submitted, so a week nobody had submitted could
 * not be reached from this page at all.
 */
function MyTimesheets({ today }: { today: string }) {
  const [day, setDay] = useState(today);
  const current = useMyTimesheet(day);
  const history = useTimesheetHistory();
  const rows = useMemo(() => history.data ?? [], [history.data]);
  const historyPage = usePagination(rows, { pageSize: 10 });
  const [logOn, setLogOn] = useState<string | null>(null);
  const view = current.data;
  const thisPeriod = !view || (today >= view.periodStart && today <= view.periodEnd);
  const mayLog = view?.status === 'draft' && view.periodStart <= today;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Previous period')}
            onClick={() => setDay(addDays(view?.periodStart ?? day, -1))}
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <span className="min-w-40 px-2 text-center text-2xs">
            {view ? t('{from} to {to}', { from: formatShortDate(view.periodStart), to: formatShortDate(view.periodEnd) }) : '…'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Next period')}
            onClick={() => setDay(addDays(view?.periodEnd ?? day, 1))}
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
        </div>
        <Button size="sm" variant="secondary" disabled={thisPeriod} onClick={() => setDay(today)}>
          {t('This period')}
        </Button>
      </div>
      <TimesheetBar view={view} loading={current.isLoading} day={view?.periodStart ?? day} />
      {view ? <TimesheetEntries view={view} onAdd={mayLog ? setLogOn : undefined} /> : null}
      {logOn ? <TimeEntryDialog open spentOn={logOn} onOpenChange={(open) => !open && setLogOn(null)} /> : null}
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Submitted timesheets')}</CardTitle>
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
                {historyPage.items.map((row) => (
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
            {rows.length > 0 ? (
              <Pagination
                page={historyPage.page}
                pageSize={historyPage.pageSize}
                total={historyPage.total}
                onPageChange={historyPage.setPage}
                onPageSizeChange={historyPage.setPageSize}
                pageSizeOptions={[10, 25, 50]}
                itemLabel={t('timesheet')}
                itemLabelPlural={t('timesheets')}
              />
            ) : null}
          </QueryBoundary>
        </CardContent>
      </Card>
    </>
  );
}
