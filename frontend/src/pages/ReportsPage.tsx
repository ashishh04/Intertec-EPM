import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FolderKanban,
  Printer,
  Sheet,
  Table2,
  Gauge,
  TrendingUp,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { Badge } from '@/components/ui/badge';
import { HealthIndicator, ProjectStatusBadge } from '@/components/common/StatusBadge';
import { UserAvatar } from '@/components/common/UserAvatar';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { TruncationNotice } from '@/components/common/TruncationNotice';
import {
  DeliveryTrendChart,
  HorizontalBarChart,
  StatusDistributionChart,
  VelocityChart,
} from '@/components/charts/EpmCharts';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useUsers } from '@/hooks/useUsers';
import { useTasks } from '@/hooks/useTasks';
import { usePagination } from '@/hooks/usePagination';
import {
  useDeliveryTrends,
  useExecutiveInsights,
  useStatusDistribution,
  useTimeSummary,
} from '@/hooks/useReports';
import { PROJECT_STATUS_META } from '@/lib/domain';
import {
  daysFromToday,
  formatHours,
  formatNumber,
  formatPercent,
  formatShortDate,
  toISODateOnly,
} from '@/lib/utils';
import { subDays } from 'date-fns';
import type { HealthLevel, ID, ReportFilters } from '@/types';

const ALL = '__all__';

/**
 * How many work packages the overdue report reads at once.
 *
 * The overdue list is filtered in the browser from this page, so a project
 * with more open work than this would under-report. The notice under the
 * table says when that happens and lets the reader pull the rest.
 */
const TASK_PAGE_SIZE = 200;

const REPORTS = [
  { value: 'status', label: 'Project Status' },
  { value: 'completion', label: 'Task Completion' },
  { value: 'velocity', label: 'Sprint Velocity' },
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
  const [taskPageSize, setTaskPageSize] = useState(TASK_PAGE_SIZE);

  const projectsQuery = useProjects();
  const teamsQuery = useTeams();
  const { data: users } = useUsers();
  const distributionQuery = useStatusDistribution(filters);
  const trendsQuery = useDeliveryTrends(filters);
  const insightsQuery = useExecutiveInsights(filters);
  const timeQuery = useTimeSummary(filters);
  const tasksQuery = useTasks({ projectId: filters.projectId, pageSize: taskPageSize });

  // One key for every client-side pager, so changing any filter returns each
  // table to its first page rather than stranding the reader mid-list.
  const filtersKey = `${filters.projectId ?? ''}|${filters.teamId ?? ''}|${filters.from ?? ''}|${filters.to ?? ''}`;

  const projects = useMemo(
    () =>
      (projectsQuery.data ?? []).filter(
        (project) => !filters.projectId || project.id === filters.projectId,
      ),
    [projectsQuery.data, filters.projectId],
  );

  const loadedTasks = tasksQuery.data?.items ?? [];
  const totalTasks = tasksQuery.data?.total ?? loadedTasks.length;

  const overdue = useMemo(
    () =>
      (tasksQuery.data?.items ?? [])
        .filter((task) => task.statusCategory !== 'done' && (daysFromToday(task.dueDate) ?? 0) < 0)
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')),
    [tasksQuery.data],
  );

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

  // The overdue list is filtered from one page of work packages, so a large
  // project can under-report until the rest is loaded. Shown under the table
  // and beside the empty state alike: "nothing is overdue" is only true of
  // what was fetched.
  const overdueTruncation = (
    <TruncationNotice
      shown={loadedTasks.length}
      total={totalTasks}
      itemLabel="task"
      affected="The overdue figures"
      step={TASK_PAGE_SIZE}
      loading={tasksQuery.isFetching}
      onLoadMore={() => setTaskPageSize((size) => size + TASK_PAGE_SIZE)}
    />
  );

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
          headers: ['Project', 'Code', 'Status', 'Health', 'Progress %', 'Start', 'Due'],
          rows: projects.map((project) => [
            project.name,
            project.identifier,
            PROJECT_STATUS_META[project.status].label,
            project.health.overall,
            project.progress,
            project.startDate ?? null,
            project.dueDate ?? null,
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
            task.key,
            task.subject,
            projects.find((project) => project.id === task.projectId)?.name ?? task.projectId,
            task.status.name,
            task.priorityRef.name,
            task.dueDate ?? null,
            // Negative days from today, read as lateness — the figure the table
            // shows, rather than the raw signed number.
            Math.abs(daysFromToday(task.dueDate) ?? 0),
          ]),
        };
      case 'time':
        return {
          name: `time-tracking-${range}`,
          headers: ['Person', 'Hours logged', 'Billable hours'],
          rows: (timeQuery.data ?? []).map((entry) => [
            users?.find((user) => user.id === entry.userId)?.name ?? entry.userId,
            entry.hoursLogged,
            entry.hoursBillable,
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
          name: `${report === 'velocity' ? 'sprint-velocity' : 'delivery-trends'}-${range}`,
          headers: ['Period', 'Completed', 'Created', 'Velocity (points)'],
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
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
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

      {/* Headline metrics */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {insightsQuery.isLoading || !insights ? (
          [0, 1, 2, 3].map((index) => <MetricCardSkeleton key={index} />)
        ) : (
          <>
            <MetricCard
              label="Portfolio Health"
              value={insights.portfolioHealth}
              suffix="%"
              support="Projects rated healthy"
              icon={Gauge}
              tone="success"
            />
            <MetricCard
              label="On-Time Delivery"
              value={insights.onTimeDelivery}
              suffix="%"
              support="Milestones hit on plan"
              icon={CheckCircle2}
              tone="primary"
            />
            <MetricCard
              label="Overdue Work"
              value={insights.overdueTasks}
              support="Across all projects"
              icon={AlertTriangle}
              tone="danger"
            />
            <MetricCard
              label="Sprint Velocity"
              value={insights.sprintVelocity}
              suffix="pts"
              trend={insights.velocityTrend}
              icon={TrendingUp}
              tone="highlight"
            />
          </>
        )}
      </div>

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
                    <TableHead>Target</TableHead>
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
                            <Badge tone="accent" className="text-2xs">
                              Overridden
                            </Badge>
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
            errorTitle="Unable to load sprint velocity"
            skeleton={<ChartCardSkeleton height={280} />}
          >
            <ChartCard title="Sprint velocity" description="Story points delivered per sprint" height={280}>
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

        {/* Overdue work */}
        <TabsContent value="overdue" className="mt-4">
          <QueryBoundary
            isLoading={tasksQuery.isLoading}
            isError={tasksQuery.isError}
            error={tasksQuery.error}
            onRetry={() => tasksQuery.refetch()}
            errorTitle="Unable to load overdue work"
            skeleton={<TableSkeleton columns={5} rows={6} />}
            isEmpty={overdue.length === 0}
            empty={
              <div className="space-y-3">
                <Card>
                  <EmptyState
                    icon={CheckCircle2}
                    title="Nothing is overdue"
                    description="Every open work package is still inside its committed date."
                  />
                </Card>
                {overdueTruncation}
              </div>
            }
          >
            <div className="space-y-3">
              <TableCard
                toolbar={
                  <CardHeader variant="compact" className="border-b-0">
                    <CardTitle>Overdue work packages</CardTitle>
                  </CardHeader>
                }
                footer={
                  <Pagination
                    page={overduePaged.page}
                    pageSize={overduePaged.pageSize}
                    total={overduePaged.total}
                    onPageChange={overduePaged.setPage}
                    onPageSizeChange={overduePaged.setPageSize}
                    itemLabel="task"
                  />
                }
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Task</TableHead>
                      <TableHead>Assignee</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead numeric>Days late</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overduePaged.items.map((task) => {
                      const assignee = users?.find((user) => user.id === task.assigneeId);
                      const late = Math.abs(daysFromToday(task.dueDate) ?? 0);
                      return (
                        <TableRow key={task.id}>
                          <TableCell className="font-mono text-2xs text-muted-foreground">
                            {task.key}
                          </TableCell>
                          <TableCell className="font-medium">{task.subject}</TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1.5">
                              <UserAvatar user={assignee} size="xs" />
                              {assignee?.name ?? 'Unassigned'}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-2xs tabular-nums">
                            {formatShortDate(task.dueDate)}
                          </TableCell>
                          <TableCell numeric className="font-medium text-danger">
                            {formatNumber(late)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableCard>
              {overdueTruncation}
            </div>
          </QueryBoundary>
        </TabsContent>

        {/* Time tracking */}
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
                    <CardTitle>Billable summary</CardTitle>
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
                      <TableHead numeric>Billable</TableHead>
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
                          <TableCell numeric>{formatHours(entry.hoursBillable)}</TableCell>
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
                description="Completed vs. created work packages per sprint"
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
                  value={insights?.openRisks ?? 0}
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
