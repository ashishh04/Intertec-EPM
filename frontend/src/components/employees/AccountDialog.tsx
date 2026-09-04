import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateAccount, useUpdateAccount } from '@/hooks/useAccounts';
import { useDepartments } from '@/hooks/useDepartments';
import { useTeams } from '@/hooks/useTeams';
import type { EpmAccount } from '@/types';

/**
 * Add a person, or edit their account details.
 *
 * Creating covers both systems: the account is made in OpenProject and the
 * department, team and capacity are written in EPM. That pairing is the point
 * — OpenProject's own form cannot ask for the last three, because it has no
 * such concepts.
 *
 * Editing covers the account only. Department, team and capacity already have
 * their own dialogs on this page, and duplicating them here would give two
 * places to change one thing.
 *
 * No password field, in either mode. A new account is created as *invited*, so
 * OpenProject mails the person and they set their own credentials — EPM never
 * sees, stores or transmits one.
 */

const NONE = '__none__';

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. Absent means create. */
  account?: EpmAccount;
}

export function AccountDialog({ open, onOpenChange, account }: AccountDialogProps) {
  const isEdit = Boolean(account);

  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();
  const departments = useDepartments();
  const teams = useTeams();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [login, setLogin] = useState('');
  const [admin, setAdmin] = useState(false);
  const [departmentId, setDepartmentId] = useState(NONE);
  const [teamId, setTeamId] = useState(NONE);
  const [capacity, setCapacity] = useState('40');
  const [problem, setProblem] = useState<string>();

  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setFirstName(account?.firstName ?? '');
    setLastName(account?.lastName ?? '');
    setEmail(account?.email ?? '');
    setLogin(account?.login ?? '');
    setAdmin(account?.admin ?? false);
    setDepartmentId(NONE);
    setTeamId(NONE);
    setCapacity('40');
    setProblem(undefined);
  }, [open, account?.id]);

  const pending = createAccount.isPending || updateAccount.isPending;

  // A team that belongs to a department settles the department too, so only
  // compatible teams are offered — the same rule the mapping dialog applies,
  // and the backend rejects a contradictory pair regardless.
  const selectableTeams = (teams.data ?? []).filter(
    (team) =>
      departmentId === NONE || !team.department || team.department.id === departmentId,
  );

  const fail = (error: unknown) =>
    setProblem(error instanceof Error ? error.message : 'That could not be saved.');

  const submit = () => {
    setProblem(undefined);

    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setProblem('A first name, last name and email address are required.');
      return;
    }

    if (isEdit && account) {
      updateAccount.mutate(
        {
          id: account.id,
          patch: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            admin,
          },
        },
        {
          onSuccess: () => {
            toast.success('Person updated');
            onOpenChange(false);
          },
          onError: fail,
        },
      );
      return;
    }

    if (!login.trim()) {
      setProblem('A username is required.');
      return;
    }

    const hours = Number(capacity);
    if (!Number.isFinite(hours) || hours < 0) {
      setProblem('Capacity must be a number of hours.');
      return;
    }

    createAccount.mutate(
      {
        login: login.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        admin,
        departmentId: departmentId === NONE ? undefined : departmentId,
        teamId: teamId === NONE ? undefined : teamId,
        hoursCapacity: hours,
      },
      {
        onSuccess: (created) => {
          // The account exists even when the placement failed, so this says
          // what actually happened rather than a blanket success.
          if (created.placementProblems?.length) {
            toast.warning(`${created.name} was created, but not fully placed`, {
              description: created.placementProblems.join(' '),
            });
          } else {
            toast.success(`${created.name} was invited`, {
              description: 'They will receive an email to set their password.',
            });
          }
          onOpenChange(false);
        },
        onError: fail,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit person' : 'Add a person'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Their account details in OpenProject.'
              : 'Creates the account in OpenProject and places them in your organisation.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="account-first">First name</Label>
              <Input
                id="account-first"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-last">Last name</Label>
              <Input
                id="account-last"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="account-email">Email</Label>
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          {isEdit ? null : (
            <div className="space-y-1.5">
              <Label htmlFor="account-login">Username</Label>
              <Input
                id="account-login"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder="jane.doe"
              />
              <p className="text-2xs text-muted-foreground">
                What they sign in with. It cannot be changed here afterwards.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="min-w-0 pr-3">
              <p className="text-xs font-medium">Instance administrator</p>
              <p className="text-2xs text-muted-foreground">
                Full access in OpenProject. Unrelated to permissions in EPM.
              </p>
            </div>
            <Switch checked={admin} onCheckedChange={setAdmin} aria-label="Instance administrator" />
          </div>

          {isEdit ? null : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="account-department">Department</Label>
                  <Select
                    value={departmentId}
                    onValueChange={(value) => {
                      setDepartmentId(value);
                      setTeamId(NONE);
                    }}
                  >
                    <SelectTrigger id="account-department" aria-label="Select a department">
                      <SelectValue placeholder="No department" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>No department</SelectItem>
                      {(departments.data ?? []).map((department) => (
                        <SelectItem key={department.id} value={department.id}>
                          {department.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="account-team">Team</Label>
                  <Select value={teamId} onValueChange={setTeamId}>
                    <SelectTrigger id="account-team" aria-label="Select a team">
                      <SelectValue placeholder="No team" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>No team</SelectItem>
                      {selectableTeams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="account-capacity">Weekly capacity (hours)</Label>
                <Input
                  id="account-capacity"
                  type="number"
                  min={0}
                  max={168}
                  step={0.25}
                  value={capacity}
                  onChange={(event) => setCapacity(event.target.value)}
                />
                <p className="text-2xs text-muted-foreground">
                  Used for allocation. 40 is the default when nothing is set.
                </p>
              </div>
            </>
          )}

          {problem ? <p className="text-2xs text-danger">{problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {isEdit ? 'Save' : 'Create and invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
