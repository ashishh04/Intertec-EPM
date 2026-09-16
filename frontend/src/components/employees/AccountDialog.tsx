import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
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
import { FieldHint, Label } from '@/components/ui/label';
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
 * Creating does two things at once: it makes the sign-in account and records
 * where the person sits in the organisation. The second half is the reason
 * this exists here at all.
 *
 * Editing covers the account only. Department, team and capacity already have
 * their own dialogs on this page, and duplicating them here would give two
 * places to change one thing.
 *
 * By default the person is emailed a link and chooses their own password, so
 * nobody else ever sees one. A starting password remains for the cases where
 * mail cannot reach them: it is shown once for the administrator to hand over,
 * sent once, and never stored on either side.
 */

/**
 * A password that satisfies the usual rules without the administrator having
 * to think of one. Uses `crypto.getRandomValues`, not `Math.random`, because
 * this is a credential and not a placeholder.
 */
function suggestPassword(): string {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#$%^&*?',
  ];
  const all = groups.join('');
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);

  // One from each group first, so every rule is met however the rest fall.
  const picked = groups.map((group, index) => group[bytes[index]! % group.length]!);
  for (let index = groups.length; index < bytes.length; index += 1) {
    picked.push(all[bytes[index]! % all.length]!);
  }

  // Shuffled, so the guaranteed characters are not always in the same places.
  for (let index = picked.length - 1; index > 0; index -= 1) {
    const swap = bytes[index]! % (index + 1);
    [picked[index], picked[swap]] = [picked[swap]!, picked[index]!];
  }

  return picked.join('');
}

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
  const [password, setPassword] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  // Brief confirmation on the copy button; the toast says it too, but the
  // button is where the eye is.
  const [copied, setCopied] = useState(false);
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
    setPassword(isEdit ? '' : suggestPassword());
    setSendInvite(true);
    setDepartmentId(NONE);
    setTeamId(NONE);
    setCapacity('40');
    setProblem(undefined);
  }, [open, account?.id]);

  const pending = createAccount.isPending || updateAccount.isPending;

  // An invitation needs somewhere to go, so the switch only counts once an
  // email address is in. Create only: an existing account is never re-invited
  // from here.
  const inviting = !isEdit && sendInvite && email.trim() !== '';

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

    if (!inviting && !password) {
      setProblem('A starting password is required.');
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
        // Never both: with an invitation the server makes a password nobody
        // sees, and one typed here would be a second secret to leak.
        password: inviting ? undefined : password,
        sendInvite: inviting,
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
          } else if (created.inviteSent) {
            toast.success(`Invitation sent to ${created.email || email.trim()}`, {
              description: 'They have 7 days to set a password from the link.',
            });
          } else if (inviting) {
            // Asked for, not delivered: the account exists with a password
            // nobody knows, so the way forward is another invitation.
            toast.warning(`${created.name} was created, but the invitation was not sent`, {
              description: 'Use "Resend invitation" from their account menu.',
            });
          } else {
            toast.success(`${created.name} can now sign in`, {
              description: 'Give them the username and password you set.',
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit person' : 'Add a person'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Their account details.'
              : 'Creates a sign-in account and places them in your organisation.'}
          </DialogDescription>
        </DialogHeader>

        <div className="epm-dialog-body epm-scroll space-y-5 py-1 pr-1">
          {/* Two halves, labelled: the sign-in account, then where the person
              sits. Grouping them is what makes a form this long readable —
              stacked one-per-row it ran off the bottom of the screen. */}
          <section className="space-y-3">
            {isEdit ? null : <p className="epm-eyebrow">Account</p>}

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

            <div className="grid gap-3 sm:grid-cols-2">
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
                </div>
              )}
            </div>

            {isEdit ? null : (
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
                <div className="min-w-0">
                  <Label htmlFor="account-invite">Send an invitation email</Label>
                  <FieldHint className="mt-0.5">
                    {email.trim() === ''
                      ? 'Enter their email address first.'
                      : inviting
                        ? 'They will set their own password from the link. It expires in 7 days.'
                        : 'You will hand over a starting password instead.'}
                  </FieldHint>
                </div>
                <Switch
                  id="account-invite"
                  checked={inviting}
                  disabled={email.trim() === ''}
                  onCheckedChange={setSendInvite}
                />
              </div>
            )}

            {isEdit || inviting ? null : (
              <div className="space-y-1.5">
                <Label htmlFor="account-password">Starting password</Label>
                <div className="flex gap-2">
                  {/* Shown, not masked: the administrator has to read it out to
                      hand it over, and hiding it from the person typing it
                      protects nobody. */}
                  <Input
                    id="account-password"
                    value={password}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    disabled={!password}
                    aria-label="Copy starting password"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(password)
                        .then(() => {
                          setCopied(true);
                          toast.success('Password copied');
                          window.setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() => toast.error('Could not copy. Select the password and copy it by hand.'));
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => setPassword(suggestPassword())}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    New
                  </Button>
                </div>
                <FieldHint>
                  Give this to them with the username. They can change it once signed in.
                </FieldHint>
              </div>
            )}

            {/* The same toggle row as the settings page, so a switch reads the
                same wherever it appears. */}
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
              <div className="min-w-0">
                <Label htmlFor="account-admin">Instance administrator</Label>
                <FieldHint className="mt-0.5">Full access to every project and setting.</FieldHint>
              </div>
              <Switch id="account-admin" checked={admin} onCheckedChange={setAdmin} />
            </div>
          </section>

          {isEdit ? null : (
            <section className="space-y-3 border-t border-border pt-4">
              <p className="epm-eyebrow">Organisation</p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="account-department">Department</Label>
                  {/* An empty value while loading shows the placeholder instead
                      of the "No department" option, which would read as a
                      settled answer. */}
                  <Select
                    value={departments.isLoading ? '' : departmentId}
                    onValueChange={(value) => {
                      setDepartmentId(value);
                      setTeamId(NONE);
                    }}
                    disabled={departments.isLoading}
                  >
                    <SelectTrigger id="account-department" aria-label="Select a department">
                      <SelectValue
                        placeholder={departments.isLoading ? 'Loading…' : 'No department'}
                      />
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
                  <Select
                    value={teams.isLoading ? '' : teamId}
                    onValueChange={setTeamId}
                    disabled={teams.isLoading}
                  >
                    <SelectTrigger id="account-team" aria-label="Select a team">
                      <SelectValue placeholder={teams.isLoading ? 'Loading…' : 'No team'} />
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
                  {!teams.isLoading && (teams.data ?? []).length === 0 ? (
                    <FieldHint>No teams yet.</FieldHint>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="account-capacity">Weekly capacity</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="account-capacity"
                      type="number"
                      min={0}
                      max={168}
                      step={0.25}
                      value={capacity}
                      onChange={(event) => setCapacity(event.target.value)}
                    />
                    <span className="shrink-0 text-2xs text-muted-foreground">hours</span>
                  </div>
                  <FieldHint>Used for allocation.</FieldHint>
                </div>
              </div>
            </section>
          )}

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {isEdit ? 'Save' : 'Create person'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
