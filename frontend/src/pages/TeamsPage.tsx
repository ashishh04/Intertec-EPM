import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, Briefcase, Building2, Mail, Pencil, Phone, Plus, RotateCcw, Trash2, Users } from 'lucide-react';

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDepartments } from '@/hooks/useDepartments';
import { usePagination } from '@/hooks/usePagination';
import { useDeleteTeam, useSetTeamActive, useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmTeam, TeamKind } from '@/services/api/teams';

/**
 * Teams & clients.
 *
 * Two tabs over one list: internal teams, the organisation's own people, and
 * external clients it delivers for, each with a contact and an account manager.
 * Backed entirely by EPM's own database.
 *
 * Everyone signed in can read; creating and changing needs `teams:manage`,
 * which the backend checks on every write regardless of what is rendered here.
 */

const ALL = '__all__';

const PAGE_SIZE = 12;

export default function TeamsPage() {
  const { can } = useAuth();
  const mayManage = can('teams:manage');

  // In the address, so "External clients" can be linked to and survives a reload.
  const [search, setSearch] = useSearchParams();
  const kind: TeamKind = search.get('kind') === 'client' ? 'client' : 'internal';
  const isClient = kind === 'client';
  const setKind = (next: string) => {
    const params = new URLSearchParams(search);
    if (next === 'client') params.set('kind', 'client');
    else params.delete('kind');
    setSearch(params, { replace: true });
  };

  const [showArchived, setShowArchived] = useState(false);
  const [departmentId, setDepartmentId] = useState(ALL);

  const teams = useTeams({
    includeInactive: showArchived,
    // Clients are not filed under departments here; the filter is the internal tab's.
    departmentId: departmentId === ALL || isClient ? undefined : departmentId,
    kind,
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
        toast.success(t('{name} deleted', { name }));
        setRemoving(undefined);
      },
      // The refusal names who is still on the team, so it is shown as-is.
      onError: (error) =>
        toast.error(t('That could not be deleted'), {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const toggleActive = (team: EpmTeam) => {
    const active = !team.active;

    setActive.mutate(
      { id: team.id, active },
      {
        onSuccess: () =>
          toast.success(
            team.kind === 'client'
              ? active
                ? t('Client restored')
                : t('Client archived')
              : active
                ? t('Team restored')
                : t('Team archived'),
          ),
        onError: (error) =>
          toast.error(t('That could not be changed'), {
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
    resetKey: `${kind}|${departmentId}|${showArchived}`,
  });

  const RowIcon = isClient ? Briefcase : Users;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Teams & clients')}
        description={
          isClient
            ? t('The external clients the organisation delivers for, with a contact and an account manager each.')
            : t('The organisation’s own delivery teams.')
        }
        actions={
          mayManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              {isClient ? t('New client') : t('New team')}
            </Button>
          ) : null
        }
      />

      <Tabs value={kind} onValueChange={setKind}>
        <TabsList>
          <TabsTrigger value="internal">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {t('Internal teams')}
          </TabsTrigger>
          <TabsTrigger value="client">
            <Briefcase className="h-3.5 w-3.5" aria-hidden />
            {t('External clients')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <ListToolbar
        trailing={
          isClient ? (
            <ResultCount count={items.length} label={t('client')} plural={t('clients')} />
          ) : (
            <ResultCount count={items.length} label={t('team')} plural={t('teams')} />
          )
        }
      >
        {!isClient ? (
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label={t('Filter by department')}>
              <SelectValue placeholder={t('All departments')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('All departments')}</SelectItem>
              {(departments.data ?? []).map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.active ? department.name : t('{name} (archived)', { name: department.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={showArchived}
            onCheckedChange={setShowArchived}
            aria-label={isClient ? t('Show archived clients') : t('Show archived teams')}
          />
          {t('Show archived')}
        </label>
      </ListToolbar>

      <QueryBoundary
        isLoading={teams.isLoading}
        isError={teams.isError}
        onRetry={() => teams.refetch()}
        errorTitle={isClient ? t('Unable to load clients') : t('Unable to load teams')}
        skeleton={<ListSkeleton rows={4} height="h-16" />}
        isEmpty={items.length === 0}
        empty={
          isClient ? (
            <EmptyState
              icon={Briefcase}
              title={t('No clients')}
              description={
                mayManage
                  ? t('Add the clients the organisation delivers for, with a contact and an account manager.')
                  : t('No clients have been added yet.')
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title={departmentId === ALL ? t('No teams') : t('No teams in this department')}
              description={
                mayManage
                  ? t('Create a team to describe how delivery is organised.')
                  : t('No teams have been set up yet.')
              }
            />
          )
        }
      >
        <div className="space-y-3">
          <ul className="space-y-2">
            {paged.items.map((team) => (
              <li key={team.id}>
                <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-primary/40">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <RowIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* Stretched over the whole row: the name alone was a
                          small target on a wide card. The row's own buttons are
                          lifted above it rather than nested inside it. */}
                      <Link
                        to={`/teams/${team.id}`}
                        dir="auto"
                        className="truncate rounded-sm text-sm font-medium transition-colors after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {team.name}
                      </Link>
                      <Badge size="sm" className="font-mono">
                        {team.code}
                      </Badge>
                      {!team.active ? (
                        <Badge tone="warning" size="sm">
                          {t('Archived')}
                        </Badge>
                      ) : null}
                    </div>
                    {team.description ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="auto">
                        {team.description}
                      </p>
                    ) : null}
                  </div>

                  {team.kind === 'client' ? (
                    <div className="hidden min-w-0 shrink-0 flex-col gap-0.5 text-xs text-muted-foreground sm:flex">
                      {/* A real mail link: the card's stretched link sits under it. */}
                      {team.contactEmail ? (
                        <a
                          href={`mailto:${team.contactEmail}`}
                          className="relative z-10 inline-flex items-center gap-1.5 truncate hover:text-primary"
                          dir="ltr"
                        >
                          <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          {team.contactEmail}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          {t('No email')}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5" dir={team.contactPhone ? 'ltr' : undefined}>
                        <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {team.contactPhone ?? t('No phone')}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                        <Users className="h-3.5 w-3.5" aria-hidden />
                        {/* Both counted from EPM's employee mapping, never from an
                            OpenProject group. */}
                        <span className="tabular-nums">
                          {t('{count, plural, one {# member} other {# members}}', { count: team.memberCount })} ·{' '}
                          {t('{hours, number} h/wk', { hours: team.capacityHours })}
                        </span>
                      </div>

                      <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                        <Building2 className="h-3.5 w-3.5" aria-hidden />
                        {team.department ? (
                          <span>
                            {/* A team outlives its department's archival, so say so
                                rather than showing a name that looks current. */}
                            {team.department.active
                              ? team.department.name
                              : t('{name} (archived)', { name: team.department.name })}
                          </span>
                        ) : (
                          <span>{t('No department')}</span>
                        )}
                      </div>
                    </>
                  )}

                  {team.lead ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <UserAvatarWithTooltip user={users.get(team.lead.id)} size="xs" />
                      <span className="hidden text-xs text-muted-foreground sm:inline" dir="auto">
                        {team.kind === 'client'
                          ? t('Account manager: {name}', { name: team.lead.name })
                          : team.lead.name}
                      </span>
                    </div>
                  ) : (
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {team.kind === 'client' ? t('No account manager') : t('No lead')}
                    </span>
                  )}

                  {mayManage ? (
                    <div className="relative z-10 flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('Edit {name}', { name: team.name })}
                        onClick={() => openEdit(team)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                          team.active
                            ? t('Archive {name}', { name: team.name })
                            : t('Restore {name}', { name: team.name })
                        }
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
                        aria-label={t('Delete {name}', { name: team.name })}
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
                itemLabel={isClient ? t('client') : t('team')}
                itemLabelPlural={isClient ? t('clients') : t('teams')}
              />
            </Card>
        </div>
      </QueryBoundary>

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Delete {name}?', { name: removing?.name })}</DialogTitle>
            <DialogDescription>
              {removing?.kind === 'client'
                ? t(
                    'This removes the client from EPM permanently. Archiving keeps it and can be undone; deleting cannot. It is refused if anyone is still on it.',
                  )
                : t(
                    'This removes the team from EPM permanently. Archiving keeps it and can be undone; deleting cannot. It is refused if anyone is still on the team.',
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={deleteTeam.isPending}
            >
              {t('Cancel')}
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={deleteTeam.isPending}>
              {t('Delete permanently')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TeamDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={editing}
        defaultKind={kind}
        defaultDepartmentId={departmentId === ALL || isClient ? undefined : departmentId}
      />
    </div>
  );
}
