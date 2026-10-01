import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  LogOut,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { usePasswordPolicy } from '@/hooks/useUsers';
import {
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
} from '@/hooks/useSessions';
import { useAuth } from '@/providers/AuthProvider';
import { passwordRuleRows, passwordSatisfies } from '@/lib/password';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import type { EpmBrowserSession } from '@/types';

/**
 * Security — the part a person can act on.
 *
 * This used to be a list of policy facts and nothing else, which is honest but
 * useless: it told somebody their session lasts eight hours and gave them no way
 * to change their password or to throw a stolen laptop out. Both are here now,
 * and both are things EPM genuinely owns — the password change is written as the
 * person themselves, so no elevated rights are involved, and sessions are rows in
 * EPM's own database rather than tokens it cannot recall.
 *
 * The policy facts stay, below the actions. They are context for the actions
 * rather than a substitute for them.
 */
export function SecuritySettings() {
  return (
    <>
      <PasswordCard />
      <SessionsCard />

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Policy</CardTitle>
          <CardDescription>Set for the whole organisation, not per person.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <Alert tone="neutral" icon={ShieldCheck}>
            Authentication, authorisation and API credentials are handled entirely by the EPM
            backend. No token or secret is ever stored in the browser.
          </Alert>

          <FactList
            facts={[
              { label: 'Single sign-on', value: 'Microsoft Entra ID' },
              { label: 'Multi-factor authentication', value: 'Enforced by policy' },
              { label: 'API credentials', value: 'Server-side only' },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Changing your own password.
 *
 * The requirements come from the instance, not from a list written here, so what
 * is shown can never contradict what is enforced — and the backend applies the
 * same policy before forwarding, which is what makes this a preview rather than
 * the check. Paste is blocked on the confirmation field only: pasting into both
 * from a password manager is normal and good, pasting the same typo twice is not
 * a confirmation.
 */
function PasswordCard() {
  const { changePassword } = useAuth();
  const { data: policy } = usePasswordPolicy();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  const rules = useMemo(() => passwordRuleRows(policy, password), [policy, password]);
  const strong = useMemo(() => passwordSatisfies(policy, password), [policy, password]);
  const matches = password.length > 0 && password === confirmation;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (!strong) return setProblem('That password does not meet the requirements below.');
    if (!matches) return setProblem('The two passwords do not match.');

    setSaving(true);
    try {
      await changePassword(password);
      toast.success('Password changed');
      setPassword('');
      setConfirmation('');
    } catch (error) {
      // The instance owns the rules and its refusal carries the reason — a
      // password found in a breach list, or one reused too recently.
      setProblem(error instanceof Error ? error.message : 'That password was refused.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>Password</CardTitle>
        <CardDescription>Change the password you sign in with.</CardDescription>
      </CardHeader>
      <CardContent className="p-4">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="security-password" required>
                New password
              </Label>
              <div className="relative">
                <Input
                  id="security-password"
                  type={visible ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  className="pr-9"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  onClick={() => setVisible((shown) => !shown)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="security-confirm" required>
                Confirm it
              </Label>
              <Input
                id="security-confirm"
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmation}
                onPaste={(event) => event.preventDefault()}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              {confirmation.length > 0 && !matches ? (
                <FieldError>These do not match.</FieldError>
              ) : (
                <FieldHint>Typed again, not pasted.</FieldHint>
              )}
            </div>
          </div>

          {rules.length > 0 ? (
            <ul className="grid gap-1 sm:grid-cols-2">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center gap-1.5 text-2xs">
                  {rule.ok ? (
                    <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />
                  ) : (
                    <X className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={cn(rule.ok ? 'text-foreground' : 'text-muted-foreground')}>
                    {rule.label}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {policy && policy.minAdheredRules < policy.activeRules.length ? (
            <FieldHint>
              Any {policy.minAdheredRules} of the character requirements is enough, plus the length.
            </FieldHint>
          ) : null}

          {problem ? <Alert tone="danger">{problem}</Alert> : null}

          <Button type="submit" loading={saving} disabled={!strong || !matches}>
            <KeyRound className="h-3.5 w-3.5" />
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Where this person is signed in, and how to stop being.
 *
 * Possible at all because EPM's sessions are rows: revoking one takes effect on
 * that browser's next request rather than whenever a token happens to lapse.
 * The current session is listed but not revocable — ending it from here would
 * leave this browser holding a cookie for a row that no longer exists, 401ing
 * with no explanation. Signing out is the control for that, and it is offered.
 */
function SessionsCard() {
  const { signOut } = useAuth();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  const [confirming, setConfirming] = useState(false);
  const others = (sessions.data ?? []).filter((session) => !session.current);

  return (
    <>
      <Card>
        <CardHeader
          variant="compact"
          actions={
            <div className="flex items-center gap-2">
              {others.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                  Sign out everywhere else
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={signOut}>
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </Button>
            </div>
          }
        >
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Every browser currently signed in as you. Ending one takes effect immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <QueryBoundary
            isLoading={sessions.isLoading}
            isError={sessions.isError}
            error={sessions.error}
            onRetry={() => sessions.refetch()}
            errorTitle="Unable to load your sessions"
            skeleton={
              <div className="space-y-2 p-4">
                {[0, 1].map((index) => (
                  <Skeleton key={index} className="h-12 w-full" />
                ))}
              </div>
            }
          >
            <ul className="divide-y divide-border">
              {(sessions.data ?? []).map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  pending={revoke.isPending}
                  onRevoke={() =>
                    revoke.mutate(session.id, {
                      onSuccess: () => toast.success('That session was ended'),
                      onError: (error) =>
                        toast.error('That session could not be ended', {
                          description: error instanceof Error ? error.message : undefined,
                        }),
                    })
                  }
                />
              ))}
            </ul>
          </QueryBoundary>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out everywhere else?"
        description={`${others.length} other ${
          others.length === 1 ? 'session' : 'sessions'
        } will end immediately. This browser stays signed in.`}
        confirmLabel="Sign out everywhere else"
        tone="danger"
        pending={revokeOthers.isPending}
        onConfirm={() =>
          revokeOthers.mutate(undefined, {
            onSuccess: (result) => {
              toast.success(
                result.revoked === 0
                  ? 'There was nothing else to sign out'
                  : `Ended ${result.revoked} other ${result.revoked === 1 ? 'session' : 'sessions'}`,
              );
              setConfirming(false);
            },
            onError: (error) =>
              toast.error('Those sessions could not be ended', {
                description: error instanceof Error ? error.message : undefined,
              }),
          })
        }
      />
    </>
  );
}

function SessionRow({
  session,
  pending,
  onRevoke,
}: {
  session: EpmBrowserSession;
  pending: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
            {session.device}
            {session.current ? (
              <Badge tone="success" size="sm" dot>
                This browser
              </Badge>
            ) : null}
          </p>
          <p className="text-2xs text-muted-foreground">
            Last used {formatRelative(session.lastSeenAt)} &middot; signed in{' '}
            {formatDateTime(session.createdAt)}
          </p>
          {/* The raw agent, for somebody who needs to be certain this is theirs.
              `title` rather than on screen: it is long and nobody reads it twice. */}
          {session.userAgent ? (
            <p className="truncate text-2xs text-muted-foreground/70" title={session.userAgent}>
              {session.userAgent}
            </p>
          ) : null}
        </div>
      </div>

      {session.current ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-label={`End the session on ${session.device}`}
          onClick={onRevoke}
        >
          <Trash2 className="h-3.5 w-3.5" />
          End
        </Button>
      )}
    </li>
  );
}
