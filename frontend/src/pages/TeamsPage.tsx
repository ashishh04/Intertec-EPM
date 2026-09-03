import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, Building2, Pencil, Plus, RotateCcw, Users } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TeamDialog } from '@/components/teams/TeamDialog';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useDepartments } from '@/hooks/useDepartments';
import { useSetTeamActive, useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmTeam } from '@/services/api/teams';

/**
 * The team directory.
 *
 * Backed entirely by EPM's own database. Teams used to be a reading of
 * OpenProject groups, of which this instance defines none, so the page could
 * only ever be empty.
 *
 * Everyone signed in can read; creating and changing needs `teams:manage`,
 * which the backend checks on every write regardless of what is rendered here.
 */

const ALL = '__all__';

export default function TeamsPage() {
  const { can } = useAuth();
  const mayManage = can('teams:manage');

  const [showArchived, setShowArchived] = useState(false);
  const [departmentId, setDepartmentId] = useState(ALL);

  const teams = useTeams({
    includeInactive: showArchived,
    departmentId: departmentId === ALL ? undefined : departmentId,
  });
  const departments = useDepartments(true);
  const setActive = useSetTeamActive();
  const users = useUserMap();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EpmTeam>();

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (team: EpmTeam) => {
    setEditing(team);
    setDialogOpen(true);
  };

  const toggleActive = (team: EpmTeam) => {
    const active = !team.active;

    setActive.mutate(
      { id: team.id, active },
      {
        onSuccess: () => toast.success(active ? 'Team restored' : 'Team archived'),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const items = teams.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Teams"
        description="Delivery teams defined in EPM."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger className="w-52" aria-label="Filter by department">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {(departments.data ?? []).map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                    {department.active ? '' : ' (archived)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showArchived}
                onCheckedChange={setShowArchived}
                aria-label="Show archived teams"
              />
              Show archived
            </label>

            {mayManage ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                New team
              </Button>
            ) : null}
          </div>
        }
      />

      <QueryBoundary
        isLoading={teams.isLoading}
        isError={teams.isError}
        onRetry={() => teams.refetch()}
        errorTitle="Unable to load teams"
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        }
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={Users}
            title={departmentId === ALL ? 'No teams' : 'No teams in this department'}
            description={
              mayManage
                ? 'Create a team to describe how delivery is organised.'
                : 'No teams have been set up yet.'
            }
          />
        }
      >
        <ul className="space-y-2">
          {items.map((team) => (
            <li key={team.id}>
              <Card className="flex items-center gap-4 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/teams/${team.id}`}
                      className="truncate text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {team.name}
                    </Link>
                    <Badge className="font-mono text-2xs">{team.code}</Badge>
                    {!team.active ? (
                      <Badge tone="warning" className="text-2xs">
                        Archived
                      </Badge>
                    ) : null}
                  </div>
                  {team.description ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {team.description}
                    </p>
                  ) : null}
                </div>

                <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  {/* Both counted from EPM's employee mapping, never from an
                      OpenProject group. */}
                  <span>
                    {team.memberCount} · {team.capacityHours} h/wk
                  </span>
                </div>

                <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <Building2 className="h-3.5 w-3.5" aria-hidden />
                  {team.department ? (
                    <span>
                      {team.department.name}
                      {/* A team outlives its department's archival, so say so
                          rather than showing a name that looks current. */}
                      {team.department.active ? '' : ' (archived)'}
                    </span>
                  ) : (
                    <span>No department</span>
                  )}
                </div>

                {team.lead ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <UserAvatarWithTooltip user={users.get(team.lead.id)} size="xs" />
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {team.lead.name}
                    </span>
                  </div>
                ) : (
                  <span className="hidden text-xs text-muted-foreground sm:inline">No lead</span>
                )}

                {mayManage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Edit ${team.name}`}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openEdit(team)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>

                    <button
                      type="button"
                      aria-label={team.active ? `Archive ${team.name}` : `Restore ${team.name}`}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => toggleActive(team)}
                    >
                      {team.active ? (
                        <Archive className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </QueryBoundary>

      <TeamDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={editing}
        defaultDepartmentId={departmentId === ALL ? undefined : departmentId}
      />
    </div>
  );
}
