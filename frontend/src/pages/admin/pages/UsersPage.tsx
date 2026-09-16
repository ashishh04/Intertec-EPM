import { useMemo, useState } from 'react';
import { Ellipsis, Lock, Mail, Pencil, Trash2, Unlock, UserPlus, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { AccountDialog } from '@/components/employees/AccountDialog';
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
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useAccounts,
  useDeleteAccount,
  useResendInvite,
  useSetAccountLocked,
} from '@/hooks/useAccounts';
import { usePagination } from '@/hooks/usePagination';
import type { Tone } from '@/lib/domain';
import { formatLongDate, formatNumber } from '@/lib/utils';
import type { AccountStatus, EpmAccount } from '@/types';
import { AdminPagination, AdminTable, CheckCell } from './shared-tables';

/**
 * Users, shaped like OpenProject's Users administration page: a status filter
 * with counts, a name filter, and one row per account with the actions the
 * backend publishes for it.
 *
 * Every write goes through the same hooks the Employees page uses, so the two
 * surfaces can never disagree about what an account may have done to it.
 */

const ALL = '__all__';

type StatusFilter = typeof ALL | AccountStatus;

const STATUS_LABEL: Record<AccountStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  registered: 'Registered',
  locked: 'Locked',
};

const STATUS_TONE: Record<AccountStatus, Tone> = {
  active: 'success',
  invited: 'warning',
  registered: 'warning',
  locked: 'danger',
};

/** The filter options in OpenProject's order. Registered is rare, so it appears only when present. */
const STATUS_ORDER: AccountStatus[] = ['active', 'invited', 'locked', 'registered'];

export default function UsersPage() {
  const accounts = useAccounts(true);
  const setLocked = useSetAccountLocked();
  const deleteAccount = useDeleteAccount();
  const resendInvite = useResendInvite();

  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [name, setName] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EpmAccount>();
  const [removing, setRemoving] = useState<EpmAccount>();

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);

  const counts = useMemo(() => {
    const tally: Record<AccountStatus, number> = { active: 0, invited: 0, registered: 0, locked: 0 };
    for (const account of all) tally[account.status] += 1;
    return tally;
  }, [all]);

  const items = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return all
      .filter((account) => status === ALL || account.status === status)
      .filter((account) => {
        if (!needle) return true;
        return [account.login, account.firstName, account.lastName, account.name, account.email]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(needle));
      })
      .sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }));
  }, [all, status, name]);

  const filtering = status !== ALL || name.trim() !== '';
  const paging = usePagination(items, { pageSize: 25, resetKey: `${status}|${name}` });

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (account: EpmAccount) => {
    setEditing(account);
    setDialogOpen(true);
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

  const confirmRemove = () => {
    if (!removing) return;
    const label = removing.name;

    deleteAccount.mutate(removing.id, {
      onSuccess: () => {
        toast.success(`${label} was deleted`);
        setRemoving(undefined);
      },
      onError: (error) =>
        toast.error('That could not be deleted', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <div className="space-y-4">
      <ListToolbar
        trailing={
          <>
            <ResultCount count={items.length} total={all.length} label="user" />
            <Button size="sm" onClick={openCreate}>
              <UserPlus className="h-3.5 w-3.5" />
              Add user
            </Button>
          </>
        }
      >
        <SearchInput
          value={name}
          onValueChange={setName}
          placeholder="Filter by name"
          aria-label="Filter users by name"
        />
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All ({formatNumber(all.length)})</SelectItem>
            {STATUS_ORDER.filter((key) => key !== 'registered' || counts.registered > 0).map(
              (key) => (
                <SelectItem key={key} value={key}>
                  {STATUS_LABEL[key]} ({formatNumber(counts[key])})
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </ListToolbar>

      <QueryBoundary
        isLoading={accounts.isLoading}
        isError={accounts.isError}
        error={accounts.error}
        onRetry={() => accounts.refetch()}
        errorTitle="Unable to load users"
        skeleton={<TableSkeleton columns={8} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRound}
            title={filtering ? 'No users match' : 'No users'}
            description={
              filtering
                ? 'Try a different status or name.'
                : 'Users appear here once they have an account.'
            }
            action={filtering ? undefined : { label: 'Add user', onClick: openCreate }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="user" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>First name</TableHead>
              <TableHead>Last name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Administrator</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created on</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((account) => {
              const { update, lock, unlock, remove } = account.can;
              const hasActions = update || lock || unlock || remove;

              return (
                <TableRow key={account.id}>
                  <TableCell className="font-mono text-2xs">{account.login}</TableCell>
                  <TableCell>{account.firstName}</TableCell>
                  <TableCell>{account.lastName}</TableCell>
                  <TableCell>
                    {account.email ? (
                      <a
                        href={`mailto:${account.email}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {account.email}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{'—'}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <CheckCell value={account.admin} label="Administrator" />
                  </TableCell>
                  <TableCell>
                    <Badge tone={STATUS_TONE[account.status]} size="sm">
                      {STATUS_LABEL[account.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                    {formatLongDate(account.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {hasActions ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Actions for ${account.name}`}
                          >
                            <Ellipsis className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {update ? (
                            <DropdownMenuItem onSelect={() => openEdit(account)}>
                              <Pencil />
                              Edit
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

                          {remove ? (
                            <DropdownMenuItem destructive onSelect={() => setRemoving(account)}>
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <AccountDialog open={dialogOpen} onOpenChange={setDialogOpen} account={editing} />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              This removes their account permanently, along with their department, team and
              capacity in EPM. It cannot be undone. To keep their history and stop them signing
              in, deactivate them instead.
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
            <Button
              variant="danger"
              onClick={confirmRemove}
              loading={deleteAccount.isPending}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
