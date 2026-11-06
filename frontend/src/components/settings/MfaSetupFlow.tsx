import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Download, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { APP_NAME } from '@/config/env';
import { useConfirmMfaSetup, useStartMfaSetup } from '@/hooks/useMfa';
import { saveBlob } from '@/lib/download';
import { t } from '@/lib/i18n';
import { ApiError } from '@/services/api/client';
import type { MfaSetup } from '@/types';

const describe = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);

/** The server wants the password: a page left open past the minutes it stays proved. */
export const wantsPassword = (error: unknown): boolean =>
  error instanceof ApiError && (error.details as { field?: string } | undefined)?.field === 'password';

function copyToClipboard(text: string, done: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(done))
    .catch(() => toast.error(t('That could not be copied. Select it and copy it by hand.')));
}

/**
 * Setting up an authenticator, for Security settings and for the screen that
 * holds someone whose role requires it: what they will need, the QR code, a code
 * to prove the app has it, and then the recovery codes.
 */
export function MfaSetupFlow({
  passwordRequired,
  onCodesShown,
  onFinished,
  onCancel,
}: {
  /** They did not sign in just now, so the server wants their password first. */
  passwordRequired: boolean;
  /** From here it is on, and leaving would lose the only sight of the codes. */
  onCodesShown?: () => void;
  onFinished: () => void;
  /** Absent where there is nowhere to go back to. */
  onCancel?: () => void;
}) {
  const start = useStartMfaSetup();
  const confirm = useConfirmMfaSetup();

  const [askPassword, setAskPassword] = useState(passwordRequired);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<MfaSetup>();
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [problem, setProblem] = useState<string>();

  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} onDone={onFinished} doneLabel={t('Finish')} />;

  if (!setup) {
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(undefined);
          if (askPassword && !password) {
            setProblem(t('Enter your password.'));
            return;
          }
          start.mutate(askPassword ? password : undefined, {
            onSuccess: (created) => {
              setPassword('');
              setSetup(created);
            },
            onError: (error) => {
              if (wantsPassword(error)) setAskPassword(true);
              setPassword('');
              setProblem(describe(error));
            },
          });
        }}
      >
        <p className="text-xs text-muted-foreground">
          {t('You will need an authenticator app on your phone, such as Microsoft Authenticator, Google Authenticator or Authy. When you sign in, {app} will ask for your password and a six-digit code from the app, so a stolen password alone is not enough.', { app: APP_NAME })}
        </p>

        {askPassword ? (
          <div className="space-y-1.5">
            <Label htmlFor="mfa-password" required>
              {t('Your password')}
            </Label>
            <Input
              id="mfa-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldHint>{t('To be sure it is you, as you did not sign in just now.')}</FieldHint>
          </div>
        ) : null}

        {problem ? <Alert tone="danger">{problem}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={start.isPending}>
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('Continue')}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('Cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    );
  }

  const groupedSecret = setup.secret.match(/.{1,4}/g)?.join(' ') ?? setup.secret;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(undefined);
        if (code.length !== 6) {
          setProblem(t('Enter the six-digit code your app shows.'));
          return;
        }
        confirm.mutate(code, {
          onSuccess: (confirmed) => {
            onCodesShown?.();
            setRecoveryCodes(confirmed.recoveryCodes);
          },
          onError: (error) => {
            setProblem(describe(error));
            setCode('');
          },
        });
      }}
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        {/* White whatever the theme: scanners want dark on light. */}
        <div className="shrink-0 rounded-lg border border-border bg-white p-2">
          <QRCodeSVG value={setup.uri} size={168} level="M" title={t('QR code for your authenticator app')} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs font-medium text-foreground">{t('Scan this with your authenticator app.')}</p>
          <p className="text-2xs text-muted-foreground">{t('Cannot scan it? Add an account in the app by hand, with this key:')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code dir="ltr" className="break-all rounded bg-muted px-2 py-1 font-mono text-2xs text-foreground">
              {groupedSecret}
            </code>
            <Button type="button" variant="ghost" size="sm" onClick={() => copyToClipboard(setup.secret, t('Key copied'))}>
              <Copy className="h-3.5 w-3.5" />
              {t('Copy')}
            </Button>
          </div>
          <p className="text-2xs text-muted-foreground">
            {t('It will appear in the app as {issuer} ({account}).', { issuer: setup.issuer, account: setup.account })}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mfa-code" required>
          {t('The six-digit code it shows')}
        </Label>
        <Input
          id="mfa-code"
          dir="ltr"
          autoFocus
          value={code}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          placeholder="123456"
          className="max-w-44 text-center font-mono text-base tracking-widest"
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
      </div>

      {problem ? <Alert tone="danger">{problem}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={confirm.isPending}>
          <Check className="h-3.5 w-3.5" />
          {t('Verify and turn on')}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Recovery codes, the one time they are shown. Moving on asks for a tick, because
 * someone who skips past this and later loses their phone needs an administrator.
 */
export function RecoveryCodes({
  codes,
  onDone,
  doneLabel,
}: {
  codes: string[];
  onDone: () => void;
  doneLabel: string;
}) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');

  const download = () =>
    saveBlob(new Blob([`${t('EPM recovery codes. Each works once.')}\n\n${text}\n`], { type: 'text/plain' }), 'epm-recovery-codes.txt');

  return (
    <div className="space-y-4">
      <Alert tone="warning" title={t('Save your recovery codes')}>
        {t('If you lose your phone, each of these lets you sign in once. This is the only time they are shown: keep them somewhere safe, away from your phone.')}
      </Alert>

      <ul dir="ltr" className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code} className="text-center">
            {code}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => copyToClipboard(text, t('Recovery codes copied'))}>
          <Copy className="h-3.5 w-3.5" />
          {t('Copy')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={download}>
          <Download className="h-3.5 w-3.5" />
          {t('Download')}
        </Button>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
        {t('I have saved these codes')}
      </label>

      <Button type="button" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
