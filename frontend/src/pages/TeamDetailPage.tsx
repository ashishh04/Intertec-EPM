import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, Building2, Pencil, RotateCcw, UserRound, Users } from 'lucide-react';

import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TeamDialog } from '@/components/teams/TeamDialog';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePagination } from '@/hooks/usePagination';
import { useSetTeamActive, useTeam, useTeamWorkloads } from '@/hooks/useTeams';
import { useTeamMembers } from '@/hooks/useEmployees';
import { useUserMap } from '@/hooks/useUsers';
import { formatHours, formatNumber, formatPercent } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';

const MEMBERS_PAGE_SIZE = 10;

/**
 * One team.
 *
 * Shows what EPM owns: identity, department, lead, members and lifecycle.
 *
 * Membership comes from EPM's employee mapping. It is not the group-derived
 * `memberIds` this page used to render, which was always empty because the
 * instance defines no OpenProject groups. Projects and capacity remain absent —
 * they belong to Portfolio and Capacity.
 */
export default function TeamDetailPage() {
  const { teamId } = useParams();
  const { can } = useAuth();
  const mayManage = can('teams:manage');

  const team = useTeam(teamId);
  const members = useTeamMembers(teamId);
  const workloads = useTeamWorkloads(teamId);
  const setActive = useSetTeamActive();
  const users = useUserMap();

  const [dialogOpen, setDialogOpen] = useState(false);

  const memberItems = useMemo(() => members.data ?? [], [members.data]);
  const pagedMembers = usePagination(memberItems, { pageSize: MEMBERS_PAGE_SIZE });

  const loggedThisWeek = (workloads.data ?? []).reduce((total, w) => total + w.hoursLogged, 0);

  // Undefined rather than zero when there is no capacity to divide by — the
  // same rule the per-person figure uses.
  const capacityHours = team.data?.capacityHours ?? 0;
  const utilization =
    capacityHours > 0 ? Math.round((loggedThisWeek / capacityHours) * 100) : null;

  const toggleActive = () => {
    if (!team.data) return;
    const active = !team.data.active;

    setActive.mutate(
      { id: team.data.id, active },
      {
        onSuccess: () => toast.success(active ? 'Team restored' : 'Team archived'),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <QueryBoundary
      isLoading={team.isLoading}
      isError={team.isError}
      onRetry={() => team.refetch()}
      errorTitle="Unable to load this team"
      skeleton={
        <div className="space-y-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      {team.data ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow={<span className="font-mono">{team.data.code}</span>}
            title={team.data.name}
            description={team.data.description}
            meta={
              team.data.active ? null : (
                <Badge tone="warning" size="sm">
                  Archived
                </Badge>
              )
            }
            actions={
              mayManage ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={setActive.isPending}
                    onClick={toggleActive}
                  >
                    {team.data.active ? (
                      <Archive className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    {team.data.active ? 'Archive' : 'Restore'}
                  </Button>
                </div>
              ) : null
            }
          />

          {/* Capacity is EPM's own: members' weekly hours summed. Logged hours
              come from OpenProject time entries for the current week, which is
              the same period, so the ratio between them means something. */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="epm-eyebrow">Members</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(team.data.memberCount)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="epm-eyebrow">Capacity</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(team.data.capacityHours)}
                <span className="ml-1 text-xs text-muted-foreground">h/wk</span>
              </p>
            </Card>
            <Card className="p-4">
              <p className="epm-eyebrow">Logged this week</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatHours(loggedThisWeek)}
                {utilization === null ? null : (
                  <span className="ml-1 text-xs text-muted-foreground">
                    · {formatPercent(utilization)}
                  </span>
                )}
              </p>
              {utilization === null ? (
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  No capacity set, so utilisation is undefined.
                </p>
              ) : null}
            </Card>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader variant="compact">
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Department
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {team.data.department ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{team.data.department.name}</span>
                    {team.data.department.active ? null : (
                      <Badge tone="warning" size="sm">
                        Archived
                      </Badge>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    size="inline"
                    icon={Building2}
                    title="No department"
                    description="This team does not belong to a department."
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader variant="compact">
                <CardTitle className="flex items-center gap-2">
                  <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Lead
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {team.data.lead ? (
                  <div className="flex items-center gap-2">
                    {/* The name comes from the backend; the directory is only
                        consulted for the avatar. */}
                    <UserAvatar user={users.get(team.data.lead.id)} size="sm" />
                    <span className="text-sm">{team.data.lead.name}</span>
                  </div>
                ) : (
                  <EmptyState
                    size="inline"
                    icon={UserRound}
                    title="No lead"
                    description="No lead has been assigned."
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader variant="compact">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
                Members
                {memberItems.length > 0 ? (
                  <span className="font-mono text-2xs font-normal tabular-nums text-muted-foreground">
                    {formatNumber(memberItems.length)}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <QueryBoundary
                isLoading={members.isLoading}
                isError={members.isError}
                onRetry={() => members.refetch()}
                errorTitle="Unable to load members"
                skeleton={<ListSkeleton rows={3} height="h-8" />}
                isEmpty={memberItems.length === 0}
                empty={
                  <EmptyState
                    size="inline"
                    icon={Users}
                    title="Nobody is assigned to this team yet"
                    description="People are assigned on the employees page."
                  />
                }
              >
                <ul className="space-y-1.5">
                  {pagedMembers.items.map((member) => (
                    <li key={member.id} className="flex items-center gap-2">
                      <UserAvatar user={users.get(member.id)} size="xs" />
                      <span className="text-xs">{member.name}</span>
                      {member.email ? (
                        <span className="text-2xs text-muted-foreground">{member.email}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </QueryBoundary>
            </CardContent>
            {/* Hides itself when everyone fits on one page. */}
            <Pagination
              page={pagedMembers.page}
              pageSize={pagedMembers.pageSize}
              total={pagedMembers.total}
              onPageChange={pagedMembers.setPage}
              itemLabel="member"
              className="border-t border-border"
            />
          </Card>

          <TeamDialog open={dialogOpen} onOpenChange={setDialogOpen} team={team.data} />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
