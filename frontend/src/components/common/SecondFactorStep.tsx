import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ShieldAlert, Smartphone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { APP_NAME } from '@/config/env';
import { t } from '@/lib/i18n';
import { useAuth, type SecondFactorResult } from '@/providers/AuthProvider';
import { ApiError } from '@/services/api/client';

/** Six digits, as a person's app shows them. */
const CODE_LENGTH = 6;

/**
 * The second half of signing in: the password was right, and now a code from the
 * person's authenticator app, or one of their recovery codes.
 *
 * Six digits submit themselves, which is how every other service behaves and
 * what someone reading a code off their phone expects. A recovery code is too
 * long to guess when it is finished, so that one has a button.
 */
export function SecondFactorStep({
  onVerified,
  onRestart,
}: {
  onVerified: (result: SecondFactorResult) => void;
  /** Back to the password, because they asked or because this sign-in is over. */
  onRestart: (reason?: string) => void;
}) {
  const { verifySecondFactor, cancelSecondFactor } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [recovery]);

  const submit = async (value: string) => {
    if (pending) return;
    if (!value.trim()) {
      setFailure(recovery ? t('Enter one of your recovery codes.') : t('Enter the code from your authenticator app.'));
      return;
    }

    setPending(true);
    setFailure(undefined);
    try {
      onVerified(await verifySecondFactor(value));
    } catch (error) {
      // Gone: too many tries, or it took too long. There is nothing to retry here,
      // and the sign-in form is what can start another.
      if (error instanceof ApiError && error.status === 410) {
        onRestart(error.message);
        return;
      }
      setFailure(error instanceof Error && error.message ? error.message : t('Sign-in failed. Please try again.'));
      setCode('');
      inputRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Smartphone className="h-4 w-4 text-primary" aria-hidden />
          {t('Enter your code')}
        </h1>
        <p className="text-xs text-muted-foreground">
          {recovery
            ? t('Enter one of the recovery codes you saved. Each one works once.')
            : t('Open your authenticator app and enter the six-digit code it shows for {app}.', { app: APP_NAME })}
        </p>
      </div>

      {failure ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-soft p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          <p className="text-2xs text-foreground">{failure}</p>
        </div>
      ) : null}

      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(code);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="login-code" required>
            {recovery ? t('Recovery code') : t('Six-digit code')}
          </Label>
          <Input
            key={recovery ? 'recovery' : 'code'}
            ref={inputRef}
            id="login-code"
            dir="ltr"
            value={code}
            autoComplete={recovery ? 'off' : 'one-time-code'}
            inputMode={recovery ? 'text' : 'numeric'}
            spellCheck={false}
            maxLength={recovery ? 32 : CODE_LENGTH}
            placeholder={recovery ? 'xxxx-xxxx-xxxx-xxxx' : '123456'}
            invalid={Boolean(failure)}
            className="h-11 text-center font-mono text-base tracking-widest"
            onChange={(event) => {
              const next = recovery ? event.target.value : event.target.value.replace(/\D/g, '');
              setCode(next);
              if (!recovery && next.length === CODE_LENGTH) void submit(next);
            }}
          />
        </div>

        <Button type="submit" size="lg" className="h-11 w-full" loading={pending}>
          {t('Verify and sign in')}
          <ArrowRight className="rtl:rotate-180" />
        </Button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <button
          type="button"
          className="rounded text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            setRecovery((using) => !using);
            setCode('');
            setFailure(undefined);
          }}
        >
          {recovery ? t('Use my authenticator app') : t('Use a recovery code')}
        </button>
        <button
          type="button"
          className="rounded text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            void cancelSecondFactor();
            onRestart();
          }}
        >
          {t('Start again')}
        </button>
      </div>

      {/* Nothing here can help someone who has lost both; say who can. */}
      <p className="text-2xs text-muted-foreground">
        {t('Lost your phone and your recovery codes? An administrator can reset this for you.')}
      </p>
    </div>
  );
}
