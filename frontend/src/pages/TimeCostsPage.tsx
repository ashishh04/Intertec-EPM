import { useMemo, useState } from 'react';
import { subDays, startOfMonth, startOfYear } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, Coins, Download, Clock, Hash, Printer, Sheet, Table2 } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { ComboSelect } from '@/components/common/ComboSelect';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { TrendChart } from '@/components/charts/EpmCharts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProgressBar } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useProjects } from '@/hooks/useProjects';
import { useReportablePeople, useTimeReport } from '@/hooks/useTimeEntries';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadCsv } from '@/lib/csv';
import { downloadXlsx } from '@/lib/xlsx';
import { formatCurrency, formatHours, formatNumber, toISODateOnly } from '@/lib/utils';
import type { TimeReportGrouping } from '@/types';

/**
 * Time & Costs.
 *
 * The reporting half of time tracking: what was logged over a range, grouped,
 * and what it cost. Aggregation happens on the server — a quarter is thousands
 * of entries — so this page sends a range and a grouping and renders the answer.
 *
 * Cost is deliberately partial and says so. Rates are EPM's own field, because
 * OpenProject publishes none, so hours belonging to someone nobody has costed
 * are counted as hours and excluded from the money. The alternative is a total
 * that silently prices half the work at zero, which is worse than an honest gap.
 */

const GROUPINGS: { value: TimeReportGrouping; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'user', label: 'Person' },
  { value: 'activity', label: 'Activity' },
  { value: 'workPackage', label: 'Task' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

/** Said when Export is chosen over a range that produced no rows. */
const NOTHING_TO_EXPORT = 'No time is logged in this range, so there is nothing to export.';

/** Ranges worth one click. `days` counts back from today, inclusive. */
const PRESETS = [
  { label: 'This month', from: () => startOfMonth(new Date()) },
  { label: 'Last 30 days', from: () => subDays(new Date(), 29) },
  { label: 'Last 90 days', from: () => subDays(new Date(), 89) },
  { label: 'This year', from: () => startOfYear(new Date()) },
];

export default function TimeCostsPage() {
  /*
   * Last 30 days, not month-to-date.
   *
   * Month-to-date is the natural-sounding default and it is the one that lands
   * you on an empty page: on the first of a month the range is a single day,
   * and a costing page whose first impression is "0h, no cost, export greyed
   * out" reads as broken rather than as empty. Reports, next door, defaults to
   * ninety days for the same reason. `This month` is still one click away.
   */
  const [from, setFrom] = useState(() => toISODateOnly(subDays(new Date(), 29)));
  const [to, setTo] = useState(() => toISODateOnly(new Date()));
  const [projectId, setProjectId] = useState<string>();
  const [userId, setUserId] = useState<string>();
  const [groupBy, setGroupBy] = useState<TimeReportGrouping>('project');

  const projectsQuery = useProjects();
  const peopleQuery = useReportablePeople();

  // A reversed range is a typo, not a question. Asking anyway would spend a
  // request to be told so, and the backend's message would land on the table
  // rather than on the field that is wrong.
  const valid = Boolean(from && to && from <= to);

  const report = useTimeReport({ from, to, projectId, userId, groupBy }, { enabled: valid });
  const data = report.data;

  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        hint: project.identifier,
      })),
    [projectsQuery.data],
  );

  /*
   * Only people the filter will actually accept.
   *
   * Not the directory: OpenProject's time-entry `user` filter rejects anybody
   * who is not a member of a project, so offering the full user list meant most
   * choices came back "Filters User filter has invalid values" with nothing to
   * do about it.
   */
  const userOptions = useMemo(
    () => (peopleQuery.data ?? []).map((person) => ({ id: person.id, name: person.name })),
    [peopleQuery.data],
  );

  /**
   * The rows as shown, so an export matches the screen rather than the query.
   *
   * One shape for both formats, because an XLSX and a CSV of the same report that
   * disagree is worse than having only one of them. The difference is what the
   * cells are: a spreadsheet gets numbers it can sum, a CSV gets text.
   */
  const exportRows = () => {
    // Null for an empty range as well as for no answer yet, so a caller can say
    // so rather than hand over a file containing nothing but headers.
    if (!data || data.rows.length === 0) return null;

    return {
      name: `time-and-costs-${data.from}-to-${data.to}`,
      headers: [
        GROUPINGS.find((option) => option.value === data.groupBy)?.label ?? 'Group',
        'Hours',
        'Entries',
        `Cost (${data.currency})`,
        'Uncosted hours',
      ],
      rows: data.rows.map((row) => [
        row.label,
        row.hours,
        row.entries,
        // Blank, not zero. A row nobody has costed has no cost, and a zero would
        // be summed into a total that then understates the real one.
        row.cost ?? null,
        row.hoursWithoutRate,
      ]),
    };
  };

  const exportCsv = () => {
    const sheet = exportRows();
    if (!sheet) return toast.info(NOTHING_TO_EXPORT);
    downloadCsv(`${sheet.name}.csv`, sheet.headers, sheet.rows);
  };

  const exportXlsx = () => {
    const sheet = exportRows();
    if (!sheet) return toast.info(NOTHING_TO_EXPORT);
    downloadXlsx(`${sheet.name}.xlsx`, {
      sheetName: 'Time and costs',
      headers: sheet.headers,
      rows: sheet.rows,
    });
  };

  const costedShare =
    data && data.totalHours > 0
      ? Math.round(((data.totalHours - data.hoursWithoutRate) / data.totalHours) * 100)
      : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Time & Costs"
        description="Hours logged across the organisation, grouped and costed."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/*
                Never disabled. A greyed-out Export with no stated reason reads
                as a broken button, and the reason — an empty range — is not
                visible from the control itself. It opens, and the handlers say
                what is wrong if there is nothing behind it.
              */}
              <Button variant="secondary" size="sm">
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={exportXlsx}>
                <Sheet className="h-3.5 w-3.5" />
                Excel workbook (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={exportCsv}>
                <Table2 className="h-3.5 w-3.5" />
                Comma-separated (.csv)
              </DropdownMenuItem>
              {/* PDF is the browser's own print-to-PDF, which paginates and
                  embeds fonts better than anything shippable in a bundle — and
                  prints on paper as a bonus. The print stylesheet strips the
                  navigation and lets the table run the length of the page. */}
              <DropdownMenuItem onSelect={() => window.print()}>
                <Printer className="h-3.5 w-3.5" />
                Print or save as PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* Only on paper: a printed report has to carry its own scope, because the
          filters that produced it are on screen and the page is not. */}
      <div className="epm-print-only mb-4 border-b border-border pb-3">
        <h2 className="font-display text-base font-bold">Time &amp; Costs</h2>
        <p className="text-2xs text-muted-foreground">
          {from} to {to}
          {projectId
            ? ` · ${projectOptions.find((option) => option.id === projectId)?.name ?? 'one project'}`
            : ' · every project'}
          {userId
            ? ` · ${userOptions.find((option) => option.id === userId)?.name ?? 'one person'}`
            : ' · everyone'}
          {` · grouped by ${GROUPINGS.find((option) => option.value === groupBy)?.label.toLowerCase()}`}
        </p>
      </div>

      <ListToolbar
        className="epm-no-print"
        trailing={
          <div className="flex items-center gap-1.5">
            <Label htmlFor="time-group" className="text-2xs text-muted-foreground">
              Group by
            </Label>
            <Select
              value={groupBy}
              onValueChange={(value) => setGroupBy(value as TimeReportGrouping)}
            >
              <SelectTrigger id="time-group" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPINGS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        <div className="flex items-center gap-1.5">
          <Label htmlFor="time-from" className="text-2xs text-muted-foreground">
            From
          </Label>
          <Input
            id="time-from"
            type="date"
            value={from}
            className="w-36"
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label htmlFor="time-to" className="text-2xs text-muted-foreground">
            To
          </Label>
          <Input
            id="time-to"
            type="date"
            value={to}
            className="w-36"
            onChange={(event) => setTo(event.target.value)}
          />
        </div>

        <div className="w-48">
          <ComboSelect
            label="Project"
            options={projectOptions}
            value={projectId}
            clearable
            loading={projectsQuery.isLoading}
            placeholder="All projects"
            emptyLabel="No projects match"
            onChange={setProjectId}
          />
        </div>
        <div className="w-48">
          <ComboSelect
            label="Person"
            options={userOptions}
            value={userId}
            clearable
            loading={peopleQuery.isLoading}
            placeholder="Everyone"
            emptyLabel="Nobody has been added to a project yet"
            onChange={setUserId}
          />
        </div>
      </ListToolbar>

      <div className="epm-no-print flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="ghost"
            size="sm"
            className="text-2xs"
            onClick={() => {
              setFrom(toISODateOnly(preset.from()));
              setTo(toISODateOnly(new Date()));
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      {!valid ? (
        <Alert tone="warning" icon={AlertTriangle} title="That range runs backwards">
          The end date is before the start date, so there is nothing to report on.
        </Alert>
      ) : null}

      {data?.truncated ? (
        <Alert tone="warning" icon={AlertTriangle} title="This range is larger than one report">
          Only part of the logged time was read, so the totals below are a floor rather than the
          whole picture. Narrow the range or filter to one project.
        </Alert>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Totals">
        {report.isLoading || !data ? (
          [0, 1, 2].map((index) => <MetricCardSkeleton key={index} />)
        ) : (
          <>
            <MetricCard
              label="Hours logged"
              value={formatHours(data.totalHours)}
              support={`${formatNumber(data.rows.reduce((sum, row) => sum + row.entries, 0))} entries`}
              icon={Clock}
              tone="primary"
            />
            <MetricCard
              label="Cost"
              value={data.totalCost === undefined ? '—' : formatCurrency(data.totalCost, data.currency)}
              support={
                data.totalCost === undefined
                  ? 'No hourly rates are set'
                  : `${costedShare}% of hours are costed`
              }
              icon={Coins}
              tone="accent"
            />
            <MetricCard
              label="Uncosted hours"
              value={formatHours(data.hoursWithoutRate)}
              support={
                data.hoursWithoutRate > 0
                  ? 'Set rates on the Employees page'
                  : 'Every hour has a rate behind it'
              }
              icon={Hash}
              tone={data.hoursWithoutRate > 0 ? 'warning' : 'success'}
            />
          </>
        )}
      </section>

      <QueryBoundary
        isLoading={report.isLoading}
        isError={report.isError}
        error={report.error}
        onRetry={() => report.refetch()}
        errorTitle="Unable to load the report"
        skeleton={<ChartCardSkeleton height={220} />}
      >
        <ChartCard title="Hours per day" description="Across the selected range" height={220}>
          <TrendChart
            trends={[
              {
                metric: 'hours',
                points: (data?.byDay ?? []).map((point) => ({
                  date: point.date,
                  value: point.hours,
                })),
              },
            ]}
            unit="h"
            labels={{ hours: 'Hours' }}
          />
        </ChartCard>
      </QueryBoundary>

      <QueryBoundary
        isLoading={report.isLoading}
        isError={report.isError}
        error={report.error}
        onRetry={() => report.refetch()}
        errorTitle="Unable to load the report"
        skeleton={<TableSkeleton columns={5} rows={6} />}
        isEmpty={(data?.rows.length ?? 0) === 0}
        empty={
          <TableCard>
            <EmptyState
              icon={Clock}
              title="No time logged in this range"
              description="Widen the range, or clear the project and person filters."
            />
          </TableCard>
        }
      >
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {GROUPINGS.find((option) => option.value === groupBy)?.label}
                </TableHead>
                <TableHead className="w-48">Share</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="text-right">Entries</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows ?? []).map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell>
                    <ProgressBar
                      size="xs"
                      value={
                        data && data.totalHours > 0
                          ? Math.round((row.hours / data.totalHours) * 100)
                          : 0
                      }
                      label={`${row.label} share of hours`}
                    />
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatHours(row.hours)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatNumber(row.entries)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {row.cost === undefined ? (
                      <span className="text-muted-foreground" title="Nobody in this row has a rate">
                        —
                      </span>
                    ) : (
                      <>
                        {formatCurrency(row.cost, data!.currency)}
                        {/* A part-costed row is the one case where a number is
                            true and misleading at once, so it is flagged. */}
                        {row.hoursWithoutRate > 0 ? (
                          <span
                            className="ml-1 text-2xs text-warning"
                            title={`${formatHours(row.hoursWithoutRate)} in this row have no rate`}
                          >
                            partial
                          </span>
                        ) : null}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      </QueryBoundary>
    </div>
  );
}
