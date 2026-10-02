import { useState } from 'react';
import {
  Ellipsis,
  Lock,
  Mail,
  Pencil,
  Trash2,
  Unlock,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';

import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { AccountDialog } from '@/components/employees/AccountDialog';
import { RemovePersonDialog } from '@/components/employees/RemovePersonDialog';
import { StaffingDialog } from '@/components/employees/StaffingDialog';
import { MappingDialog } from '@/components/employees/MappingDialog';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDebounce } from '@/hooks/useDebounce';
import { useAccounts, useResendInvite, useSetAccountLocked } from '@/hooks/useAccounts';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { usePagination } from '@/hooks/usePagination';
import { useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import type { Tone } from '@/lib/domain';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { env } from '@/config/env';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmEmployee } from '@/services/api/employees';
import type { AccountStatus, EpmAccount, ID } from '@/types';
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

const PAGE_SIZE = 25;

// Locked is the one state that stops someone signing in; the two pre-active
// states are pending rather than wrong, so they share the warning tone.
const ACCOUNT_STATUS_TONE: Record<AccountStatus, Tone> = {
  active: 'success',
  invited: 'warning',
  registered: 'warning',
  locked: 'danger',
};

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
  const [staffingOpen, setStaffingOpen] = useState(false);

  // Account management is a separate permission from placing people, and the
  // directory upstream is admin-only — so this is fetched only when the caller
  // can manage, and a 403 simply leaves the account columns absent.
  const mayManageAccounts = can('users:manage');
  const accounts = useAccounts(mayManageAccounts);
  const setLocked = useSetAccountLocked();
  const resendInvite = useResendInvite();

  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EpmAccount>();
  // The account being offboarded. Held rather than passed straight through,
  // because the staged dialog re-reads it from the refreshed list after each
  // step so the next step sees the new status.
  const [removingId, setRemovingId] = useState<ID>();

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

  // Nothing to confirm: another email is cheap, and the old link simply stops
  // working.
  const sendInvitation = (account: EpmAccount) => {
    resendInvite.mutate(account.id, {
      onSuccess: () => toast.success(`Invitation sent to ${account.email}`),
      onError: (error) =>
        toast.error('The invitation could not be sent', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const openEdit = (employee: EpmEmployee) => {
    setEditing(employee);
    setDialogOpen(true);
  };

  const openStaffing = (employee: EpmEmployee) => {
    setEditing(employee);
    setStaffingOpen(true);
  };

  const items = employees.data ?? [];

  // The search and filters are applied server-side; only the page is local,
  // and it returns to the first page whenever the query behind it changes.
  const paged = usePagination(items, {
    pageSize: PAGE_SIZE,
    resetKey: `${q}|${departmentId}|${teamId}`,
  });

  const filtered = Boolean(q) || departmentId !== ALL || teamId !== ALL;

  // The skeleton mirrors the real table, so the optional columns count too.
  const columnCount =
    4 + (mayManageAccounts ? 1 : 0) + (mayManage || mayManageAccounts ? 1 : 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employees"
        description="Where each person sits in the organisation."
        actions={
          mayManageAccounts ? (
            <Button size="sm" onClick={openCreate}>
              <UserPlus className="h-3.5 w-3.5" />
              Add person
            </Button>
          ) : null
        }
      />

      <ListToolbar trailing={<ResultCount count={items.length} label="person" plural="people" />}>
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search people"
          aria-label="Search employees"
        />

        <Select value={departmentId} onValueChange={setDepartmentId}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by department">
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
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by team">
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
      </ListToolbar>

      <QueryBoundary
        isLoading={employees.isLoading}
        isError={employees.isError}
        onRetry={() => employees.refetch()}
        errorTitle="Unable to load employees"
        skeleton={<TableSkeleton columns={columnCount} rows={8} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRound}
            title={filtered ? 'Nobody matches' : 'No people'}
            description={
              filtered
                ? 'Try a different search or filter.'
                : 'People appear here once they have an account.'
            }
          />
        }
      >
        <TableCard
          footer={
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              onPageSizeChange={paged.setPageSize}
              itemLabel="person"
              itemLabelPlural="people"
            />
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Team</TableHead>
                <TableHead numeric>Capacity</TableHead>
                <TableHead numeric>Rate</TableHead>
                {mayManageAccounts ? <TableHead>Account</TableHead> : null}
                {mayManage || mayManageAccounts ? <TableHead className="w-44" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.items.map((employee) => (
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
                          <Badge tone="warning" size="sm">
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
                          <Badge tone="warning" size="sm">
                            Archived
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>

                  <TableCell numeric>
                    {formatNumber(employee.hoursCapacity)} h
                    <span className="text-muted-foreground">/wk</span>
                  </TableCell>

                  {/* Absent rather than zero: nobody has costed this person, and
                      Time & Costs reports their hours as uncosted rather than
                      pricing them at nothing. */}
                  <TableCell numeric>
                    {employee.hourlyRate === undefined ? (
                      <span className="text-muted-foreground" title="Not costed">
                        &mdash;
                      </span>
                    ) : (
                      <>
                        {formatCurrency(employee.hourlyRate, env.currency, 2)}
                        <span className="text-muted-foreground">/h</span>
                      </>
                    )}
                  </TableCell>

                  {mayManageAccounts ? (
                    <TableCell>
                      {/* Absent rather than guessed: someone who is in the
                          directory but not in the admin listing has no
                          account state this caller may read. */}
                      {(() => {
                        const account = accountById.get(employee.id);
                        if (!account) {
                          return <span className="text-2xs text-muted-foreground">—</span>;
                        }
                        return (
                          <Badge
                            tone={ACCOUNT_STATUS_TONE[account.status]}
                            size="sm"
                            dot
                            className="capitalize"
                          >
                            {account.status}
                          </Badge>
                        );
                      })()}
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
                              aria-label={`Set staffing for ${employee.name}`}
                              onClick={() => openStaffing(employee)}
                            >
                              Staffing
                            </Button>
                          </>
                        ) : null}

                        {/* The account actions live behind one menu.
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

                          const { update, lock, unlock } = account.can;

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

                                {update ? (
                                  <DropdownMenuItem onSelect={() => sendInvitation(account)}>
                                    <Mail />
                                    Resend invitation
                                  </DropdownMenuItem>
                                ) : null}

                                {lock || unlock ? (
                                  <DropdownMenuItem onSelect={() => toggleLocked(account)}>
                                    {unlock ? <Unlock /> : <Lock />}
                                    {unlock ? 'Reactivate' : 'Deactivate'}
                                  </DropdownMenuItem>
                                ) : null}

                                {/* Offered whether or not the instance allows
                                    deletion: the first two steps of removing
                                    somebody — deactivate, then revoke — need
                                    no upstream affordance, and the dialog
                                    explains the third rather than hiding it. */}
                                <DropdownMenuItem
                                  destructive
                                  onSelect={() => setRemovingId(account.id)}
                                >
                                  <Trash2 />
                                  Remove person…
                                </DropdownMenuItem>
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
        </TableCard>
      </QueryBoundary>

      <MappingDialog open={dialogOpen} onOpenChange={setDialogOpen} employee={editing} />
      <StaffingDialog open={staffingOpen} onOpenChange={setStaffingOpen} employee={editing} />
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} account={editingAccount} />

      {/* Removing somebody is deactivate, then revoke, then delete — each one
          a real step with its own outcome, rather than one confirmation that
          either works or is missing entirely. The account is read from the
          live list by id so each step sees the status the last one left. */}
      <RemovePersonDialog
        open={Boolean(removingId)}
        onOpenChange={(open) => !open && setRemovingId(undefined)}
        account={removingId ? accountById.get(removingId) : undefined}
      />
    </div>
  );
}
