import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Gauge, Users } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState } from '@/components/common/ErrorState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { MetricCard } from '@/components/common/MetricCard';
import { ProjectRow } from '@/components/common/ProjectCard';
import { ActivityTimeline, ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { UserAvatar } from '@/components/common/UserAvatar';
import { WorkloadList, WorkloadListSkeleton } from '@/components/teams/WorkloadList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ProgressBar } from '@/components/ui/progress';
import { useTeam, useTeamWorkloads } from '@/hooks/useTeams';
import { useProjects } from '@/hooks/useProjects';
import { useActivity } from '@/hooks/useDashboard';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { CheckCircle2, FolderKanban } from 'lucide-react';
import type { EpmProject } from '@/types';

/** Team workspace: people, projects, workload and recent activity. */
export default function TeamDetailPage() {
  const { teamId } = useParams();
  const { data: team, isLoading, isError, refetch } = useTeam(teamId);
  const workloadsQuery = useTeamWorkloads(teamId);
  const projectsQuery = useProjects();
  const activityQuery = useActivity({ limit: 15 });
  const users = useUserMap();

  const teamProjects = useMemo(() => {
    if (!team) return [] as EpmProject[];
    return (projectsQuery.data ?? []).filter((project) => team.projectIds.includes(project.id));
  }, [team, projectsQuery.data]);

  const memberPage = usePagination(team?.memberIds ?? [], { pageSize: 10, resetKey: teamId });
  const activityPage = usePagination(activityQuery.data ?? [], { pageSize: 12, resetKey: teamId });

  const totals = useMemo(() => {
    const workloads = workloadsQuery.data ?? [];
    if (workloads.length === 0) return { allocation: 0, assigned: 0, completed: 0 };
    return {
      allocation: Math.round(
        workloads.reduce((sum, item) => sum + item.allocation, 0) / workloads.length,
      ),
      assigned: workloads.reduce((sum, item) => sum + item.assignedTasks, 0),
      completed: workloads.reduce((sum, item) => sum + item.completedThisSprint, 0),
    };
  }, [workloadsQuery.data]);

  if (isError) {
    return (
      <ErrorState
        title="Unable to load team"
        description="Something went wrong while loading this team."
        onRetry={() => refetch()}
      />
    );
  }

  if (isLoading || !team) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const lead = users.get(team.leadId);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Team"
        title={team.name}
        description={team.description}
        meta={<Badge tone="neutral" size="sm">{team.memberIds.length} members</Badge>}
        actions={
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
            <UserAvatar user={lead} size="sm" showStatus />
            <div className="text-left">
              <p className="epm-eyebrow">Team lead</p>
              <p className="text-2xs font-medium">{lead?.name ?? 'Unassigned'}</p>
            </div>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Members" value={team.memberIds.length} icon={Users} tone="primary" />
        <MetricCard
          label="Active Projects"
          value={teamProjects.length}
          icon={FolderKanban}
          tone="highlight"
        />
        <MetricCard
          label="Average Allocation"
          value={totals.allocation}
          suffix="%"
          support={totals.allocation > 85 ? 'Above healthy capacity' : 'Within capacity'}
          icon={Gauge}
          tone={totals.allocation > 85 ? 'warning' : 'accent'}
        />
        <MetricCard
          label="Sprint Progress"
          value={team.sprintProgress}
          suffix="%"
          support={`${totals.completed} completed this sprint`}
          icon={CheckCircle2}
          tone="success"
        />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="workload">Workload</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="border-b border-border">
              <CardTitle>Workload distribution</CardTitle>
            </CardHeader>
            <QueryBoundary
              isLoading={workloadsQuery.isLoading}
              isError={workloadsQuery.isError}
              onRetry={() => workloadsQuery.refetch()}
              errorTitle="Unable to load workload"
              skeleton={<WorkloadListSkeleton />}
            >
              <WorkloadList workloads={workloadsQuery.data ?? []} users={users} />
            </QueryBoundary>
          </Card>

          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle>Projects</CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {teamProjects.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="members" className="mt-4">
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {memberPage.items.map((memberId) => {
                const member = users.get(memberId);
                const workload = (workloadsQuery.data ?? []).find(
                  (item) => item.userId === memberId,
                );
                return (
                  <li key={memberId} className="flex items-center gap-3 px-4 py-3">
                    <UserAvatar user={member} size="default" showStatus />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{member?.name}</p>
                      <p className="truncate text-2xs text-muted-foreground">
                        {member?.role} · {member?.department}
                      </p>
                    </div>
                    {memberId === team.leadId ? (
                      <Badge size="sm" tone="primary">
                        Lead
                      </Badge>
                    ) : null}
                    <div className="hidden w-32 items-center gap-2 sm:flex">
                      <ProgressBar
                        value={workload?.allocation ?? 0}
                        size="xs"
                        tone={(workload?.allocation ?? 0) > 85 ? 'warning' : 'success'}
                        label={`${member?.name ?? 'Member'} allocation`}
                      />
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                        {workload?.allocation ?? 0}%
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <Pagination
              page={memberPage.page}
              pageSize={memberPage.pageSize}
              total={memberPage.total}
              onPageChange={memberPage.setPage}
              itemLabel="member"
              className="border-t border-border"
            />
          </Card>
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          <Card className="p-2">
            {teamProjects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </Card>
        </TabsContent>

        <TabsContent value="workload" className="mt-4">
          <Card className="overflow-hidden">
            <QueryBoundary
              isLoading={workloadsQuery.isLoading}
              isError={workloadsQuery.isError}
              onRetry={() => workloadsQuery.refetch()}
              errorTitle="Unable to load workload"
              skeleton={<WorkloadListSkeleton rows={6} />}
            >
              <WorkloadList workloads={workloadsQuery.data ?? []} users={users} />
            </QueryBoundary>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardContent className="pt-5">
              <QueryBoundary
                isLoading={activityQuery.isLoading}
                isError={activityQuery.isError}
                onRetry={() => activityQuery.refetch()}
                errorTitle="Unable to load activity"
                skeleton={<ActivityTimelineSkeleton rows={6} />}
              >
                <ActivityTimeline entries={activityPage.items} users={users} />
              </QueryBoundary>
            </CardContent>
            <Pagination
              page={activityPage.page}
              pageSize={activityPage.pageSize}
              total={activityPage.total}
              onPageChange={activityPage.setPage}
              itemLabel="event"
              className="border-t border-border"
            />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
