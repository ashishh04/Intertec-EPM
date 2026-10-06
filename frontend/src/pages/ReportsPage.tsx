import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FolderKanban,
  Printer,
  Sheet,
  Table2,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { MetricCard } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { Badge } from '@/components/ui/badge';
import { InfoTooltip } from '@/components/ui/tooltip';
import { HealthIndicator, ProjectStatusBadge } from '@/components/common/StatusBadge';
import { UserAvatar } from '@/components/common/UserAvatar';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { DrillSheet } from '@/components/insights/DrillSheet';
import { MeasureTile, MeasureTileSkeleton } from '@/components/insights/MeasureTile';
import {
  DeliveryTrendChart,
  HorizontalBarChart,
  StatusDistributionChart,
  VelocityChart,
} from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProgressBar } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadCsv, type CsvValue } from '@/lib/csv';
import { downloadXlsx } from '@/lib/xlsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjects } from '@/hooks/useProjects';
import { useTeams } from '@/hooks/useTeams';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useUsers } from '@/hooks/useUsers';
import { useMeasureMembers } from '@/hooks/useInsights';
import { usePagination } from '@/hooks/usePagination';
import {
  useDeliveryTrends,
  useExecutiveInsights,
  useStatusDistribution,
  useTimeSummary,
} from '@/hooks/useReports';
import { HEALTH_META, PROJECT_STATUS_META } from '@/lib/domain';
import {
  formatHours,
  formatNumber,
  formatPercent,
  formatShortDate,
  toISODateOnly,
} from '@/lib/utils';
import { subDays } from 'date-fns';
import type { HealthLevel, ID, ReportFilters } from '@/types';

const ALL = '__all__';


const REPORTS = [
  { value: 'status', label: 'Project Status' },
  { value: 'completion', label: 'Task Completion' },
  { value: 'velocity', label: 'Points Delivered' },
  { value: 'team', label: 'Team Performance' },
  { value: 'overdue', label: 'Overdue Work' },
  { value: 'time', label: 'Time Tracking' },
  { value: 'trends', label: 'Delivery Trends' },
] as const;

/** Executive reporting workspace. */
export default function ReportsPage() {
  const [report, setReport] = useState<(typeof REPORTS)[number]['value']>('status');
  const [filters, setFilters] = useState<ReportFilters>({
    from: toISODateOnly(subDays(new Date(), 90)),
    to: toISODateOnly(new Date()),
  });
  const [drill, setDrill] = useState<string | undefined>();

  const projectsQuery = useProjects();
  const teamsQuery = useTeams();
  const portfoliosQuery = usePortfolios();
  const { data: users } = useUsers();
  const distributionQuery = useStatusDistribution(filters);
  const trendsQuery = useDeliveryTrends(filters);
  const insightsQuery = useExecutiveInsights(filters);
  const timeQuery = useTimeSummary(filters);
  // The same scope the server gives the figures above: a project, else a
  // portfolio, else the instance — and a team narrows any of them to its people.
  const reportQuery = useMemo(() => {
    const place = filters.projectId
      ? `project:${filters.projectId}`
      : filters.portfolioId
        ? `portfolio:${filters.portfolioId}`
        : undefined;
    return {
      scope: filters.teamId ? `team:${filters.teamId}` : (place ?? 'instance'),
      within: filters.teamId ? place : undefined,
      from: filters.from,
      to: filters.to,
    };
  }, [filters.projectId, filters.portfolioId, filters.teamId, filters.from, filters.to]);
  // Overdue work is the drill-through of the overdue measure: every item, by
  // the one definition, rather than a filter over the first page of tasks.
  const overdueQuery = useMeasureMembers('work.overdue', reportQuery);

  // One key for every client-side pager, so changing any filter returns each
  // table to its first page rather than stranding the reader mid-list.
  const filtersKey = `${filters.projectId ?? ''}|${filters.portfolioId ?? ''}|${filters.teamId ?? ''}|${filters.from ?? ''}|${filters.to ?? ''}`;

  const projects = useMemo(
    () =>
      (projectsQuery.data ?? []).filter(
        (project) => !filters.projectId || project.id === filters.projectId,
      ),
    [projectsQuery.data, filters.projectId],
  );

  const overdue = useMemo(
    () => (overdueQuery.data?.members.kind === 'work_package' ? overdueQuery.data.members.items : []),
    [overdueQuery.data],
  );
  const lateDays = (flag?: string) => Number(/late (\d+)d/.exec(flag ?? '')?.[1] ?? 0);

  const timeByUser = useMemo(
    () =>
      (timeQuery.data ?? [])
        .map((entry) => ({
          label: users?.find((user) => user.id === entry.userId)?.name.split(' ')[0] ?? 'Unknown',
          value: entry.hoursLogged,
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10),
    [timeQuery.data, users],
  );

  const projectsPaged = usePagination(projects, { pageSize: 10, resetKey: filtersKey });
  const teamsPaged = usePagination(teamsQuery.data ?? [], { pageSize: 10, resetKey: filtersKey });
  const overduePaged = usePagination(overdue, { pageSize: 10, resetKey: filtersKey });
  const timePaged = usePagination(timeQuery.data ?? [], { pageSize: 10, resetKey: filtersKey });

  const insights = insightsQuery.data;

  /**
   * The report on screen, as rows.
   *
   * Built from the same arrays the tables render, so an export cannot disagree
   * with what the reader is looking at — which is the failure mode of exporting
   * from a second query. Each report has its own shape; the switch is what makes
   * one Export button serve all of them.
   */
  const exportSheet = (): { name: string; headers: CsvValue[]; rows: CsvValue[][] } | null => {
    const range = `${filters.from ?? 'start'}-to-${filters.to ?? 'today'}`;

    switch (report) {
      case 'status':
        return {
          name: `project-status-${range}`,
          // Both values travel with an override, and its reason: an export
          // that carried only the pinned value would report it as measured.
          headers: [
            'Project',
            'Code',
            'Status',
            'Health',
            'Calculated health',
            'Override reason',
            'Overridden by',
            'Overridden on',
            'Schedule',
            'Budget',
            'Risks',
            'Overdue',
            'Progress %',
            'Planned start',
            'Planned finish',
            'Forecast finish',
          ],
          rows: projects.map((project) => [
            project.name,
            project.identifier,
            PROJECT_STATUS_META[project.status].label,
            HEALTH_META[project.health.overall].label,
            HEALTH_META[project.healthCalculated.overall].label,
            project.healthOverride?.reason ?? null,
            project.healthOverride
              ? users?.find((user) => user.id === project.healthOverride!.setBy)?.name ?? project.healthOverride.setBy
              : null,
            project.healthOverride?.setAt.slice(0, 10) ?? null,
            ...(['schedule', 'budget', 'risks', 'overdue'] as const).map((criterion) => {
              const level = project.health[criterion];
              return level ? HEALTH_META[level].label : 'Not assessed';
            }),
            project.progress,
            project.startDate ?? null,
            project.dueDate ?? null,
            project.forecastFinish ?? null,
          ]),
        };
      case 'team':
        return {
          name: `team-performance-${range}`,
          headers: ['Team', 'Code', 'Department', 'Lead', 'Members', 'Capacity (h/week)'],
          rows: (teamsQuery.data ?? []).map((team) => [
            team.name,
            team.code,
            team.department?.name ?? null,
            team.lead?.name ?? null,
            team.memberCount,
            team.capacityHours,
          ]),
        };
      case 'overdue':
        return {
          name: `overdue-work-${range}`,
          headers: ['Key', 'Subject', 'Project', 'Status', 'Priority', 'Due', 'Days late'],
          rows: overdue.map((task) => [
            `#${task.id}`,
            task.subject,
            task.projectName,
            task.status,
            task.priority ?? '',
            task.dueDate ?? null,
            lateDays(task.flag),
          ]),
        };
      case 'time':
        return {
          name: `time-tracking-${range}`,
          headers: ['Person', 'Hours logged', 'Not costed'],
          rows: (timeQuery.data ?? []).map((entry) => [
            users?.find((user) => user.id === entry.userId)?.name ?? entry.userId,
            entry.hoursLogged,
            entry.hoursUncosted,
          ]),
        };
      case 'completion':
        return {
          name: `task-completion-${range}`,
          headers: ['Status', 'Tasks'],
          rows: (distributionQuery.data ?? []).map((slice) => [slice.status, slice.count]),
        };
      case 'velocity':
      case 'trends':
        return {
          name: `${report === 'velocity' ? 'points-delivered' : 'delivery-trends'}-${range}`,
          headers: ['Month', 'Delivered', 'Created', 'Points delivered'],
          rows: (trendsQuery.data ?? []).map((point) => [
            point.period,
            point.completed,
            point.created,
            point.velocity,
          ]),
        };
      default:
        return null;
    }
  };

  const exportAs = (format: 'xlsx' | 'csv') => {
    const sheet = exportSheet();
    if (!sheet || sheet.rows.length === 0) return;

    if (format === 'csv') {
      downloadCsv(`${sheet.name}.csv`, sheet.headers, sheet.rows);
      return;
    }

    downloadXlsx(`${sheet.name}.xlsx`, {
      sheetName: REPORTS.find((item) => item.value === report)?.label ?? 'Report',
      headers: sheet.headers,
      rows: sheet.rows,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="Delivery reporting across projects, teams and time."
        actions={
          /*
           * Exported from the browser, not prepared on the backend.
           *
           * This used to be a disabled button explaining that export was a
           * backend job nobody had built. It did not need to be: the rows are
           * already here, and exporting the rendered data is strictly more
           * correct than a second query that can disagree with the screen.
           */
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm">
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => exportAs('xlsx')}>
                <Sheet className="h-3.5 w-3.5" />
                Excel workbook (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportAs('csv')}>
                <Table2 className="h-3.5 w-3.5" />
                Comma-separated (.csv)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.print()}>
                <Printer className="h-3.5 w-3.5" />
                Print or save as PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* Only on paper: which report this is, and over what. */}
      <div className="epm-print-only mb-4 border-b border-border pb-3">
        <h2 className="font-display text-base font-bold">
          {REPORTS.find((item) => item.value === report)?.label}
        </h2>
        <p className="text-2xs text-muted-foreground">
          {filters.from ?? 'the beginning'} to {filters.to ?? 'today'}
        </p>
      </div>

      {/* Filters */}
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div className="space-y-1.5">
          <Label htmlFor="report-type">Report</Label>
          <Select value={report} onValueChange={(value) => setReport(value as typeof report)}>
            <SelectTrigger id="report-type" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORTS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="report-from">From</Label>
          <Input
            id="report-from"
            type="date"
            className="h-8 text-xs"
            value={filters.from ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="report-to">To</Label>
          <Input
            id="report-to"
            type="date"
            className="h-8 text-xs"
            value={filters.to ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="report-project">Project</Label>
          <Select
            value={filters.projectId ?? ALL}
            onValueChange={(value) =>
              setFilters((current) => ({
                ...current,
                projectId: value === ALL ? undefined : (value as ID),
              }))
            }
          >
            <SelectTrigger id="report-project" className="h-8 text-xs">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {(projectsQuery.data ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="report-portfolio">Portfolio</Label>
          <Select
            value={filters.portfolioId ?? ALL}
            onValueChange={(value) =>
              setFilters((current) => ({
                ...current,
                portfolioId: value === ALL ? undefined : (value as ID),
              }))
            }
          >
            <SelectTrigger id="report-portfolio" className="h-8 text-xs">
              <SelectValue placeholder="All portfolios" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All portfolios</SelectItem>
              {(portfoliosQuery.data ?? []).map((portfolio) => (
                <SelectItem key={portfolio.id} value={portfolio.id}>
                  {portfolio.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="report-team">Team</Label>
          <Select
            value={filters.teamId ?? ALL}
            onValueChange={(value) =>
              setFilters((current) => ({
                ...current,
                teamId: value === ALL ? undefined : (value as ID),
              }))
            }
          >
            <SelectTrigger id="report-team" className="h-8 text-xs">
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All teams</SelectItem>
              {(teamsQuery.data ?? []).map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* Headline figures: measures of the semantic layer, for the filters
          above, each with its definition and the items behind it. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {insightsQuery.isLoading || !insights
          ? [0, 1, 2, 3].map((index) => <MeasureTileSkeleton key={index} />)
          : ['health.greenPct', 'milestones.onTime', 'work.overdue', 'sprint.velocity'].map((id) => {
              const measure = insights.measures?.[id];
              return measure ? <MeasureTile key={id} measure={measure} onOpen={() => setDrill(id)} /> : null;
            })}
      </div>
      <DrillSheet
        measureId={drill}
        query={reportQuery}
        onClose={() => setDrill(undefined)}
        onScope={() => setDrill(undefined)}
      />

      <Tabs value={report} onValueChange={(value) => setReport(value as typeof report)}>
        <div className="epm-scroll overflow-x-auto">
          <TabsList variant="underline" className="min-w-max">
            {REPORTS.map((item) => (
              <TabsTrigger key={item.value} value={item.value} variant="underline">
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* Project status */}
        <TabsContent value="status" className="mt-4">
          <QueryBoundary
            isLoading={projectsQuery.isLoading}
            isError={projectsQuery.isError}
            error={projectsQuery.error}
            onRetry={() => projectsQuery.refetch()}
            errorTitle="Unable to load project status"
            skeleton={<TableSkeleton columns={7} rows={6} />}
            isEmpty={projects.length === 0}
            empty={
              <Card>
                <EmptyState
                  icon={FolderKanban}
                  title="No projects to report on"
                  description="Projects appear here once they exist in the portfolio."
                />
              </Card>
            }
          >
            <TableCard
              toolbar={
                // The toolbar slot draws the divider, so the header drops its own.
                <CardHeader
                  variant="compact"
                  className="border-b-0"
                  actions={
                    // Counted from effective health, so a pinned project is
                    // counted where it was pinned rather than where the rules
                    // put it.
                    <div className="flex items-center gap-3 text-2xs text-muted-foreground">
                      {(['healthy', 'warning', 'critical'] as HealthLevel[]).map((level) => (
                        <span key={level} className="flex items-center gap-1.5">
                          <HealthIndicator level={level} />
                          <span className="font-mono tabular-nums">
                            {formatNumber(
                              projects.filter((project) => project.health.overall === level).length,
                            )}
                          </span>
                        </span>
                      ))}
                    </div>
                  }
                >
                  <CardTitle>Project status</CardTitle>
                </CardHeader>
              }
              footer={
                <Pagination
                  page={projectsPaged.page}
                  pageSize={projectsPaged.pageSize}
                  total={projectsPaged.total}
                  onPageChange={projectsPaged.setPage}
                  onPageSizeChange={projectsPaged.setPageSize}
                  itemLabel="project"
                />
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead className="min-w-36">Progress</TableHead>
                    <TableHead numeric>Tasks</TableHead>
                    <TableHead numeric>Risks</TableHead>
                    <TableHead>Planned finish</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projectsPaged.items.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.name}</TableCell>
                      <TableCell>
                        <ProjectStatusBadge status={project.status} size="sm" />
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <HealthIndicator level={project.health.overall} />
                          {/* Says so when the value is pinned rather than
                              calculated, so a reader is not misled by it. */}
                          {project.healthOverride ? (
                            <InfoTooltip
                              label={`Calculated ${HEALTH_META[project.healthCalculated.overall].label}. ${project.healthOverride.reason}`}
                            >
                              <Badge tone="accent" className="text-2xs" tabIndex={0}>
                                Overridden
                              </Badge>
                            </InfoTooltip>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ProgressBar
                            value={project.progress}
                            size="xs"
                            tone={PROJECT_STATUS_META[project.status].tone}
                            label={`${project.name} progress`}
                            className="w-20"
                          />
                          <span className="font-mono text-2xs tabular-nums">
                            {formatPercent(project.progress)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell numeric>
                        {formatNumber(project.completedTaskCount)}/{formatNumber(project.taskCount)}
                      </TableCell>
                      <TableCell numeric>{formatNumber(project.openRiskCount)}</TableCell>
                      <TableCell className="font-mono text-2xs tabular-nums">
                        {formatShortDate(project.dueDate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          </QueryBoundary>
        </TabsContent>

        {/* Task completion */}
        <TabsContent value="completion" className="mt-4">
          <QueryBoundary
            isLoading={distributionQuery.isLoading}
            isError={distributionQuery.isError}
            error={distributionQuery.error}
            onRetry={() => distributionQuery.refetch()}
            errorTitle="Unable to load the report"
            skeleton={
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCardSkeleton />
                <ChartCardSkeleton />
              </div>
            }
          >
            {/* An empty distribution is drawn by the charts themselves, inside
                their cards, so the layout holds its shape. */}
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCard title="Status distribution" description="Where work currently sits">
                <StatusDistributionChart data={distributionQuery.data ?? []} />
              </ChartCard>
              <ChartCard title="Completion by status" description="Work package counts">
                <HorizontalBarChart
                  data={(distributionQuery.data ?? []).map((entry) => ({
                    label: entry.label,
                    value: entry.count,
                  }))}
                />
              </ChartCard>
            </div>
          </QueryBoundary>
        </TabsContent>

        {/* Velocity */}
        <TabsContent value="velocity" className="mt-4">
          <QueryBoundary
            isLoading={trendsQuery.isLoading}
            isError={trendsQuery.isError}
            error={trendsQuery.error}
            onRetry={() => trendsQuery.refetch()}
            errorTitle="Unable to load points delivered"
            skeleton={<ChartCardSkeleton height={280} />}
          >
            <ChartCard
              title="Points delivered"
              description="Story points of the work delivered each month, counted on the day it was closed"
              height={280}
            >
              <VelocityChart data={trendsQuery.data ?? []} />
            </ChartCard>
          </QueryBoundary>
        </TabsContent>

        {/* Team performance */}
        <TabsContent value="team" className="mt-4">
          <QueryBoundary
            isLoading={teamsQuery.isLoading}
            isError={teamsQuery.isError}
            error={teamsQuery.error}
            onRetry={() => teamsQuery.refetch()}
            errorTitle="Unable to load teams"
            skeleton={<TableSkeleton columns={6} rows={6} />}
            isEmpty={teamsPaged.total === 0}
            empty={
              <Card>
                <EmptyState
                  icon={Users}
                  title="No teams yet"
                  description="Team performance fills in once teams are set up in administration."
                />
              </Card>
            }
          >
            <TableCard
              toolbar={
                <CardHeader variant="compact" className="border-b-0">
                  <CardTitle>Teams</CardTitle>
                </CardHeader>
              }
              footer={
                <Pagination
                  page={teamsPaged.page}
                  pageSize={teamsPaged.pageSize}
                  total={teamsPaged.total}
                  onPageChange={teamsPaged.setPage}
                  onPageSizeChange={teamsPaged.setPageSize}
                  itemLabel="team"
                />
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Team</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Lead</TableHead>
                    <TableHead numeric>Members</TableHead>
                    <TableHead numeric>Capacity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Members and capacity are back, but from EPM's employee
                      mapping rather than the OpenProject-group reading that
                      made them permanently zero. Sprint progress stays out —
                      it has no source yet. */}
                  {teamsPaged.items.map((team) => (
                    <TableRow key={team.id}>
                      <TableCell className="font-medium">{team.name}</TableCell>
                      <TableCell className="font-mono text-2xs">{team.code}</TableCell>
                      <TableCell className="text-2xs">{team.department?.name ?? '—'}</TableCell>
                      <TableCell className="text-2xs">{team.lead?.name ?? '—'}</TableCell>
                      <TableCell numeric>{formatNumber(team.memberCount)}</TableCell>
                      <TableCell numeric>{formatNumber(team.capacityHours)} h/wk</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          </QueryBoundary>
        </TabsContent>

        {/* Overdue work: the overdue measure's own list (BR-404) */}
        <TabsContent value="overdue" className="mt-4">
          <QueryBoundary
            isLoading={overdueQuery.isLoading}
            isError={overdueQuery.isError}
            error={overdueQuery.error}
            onRetry={() => overdueQuery.refetch()}
            errorTitle="Unable to load overdue work"
            skeleton={<TableSkeleton columns={5} rows={6} />}
            isEmpty={overdue.length === 0}
            empty={
              <Card>
                <EmptyState
                  icon={CheckCircle2}
                  title="Nothing is overdue"
                  description="Every open work package is still inside its committed date."
                />
              </Card>
            }
          >
            <TableCard
              toolbar={
                <CardHeader variant="compact" className="border-b-0">
                  <CardTitle>Overdue work packages</CardTitle>
                  <CardDescription className="text-2xs">
                    {overdueQuery.data?.measure.definition}
                  </CardDescription>
                </CardHeader>
              }
              footer={
                <Pagination
                  page={overduePaged.page}
                  pageSize={overduePaged.pageSize}
                  total={overduePaged.total}
                  onPageChange={overduePaged.setPage}
                  onPageSizeChange={overduePaged.setPageSize}
                  itemLabel="work package"
                />
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Work package</TableHead>
                    <TableHead>Assignee</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead numeric>Days late</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overduePaged.items.map((task) => {
                    const assignee = users?.find((user) => user.id === String(task.assigneeId ?? ''));
                    return (
                      <TableRow key={task.id}>
                        <TableCell className="font-mono text-2xs text-muted-foreground">#{task.id}</TableCell>
                        <TableCell className="font-medium">
                          <Link to={`/tasks/${task.id}`} className="hover:text-primary hover:underline">
                            {task.subject}
                          </Link>
                          <span className="block text-2xs font-normal text-muted-foreground">{task.projectName}</span>
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <UserAvatar user={assignee} size="xs" />
                            {task.assigneeName ?? 'Unassigned'}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-2xs tabular-nums">
                          {formatShortDate(task.dueDate)}
                        </TableCell>
                        <TableCell numeric className="font-medium text-danger">
                          {formatNumber(lateDays(task.flag))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableCard>
          </QueryBoundary>
        </TabsContent>

        <TabsContent value="time" className="mt-4">
          <QueryBoundary
            isLoading={timeQuery.isLoading}
            isError={timeQuery.isError}
            error={timeQuery.error}
            onRetry={() => timeQuery.refetch()}
            errorTitle="Unable to load time tracking"
            skeleton={
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCardSkeleton />
                <TableSkeleton columns={4} rows={6} />
              </div>
            }
            isEmpty={timePaged.total === 0}
            empty={
              <Card>
                <EmptyState
                  icon={Clock}
                  title="No time logged"
                  description="Hours appear here once people record time against work in this window."
                />
              </Card>
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCard title="Hours logged" description="Effort recorded per person">
                <HorizontalBarChart data={timeByUser} tone="highlight" />
              </ChartCard>

              <TableCard
                toolbar={
                  <CardHeader variant="compact" className="border-b-0">
                    <CardTitle>Hours by person</CardTitle>
                  </CardHeader>
                }
                footer={
                  <Pagination
                    page={timePaged.page}
                    pageSize={timePaged.pageSize}
                    total={timePaged.total}
                    onPageChange={timePaged.setPage}
                  onPageSizeChange={timePaged.setPageSize}
                    itemLabel="contributor"
                  />
                }
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead numeric>Logged</TableHead>
                      <TableHead numeric>Not costed</TableHead>
                      <TableHead numeric>Projects</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timePaged.items.map((entry) => {
                      const user = users?.find((item) => item.id === entry.userId);
                      return (
                        <TableRow key={entry.userId}>
                          <TableCell className="font-medium">{user?.name ?? 'Unknown'}</TableCell>
                          <TableCell numeric>{formatHours(entry.hoursLogged)}</TableCell>
                          <TableCell numeric>{formatHours(entry.hoursUncosted)}</TableCell>
                          <TableCell numeric>{formatNumber(entry.projectBreakdown.length)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableCard>
            </div>
          </QueryBoundary>
        </TabsContent>

        {/* Delivery trends */}
        <TabsContent value="trends" className="mt-4">
          <QueryBoundary
            isLoading={trendsQuery.isLoading}
            isError={trendsQuery.isError}
            error={trendsQuery.error}
            onRetry={() => trendsQuery.refetch()}
            errorTitle="Unable to load delivery trends"
            skeleton={<ChartCardSkeleton height={280} />}
          >
            <div className="space-y-4">
              <ChartCard
                title="Delivery trend"
                description="Delivered and created work packages per month"
                height={280}
              >
                <DeliveryTrendChart data={trendsQuery.data ?? []} />
              </ChartCard>

              <div className="grid gap-4 sm:grid-cols-3">
                <MetricCard
                  label="Projects reported"
                  value={projects.length}
                  icon={FolderKanban}
                  tone="primary"
                />
                <MetricCard
                  label="Window"
                  value={`${formatShortDate(filters.from)} – ${formatShortDate(filters.to)}`}
                  icon={Clock}
                  tone="neutral"
                />
                <MetricCard
                  label="Open risks"
                  value={insights?.openRisks ?? '—'}
                  icon={AlertTriangle}
                  tone="warning"
                />
              </div>
            </div>
          </QueryBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}
