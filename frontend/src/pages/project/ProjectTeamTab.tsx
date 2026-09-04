import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Mail, Pencil, UserMinus, UserPlus } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SectionHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { UserAvatar } from '@/components/common/UserAvatar';
import { MemberDialog } from '@/components/projects/MemberDialog';
import { WorkloadList, WorkloadListSkeleton } from '@/components/teams/WorkloadList';
import { useProject } from '@/hooks/useProjects';
import { useProjectMembers, useRemoveProjectMember } from '@/hooks/useMembers';
import { useTeamWorkloads } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmProjectMember } from '@/types';
import { toast } from 'sonner';

/** People assigned to a project, with their role and current allocation. */
export default function ProjectTeamTab() {
  const { projectId } = useParams();
  const { canInProject } = useAuth();
  const { data: project, isLoading } = useProject(projectId);
  const membersQuery = useProjectMembers(projectId);
  const workloadsQuery = useTeamWorkloads();
  const removeMember = useRemoveProjectMember(projectId ?? '');
  const users = useUserMap();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EpmProjectMember>();
  const [removing, setRemoving] = useState<EpmProjectMember>();

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);

  const memberWorkloads = useMemo(
    () =>
      (workloadsQuery.data ?? []).filter((workload) =>
        members.some((member) => member.userId === workload.userId),
      ),
    [workloadsQuery.data, members],
  );

  const memberPage = usePagination(members, { pageSize: 10, resetKey: projectId });

  const openAdd = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (member: EpmProjectMember) => {
    setEditing(member);
    setDialogOpen(true);
  };

  const confirmRemove = () => {
    if (!removing) return;
    const name = users.get(removing.userId)?.name ?? 'That person';

    removeMember.mutate(removing.membershipId, {
      onSuccess: () => {
        toast.success(`${name} removed from this project`);
        setRemoving(undefined);
      },
      onError: (error) =>
        toast.error('That could not be removed', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

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
              // Hiding is a courtesy; the backend rejects the write regardless.
              disabled={!canInProject(projectId, 'member:manage')}
              onClick={openAdd}
            >
              <UserPlus className="h-3.5 w-3.5" />
              Invite
            </Button>
          }
        />

        <Card className="overflow-hidden">
          <QueryBoundary
            isLoading={membersQuery.isLoading}
            isError={membersQuery.isError}
            onRetry={() => membersQuery.refetch()}
            errorTitle="Unable to load members"
            skeleton={<Skeleton className="h-48 w-full" />}
          >
            <ul className="divide-y divide-border">
              {memberPage.items.map((member) => {
                const person = users.get(member.userId);

                return (
                  <li key={member.membershipId} className="flex items-center gap-3 px-4 py-3">
                    <UserAvatar user={person} size="default" showStatus />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {person?.name ?? 'Unknown person'}
                      </p>
                      {/* The role on this project, which is not the same as the
                          account's role on the instance. */}
                      <p className="truncate text-2xs text-muted-foreground">
                        {member.roles.map((role) => role.name).join(', ') || 'No role'}
                      </p>
                    </div>

                    {member.userId === project.ownerId ? (
                      <Badge size="sm" tone="primary">
                        Owner
                      </Badge>
                    ) : null}

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Email ${person?.name ?? 'this person'}`}
                      onClick={() =>
                        toast('Messaging is not implemented yet', {
                          description: `A connected workspace opens a thread with ${
                            person?.name ?? 'this person'
                          }.`,
                        })
                      }
                    >
                      <Mail className="h-3.5 w-3.5" />
                    </Button>

                    {member.canManage ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Change ${person?.name ?? 'this person'}'s role`}
                          onClick={() => openEdit(member)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${person?.name ?? 'this person'} from this project`}
                          onClick={() => setRemoving(member)}
                        >
                          <UserMinus className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </QueryBoundary>

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

      <MemberDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId ?? ''}
        member={editing}
      />

      {/* Confirmed rather than immediate: this revokes someone's access to the
          project in OpenProject. It is reversible by adding them back, but not
          by an undo. */}
      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove from project</DialogTitle>
            <DialogDescription>
              {users.get(removing?.userId ?? '')?.name ?? 'This person'} loses access to{' '}
              {project.name}. You can add them back afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={removeMember.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={removeMember.isPending}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
