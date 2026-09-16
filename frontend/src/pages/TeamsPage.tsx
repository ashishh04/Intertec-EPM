import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, Building2, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react';

import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TeamDialog } from '@/components/teams/TeamDialog';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useDepartments } from '@/hooks/useDepartments';
import { usePagination } from '@/hooks/usePagination';
import { useDeleteTeam, useSetTeamActive, useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { formatNumber, pluralize } from '@/lib/utils';
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

const PAGE_SIZE = 12;

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

  const [removing, setRemoving] = useState<EpmTeam>();
  const deleteTeam = useDeleteTeam();

  const confirmRemove = () => {
    if (!removing) return;
    const name = removing.name;

    deleteTeam.mutate(removing.id, {
      onSuccess: () => {
        toast.success(`${name} deleted`);
        setRemoving(undefined);
      },
      // The refusal names who is still on the team, so it is shown as-is.
      onError: (error) =>
        toast.error('That could not be deleted', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
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

  // Filtering is server-side; only the page is local, and it returns to the
  // first page whenever the filters change.
  const paged = usePagination(items, {
    pageSize: PAGE_SIZE,
    resetKey: `${departmentId}|${showArchived}`,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Teams"
        description="Delivery teams defined in EPM."
        actions={
          mayManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              New team
            </Button>
          ) : null
        }
      />

      <ListToolbar trailing={<ResultCount count={items.length} label="team" />}>
        <Select value={departmentId} onValueChange={setDepartmentId}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by department">
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
      </ListToolbar>

      <QueryBoundary
        isLoading={teams.isLoading}
        isError={teams.isError}
        onRetry={() => teams.refetch()}
        errorTitle="Unable to load teams"
        skeleton={<ListSkeleton rows={4} height="h-16" />}
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
        <div className="space-y-3">
          <ul className="space-y-2">
            {paged.items.map((team) => (
              <li key={team.id}>
                <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-primary/40">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* Stretched over the whole row: the name alone was a
                          small target on a wide card. The row's own buttons are
                          lifted above it rather than nested inside it. */}
                      <Link
                        to={`/teams/${team.id}`}
                        className="truncate rounded-sm text-sm font-medium transition-colors after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {team.name}
                      </Link>
                      <Badge size="sm" className="font-mono">
                        {team.code}
                      </Badge>
                      {!team.active ? (
                        <Badge tone="warning" size="sm">
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
                    <span className="tabular-nums">
                      {formatNumber(team.memberCount)} {pluralize(team.memberCount, 'member')} ·{' '}
                      {formatNumber(team.capacityHours)} h/wk
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
                    <div className="relative z-10 flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${team.name}`}
                        onClick={() => openEdit(team)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={team.active ? `Archive ${team.name}` : `Restore ${team.name}`}
                        onClick={() => toggleActive(team)}
                      >
                        {team.active ? (
                          <Archive className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </Button>

                      {/* For a team created by mistake. Archiving keeps it; the
                          backend refuses this while anyone is still on it. */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${team.name}`}
                        className="hover:bg-danger-soft hover:text-danger"
                        onClick={() => setRemoving(team)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>

          <Card className="px-1">
              <Pagination
                page={paged.page}
                pageSize={paged.pageSize}
                total={paged.total}
                onPageChange={paged.setPage}
                onPageSizeChange={paged.setPageSize}
                pageSizeOptions={[12, 24, 48]}
                itemLabel="team"
              />
            </Card>
        </div>
      </QueryBoundary>

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              This removes the team from EPM permanently. Archiving keeps it and can be undone;
              deleting cannot. It is refused if anyone is still on the team.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={deleteTeam.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={deleteTeam.isPending}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TeamDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={editing}
        defaultDepartmentId={departmentId === ALL ? undefined : departmentId}
      />
    </div>
  );
}
