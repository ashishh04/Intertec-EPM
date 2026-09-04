import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Eye,
  EyeOff,
  GitBranch,
  Layers,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import { EpmLogo, EpmMark } from '@/components/common/EpmLogo';
import { useAuth } from '@/providers/AuthProvider';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME, env } from '@/config/env';

const PILLARS = [
  {
    icon: Layers,
    title: 'Portfolio in one view',
    body: 'Every project, sprint and dependency in a single operating picture.',
  },
  {
    icon: TrendingUp,
    title: 'Delivery intelligence',
    body: 'Velocity, health and risk surfaced before they become escalations.',
  },
  {
    icon: GitBranch,
    title: 'Connected to your tools',
    body: 'Work packages stay in sync with the delivery systems your teams already use.',
  },
];

const DEFAULT_DESTINATION = '/dashboard';

/**
 * Where to land after a successful sign-in. RequireAuth stores the path the
 * user actually asked for, so a deep link survives the trip through /login —
 * but only a same-site absolute path is honoured, so a crafted `from` cannot
 * turn this form into an open redirect.
 */
function safeDestination(from: unknown): string {
  if (typeof from !== 'string') return DEFAULT_DESTINATION;
  if (!from.startsWith('/') || from.startsWith('//')) return DEFAULT_DESTINATION;
  if (from === '/login') return DEFAULT_DESTINATION;
  return from;
}

/** Sign-in. Credentials are verified by the EPM backend; none are kept here. */
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
      setFailure('Enter your username and password.');
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
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,34rem)]">
      {/* ---- Brand panel ------------------------------------------------- */}
      <section className="relative hidden overflow-hidden bg-primary-dark p-10 text-primary-foreground lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.9) 0.5px, transparent 0.5px), radial-gradient(circle at 70% 60%, rgba(255,255,255,0.6) 0.5px, transparent 0.5px)',
            backgroundSize: '28px 28px, 44px 44px',
          }}
          aria-hidden
        />

        <motion.div {...rise()} className="relative">
          <Link to="/" className="inline-flex items-center gap-3 rounded-lg" aria-label="EPM home">
            <EpmMark className="h-9 w-9" />
            <span>
              <span className="block text-sm font-semibold tracking-tight">{APP_NAME}</span>
              <span className="block text-2xs text-primary-foreground/70">{ORG_NAME}</span>
            </span>
          </Link>
        </motion.div>

        <motion.div {...rise(0.08)} className="relative max-w-xl space-y-9">
          <div className="space-y-3">
            <h1 className="text-balance text-4xl font-semibold leading-[1.12] tracking-tight">
              The connection point between projects, people and delivery.
            </h1>
            <p className="text-sm text-primary-foreground/75">{APP_DESCRIPTOR}</p>
          </div>

          <ul className="space-y-5">
            {PILLARS.map((pillar) => (
              <li key={pillar.title} className="flex gap-3.5">
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/10"
                  aria-hidden
                >
                  <pillar.icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium">{pillar.title}</p>
                  <p className="mt-1 max-w-md text-xs leading-relaxed text-primary-foreground/70">
                    {pillar.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </motion.div>

        <p className="relative text-2xs text-primary-foreground/60">
          Internal platform · {ORG_NAME} · Authorised users only
        </p>
      </section>

      {/* ---- Sign-in panel ----------------------------------------------- */}
      <section className="flex items-center justify-center bg-background px-5 py-10 sm:px-10">
        <motion.div {...rise()} className="w-full max-w-sm space-y-6">
          <div className="lg:hidden">
            <Link to="/" className="inline-block rounded-lg" aria-label="EPM home">
              <EpmLogo variant="full" showDescriptor />
            </Link>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight">Sign in to {APP_NAME}</h2>
            <p className="text-xs text-muted-foreground">
              Use your {ORG_NAME} account to continue.
            </p>
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
                Username
              </Label>
              <Input
                id="login-username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Your work username"
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
              ) : (
                <FieldHint>
                  Your password is verified on the server and is never stored in this browser.
                </FieldHint>
              )}
            </div>

            <Button type="submit" size="lg" className="h-11 w-full" loading={pending}>
              Sign in
              <ArrowRight />
            </Button>
          </form>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Sessions are issued by the {APP_NAME} backend; no credentials or API tokens are held
              in the frontend.
              {!env.isProduction ? (
                <>
                  {' '}
                  This build runs on{' '}
                  <span className="font-medium text-foreground">{env.appEnv}</span> data.
                </>
              ) : null}
            </p>
          </div>

          <Link
            to="/"
            className="inline-block rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Back to overview
          </Link>
        </motion.div>
      </section>
    </div>
  );
}
