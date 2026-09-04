import { useState } from 'react';
import {
  Ellipsis,
  Lock,
  Pencil,
  Search,
  Trash2,
  Unlock,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { AccountDialog } from '@/components/employees/AccountDialog';
import { CapacityDialog } from '@/components/employees/CapacityDialog';
import { MappingDialog } from '@/components/employees/MappingDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDebounce } from '@/hooks/useDebounce';
import {
  useAccounts,
  useDeleteAccount,
  useSetAccountLocked,
} from '@/hooks/useAccounts';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmEmployee } from '@/services/api/employees';
import type { EpmAccount } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

/**
 * People, and where they sit.
 *
 * Not an employee directory in the HR sense: nobody is created, removed or
 * renamed here. Identity belongs to OpenProject, and the only thing this page
 * writes is the mapping onto EPM's departments and teams.
 *
 * Everyone who is signed in can read it. Assigning needs `employees:manage`,
 * which the backend checks on every write regardless of what is rendered.
 */

const ALL = '__all__';

export default function EmployeesPage() {
  const { can } = useAuth();
  const mayManage = can('employees:manage');

  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState(ALL);
  const [teamId, setTeamId] = useState(ALL);

  // Typing should not fire a request per keystroke.
  const q = useDebounce(search, 250);

  const employees = useEmployees({
    q: q || undefined,
    departmentId: departmentId === ALL ? undefined : departmentId,
    teamId: teamId === ALL ? undefined : teamId,
  });
  const departments = useDepartments();
  const teams = useTeams();
  const users = useUserMap();

  const [editing, setEditing] = useState<EpmEmployee>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);

  // Account management is a separate permission from placing people, and the
  // directory upstream is admin-only — so this is fetched only when the caller
  // can manage, and a 403 simply leaves the account columns absent.
  const mayManageAccounts = can('users:manage');
  const accounts = useAccounts(mayManageAccounts);
  const setLocked = useSetAccountLocked();
  const deleteAccount = useDeleteAccount();

  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EpmAccount>();
  const [removing, setRemoving] = useState<EpmAccount>();

  const accountById = new Map((accounts.data ?? []).map((account) => [account.id, account]));

  const openCreate = () => {
    setEditingAccount(undefined);
    setAccountOpen(true);
  };

  const openAccount = (account: EpmAccount) => {
    setEditingAccount(account);
    setAccountOpen(true);
  };

  const toggleLocked = (account: EpmAccount) => {
    const locked = account.status !== 'locked';

    setLocked.mutate(
      { id: account.id, locked },
      {
        onSuccess: () =>
          toast.success(locked ? `${account.name} deactivated` : `${account.name} reactivated`),
        onError: (error) =>
          toast.error('That could not be changed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const confirmRemove = () => {
    if (!removing) return;
    const name = removing.name;

    deleteAccount.mutate(removing.id, {
      onSuccess: () => {
        toast.success(`${name} was deleted`);
        setRemoving(undefined);
      },
      onError: (error) =>
        toast.error('That could not be deleted', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const openEdit = (employee: EpmEmployee) => {
    setEditing(employee);
    setDialogOpen(true);
  };

  const openCapacity = (employee: EpmEmployee) => {
    setEditing(employee);
    setCapacityOpen(true);
  };

  const items = employees.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employees"
        description="Where each person sits in the organisation."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                placeholder="Search people"
                aria-label="Search employees"
                className="w-52 pl-8"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger className="w-48" aria-label="Filter by department">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {(departments.data ?? []).map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger className="w-44" aria-label="Filter by team">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All teams</SelectItem>
                {(teams.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {mayManageAccounts ? (
              <Button size="sm" onClick={openCreate}>
                <UserPlus className="h-3.5 w-3.5" />
                Add person
              </Button>
            ) : null}
          </div>
        }
      />

      <QueryBoundary
        isLoading={employees.isLoading}
        isError={employees.isError}
        onRetry={() => employees.refetch()}
        errorTitle="Unable to load employees"
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        }
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRound}
            title={q || departmentId !== ALL || teamId !== ALL ? 'Nobody matches' : 'No people'}
            description={
              q || departmentId !== ALL || teamId !== ALL
                ? 'Try a different search or filter.'
                : 'People appear here once they have an account.'
            }
          />
        }
      >
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">Capacity</TableHead>
                  {mayManageAccounts ? <TableHead>Account</TableHead> : null}
                  {mayManage || mayManageAccounts ? <TableHead className="w-44" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {/* The name comes from the backend; the directory is
                            only consulted for the avatar. */}
                        <UserAvatar user={users.get(employee.id)} size="xs" />
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">{employee.name}</p>
                          {employee.email ? (
                            <p className="truncate text-2xs text-muted-foreground">
                              {employee.email}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="text-2xs">
                      {employee.department ? (
                        <span className="flex items-center gap-1.5">
                          {employee.department.name}
                          {/* A mapping outlives its department's archival. */}
                          {employee.department.active ? null : (
                            <Badge tone="warning" className="text-2xs">
                              Archived
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>

                    <TableCell className="text-2xs">
                      {employee.team ? (
                        <span className="flex items-center gap-1.5">
                          <Users className="h-3 w-3 text-muted-foreground" aria-hidden />
                          {employee.team.name}
                          {employee.team.active ? null : (
                            <Badge tone="warning" className="text-2xs">
                              Archived
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>

                    <TableCell className="text-right font-mono text-2xs tabular-nums">
                      {employee.hoursCapacity} h
                      <span className="text-muted-foreground">/wk</span>
                    </TableCell>

                    {mayManageAccounts ? (
                      <TableCell>
                        {/* Absent rather than guessed: someone who is in the
                            directory but not in the admin listing has no
                            account state this caller may read. */}
                        {accountById.get(employee.id) ? (
                          <Badge
                            tone={
                              accountById.get(employee.id)!.status === 'active'
                                ? 'success'
                                : accountById.get(employee.id)!.status === 'locked'
                                  ? 'danger'
                                  : 'warning'
                            }
                            className="text-2xs capitalize"
                          >
                            {accountById.get(employee.id)!.status}
                          </Badge>
                        ) : (
                          <span className="text-2xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    ) : null}

                    {mayManage || mayManageAccounts ? (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {mayManage ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Assign ${employee.name}`}
                                onClick={() => openEdit(employee)}
                              >
                                Assign
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Set capacity for ${employee.name}`}
                                onClick={() => openCapacity(employee)}
                              >
                                Capacity
                              </Button>
                            </>
                          ) : null}

                          {/* The three account actions live behind one menu.
                              Five controls in a narrow cell read as clutter,
                              and these are a different kind of thing from the
                              two above: those place a person in EPM, these
                              change their sign-in account.

                              Each item still appears only where the backend
                              published the affordance for this very account —
                              an invited person cannot be locked, a locked one
                              cannot be locked again, and deletion is absent
                              unless the instance allows it at all. */}
                          {(() => {
                            const account = accountById.get(employee.id);
                            if (!account) return null;

                            const { update, lock, unlock, remove } = account.can;
                            if (!update && !lock && !unlock && !remove) return null;

                            return (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`Account actions for ${employee.name}`}
                                  >
                                    <Ellipsis className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {update ? (
                                    <DropdownMenuItem onSelect={() => openAccount(account)}>
                                      <Pencil />
                                      Edit details
                                    </DropdownMenuItem>
                                  ) : null}

                                  {lock || unlock ? (
                                    <DropdownMenuItem onSelect={() => toggleLocked(account)}>
                                      {unlock ? <Unlock /> : <Lock />}
                                      {unlock ? 'Reactivate' : 'Deactivate'}
                                    </DropdownMenuItem>
                                  ) : null}

                                  {remove ? (
                                    <DropdownMenuItem
                                      destructive
                                      onSelect={() => setRemoving(account)}
                                    >
                                      <Trash2 />
                                      Delete permanently
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            );
                          })()}
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </QueryBoundary>

      <MappingDialog open={dialogOpen} onOpenChange={setDialogOpen} employee={editing} />
      <CapacityDialog open={capacityOpen} onOpenChange={setCapacityOpen} employee={editing} />
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} account={editingAccount} />

      {/* Deletion is permanent and OpenProject processes it in the background,
          so it is confirmed and says plainly what goes with it. Deactivating
          is the reversible alternative, and is named here. */}
      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              This removes their account permanently, along with their
              department, team and capacity in EPM. It cannot be undone. To keep their history
              and stop them signing in, deactivate them instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoving(undefined)}
              disabled={deleteAccount.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={deleteAccount.isPending}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
