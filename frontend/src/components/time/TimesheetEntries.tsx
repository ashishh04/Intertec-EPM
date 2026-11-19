import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Plus } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePagination } from '@/hooks/usePagination';
import { intlLocale, t } from '@/lib/i18n';
import { cn, formatHours } from '@/lib/utils';
import type { TimesheetLine, TimesheetView } from '@/types';

/**
 * A timesheet's time, as people expect a timesheet to look: for a week, a grid
 * of each task against each day with the totals; for any period, every entry
 * day by day with what was written about it. The page used to show the hours
 * per project and nothing else, so whoever approved a timesheet agreed to
 * hours without seeing what they were spent on, and the person submitting it
 * could not see what they were submitting.
 *
 * The entries are paged, twenty to a page by default, each page still read day
 * by day: a month of a busy person's time is a few hundred rows.
 */

const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

function daysOf(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end && days.length < 62; day = addDays(day, 1)) days.push(day);
  return days;
}

const weekday = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: 'short', timeZone: 'UTC' });
const dayMonth = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * The work an entry was on: its task, or its project when it names no task, or
 * — for time on no project — its kind, a daily scrum or a follow-up.
 */
const keyOf = (line: TimesheetLine) => `${line.projectId}:${line.workPackageId ?? line.workPackageSubject ?? ''}`;

/** What an entry with no task was: its kind on no project, or the project itself. */
const workOf = (line: { workPackageId?: string; subject?: string; projectId?: string }) =>
  !line.projectId && line.subject ? line.subject : t('On the project');

interface Row {
  key: string;
  projectId: string;
  projectName: string;
  workPackageId?: string;
  subject?: string;
  byDay: Map<string, { hours: number; notes: string[] }>;
  total: number;
}

export function TimesheetEntries({
  view,
  onAdd,
}: {
  view: TimesheetView;
  /** Offered while the timesheet is the reader's own and still a draft. */
  onAdd?: (day: string) => void;
}) {
  const days = useMemo(() => daysOf(view.periodStart, view.periodEnd), [view.periodStart, view.periodEnd]);
  const weekly = days.length <= 7;
  const today = new Date().toISOString().slice(0, 10);

  const { rows, dayTotals, byDay } = useMemo(() => {
    const rowMap = new Map<string, Row>();
    const totals = new Map<string, number>();
    const grouped = new Map<string, TimesheetLine[]>();
    for (const line of view.lines) {
      const row = rowMap.get(keyOf(line)) ?? {
        key: keyOf(line),
        projectId: line.projectId,
        projectName: line.projectName,
        workPackageId: line.workPackageId,
        subject: line.workPackageSubject,
        byDay: new Map(),
        total: 0,
      };
      const cell = row.byDay.get(line.spentOn) ?? { hours: 0, notes: [] };
      cell.hours += line.hours;
      if (line.comment) cell.notes.push(line.comment);
      row.byDay.set(line.spentOn, cell);
      row.total += line.hours;
      rowMap.set(row.key, row);
      totals.set(line.spentOn, (totals.get(line.spentOn) ?? 0) + line.hours);
      grouped.set(line.spentOn, [...(grouped.get(line.spentOn) ?? []), line]);
    }
    return {
      rows: [...rowMap.values()].sort((a, b) => a.projectName.localeCompare(b.projectName) || (a.subject ?? '').localeCompare(b.subject ?? '')),
      dayTotals: totals,
      byDay: grouped,
    };
  }, [view.lines]);

  // Logging opens on today when it falls in the period, else on its first day.
  const addDay = today >= view.periodStart && today <= view.periodEnd ? today : view.periodStart;

  // Every entry in day order, paged; each page is drawn day by day again.
  const ordered = useMemo(() => days.flatMap((day) => byDay.get(day) ?? []), [days, byDay]);
  const paged = usePagination(ordered, { pageSize: 20, resetKey: `${view.periodStart}:${view.periodEnd}` });
  const pageDays = useMemo(() => {
    const out = new Map<string, TimesheetLine[]>();
    for (const line of paged.items) out.set(line.spentOn, [...(out.get(line.spentOn) ?? []), line]);
    return [...out.entries()];
  }, [paged.items]);

  return (
    <Card data-testid="timesheet-entries">
      <CardHeader
        variant="compact"
        actions={
          onAdd ? (
            <Button size="sm" onClick={() => onAdd(addDay)}>
              <Plus className="h-3.5 w-3.5" />
              {t('Log time')}
            </Button>
          ) : null
        }
      >
        <CardTitle>{weekly ? t('The week, task by task') : t('Time in the period')}</CardTitle>
        <CardDescription className="text-2xs">
          {t('{count, plural, =0 {Nothing logged yet} one {# entry} other {# entries}} · {hours} in total', {
            count: view.lines.length,
            hours: formatHours(view.hours),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {view.lines.length === 0 ? (
          <EmptyState
            size="inline"
            icon={CalendarClock}
            title={t('Nothing logged in this period')}
            description={onAdd ? t('Log time against your tasks and it shows here, day by day.') : t('No time has been logged in this period.')}
            action={onAdd ? { label: t('Log time'), onClick: () => onAdd(addDay) } : undefined}
          />
        ) : (
          <>
            {weekly ? (
              <div className="overflow-x-auto border-b border-border">
                <table className="w-full min-w-[42rem] text-xs">
                  <thead>
                    <tr className="border-b border-border text-2xs text-muted-foreground">
                      <th className="px-4 py-2 text-start font-medium">{t('Task')}</th>
                      {days.map((day) => (
                        <th key={day} className={cn('w-16 px-2 py-2 text-end font-medium', day === today && 'text-primary')}>
                          <span className="block">{weekday(day)}</span>
                          <span className="block font-normal">{dayMonth(day)}</span>
                        </th>
                      ))}
                      <th className="w-16 px-4 py-2 text-end font-medium">{t('Total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className="border-b border-border/60 align-top">
                        <td className="max-w-[18rem] px-4 py-2">
                          {row.workPackageId ? (
                            <Link to={`/tasks/${row.workPackageId}`} className="block truncate font-medium hover:text-primary" dir="auto">
                              {row.subject ?? `#${row.workPackageId}`}
                            </Link>
                          ) : (
                            <span className="block truncate font-medium" dir="auto">
                              {workOf(row)}
                            </span>
                          )}
                          <span className="block truncate text-2xs text-muted-foreground" dir="auto">
                            {row.projectName}
                          </span>
                        </td>
                        {days.map((day) => {
                          const cell = row.byDay.get(day);
                          return (
                            <td
                              key={day}
                              className={cn('px-2 py-2 text-end font-mono tabular-nums', !cell && 'text-muted-foreground/40')}
                              title={cell?.notes.join('\n') || undefined}
                            >
                              {cell ? formatHours(Math.round(cell.hours * 100) / 100) : '·'}
                            </td>
                          );
                        })}
                        <td className="px-4 py-2 text-end font-mono font-medium tabular-nums">{formatHours(Math.round(row.total * 100) / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="text-2xs font-medium">
                      <td className="px-4 py-2 text-muted-foreground">{t('Total')}</td>
                      {days.map((day) => (
                        <td key={day} className="px-2 py-2 text-end font-mono tabular-nums">
                          {dayTotals.get(day) ? formatHours(Math.round(dayTotals.get(day)! * 100) / 100) : '—'}
                        </td>
                      ))}
                      <td className="px-4 py-2 text-end font-mono tabular-nums">{formatHours(view.hours)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : null}

            {/* Every entry, day by day, with what was written about it. */}
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-2xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">{t('Work')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('Activity')}</th>
                  <th className="w-20 px-4 py-2 text-end font-medium">{t('Hours')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('Work description')}</th>
                </tr>
              </thead>
              <tbody>
                {pageDays.map(([day, lines]) => (
                    <Fragment key={day}>
                      <tr className="border-b border-border bg-muted/40">
                        <td colSpan={2} className="px-4 py-1.5 text-2xs font-medium">
                          {longDay(day)}
                        </td>
                        <td className="px-4 py-1.5 text-end font-mono text-2xs font-medium tabular-nums">
                          {formatHours(Math.round((dayTotals.get(day) ?? 0) * 100) / 100)}
                        </td>
                        <td />
                      </tr>
                      {lines.map((line) => (
                        <tr key={line.id} className="border-b border-border/60 align-top">
                          <td className="max-w-[16rem] px-4 py-2">
                            {line.workPackageId ? (
                              <Link to={`/tasks/${line.workPackageId}`} className="block truncate hover:text-primary" dir="auto">
                                {line.workPackageSubject ?? `#${line.workPackageId}`}
                              </Link>
                            ) : (
                              <span className="block truncate" dir="auto">
                                {workOf({ projectId: line.projectId, subject: line.workPackageSubject })}
                              </span>
                            )}
                            <span className="block truncate text-2xs text-muted-foreground" dir="auto">
                              {line.projectName}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            {line.activityName ? (
                              <Badge size="sm" tone="neutral">
                                {line.activityName}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-end font-mono tabular-nums">{formatHours(line.hours)}</td>
                          <td className="px-4 py-2 text-muted-foreground" dir="auto">
                            {line.comment ? <span className="whitespace-pre-line">{line.comment}</span> : '—'}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
              </tbody>
            </table>
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              onPageSizeChange={paged.setPageSize}
              pageSizeOptions={[10, 20, 50, 100]}
              itemLabel={t('entry')}
              itemLabelPlural={t('entries')}
              className="border-t border-border"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
