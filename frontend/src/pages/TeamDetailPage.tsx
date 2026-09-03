import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, Building2, Pencil, RotateCcw, UserRound, Users } from 'lucide-react';

import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TeamDialog } from '@/components/teams/TeamDialog';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetTeamActive, useTeam } from '@/hooks/useTeams';
import { useTeamMembers } from '@/hooks/useEmployees';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';

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
  const setActive = useSetTeamActive();
  const users = useUserMap();

  const [dialogOpen, setDialogOpen] = useState(false);

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

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Department
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {team.data.department ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{team.data.department.name}</span>
                    {team.data.department.active ? null : (
                      <Badge tone="warning" className="text-2xs">
                        Archived
                      </Badge>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This team does not belong to a department.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2">
                  <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Lead
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {team.data.lead ? (
                  <div className="flex items-center gap-2">
                    {/* The name comes from the backend; the directory is only
                        consulted for the avatar. */}
                    <UserAvatar user={users.get(team.data.lead.id)} size="sm" />
                    <span className="text-sm">{team.data.lead.name}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No lead has been assigned.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
                Members
                {(members.data?.length ?? 0) > 0 ? (
                  <span className="text-2xs font-normal text-muted-foreground">
                    {members.data?.length}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {members.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (members.data?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nobody is assigned to this team yet. People are assigned on the
                  employees page.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {members.data?.map((member) => (
                    <li key={member.id} className="flex items-center gap-2">
                      <UserAvatar user={users.get(member.id)} size="xs" />
                      <span className="text-xs">{member.name}</span>
                      {member.email ? (
                        <span className="text-2xs text-muted-foreground">{member.email}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <TeamDialog open={dialogOpen} onOpenChange={setDialogOpen} team={team.data} />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
