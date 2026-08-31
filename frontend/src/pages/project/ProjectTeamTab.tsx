import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Mail, UserPlus } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { UserAvatar } from '@/components/common/UserAvatar';
import { WorkloadList, WorkloadListSkeleton } from '@/components/teams/WorkloadList';
import { useProject } from '@/hooks/useProjects';
import { useTeamWorkloads } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { toast } from 'sonner';

/** People assigned to a project, with their current allocation. */
export default function ProjectTeamTab() {
  const { projectId } = useParams();
  const { data: project, isLoading } = useProject(projectId);
  const workloadsQuery = useTeamWorkloads();
  const users = useUserMap();

  const members = useMemo(
    () => (project?.memberIds ?? []).map((id) => users.get(id)).filter(Boolean),
    [project?.memberIds, users],
  );

  const memberWorkloads = useMemo(
    () =>
      (workloadsQuery.data ?? []).filter((workload) =>
        (project?.memberIds ?? []).includes(workload.userId),
      ),
    [workloadsQuery.data, project?.memberIds],
  );

  const memberPage = usePagination(members, { pageSize: 10, resetKey: projectId });

  if (isLoading || !project) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-2">
        <SectionHeader
          title="Members"
          description={`${members.length} people on this project`}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                toast('Inviting members is not enabled in the demo', {
                  description: 'Memberships are managed through the Nexus backend.',
                })
              }
            >
              <UserPlus className="h-3.5 w-3.5" />
              Invite
            </Button>
          }
        />

        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {memberPage.items.map((member) => (
              <li key={member!.id} className="flex items-center gap-3 px-4 py-3">
                <UserAvatar user={member} size="default" showStatus />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{member!.name}</p>
                  <p className="truncate text-2xs text-muted-foreground">{member!.role}</p>
                </div>
                {member!.id === project.ownerId ? (
                  <Badge size="sm" tone="primary">
                    Owner
                  </Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Email ${member!.name}`}
                  onClick={() =>
                    toast('Messaging is not enabled in the demo', {
                      description: `A connected workspace opens a thread with ${member!.name}.`,
                    })
                  }
                >
                  <Mail className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
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
      </div>

      <div className="space-y-3 lg:col-span-3">
        <SectionHeader title="Workload" description="Allocation across all assigned work" />
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="text-xs">Capacity vs. assigned</CardTitle>
          </CardHeader>
          <QueryBoundary
            isLoading={workloadsQuery.isLoading}
            isError={workloadsQuery.isError}
            onRetry={() => workloadsQuery.refetch()}
            errorTitle="Unable to load workload"
            skeleton={<WorkloadListSkeleton />}
          >
            <WorkloadList workloads={memberWorkloads} users={users} />
          </QueryBoundary>
        </Card>
      </div>
    </div>
  );
}
