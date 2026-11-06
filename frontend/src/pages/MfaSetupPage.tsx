import { LogOut, ShieldCheck } from 'lucide-react';

import { AuthBackdrop } from '@/components/common/AuthBackdrop';
import { EpmMark } from '@/components/common/EpmLogo';
import { MfaSetupFlow } from '@/components/settings/MfaSetupFlow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFinishMfaSetup, useMfaStatus } from '@/hooks/useMfa';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Shown instead of the application when someone's role requires two-factor
 * authentication and they have not set it up. A gate rather than a prompt, like
 * the password one before it, because a prompt is a thing people dismiss; the
 * server refuses them everything else anyway (`auth/hook.ts`).
 *
 * Signing out stays available: trapping someone in a screen with no way back is
 * worse than letting them leave and return, perhaps with their phone this time.
 */
export default function MfaSetupPage() {
  const { signOut } = useAuth();
  const status = useMfaStatus();
  const finish = useFinishMfaSetup();

  return (
    <AuthBackdrop className="items-center justify-center p-4">
      <Card className="relative w-full max-w-xl border-white/60 shadow-floating">
        <CardHeader className="items-start gap-3">
          <EpmMark className="h-9 w-9" />
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
              {t('Set up two-factor authentication')}
            </CardTitle>
            <CardDescription>{t('Your organisation requires this for your role. It takes about a minute.')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.data ? (
            <MfaSetupFlow passwordRequired={status.data.passwordRequired} onFinished={() => void finish()} />
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
          <div className="border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-3.5 w-3.5" />
              {t('Sign out')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </AuthBackdrop>
  );
}
