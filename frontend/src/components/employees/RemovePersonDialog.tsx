import { useEffect, useState } from 'react';
import { Check, Loader2, Lock, ShieldOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
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
import { cn } from '@/lib/utils';
import { useDeleteAccount, useRevokeAccess, useSetAccountLocked } from '@/hooks/useAccounts';
import type { AccountRevocation, EpmAccount } from '@/types';

/**
 * Offboarding, in the order it should happen.
 *
 * Removing somebody used to be a single destructive menu item that was simply
 * absent whenever OpenProject withheld the `delete` affordance — which is the
 * default for an instance — so an administrator trying to remove a leaver saw
 * no way to do it and no reason why. The steps below are the actual sequence,
 * made visible:
 *
 *   1. Deactivate   they cannot sign in. Reversible, and usually enough.
 *   2. Revoke       sessions ended, off every project, admin dropped.
 *   3. Delete       the account itself, permanently.
 *
 * Each step runs on its own and reports what it did, so stopping after step 1
 * or step 2 is a legitimate outcome rather than an abandoned wizard. The order
 * is enforced downwards only — a later step stays disabled until the ones
 * before it are done — because deleting an account that still holds live
 * sessions and project memberships is how access gets left behind.
 *
 * Step 3 is shown even where the instance forbids it, with the reason and the
 * setting to change. An action that is missing teaches nobody anything; one
 * that explains itself is how an administrator finds out the switch exists.
 */

type StepState = 'done' | 'ready' | 'blocked' | 'running';

interface StepProps {
  index: number;
  icon: typeof Lock;
  title: string;
  body: string;
  state: StepState;
  /** Shown under the body once the step has done something. */
  outcome?: string;
  /** Why the step cannot run. Only read when `state` is `blocked`. */
  reason?: string;
  action: string;
  destructive?: boolean;
  onRun: () => void;
}

function Step({
  index,
  icon: Icon,
  title,
  body,
  state,
  outcome,
  reason,
  action,
  destructive,
  onRun,
}: StepProps) {
  const done = state === 'done';

  return (
    <li className="flex gap-3.5">
      {/* The rail: a numbered chip per step, ticked once that step is done, so
          progress is legible without reading a word of the copy. */}
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <span
          className={cn(
            'grid h-7 w-7 shrink-0 place-items-center rounded-full text-2xs font-semibold',
            done
              ? 'bg-success text-success-foreground'
              : state === 'blocked'
                ? 'bg-muted text-muted-foreground'
                : 'bg-brand-diagonal text-white',
          )}
        >
          {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : index}
        </span>
        {index < 3 ? <span aria-hidden className="w-px flex-1 bg-border" /> : null}
      </div>

      <div className="min-w-0 flex-1 pb-5">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-xs font-medium">{title}</p>
          {done ? (
            <Badge tone="success" size="sm">
              Done
            </Badge>
          ) : null}
        </div>

        <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">{body}</p>

        {outcome ? <p className="mt-1.5 text-2xs text-success-strong">{outcome}</p> : null}

        {state === 'blocked' && reason ? (
          <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">{reason}</p>
        ) : null}

        {done ? null : (
          <Button
            size="sm"
            variant={destructive ? 'danger' : 'secondary'}
            className="mt-2.5"
            disabled={state !== 'ready'}
            onClick={onRun}
          >
            {state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {action}
          </Button>
        )}
      </div>
    </li>
  );
}

/** What a revocation actually did, as a sentence. Only the parts that happened. */
function describe(revocation: AccountRevocation): string {
  const parts: string[] = [];

  if (revocation.sessionsEnded > 0) {
    parts.push(
      `${revocation.sessionsEnded} session${revocation.sessionsEnded === 1 ? '' : 's'} ended`,
    );
  }
  if (revocation.membershipsRemoved > 0) {
    parts.push(
      `removed from ${revocation.membershipsRemoved} project${
        revocation.membershipsRemoved === 1 ? '' : 's'
      }`,
    );
  }
  if (revocation.adminRevoked) parts.push('administrator rights removed');

  // Nothing to report is itself the answer: they held nothing to take away.
  return parts.length > 0
    ? `${parts.join(', ')}.`
    : 'They held no sessions, memberships or administrator rights.';
}

interface RemovePersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: EpmAccount;
}

export function RemovePersonDialog({ open, onOpenChange, account }: RemovePersonDialogProps) {
  const setLocked = useSetAccountLocked();
  const revokeAccess = useRevokeAccess();
  const deleteAccount = useDeleteAccount();

  // What a revocation did cannot be read back from anywhere — memberships that
  // are gone leave no record saying they were taken — so it is held for as long
  // as the dialog is open, and the step is offered again on reopening.
  const [revoked, setRevoked] = useState<AccountRevocation>();
  const [problem, setProblem] = useState<string>();

  // Keyed on the id rather than the object: the account is a fresh object on
  // every refetch, and this runs after each step completes.
  useEffect(() => {
    if (!open) return;
    setRevoked(undefined);
    setProblem(undefined);
  }, [open, account?.id]);

  if (!account) return null;

  const deactivated = account.status === 'locked';
  const busy = setLocked.isPending || revokeAccess.isPending || deleteAccount.isPending;

  const fail = (error: unknown) =>
    setProblem(error instanceof Error ? error.message : 'That could not be done.');

  const runDeactivate = () => {
    setProblem(undefined);
    setLocked.mutate(
      { id: account.id, locked: true },
      {
        onSuccess: () => toast.success(`${account.name} deactivated`),
        onError: fail,
      },
    );
  };

  const runRevoke = () => {
    setProblem(undefined);
    revokeAccess.mutate(account.id, {
      onSuccess: (result) => {
        setRevoked(result);
        if (result.problems?.length) {
          toast.warning('Access was only partly revoked', {
            description: result.problems.join(' '),
          });
        } else {
          toast.success('Access revoked', { description: describe(result) });
        }
      },
      onError: fail,
    });
  };

  const runDelete = () => {
    setProblem(undefined);
    deleteAccount.mutate(account.id, {
      onSuccess: () => {
        toast.success(`${account.name} was deleted`);
        onOpenChange(false);
      },
      onError: fail,
    });
  };

  // `can.lock` is absent on an invited account, which has no sign-in to stop —
  // so that step reports itself impossible rather than offering a button
  // upstream would refuse.
  const deactivateState: StepState = deactivated
    ? 'done'
    : setLocked.isPending
      ? 'running'
      : account.can.lock
        ? 'ready'
        : 'blocked';

  const revokeState: StepState = revoked
    ? 'done'
    : revokeAccess.isPending
      ? 'running'
      : deactivated
        ? 'ready'
        : 'blocked';

  const deleteState: StepState = deleteAccount.isPending
    ? 'running'
    : account.can.remove && deactivated && revoked
      ? 'ready'
      : 'blocked';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {account.name}</DialogTitle>
          <DialogDescription>
            Three steps, in order. You can stop after any of them — deactivating alone already
            prevents sign-in, and keeps their history intact.
          </DialogDescription>
        </DialogHeader>

        <div className="epm-dialog-body epm-scroll py-1 pr-1">
          <ol>
            <Step
              index={1}
              icon={Lock}
              title="Deactivate the account"
              body="They can no longer sign in. Reversible at any time from the account menu, and for most leavers this is as far as you need to go."
              state={deactivateState}
              reason="This account cannot be deactivated: an invitation that was never accepted has no sign-in to stop."
              outcome={deactivated ? 'They cannot sign in.' : undefined}
              action="Deactivate"
              onRun={runDeactivate}
            />

            <Step
              index={2}
              icon={ShieldOff}
              title="Revoke their access"
              body="Ends every browser session, removes them from every project, and takes away instance-administrator rights. Their work, comments and logged time stay where they are."
              state={revokeState}
              reason="Deactivate the account first."
              outcome={revoked ? describe(revoked) : undefined}
              action="Revoke access"
              onRun={runRevoke}
            />

            <Step
              index={3}
              icon={Trash2}
              title="Delete permanently"
              body="Removes the account itself, along with their department, team and capacity in EPM. This cannot be undone."
              state={deleteState}
              reason={
                account.can.remove
                  ? 'Complete the steps above first.'
                  : 'Deleting people is switched off for this instance. An administrator can turn on "Users deletable by admins" under Administration → Users and permissions → User settings. Steps 1 and 2 withdraw their access without it.'
              }
              action="Delete permanently"
              destructive
              onRun={runDelete}
            />
          </ol>

          {revoked?.problems?.length ? (
            <Alert tone="warning" className="mt-1">
              Some access could not be withdrawn: {revoked.problems.join(' ')}
            </Alert>
          ) : null}

          {problem ? (
            <Alert tone="danger" className="mt-1">
              {problem}
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {deactivated || revoked ? 'Done' : 'Cancel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
