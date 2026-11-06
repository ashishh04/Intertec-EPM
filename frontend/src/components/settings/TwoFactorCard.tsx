import { useState } from 'react';
import { KeyRound, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { MfaSetupFlow, RecoveryCodes, wantsPassword } from '@/components/settings/MfaSetupFlow';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useDisableMfa, useFinishMfaSetup, useMfaStatus, useRegenerateRecoveryCodes } from '@/hooks/useMfa';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelative } from '@/lib/utils';

/** Recovery codes this low are worth a warning while there is still one to sign in with. */
const FEW_RECOVERY_CODES = 2;

const describe = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);

/**
 * Two-factor authentication, for the person signed in: setting it up, new
 * recovery codes, and turning it off. In Security settings, and in the portal,
 * since a client or vendor can protect their account as anyone else can.
 */
export function TwoFactorCard() {
  const status = useMfaStatus();
  const finish = useFinishMfaSetup();

  const [dialog, setDialog] = useState<'setup' | 'recovery' | 'disable'>();
  // Once the recovery codes are on screen, leaving by accident would lose them.
  const [holdOpen, setHoldOpen] = useState(false);

  const close = () => {
    setDialog(undefined);
    setHoldOpen(false);
  };
  const onOpenChange = (open: boolean) => {
    if (!open && !holdOpen) close();
  };

  const data = status.data;
  const enabled = data?.enabled ?? false;

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          data ? (
            <Badge tone={enabled ? 'success' : 'neutral'} size="sm" dot>
              {enabled ? t('On') : t('Off')}
            </Badge>
          ) : null
        }
      >
        <CardTitle>{t('Two-factor authentication')}</CardTitle>
        <CardDescription>
          {t('A code from an app on your phone, asked for when you sign in, so a stolen password alone is not enough.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        <QueryBoundary
          isLoading={status.isLoading}
          isError={status.isError}
          error={status.error}
          onRetry={() => status.refetch()}
          errorTitle={t('Unable to load your two-factor settings')}
          skeleton={<Skeleton className="h-16 w-full" />}
        >
          {data && enabled ? (
            <div className="space-y-4">
              <FactList
                facts={[
                  { label: t('On since'), value: data.enabledAt ? formatDateTime(data.enabledAt) : '—' },
                  { label: t('Last used'), value: data.lastUsedAt ? formatRelative(data.lastUsedAt) : '—' },
                  { label: t('Recovery codes left'), value: String(data.recoveryCodesLeft) },
                ]}
              />
              {data.recoveryCodesLeft <= FEW_RECOVERY_CODES ? (
                <Alert tone="warning">
                  {t('You are running out of recovery codes. Generate new ones before you need them.')}
                </Alert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => setDialog('recovery')}>
                  <KeyRound className="h-3.5 w-3.5" />
                  {t('New recovery codes')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDialog('disable')}>
                  {data.required ? t('Replace authenticator') : t('Turn off')}
                </Button>
              </div>
            </div>
          ) : data ? (
            <Button size="sm" onClick={() => setDialog('setup')}>
              <Smartphone className="h-3.5 w-3.5" />
              {t('Set up')}
            </Button>
          ) : null}
        </QueryBoundary>
      </CardContent>

      <Dialog open={dialog === 'setup'} onOpenChange={onOpenChange}>
        {/* No close button once the codes are up: it could only do nothing. */}
        <DialogContent className="sm:max-w-xl" hideClose={holdOpen}>
          <DialogHeader>
            <DialogTitle>{t('Set up two-factor authentication')}</DialogTitle>
          </DialogHeader>
          {dialog === 'setup' ? (
            <MfaSetupFlow
              passwordRequired={data?.passwordRequired ?? true}
              onCodesShown={() => setHoldOpen(true)}
              onCancel={close}
              onFinished={() => {
                close();
                void finish();
                toast.success(t('Two-factor authentication is on'), {
                  description: t('Your other sessions have been signed out.'),
                });
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'recovery'} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" hideClose={holdOpen}>
          {dialog === 'recovery' ? (
            <NewRecoveryCodes
              onCodesShown={() => setHoldOpen(true)}
              onCancel={close}
              onFinished={() => {
                close();
                void finish();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'disable'} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          {dialog === 'disable' ? (
            <TurnOff
              required={data?.required ?? false}
              passwordRequired={data?.passwordRequired ?? true}
              onCancel={close}
              onFinished={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** A code from the app, or a recovery code: the server tells them apart by their shape. */
function FactorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="mfa-factor" required>
        {t('Code from your app')}
      </Label>
      <Input
        id="mfa-factor"
        dir="ltr"
        autoFocus
        value={value}
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={32}
        className="font-mono"
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldHint>{t('Or one of your recovery codes, if you do not have your phone.')}</FieldHint>
    </div>
  );
}

function NewRecoveryCodes({
  onCodesShown,
  onCancel,
  onFinished,
}: {
  onCodesShown: () => void;
  onCancel: () => void;
  onFinished: () => void;
}) {
  const regenerate = useRegenerateRecoveryCodes();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string>();
  const [codes, setCodes] = useState<string[]>();

  if (codes) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('Your new recovery codes')}</DialogTitle>
          <DialogDescription>{t('The old ones no longer work.')}</DialogDescription>
        </DialogHeader>
        <RecoveryCodes codes={codes} onDone={onFinished} doneLabel={t('Done')} />
      </>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(undefined);
        regenerate.mutate(code.trim(), {
          onSuccess: (result) => {
            onCodesShown();
            setCodes(result.recoveryCodes);
          },
          onError: (error) => {
            setProblem(describe(error));
            setCode('');
          },
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('New recovery codes')}</DialogTitle>
        <DialogDescription>{t('You get ten new codes, and the old ones stop working.')}</DialogDescription>
      </DialogHeader>
      <FactorField value={code} onChange={setCode} />
      {problem ? <Alert tone="danger">{problem}</Alert> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={regenerate.isPending}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={regenerate.isPending} disabled={!code.trim()}>
          {t('Generate')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TurnOff({
  required,
  passwordRequired,
  onCancel,
  onFinished,
}: {
  required: boolean;
  passwordRequired: boolean;
  onCancel: () => void;
  onFinished: () => void;
}) {
  const disable = useDisableMfa();
  const [askPassword, setAskPassword] = useState(passwordRequired);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string>();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(undefined);
        disable.mutate(
          { code: code.trim(), ...(askPassword ? { password } : {}) },
          {
            onSuccess: () => {
              onFinished();
              // If their role requires it, the set-up screen takes over from here.
              if (!required) toast.success(t('Two-factor authentication is off'));
            },
            onError: (error) => {
              setProblem(describe(error));
              // Refused for the password, the code was not looked at and is still good.
              if (wantsPassword(error)) {
                setAskPassword(true);
                setPassword('');
              } else {
                setCode('');
              }
            },
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>{required ? t('Replace your authenticator?') : t('Turn off two-factor authentication?')}</DialogTitle>
        <DialogDescription>
          {required
            ? t('Your role requires two-factor authentication, so you will set up a new authenticator straight away. Your current one and your recovery codes stop working.')
            : t('Signing in will ask only for your password. Your authenticator and recovery codes stop working.')}
        </DialogDescription>
      </DialogHeader>

      {askPassword ? (
        <div className="space-y-1.5">
          <Label htmlFor="mfa-disable-password" required>
            {t('Your password')}
          </Label>
          <Input
            id="mfa-disable-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      ) : null}

      <FactorField value={code} onChange={setCode} />

      {problem ? <Alert tone="danger">{problem}</Alert> : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={disable.isPending}>
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={disable.isPending} disabled={!code.trim() || (askPassword && !password)}>
          {required ? t('Replace authenticator') : t('Turn off')}
        </Button>
      </DialogFooter>
    </form>
  );
}
