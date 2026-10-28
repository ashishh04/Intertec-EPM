import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, KeyRound, MailCheck } from 'lucide-react';

import { AuthBackdrop } from '@/components/common/AuthBackdrop';
import { EpmMark } from '@/components/common/EpmLogo';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { APP_NAME } from '@/config/env';
import { t } from '@/lib/i18n';
import { ApiError, apiClient } from '@/services/api/client';

/**
 * Where "Forgot password?" leads. Public: whoever is here cannot sign in.
 *
 * The answer is the same whether or not the username or email matches an
 * account, so the page cannot be used to find out who has one. The email
 * carries the link, and the link leads to the reset page.
 */
export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [problem, setProblem] = useState<string>();

  const request = useMutation({
    mutationFn: (value: string) =>
      apiClient.post<{ accepted: boolean; validMinutes: number }>('/password-reset', { identifier: value }),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    const value = identifier.trim();
    if (!value) {
      setProblem(t('Enter your username or email address.'));
      return;
    }

    request.mutate(value, {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 503) return;
        if (error instanceof ApiError && error.status === 429) {
          setProblem(t('Too many requests from here. Wait a few minutes, then try again.'));
          return;
        }
        setProblem(error instanceof Error ? error.message : t('The request could not be sent.'));
      },
    });
  };

  // Nothing on this server delivers email: true of every account alike.
  const unavailable = request.error instanceof ApiError && request.error.status === 503 ? request.error : null;

  return (
    <AuthBackdrop className="items-center justify-center p-4">
      <Card className="relative w-full max-w-md border-white/60 shadow-floating">
        <CardHeader className="items-start gap-3">
          <EpmMark className="h-9 w-9" />
          {request.isSuccess ? (
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <MailCheck className="h-4 w-4 text-primary" aria-hidden />
                {t('Check your email')}
              </CardTitle>
              <CardDescription>
                {t(
                  'If {identifier} matches an account, a link to choose a new password is on its way to the email address on that account. It works once, for {minutes} minutes.',
                  { identifier: identifier.trim(), minutes: request.data.validMinutes },
                )}
              </CardDescription>
            </div>
          ) : (
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" aria-hidden />
                {t('Reset your password')}
              </CardTitle>
              <CardDescription>
                {t('Enter the username or email address of your {app} account, and we will email you a link to choose a new password.', {
                  app: APP_NAME,
                })}
              </CardDescription>
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {request.isSuccess ? (
            <>
              <FieldHint>{t('Nothing after a few minutes? Check your junk folder, or ask again.')}</FieldHint>
              <Button asChild size="lg" className="h-11 w-full">
                <Link to="/login">
                  {t('Back to sign in')}
                  <ArrowRight />
                </Link>
              </Button>
            </>
          ) : unavailable ? (
            <>
              <Alert tone="warning">{unavailable.message}</Alert>
              <BackToSignIn />
            </>
          ) : (
            <>
              <form className="space-y-4" onSubmit={submit} noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-identifier" required>
                    {t('Username or email address')}
                  </Label>
                  <Input
                    id="reset-identifier"
                    autoComplete="username"
                    autoFocus
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    invalid={Boolean(problem)}
                    className="h-11"
                  />
                  <FieldHint>{t('Administrator accounts are not reset by email: ask another administrator.')}</FieldHint>
                </div>

                {problem ? <FieldError>{problem}</FieldError> : null}

                <Button type="submit" size="lg" className="h-11 w-full" loading={request.isPending}>
                  {t('Email me a reset link')}
                  <ArrowRight />
                </Button>
              </form>
              <BackToSignIn />
            </>
          )}
        </CardContent>
      </Card>
    </AuthBackdrop>
  );
}

function BackToSignIn() {
  return (
    <Link
      to="/login"
      className="inline-flex items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
      {t('Back to sign in')}
    </Link>
  );
}
