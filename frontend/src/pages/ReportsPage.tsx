import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FolderKanban,
  Gauge,
  TrendingUp,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { ChartCard, ChartCardSkeleton } from '@/components/common/ChartCard';
import { HealthIndicator, ProjectStatusBadge } from '@/components/common/StatusBadge';
import { UserAvatar } from '@/components/common/UserAvatar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
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
import { daysFromToday, formatHours, formatShortDate, toISODateOnly } from '@/lib/utils';
import { subDays } from 'date-fns';
import type { ID, ReportFilters } from '@/types';

const ALL = '__all__';

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

  const projectsQuery = useProjects();
  const teamsQuery = useTeams();
  const { data: users } = useUsers();
  const distributionQuery = useStatusDistribution(filters);
  const trendsQuery = useDeliveryTrends(filters);
  const insightsQuery = useExecutiveInsights(filters);
  const timeQuery = useTimeSummary(filters);
  const tasksQuery = useTasks({ projectId: filters.projectId, pageSize: 200 });

  const projects = useMemo(
    () =>
      (projectsQuery.data ?? []).filter(
        (project) => !filters.projectId || project.id === filters.projectId,
      ),
    [projectsQuery.data, filters.projectId],
  );

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

  const overduePaged = usePagination(overdue, {
    pageSize: 10,
    resetKey: `${filters.projectId ?? ''}|${filters.from ?? ''}|${filters.to ?? ''}`,
  });
  const timePaged = usePagination(timeQuery.data ?? [], { pageSize: 10 });

  const insights = insightsQuery.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description="Delivery reporting across projects, teams and time."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              toast('Export runs on the EPM backend', {
                description: 'Connected workspaces generate a PDF or CSV from the current filters.',
              })
            }
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        }
      />

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
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border py-3">
              <CardTitle>Project status</CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead className="min-w-36">Progress</TableHead>
                    <TableHead>Tasks</TableHead>
                    <TableHead>Risks</TableHead>
                    <TableHead>Target</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.name}</TableCell>
                      <TableCell>
                        <ProjectStatusBadge status={project.status} size="sm" />
                      </TableCell>
                      <TableCell>
                        <HealthIndicator level={project.health.overall} />
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
                          <span className="font-mono text-2xs tabular-nums">{project.progress}%</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-2xs">
                        {project.completedTaskCount}/{project.taskCount}
                      </TableCell>
                      <TableCell className="font-mono text-2xs">{project.openRiskCount}</TableCell>
                      <TableCell className="font-mono text-2xs">
                        {formatShortDate(project.dueDate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        </TabsContent>

        {/* Task completion */}
        <TabsContent value="completion" className="mt-4">
          <QueryBoundary
            isLoading={distributionQuery.isLoading}
            isError={distributionQuery.isError}
            onRetry={() => distributionQuery.refetch()}
            errorTitle="Unable to load the report"
            skeleton={<ChartCardSkeleton />}
          >
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
          <ChartCard title="Sprint velocity" description="Story points delivered per sprint" height={280}>
            <VelocityChart data={trendsQuery.data ?? []} />
          </ChartCard>
        </TabsContent>

        {/* Team performance */}
        <TabsContent value="team" className="mt-4">
          <div className="grid gap-4">
            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border py-3">
                <CardTitle>Teams</CardTitle>
              </CardHeader>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Team</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Lead</TableHead>
                      <TableHead className="text-right">Members</TableHead>
                      <TableHead className="text-right">Capacity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* Members and capacity are back, but from EPM's employee
                        mapping rather than the OpenProject-group reading that
                        made them permanently zero. Sprint progress stays out —
                        it has no source yet. */}
                    {(teamsQuery.data ?? []).map((team) => (
                      <TableRow key={team.id}>
                        <TableCell className="font-medium">{team.name}</TableCell>
                        <TableCell className="font-mono text-2xs">{team.code}</TableCell>
                        <TableCell className="text-2xs">
                          {team.department?.name ?? '—'}
                        </TableCell>
                        <TableCell className="text-2xs">{team.lead?.name ?? '—'}</TableCell>
                        <TableCell className="text-right font-mono text-2xs tabular-nums">
                          {team.memberCount}
                        </TableCell>
                        <TableCell className="text-right font-mono text-2xs tabular-nums">
                          {team.capacityHours} h/wk
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          </div>
        </TabsContent>

        {/* Overdue work */}
        <TabsContent value="overdue" className="mt-4">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border py-3">
              <CardTitle>Overdue work packages</CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Assignee</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Days late</TableHead>
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
                        <TableCell className="font-mono text-2xs">
                          {formatShortDate(task.dueDate)}
                        </TableCell>
                        <TableCell className="font-mono text-2xs font-medium text-danger">
                          {late}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Pagination
              page={overduePaged.page}
              pageSize={overduePaged.pageSize}
              total={overduePaged.total}
              onPageChange={overduePaged.setPage}
              onPageSizeChange={overduePaged.setPageSize}
              itemLabel="task"
              className="border-t border-border"
            />
          </Card>
        </TabsContent>

        {/* Time tracking */}
        <TabsContent value="time" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Hours logged" description="Effort recorded per person">
              <HorizontalBarChart data={timeByUser} tone="highlight" />
            </ChartCard>

            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border py-3">
                <CardTitle>Billable summary</CardTitle>
              </CardHeader>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead>Logged</TableHead>
                      <TableHead>Billable</TableHead>
                      <TableHead>Projects</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timePaged.items.map((entry) => {
                      const user = users?.find((item) => item.id === entry.userId);
                      return (
                        <TableRow key={entry.userId}>
                          <TableCell className="font-medium">{user?.name ?? 'Unknown'}</TableCell>
                          <TableCell className="font-mono text-2xs">
                            {formatHours(entry.hoursLogged)}
                          </TableCell>
                          <TableCell className="font-mono text-2xs">
                            {formatHours(entry.hoursBillable)}
                          </TableCell>
                          <TableCell className="font-mono text-2xs">
                            {entry.projectBreakdown.length}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={timePaged.page}
                pageSize={timePaged.pageSize}
                total={timePaged.total}
                onPageChange={timePaged.setPage}
                itemLabel="contributor"
                className="border-t border-border"
              />
            </Card>
          </div>
        </TabsContent>

        {/* Delivery trends */}
        <TabsContent value="trends" className="mt-4">
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
