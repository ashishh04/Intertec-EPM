import { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EpmMark } from '@/components/common/EpmLogo';
import { useAuth } from '@/providers/AuthProvider';
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
export default function SetPasswordPage() {
  const { user, changePassword, signOut } = useAuth();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (password !== confirmation) {
      setProblem('The two passwords do not match.');
      return;
    }

    if (!password) {
      setProblem('Choose a password.');
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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
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
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-password" required>
                Confirm password
              </Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>

            {problem ? <p className="text-2xs text-danger">{problem}</p> : null}

            <Button type="submit" className="w-full" disabled={saving}>
              {saving ? 'Saving…' : 'Save and continue'}
            </Button>

            <Button type="button" variant="ghost" className="w-full" onClick={() => signOut()}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out instead
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
