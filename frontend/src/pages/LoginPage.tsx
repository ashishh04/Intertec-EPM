import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, GitBranch, Layers, ShieldCheck, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import { EpmLogo, EpmMark } from '@/components/common/EpmLogo';
import { useAuth } from '@/providers/AuthProvider';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME, env } from '@/config/env';

const PILLARS = [
  { icon: Layers, title: 'Portfolio in one view', body: 'Every project, sprint and dependency in a single operating picture.' },
  { icon: TrendingUp, title: 'Delivery intelligence', body: 'Velocity, health and risk surfaced before they become escalations.' },
  { icon: GitBranch, title: 'Connected to your tools', body: 'Work packages stay in sync with the delivery systems your teams already use.' },
];

/** Sign-in. Credentials are verified by the EPM backend; none are kept here. */
export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

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
      navigate('/dashboard', { replace: true });
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
    <div className="grid min-h-full lg:grid-cols-[1fr_minmax(0,30rem)]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden bg-primary-dark p-10 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.9) 0.5px, transparent 0.5px), radial-gradient(circle at 70% 60%, rgba(255,255,255,0.6) 0.5px, transparent 0.5px)',
            backgroundSize: '28px 28px, 44px 44px',
          }}
          aria-hidden
        />

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
          className="relative flex items-center gap-3"
        >
          <EpmMark className="h-9 w-9" />
          <div>
            <p className="text-sm font-semibold tracking-tight">{APP_NAME}</p>
            <p className="text-2xs text-primary-foreground/70">{ORG_NAME}</p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.08, ease: [0.32, 0.72, 0, 1] }}
          className="relative max-w-md space-y-8"
        >
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance">
              The connection point between projects, people and delivery.
            </h1>
            <p className="text-sm text-primary-foreground/75">{APP_DESCRIPTOR}</p>
          </div>

          <ul className="space-y-4">
            {PILLARS.map((pillar) => (
              <li key={pillar.title} className="flex gap-3">
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/10"
                  aria-hidden
                >
                  <pillar.icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-medium">{pillar.title}</p>
                  <p className="mt-0.5 text-2xs text-primary-foreground/70">{pillar.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </motion.div>

        <p className="relative text-2xs text-primary-foreground/60">
          Internal platform · {ORG_NAME} · Authorised users only
        </p>
      </section>

      {/* Sign-in panel */}
      <section className="flex items-center justify-center bg-background px-5 py-10 sm:px-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
          className="w-full max-w-sm space-y-6"
        >
          <div className="space-y-2 lg:hidden">
            <EpmLogo variant="full" showDescriptor />
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
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              <p className="text-2xs text-muted-foreground">{failure}</p>
            </div>
          ) : null}

          <form className="space-y-4" onSubmit={submit}>
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
                aria-invalid={Boolean(failure)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-password" required>
                Password
              </Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                aria-invalid={Boolean(failure)}
              />
              <FieldHint>
                Your password is verified on the server and is never stored in this browser.
              </FieldHint>
            </div>

            <Button type="submit" size="lg" className="w-full" loading={pending}>
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <p className="text-2xs text-muted-foreground">
              This build runs on <span className="font-medium text-foreground">{env.appEnv}</span>{' '}
              data. Sessions are issued by the EPM backend; no credentials or API tokens are held
              in the frontend.
            </p>
          </div>
        </motion.div>
      </section>
    </div>
  );
}

