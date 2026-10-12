import { useState, type ReactNode } from 'react';
import { Ellipsis, ListChecks, Lock, Mail, Pencil, Trash2, Unlock } from 'lucide-react';
import { toast } from 'sonner';

import { AccountDialog } from '@/components/employees/AccountDialog';
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
import { useDeleteAccount, useResendInvite, useSetAccountLocked } from '@/hooks/useAccounts';
import type { Tone } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { cn, formatLongDate } from '@/lib/utils';
import type { AdminInvitation } from '@/services/api/admin';
import type { AccountStatus, EpmAccount } from '@/types';
import { describeError } from './shared-format';
import { UserAttributesDialog } from './UserAttributesDialog';

/**
 * What the Users list and a person's profile share: the words for an account's
 * state, its invitation, and every action an account offers — with the dialogs
 * those actions open — so the two never disagree about what can be done.
 */

export const STATUS_LABEL: Record<AccountStatus, string> = {
  get active() { return t('Active'); },
  get invited() { return t('Invited'); },
  get registered() { return t('Registered'); },
  get locked() { return t('Locked'); },
};

export const STATUS_TONE: Record<AccountStatus, Tone> = {
  active: 'success',
  invited: 'warning',
  registered: 'warning',
  locked: 'danger',
};

/** The profile of one person, inside the Users page. */
export const userProfilePath = (id: string) => `/admin/users/users/${id}`;

/** An invitation link lives this long; a sent one older than that is history. */
const INVITATION_DAYS = 7;

/**
 * One line on what became of someone's latest invitation, or nothing when there
 * is nothing to act on: never invited, or delivered longer ago than its link
 * lasts.
 */
export function InvitationNote({
  invitation,
  className,
  history = false,
}: {
  invitation?: AdminInvitation;
  className?: string;
  /** On a profile: say when it was sent however long ago. */
  history?: boolean;
}) {
  if (!invitation || invitation.status === 'cancelled') return null;

  if (invitation.status === 'sent') {
    const sentAt = invitation.sentAt ?? invitation.queuedAt;
    const expired = Date.now() - new Date(sentAt).getTime() > INVITATION_DAYS * 24 * 60 * 60 * 1000;
    if (expired && !history) return null;
    return (
      <p className={cn('text-2xs text-muted-foreground', className)}>
        {t('Invitation sent {date}', { date: formatLongDate(sentAt) })}
      </p>
    );
  }

  if (invitation.status === 'failed') {
    return (
      <p className={cn('text-2xs font-medium text-danger', className)} title={invitation.error ?? undefined}>
        {t('Invitation not delivered')}
      </p>
    );
  }

  // Queued or being sent. An error on a queued row is a refusal that will be
  // tried again, which is worth saying while it is still on its way.
  return (
    <p
      className={cn('text-2xs', invitation.error ? 'text-warning' : 'text-muted-foreground', className)}
      title={invitation.error ?? undefined}
    >
      {invitation.error ? t('Invitation retrying') : t('Invitation on its way')}
    </p>
  );
}

/**
 * Every account action, with the dialogs it needs. Render `dialogs` once
 * wherever the hook is used.
 */
export function useAccountActions({ onRemoved }: { onRemoved?: () => void } = {}) {
  const setLocked = useSetAccountLocked();
  const deleteAccount = useDeleteAccount();
  const resendInvite = useResendInvite();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EpmAccount>();
  const [removing, setRemoving] = useState<EpmAccount>();
  const [attributesFor, setAttributesFor] = useState<EpmAccount>();

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
          toast.success(
            locked
              ? t('{name} deactivated', { name: account.name })
              : t('{name} reactivated', { name: account.name }),
          ),
        onError: (error) => toast.error(t('That could not be changed'), { description: describeError(error) }),
      },
    );
  };

  // Nothing to confirm: another email is cheap, and the old link simply stops
  // working. Only what actually happened is said: queued is not delivered,
  // and the list shows delivery once the outbox knows.
  const sendInvitation = (account: EpmAccount) => {
    resendInvite.mutate(account.id, {
      onSuccess: (result) =>
        result.inviteSent
          ? toast.success(t('Invitation queued for {email}', { email: account.email }), {
              description: t('Its delivery is shown in the users list.'),
            })
          : toast.warning(t('The invitation was not sent'), {
              description: t('Nothing was queued: they have no email address, or have turned email off.'),
            }),
      onError: (error) => toast.error(t('The invitation could not be sent'), { description: describeError(error) }),
    });
  };

  const confirmRemove = () => {
    if (!removing) return;
    const label = removing.name;

    deleteAccount.mutate(removing.id, {
      onSuccess: () => {
        toast.success(t('{name} was deleted', { name: label }));
        setRemoving(undefined);
        onRemoved?.();
      },
      onError: (error) => toast.error(t('That could not be deleted'), { description: describeError(error) }),
    });
  };

  const dialogs: ReactNode = (
    <>
      <AccountDialog open={dialogOpen} onOpenChange={setDialogOpen} account={editing} />

      <UserAttributesDialog
        account={attributesFor}
        onOpenChange={(open) => !open && setAttributesFor(undefined)}
      />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Delete {name}?', { name: removing?.name })}</DialogTitle>
            <DialogDescription>
              {t(
                'This removes their account permanently, along with their department, team and capacity in EPM. It cannot be undone. To keep their history and stop them signing in, deactivate them instead.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={deleteAccount.isPending}>
              {t('Cancel')}
            </Button>
            <Button variant="danger" onClick={confirmRemove} loading={deleteAccount.isPending}>
              {t('Delete permanently')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    openCreate,
    openEdit,
    openAttributes: setAttributesFor,
    toggleLocked,
    sendInvitation,
    askRemove: setRemoving,
    dialogs,
  };
}

export type AccountActions = ReturnType<typeof useAccountActions>;

/** The ⋯ menu of one account: what the backend says may be done to it. */
export function AccountActionsMenu({
  account,
  actions,
  include = 'all',
}: {
  account: EpmAccount;
  actions: AccountActions;
  /** On a profile, Edit and Attributes are buttons of their own. */
  include?: 'all' | 'more';
}) {
  const { update, lock, unlock, remove } = account.can;
  const items = [
    include === 'all' && update ? 'edit' : null,
    include === 'all' && update ? 'attributes' : null,
    update ? 'invite' : null,
    lock || unlock ? 'lock' : null,
    remove ? 'remove' : null,
  ].filter(Boolean);
  if (items.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={t('Actions for {name}', { name: account.name })}>
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {include === 'all' && update ? (
          <DropdownMenuItem onSelect={() => actions.openEdit(account)}>
            <Pencil />
            {t('Edit')}
          </DropdownMenuItem>
        ) : null}

        {include === 'all' && update ? (
          <DropdownMenuItem onSelect={() => actions.openAttributes(account)}>
            <ListChecks />
            {t('Attributes')}
          </DropdownMenuItem>
        ) : null}

        {update ? (
          <DropdownMenuItem onSelect={() => actions.sendInvitation(account)}>
            <Mail />
            {t('Resend invitation')}
          </DropdownMenuItem>
        ) : null}

        {lock || unlock ? (
          <DropdownMenuItem onSelect={() => actions.toggleLocked(account)}>
            {unlock ? <Unlock /> : <Lock />}
            {unlock ? t('Reactivate') : t('Deactivate')}
          </DropdownMenuItem>
        ) : null}

        {remove ? (
          <DropdownMenuItem destructive onSelect={() => actions.askRemove(account)}>
            <Trash2 />
            {t('Delete')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
