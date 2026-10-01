import { useMemo, useState } from 'react';
import { Check, Eye, EyeOff, KeyRound, LogOut, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label, FieldHint, FieldError } from '@/components/ui/label';
import { AuthBackdrop } from '@/components/common/AuthBackdrop';
import { EpmMark } from '@/components/common/EpmLogo';
import { useAuth } from '@/providers/AuthProvider';
import { usePasswordPolicy } from '@/hooks/useUsers';
import { passwordRuleRows, passwordSatisfies } from '@/lib/password';
import { cn } from '@/lib/utils';
import { APP_NAME } from '@/config/env';

/**
 * Shown instead of the application when someone still holds the password an
 * administrator handed them.
 *
 * That password was chosen by somebody else and, on an instance with no mail
 * transport, was almost certainly read out or messaged. Replacing it before
 * anything else is the point — and it has to be a gate rather than a prompt,
 * because a prompt is a thing people dismiss.
 *
 * Signing out is deliberately still available. Trapping someone in a screen
 * with no way back is worse than letting them leave and return.
 */

/** Blocks paste, drop and the clipboard shortcuts that bypass a paste handler. */
const noPaste = {
  onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => event.preventDefault(),
  onDrop: (event: React.DragEvent<HTMLInputElement>) => event.preventDefault(),
};

export default function SetPasswordPage() {
  const { user, changePassword, signOut } = useAuth();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  const { data: policy } = usePasswordPolicy();

  const results = useMemo(() => passwordRuleRows(policy, password), [policy, password]);

  /**
   * Long enough, and enough of the character rules met. Counted rather than
   * "all of them", so a policy of "any 3 of 4" is honoured as written — the
   * same arithmetic the backend does.
   */
  const allMet = useMemo(() => passwordSatisfies(policy, password), [policy, password]);
  const matches = password.length > 0 && password === confirmation;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (!password) {
      setProblem('Choose a password.');
      return;
    }

    if (!allMet) {
      setProblem('That password does not meet all of the requirements below.');
      return;
    }

    if (password !== confirmation) {
      setProblem('The two passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      await changePassword(password);
      // Nothing to do on success: the gate clears and the application renders.
    } catch (error) {
      // The instance owns the rules, so its message is the useful one.
      setProblem(error instanceof Error ? error.message : 'That password was not accepted.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthBackdrop className="items-center justify-center p-4">
      {/* Same band as sign-in: this screen is the second half of the
          same moment, and a bare page here read as a different product. */}
      <Card className="relative w-full max-w-md border-white/60 shadow-floating">
        <CardHeader className="items-start gap-3">
          <EpmMark className="h-9 w-9" />
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden />
              Choose your password
            </CardTitle>
            <CardDescription>
              {user?.name ? `${user.name}, your ` : 'Your '}
              {APP_NAME} account was set up with a password somebody else chose. Replace it before
              you continue.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="new-password" required>
                New password
              </Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-describedby="password-rules"
                  className="pr-10"
                  {...noPaste}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
            </div>

            {/* Live, not a post-submit rejection. `aria-live` is polite so a
                screen reader is not interrupted on every keystroke. */}
            <ul id="password-rules" aria-live="polite" className="space-y-1">
              {results.map((rule) => (
                <li key={rule.id} className="flex items-center gap-1.5 text-2xs">
                  {rule.ok ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                  ) : (
                    <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={cn(rule.ok ? 'text-foreground' : 'text-muted-foreground')}>
                    {rule.label}
                  </span>
                  <span className="sr-only">{rule.ok ? ' — met' : ' — not yet met'}</span>
                </li>
              ))}
            </ul>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-password" required>
                Confirm password
              </Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showConfirmation ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  invalid={confirmation.length > 0 && !matches}
                  className="pr-10"
                  {...noPaste}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmation((shown) => !shown)}
                  aria-label={showConfirmation ? 'Hide password' : 'Show password'}
                  aria-pressed={showConfirmation}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showConfirmation ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
              {confirmation.length > 0 && !matches ? (
                <FieldError>The two passwords do not match.</FieldError>
              ) : (
                <FieldHint>Type it again — pasting is turned off on both fields.</FieldHint>
              )}
            </div>

            {problem ? <FieldError>{problem}</FieldError> : null}

            <Button type="submit" className="w-full" disabled={saving || !allMet || !matches}>
              {saving ? 'Saving…' : 'Save and continue'}
            </Button>

            <Button type="button" variant="ghost" className="w-full" onClick={() => signOut()}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out instead
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthBackdrop>
  );
}
