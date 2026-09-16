import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArrowLeft, Pencil, RotateCcw, UserRound, Users } from 'lucide-react';

import { DepartmentDialog } from '@/components/departments/DepartmentDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDepartment, useSetDepartmentActive } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { usePagination } from '@/hooks/usePagination';
import { useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { formatNumber, pluralize } from '@/lib/utils';
import type { EpmDepartment } from '@/services/api/departments';

/**
 * One department.
 *
 * Shows what EPM owns: identity, manager, lifecycle, the teams inside it and
 * the people mapped to it. People are read from the department directly rather
 * than gathered from its teams, so someone mapped to the department but to no
 * team still appears — which is the case the team-by-team view would lose.
 */

const MEMBERS_PAGE_SIZE = 10;

export default function DepartmentDetailPage() {
  const { departmentId } = useParams();
  const { can } = useAuth();
  const mayManage = can('departments:manage');

  const department = useDepartment(departmentId);
  const teams = useTeams({ departmentId, includeInactive: true });
  const members = useEmployees({ departmentId });
  const users = useUserMap();
  const setActive = useSetDepartmentActive();

  const [dialogOpen, setDialogOpen] = useState(false);

  const teamItems = teams.data ?? [];
  const memberItems = members.data ?? [];
  const pagedMembers = usePagination(memberItems, { pageSize: MEMBERS_PAGE_SIZE });

  const toggleActive = () => {
    if (!department.data) return;
    const active = !department.data.active;

    setActive.mutate(
      { id: department.data.id, active },
      {
        onSuccess: () => toast.success(active ? 'Department restored' : 'Department archived'),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <QueryBoundary
      isLoading={department.isLoading}
      isError={department.isError}
      onRetry={() => department.refetch()}
      errorTitle="Unable to load this department"
      skeleton={
        <div className="space-y-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      {department.data ? (
        <div className="space-y-5">
          <Link
            to="/departments"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All departments
          </Link>

          <PageHeader
            eyebrow={<span className="font-mono">{department.data.code}</span>}
            title={department.data.name}
            description={department.data.description}
            meta={
              department.data.active ? null : (
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
                    {department.data.active ? (
                      <Archive className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    {department.data.active ? 'Archive' : 'Restore'}
                  </Button>
                </div>
              ) : null
            }
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="epm-eyebrow">People</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(department.data.memberCount)}
              </p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Mapped to this department, with or without a team.
              </p>
            </Card>

            <Card className="p-4">
              <p className="epm-eyebrow">Capacity</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(department.data.capacityHours)}
                <span className="ml-1 text-xs text-muted-foreground">h/wk</span>
              </p>
            </Card>

            <Card className="p-4">
              <p className="epm-eyebrow">Teams</p>
              <p className="mt-1 font-mono text-lg tabular-nums">
                {formatNumber(teamItems.length)}
              </p>
            </Card>
          </div>

          <Card>
            <CardHeader variant="compact">
              <CardTitle className="flex items-center gap-2">
                <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                Manager
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              {department.data.manager ? (
                <div className="flex items-center gap-2">
                  {/* The name comes from the backend; the directory is only
                      consulted for the avatar. */}
                  <UserAvatar user={users.get(department.data.manager.id)} size="xs" />
                  <span className="text-sm">{department.data.manager.name}</span>
                </div>
              ) : (
                <EmptyState
                  size="inline"
                  icon={UserRound}
                  title="No manager"
                  description="Nobody is accountable for this department yet."
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader variant="compact">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
                Teams
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {formatNumber(teamItems.length)} {pluralize(teamItems.length, 'team')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <QueryBoundary
                isLoading={teams.isLoading}
                isError={teams.isError}
                onRetry={() => teams.refetch()}
                errorTitle="Unable to load these teams"
                skeleton={<ListSkeleton rows={3} height="h-10" />}
                isEmpty={teamItems.length === 0}
                empty={
                  <EmptyState
                    size="inline"
                    icon={Users}
                    title="No teams"
                    description="No team belongs to this department yet."
                  />
                }
              >
                <ul className="space-y-1.5">
                  {teamItems.map((team) => (
                    <li key={team.id}>
                      <Link
                        to={`/teams/${team.id}`}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate">{team.name}</span>
                        <Badge size="sm" className="font-mono">
                          {team.code}
                        </Badge>
                        {team.active ? null : (
                          <Badge tone="warning" size="sm">
                            Archived
                          </Badge>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                          {formatNumber(team.memberCount)}{' '}
                          {pluralize(team.memberCount, 'member')}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </QueryBoundary>
            </CardContent>
          </Card>

          <Card>
            <CardHeader variant="compact">
              <CardTitle className="flex items-center gap-2">
                <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                People
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {formatNumber(memberItems.length)}{' '}
                  {pluralize(memberItems.length, 'person')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <QueryBoundary
                isLoading={members.isLoading}
                isError={members.isError}
                onRetry={() => members.refetch()}
                errorTitle="Unable to load these people"
                skeleton={<ListSkeleton rows={4} height="h-10" />}
                isEmpty={memberItems.length === 0}
                empty={
                  <EmptyState
                    size="inline"
                    icon={UserRound}
                    title="Nobody mapped yet"
                    description="People are mapped to a department from the Employees page."
                  />
                }
              >
                <div className="space-y-3">
                  <ul className="space-y-1.5">
                    {pagedMembers.items.map((person) => (
                      <li
                        key={person.id}
                        className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                      >
                        <UserAvatar user={users.get(person.id)} size="xs" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{person.name}</p>
                          {person.email ? (
                            <p className="truncate text-2xs text-muted-foreground">
                              {person.email}
                            </p>
                          ) : null}
                        </div>
                        {person.team ? (
                          <Link to={`/teams/${person.team.id}`} className="shrink-0">
                            <Badge size="sm" className="transition-colors hover:bg-muted">
                              {person.team.name}
                            </Badge>
                          </Link>
                        ) : (
                          <span className="shrink-0 text-2xs text-muted-foreground">No team</span>
                        )}
                        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                          {formatNumber(person.hoursCapacity)} h/wk
                        </span>
                      </li>
                    ))}
                  </ul>

                  <Pagination
                    page={pagedMembers.page}
                    pageSize={pagedMembers.pageSize}
                    total={pagedMembers.total}
                    onPageChange={pagedMembers.setPage}
                    onPageSizeChange={pagedMembers.setPageSize}
                    pageSizeOptions={[10, 25, 50]}
                    itemLabel="person"
                  />
                </div>
              </QueryBoundary>
            </CardContent>
          </Card>

          <DepartmentDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            department={department.data as EpmDepartment}
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
