import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import { AuthBackdrop } from '@/components/common/AuthBackdrop';
import { EpmMark } from '@/components/common/EpmLogo';
import { safeDestination } from '@/lib/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME } from '@/config/env';

/**
 * Sign-in. Credentials are verified by the EPM backend; none are kept here.
 *
 * One column, centred on the brand band. There is a single decision to make on
 * this screen, so nothing shares the page with it — the split layout this
 * replaced spent half the viewport re-stating what the landing page already
 * says to someone who has plainly already decided to sign in.
 */
export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotion();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [resetHintOpen, setResetHintOpen] = useState(false);

  const rise = (delay = 0) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.4, delay, ease: [0.32, 0.72, 0, 1] as const },
        };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setFailure('Enter your username or email, and your password.');
      return;
    }

    setPending(true);
    setFailure(undefined);
    try {
      await signIn(username.trim(), password);
      navigate(safeDestination((location.state as { from?: unknown } | null)?.from), {
        replace: true,
      });
    } catch (error) {
      // The backend deliberately reports one message for every rejection so the
      // form cannot be used to discover which usernames exist.
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : 'Sign-in failed. Please try again.',
      );
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthBackdrop>
      <main className="relative flex flex-1 flex-col items-center justify-center gap-8 px-5 py-12">
        <motion.div {...rise()}>
          <Link
            to="/"
            className="flex flex-col items-center gap-3 rounded-lg text-white"
            aria-label={`${APP_NAME} home`}
          >
            <EpmMark className="h-11 w-11" monochrome />
            <span className="text-center">
              <span className="block font-display text-base font-semibold tracking-tight">
                {APP_NAME}
              </span>
              <span className="block text-2xs text-white/80">{APP_DESCRIPTOR}</span>
            </span>
          </Link>
        </motion.div>

        <motion.div
          {...rise(0.08)}
          className="w-full max-w-md space-y-6 rounded-2xl border border-white/60 bg-surface p-7 shadow-floating sm:p-8"
        >
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">Sign in to {APP_NAME}</h1>
            <p className="text-xs text-muted-foreground">Use your {ORG_NAME} account to continue.</p>
          </div>

          {failure ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-soft p-3"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              <p className="text-2xs text-foreground">{failure}</p>
            </div>
          ) : null}

          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="login-username" required>
                Username or email
              </Label>
              <Input
                id="login-username"
                autoComplete="username email"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Your work username or email"
                invalid={Boolean(failure)}
                className="h-11"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor="login-password" required>
                  Password
                </Label>
                {/* No reset flow exists yet: passwords are reset by IT, so this
                    says so rather than linking somewhere that cannot help.
                    TODO: link to the self-service reset once it ships. */}
                <button
                  type="button"
                  onClick={() => setResetHintOpen((open) => !open)}
                  aria-expanded={resetHintOpen}
                  className="rounded text-2xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Forgot password?
                </button>
              </div>

              <div className="relative">
                <Input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  invalid={Boolean(failure)}
                  className="h-11 pr-10"
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

              {resetHintOpen ? (
                <FieldHint>
                  Passwords are reset by IT support. Contact the service desk to regain access.
                </FieldHint>
              ) : null}
            </div>

            <Button type="submit" size="lg" className="h-11 w-full" loading={pending}>
              Sign in
              <ArrowRight />
            </Button>
          </form>

          <Link
            to="/"
            className="inline-block rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Back to overview
          </Link>
        </motion.div>
      </main>

      <p className="relative pb-8 text-center text-2xs text-white/80">
        Internal platform · {ORG_NAME} · Authorised users only
      </p>
    </AuthBackdrop>
  );
}
