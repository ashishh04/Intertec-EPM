import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Eye, EyeOff, KeyRound, X } from 'lucide-react';

import { AuthBackdrop } from '@/components/common/AuthBackdrop';
import { EpmMark } from '@/components/common/EpmLogo';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { LoadingAnnouncement, Skeleton } from '@/components/ui/skeleton';
import { APP_NAME } from '@/config/env';
import { t } from '@/lib/i18n';
import { passwordRuleRows, passwordSatisfies } from '@/lib/password';
import { cn, formatDateTime } from '@/lib/utils';
import { ApiError, apiClient } from '@/services/api/client';
import type { PasswordPolicy } from '@/types';

interface ResetLink {
  state: 'valid' | 'used' | 'expired' | 'replaced';
  firstName: string;
  expiresAt: string;
  policy: PasswordPolicy;
}

/**
 * Where a password reset email lands. Public, like an invitation: the token in
 * the address is the only proof of who this is, and it goes to the backend and
 * nowhere else. The rules come with the link, so they show as the password is
 * typed rather than after it is refused.
 */
export default function ResetPasswordPage() {
  const { token = '' } = useParams<{ token: string }>();

  const link = useQuery({
    queryKey: ['password-reset', token],
    queryFn: () => apiClient.get<ResetLink>(`/password-reset/${token}`),
    enabled: token !== '',
    // An unknown or spent link stays that way; retrying only delays the answer.
    retry: false,
    staleTime: Infinity,
  });

  const complete = useMutation({
    mutationFn: (password: string) => apiClient.post<{ login: string }>(`/password-reset/${token}`, { password }),
  });

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [problem, setProblem] = useState<string>();

  const policy = link.data?.policy;
  const results = useMemo(() => passwordRuleRows(policy, password), [policy, password]);
  const allMet = useMemo(() => passwordSatisfies(policy, password), [policy, password]);
  const matches = password.length > 0 && password === confirmation;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (!password) {
      setProblem(t('Choose a password.'));
      return;
    }
    if (!allMet) {
      setProblem(t('That password does not meet all of the requirements below.'));
      return;
    }
    if (!matches) {
      setProblem(t('The two passwords do not match.'));
      return;
    }

    complete.mutate(password, {
      onError: (error) => {
        // Spent or expired since the page loaded: the server knows which.
        if (error instanceof ApiError && error.status === 410) {
          void link.refetch();
          return;
        }
        setProblem(error instanceof Error ? error.message : t('That password was not accepted.'));
      },
    });
  };

  const notFound = link.error instanceof ApiError && link.error.isNotFound;
  const state = link.data?.state;

  return (
    <AuthBackdrop className="items-center justify-center p-4">
      <Card className="relative w-full max-w-md border-white/60 shadow-floating">
        <CardHeader className="items-start gap-3">
          <EpmMark className="h-9 w-9" />
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden />
              {complete.isSuccess ? t('Your password has been reset') : t('Choose a new password')}
            </CardTitle>
            {complete.isSuccess ? (
              <CardDescription>
                {t('You have been signed out everywhere else. Sign in with your new password.')}
              </CardDescription>
            ) : state === 'valid' ? (
              <CardDescription>
                {link.data?.firstName
                  ? t('{name}, choose a new password for your {app} account.', { name: link.data.firstName, app: APP_NAME })
                  : t('Choose a new password for your {app} account.', { app: APP_NAME })}
              </CardDescription>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {link.isLoading ? (
            <div className="space-y-4">
              <LoadingAnnouncement label={t('Checking your reset link')} />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : link.isError ? (
            notFound ? (
              <>
                <Alert tone="warning">
                  {t('This reset link is not valid. Check the link in your email is complete, or ask for a new one.')}
                </Alert>
                <AskAgain />
              </>
            ) : (
              <Alert
                tone="danger"
                actions={
                  <Button variant="secondary" size="sm" onClick={() => link.refetch()}>
                    {t('Try again')}
                  </Button>
                }
              >
                {link.error instanceof Error ? link.error.message : t('The reset link could not be checked.')}
              </Alert>
            )
          ) : complete.isSuccess ? (
            <>
              <Alert tone="success" title={t('Username')}>
                <span className="font-mono">{complete.data.login}</span>
              </Alert>
              <Button asChild size="lg" className="h-11 w-full">
                <Link to="/login">
                  {t('Sign in')}
                  <ArrowRight />
                </Link>
              </Button>
            </>
          ) : state === 'expired' ? (
            <>
              <Alert tone="warning">{t('This reset link has expired. Ask for a new one.')}</Alert>
              <AskAgain />
            </>
          ) : state === 'replaced' ? (
            <>
              <Alert tone="neutral">{t('A newer reset link replaced this one. Use the link in your latest email.')}</Alert>
              <AskAgain />
            </>
          ) : state === 'used' ? (
            <>
              <Alert tone="neutral">
                {t('This reset link has already been used. If that was you, sign in with your new password.')}
              </Alert>
              <Button asChild size="lg" className="h-11 w-full">
                <Link to="/login">
                  {t('Sign in')}
                  <ArrowRight />
                </Link>
              </Button>
            </>
          ) : state === 'valid' ? (
            <form className="space-y-4" onSubmit={submit} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="reset-password" required>
                  {t('New password')}
                </Label>
                <div className="relative">
                  <Input
                    id="reset-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby="reset-password-rules"
                    className="h-11 pe-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={showPassword ? t('Hide password') : t('Show password')}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
              </div>

              {/* Live, not a rejection after submitting; polite, so a screen
                  reader is not interrupted on every keystroke. */}
              <ul id="reset-password-rules" aria-live="polite" className="space-y-1">
                {results.map((rule) => (
                  <li key={rule.id} className="flex items-center gap-1.5 text-2xs">
                    {rule.ok ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                    ) : (
                      <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className={cn(rule.ok ? 'text-foreground' : 'text-muted-foreground')}>{rule.label}</span>
                    <span className="sr-only">{rule.ok ? t(' — met') : t(' — not yet met')}</span>
                  </li>
                ))}
              </ul>

              <div className="space-y-1.5">
                <Label htmlFor="reset-confirm" required>
                  {t('Confirm password')}
                </Label>
                <Input
                  id="reset-confirm"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  invalid={confirmation.length > 0 && !matches}
                  className="h-11"
                />
                {confirmation.length > 0 && !matches ? <FieldError>{t('The two passwords do not match.')}</FieldError> : null}
              </div>

              {problem ? <FieldError>{problem}</FieldError> : null}

              <Button type="submit" size="lg" className="h-11 w-full" loading={complete.isPending}>
                {t('Reset password')}
                <ArrowRight />
              </Button>

              {link.data ? (
                <FieldHint>{t('This link works until {time}.', { time: formatDateTime(link.data.expiresAt) })}</FieldHint>
              ) : null}
            </form>
          ) : null}
        </CardContent>
      </Card>
    </AuthBackdrop>
  );
}

function AskAgain() {
  return (
    <Button asChild size="lg" className="h-11 w-full">
      <Link to="/forgot-password">
        {t('Ask for a new link')}
        <ArrowRight />
      </Link>
    </Button>
  );
}
