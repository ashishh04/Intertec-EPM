import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MailWarning, UserPlus, UserRound } from 'lucide-react';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAccounts } from '@/hooks/useAccounts';
import { useAdminEmailStatus, useAdminInvitations, useAdminUserLogins } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { t } from '@/lib/i18n';
import { formatDateTime, formatLongDate } from '@/lib/utils';
import type { AccountStatus, EpmAccount } from '@/types';
import {
  AccountActionsMenu,
  InvitationNote,
  STATUS_LABEL,
  STATUS_TONE,
  useAccountActions,
  userProfilePath,
} from './shared-accounts';
import { AdminPagination, AdminTable, CheckCell } from './shared-tables';
import { UserProfile } from './UserProfile';

/**
 * Users, shaped like OpenProject's Users administration page: a status filter
 * with counts, a name filter, and one row per account with the actions the
 * backend publishes for it. A person's name or email opens their profile,
 * `/admin/users/users/:id`, rather than a mail program.
 *
 * Every write goes through the same hooks the Employees page uses, so the two
 * surfaces can never disagree about what an account may have done to it.
 */

const ALL = '__all__';

type StatusFilter = typeof ALL | AccountStatus;

/** The filter options in OpenProject's order. Registered is rare, so it appears only when present. */
const STATUS_ORDER: AccountStatus[] = ['active', 'invited', 'locked', 'registered'];

export default function UsersPage() {
  const { itemId } = useParams<{ itemId?: string }>();
  return itemId ? <UserProfile id={itemId} /> : <UsersList />;
}

function UsersList() {
  const accounts = useAccounts(true);
  const logins = useAdminUserLogins();
  const invitations = useAdminInvitations();
  const email = useAdminEmailStatus();
  const actions = useAccountActions();

  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [name, setName] = useState('');

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);

  const lastLogin = useMemo(
    () => new Map((logins.data ?? []).map((login) => [login.id, login.lastLoginAt])),
    [logins.data],
  );
  const invitationOf = useMemo(
    () => new Map((invitations.data ?? []).map((invitation) => [invitation.id, invitation])),
    [invitations.data],
  );

  // Read apart from the accounts, so the list never waits on it: until it
  // arrives the column is blank, and if it cannot be read it says so once.
  const lastLoginOf = (account: EpmAccount) => {
    if (logins.isError) return t('Not available');
    if (!logins.data) return '';
    const at = lastLogin.get(account.id);
    return at ? formatDateTime(at) : t('Never');
  };

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

  return (
    <div className="space-y-4">
      {email.data?.delivery === 'none' ? (
        <Alert tone="warning" icon={MailWarning} title={t('Email is not set up on this server')}>
          {t('Invitations and email notifications cannot be delivered until the server’s mail settings are added. Until then, create users with a temporary password.')}
        </Alert>
      ) : null}

      <ListToolbar
        trailing={
          <>
            <ResultCount count={items.length} total={all.length} label={t('user')} plural={t('users')} />
            <Button size="sm" onClick={actions.openCreate}>
              <UserPlus className="h-3.5 w-3.5" />
              {t('Add user')}
            </Button>
          </>
        }
      >
        <SearchInput
          value={name}
          onValueChange={setName}
          placeholder={t('Filter by name')}
          aria-label={t('Filter users by name')}
        />
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label={t('Filter by status')}>
            <SelectValue placeholder={t('All statuses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('All ({count, number})', { count: all.length })}</SelectItem>
            {STATUS_ORDER.filter((key) => key !== 'registered' || counts.registered > 0).map(
              (key) => (
                <SelectItem key={key} value={key}>
                  {t('{status} ({count, number})', { status: STATUS_LABEL[key], count: counts[key] })}
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
        errorTitle={t('Unable to load users')}
        skeleton={<TableSkeleton columns={9} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRound}
            title={filtering ? t('No users match') : t('No users')}
            description={
              filtering
                ? t('Try a different status or name.')
                : t('Users appear here once they have an account.')
            }
            action={filtering ? undefined : { label: t('Add user'), onClick: actions.openCreate }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel={t('user')} itemLabelPlural={t('users')} />}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Username')}</TableHead>
              <TableHead>{t('First name')}</TableHead>
              <TableHead>{t('Last name')}</TableHead>
              <TableHead>{t('Email')}</TableHead>
              <TableHead>{t('Administrator')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Created on')}</TableHead>
              <TableHead>{t('Last login')}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-mono text-2xs">
                  <Link
                    to={userProfilePath(account.id)}
                    className="rounded text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {account.login}
                  </Link>
                </TableCell>
                <TableCell dir="auto">{account.firstName}</TableCell>
                <TableCell dir="auto">{account.lastName}</TableCell>
                <TableCell>
                  {account.email ? (
                    <Link
                      to={userProfilePath(account.id)}
                      className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {account.email}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{'—'}</span>
                  )}
                </TableCell>
                <TableCell>
                  <CheckCell value={account.admin} label={t('Administrator')} />
                </TableCell>
                <TableCell>
                  <Badge tone={STATUS_TONE[account.status]} size="sm">
                    {STATUS_LABEL[account.status]}
                  </Badge>
                  <InvitationNote invitation={invitationOf.get(account.id)} className="mt-1" />
                </TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  {formatLongDate(account.createdAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  {lastLoginOf(account)}
                </TableCell>
                <TableCell className="text-end">
                  <AccountActionsMenu account={account} actions={actions} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      {actions.dialogs}
    </div>
  );
}
