import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Copy, RefreshCw } from 'lucide-react';
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
import { roleLabel } from '@/config/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateAccount, useUpdateAccount } from '@/hooks/useAccounts';
import { useAdminEmailStatus } from '@/hooks/useAdmin';
import { useDepartments } from '@/hooks/useDepartments';
import { useTeams } from '@/hooks/useTeams';
import { t } from '@/lib/i18n';
import type { AppRole, EpmAccount } from '@/types';

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

/** The roles offered, Administrator first, and what each one means for the person. */
const ROLES: AppRole[] = ['admin', 'manager', 'hr', 'employee', 'external'];

function roleHint(role: AppRole): string {
  switch (role) {
    case 'admin':
      return t('Full access to every project and setting.');
    case 'manager':
      return t('Runs projects and people: resources, health, scenarios, finance and reports.');
    case 'hr':
      return t('Looks after people: departments, teams, staffing, rates and everyone\'s timesheets.');
    case 'external':
      return t('A client or vendor: sees only the portal, and in it only the projects granted to them.');
    default:
      return t('Their own work, time, timesheets, expenses and collaboration.');
  }
}

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
  // Asked only when creating: an invitation is impossible on a server with
  // no mail transport, and the switch should say so before anyone relies on it.
  const emailStatus = useAdminEmailStatus(open && !isEdit);
  const emailReady = emailStatus.data?.delivery !== 'none';

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [login, setLogin] = useState('');
  // One choice for both halves: Administrator is the instance administrator
  // flag; the other three are EPM's own role, saved with the account.
  const [role, setRole] = useState<AppRole>('employee');
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
    setRole(account?.appRole ?? (account?.admin ? 'admin' : 'employee'));
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
  const inviting = !isEdit && emailReady && sendInvite && email.trim() !== '';

  // A team that belongs to a department settles the department too, so only
  // compatible teams are offered — the same rule the mapping dialog applies,
  // and the backend rejects a contradictory pair regardless.
  const selectableTeams = (teams.data ?? []).filter(
    (team) =>
      departmentId === NONE || !team.department || team.department.id === departmentId,
  );

  const fail = (error: unknown) =>
    setProblem(error instanceof Error ? error.message : t('That could not be saved.'));

  const submit = () => {
    setProblem(undefined);

    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setProblem(t('A first name, last name and email address are required.'));
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
            admin: role === 'admin',
            ...(role === 'admin' ? {} : { appRole: role }),
          },
        },
        {
          onSuccess: () => {
            toast.success(t('User updated'));
            onOpenChange(false);
          },
          onError: fail,
        },
      );
      return;
    }

    if (!login.trim()) {
      setProblem(t('A username is required.'));
      return;
    }

    if (!inviting && !password) {
      setProblem(t('A temporary password is required.'));
      return;
    }

    const hours = Number(capacity);
    if (role !== 'external' && (!Number.isFinite(hours) || hours < 0)) {
      setProblem(t('Capacity must be a number of hours.'));
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
        admin: role === 'admin',
        ...(role === 'admin' ? {} : { appRole: role }),
        // A client or vendor is not placed in the organisation.
        ...(role === 'external'
          ? {}
          : {
              departmentId: departmentId === NONE ? undefined : departmentId,
              teamId: teamId === NONE ? undefined : teamId,
              hoursCapacity: hours,
            }),
      },
      {
        onSuccess: (created) => {
          // The account exists even when the placement failed, so this says
          // what actually happened rather than a blanket success.
          if (created.placementProblems?.length) {
            toast.warning(t('{name} was created, but not fully placed', { name: created.name }), {
              description: created.placementProblems.join(' '),
            });
          } else if (created.inviteSent) {
            toast.success(t('Invitation sent to {email}', { email: created.email || email.trim() }), {
              description: t('They have 7 days to set a password from the link.'),
            });
          } else if (inviting) {
            // Asked for, not delivered: the account exists with a password
            // nobody knows, so the way forward is another invitation.
            toast.warning(t('{name} was created, but the invitation was not sent', { name: created.name }), {
              description: created.inviteProblem ?? t('Use "Resend invitation" from their account menu.'),
            });
          } else {
            toast.success(t('{name} can now sign in', { name: created.name }), {
              description: t('Share the username and temporary password with them securely.'),
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
          <DialogTitle>{isEdit ? t('Edit user') : t('Add user')}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? t('Their account details.')
              : t('Creates a sign-in account and places them in your organisation.')}
          </DialogDescription>
        </DialogHeader>

        <div className="epm-dialog-body epm-scroll space-y-5 py-1 pe-1">
          {/* Two halves, labelled: the sign-in account, then where the person
              sits. Grouping them is what makes a form this long readable —
              stacked one-per-row it ran off the bottom of the screen. */}
          <section className="space-y-3">
            {isEdit ? null : <p className="epm-eyebrow">{t('Account')}</p>}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="account-first">{t('First name')}</Label>
                <Input
                  id="account-first"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="account-last">{t('Last name')}</Label>
                <Input
                  id="account-last"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="account-email">{t('Email')}</Label>
                <Input
                  id="account-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              {isEdit ? null : (
                <div className="space-y-1.5">
                  <Label htmlFor="account-login">{t('Username')}</Label>
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
                  <Label htmlFor="account-invite">{t('Send an invitation email')}</Label>
                  <FieldHint className="mt-0.5">
                    {!emailReady
                      ? t('Email is not set up on this server yet, so invitations cannot be sent. Set a temporary password instead.')
                      : email.trim() === ''
                        ? t('Enter their email address first.')
                        : inviting
                          ? t('They will set their own password from the link. It expires in 7 days.')
                          : t('A temporary password will be set instead, for you to share with them.')}
                  </FieldHint>
                </div>
                <Switch
                  id="account-invite"
                  checked={inviting}
                  disabled={!emailReady || email.trim() === ''}
                  onCheckedChange={setSendInvite}
                />
              </div>
            )}

            {isEdit || inviting ? null : (
              <div className="space-y-1.5">
                <Label htmlFor="account-password">{t('Temporary password')}</Label>
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
                    aria-label={t('Copy temporary password')}
                    onClick={() => {
                      navigator.clipboard
                        .writeText(password)
                        .then(() => {
                          setCopied(true);
                          toast.success(t('Temporary password copied to the clipboard'));
                          window.setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() => toast.error(t('The password could not be copied. Select it and copy it manually.')));
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? t('Copied') : t('Copy')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => setPassword(suggestPassword())}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('Generate')}
                  </Button>
                </div>
                <FieldHint>
                  {t('Share this temporary password and the username with the user through a secure channel. They will be asked to set a new password when they first sign in.')}
                </FieldHint>
              </div>
            )}

            {/* Picks their screens and sidebar, and takes effect when saved. */}
            <div className="space-y-1.5">
              <Label htmlFor="account-role">{t('Role')}</Label>
              <Select value={role} onValueChange={(value) => setRole(value as AppRole)}>
                <SelectTrigger id="account-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {roleLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>{roleHint(role)}</FieldHint>
              {role === 'external' ? (
                <p className="text-2xs text-muted-foreground">
                  {t('Which projects they see, and whether as a client or a vendor on each, is set on the External users page.')}{' '}
                  <Link
                    to="/admin/users/external-access"
                    onClick={() => onOpenChange(false)}
                    className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t('Open External users')}
                    <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden />
                  </Link>
                </p>
              ) : null}
            </div>
          </section>

          {isEdit || role === 'external' ? null : (
            <section className="space-y-3 border-t border-border pt-4">
              <p className="epm-eyebrow">{t('Organisation')}</p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="account-department">{t('Department')}</Label>
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
                    <SelectTrigger id="account-department" aria-label={t('Select a department')}>
                      <SelectValue
                        placeholder={departments.isLoading ? t('Loading…') : t('No department')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('No department')}</SelectItem>
                      {(departments.data ?? []).map((department) => (
                        <SelectItem key={department.id} value={department.id}>
                          {department.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="account-team">{t('Team')}</Label>
                  <Select
                    value={teams.isLoading ? '' : teamId}
                    onValueChange={setTeamId}
                    disabled={teams.isLoading}
                  >
                    <SelectTrigger id="account-team" aria-label={t('Select a team')}>
                      <SelectValue placeholder={teams.isLoading ? t('Loading…') : t('No team')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('No team')}</SelectItem>
                      {selectableTeams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!teams.isLoading && (teams.data ?? []).length === 0 ? (
                    <FieldHint>{t('No teams yet.')}</FieldHint>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="account-capacity">{t('Weekly capacity')}</Label>
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
                    <span className="shrink-0 text-2xs text-muted-foreground">{t('hours')}</span>
                  </div>
                  <FieldHint>{t('Used for allocation.')}</FieldHint>
                </div>
              </div>
            </section>
          )}

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={pending}>
            {isEdit ? t('Save') : t('Create user')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
