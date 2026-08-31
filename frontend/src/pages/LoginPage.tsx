import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, GitBranch, Layers, ShieldCheck, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { NexusLogo, NexusMark } from '@/components/common/NexusLogo';
import { useAuth } from '@/providers/AuthProvider';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME, env } from '@/config/env';
import { toast } from 'sonner';

const PILLARS = [
  { icon: Layers, title: 'Portfolio in one view', body: 'Every project, sprint and dependency in a single operating picture.' },
  { icon: TrendingUp, title: 'Delivery intelligence', body: 'Velocity, health and risk surfaced before they become escalations.' },
  { icon: GitBranch, title: 'Connected to your tools', body: 'Work packages stay in sync with the delivery systems your teams already use.' },
];

/**
 * Enterprise sign-in. SSO is the primary path; the email form exists only so the
 * prototype can be explored without an identity provider configured.
 */
export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('alex.morgan@demo.intertec.test');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [pending, setPending] = useState<'sso' | 'password' | null>(null);

  const enter = (method: 'sso' | 'password') => {
    setPending(method);
    // No real authentication happens here — the Nexus backend owns the session.
    window.setTimeout(() => {
      signIn();
      navigate('/dashboard', { replace: true });
    }, 450);
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
          <NexusMark className="h-9 w-9" />
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
            <NexusLogo variant="full" showDescriptor />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight">Sign in to {APP_NAME}</h2>
            <p className="text-xs text-muted-foreground">
              Use your {ORG_NAME} account to continue.
            </p>
          </div>

          <Button
            size="lg"
            className="w-full"
            loading={pending === 'sso'}
            onClick={() => enter('sso')}
          >
            <MicrosoftGlyph />
            Continue with Microsoft
          </Button>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">
              or use email
            </span>
            <Separator className="flex-1" />
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!email.trim()) {
                toast.error('Enter your work email address');
                return;
              }
              enter('password');
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="login-email" required>
                Work email
              </Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@intertecsystems.com"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password">Password</Label>
                <button
                  type="button"
                  onClick={() =>
                    toast('Password recovery is handled by your identity provider', {
                      description: 'Contact the IT service desk to reset your account.',
                    })
                  }
                  className="text-2xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
              />
              <FieldHint>
                Demo access only. Credentials are never stored in the browser.
              </FieldHint>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
                aria-label="Remember me on this device"
              />
              Remember me on this device
            </label>

            <Button
              type="submit"
              variant="secondary"
              className="w-full"
              loading={pending === 'password'}
            >
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <p className="text-2xs text-muted-foreground">
              This build runs on <span className="font-medium text-foreground">{env.appEnv}</span>{' '}
              data. Sessions are issued by the Nexus backend; no credentials or API tokens are held
              in the frontend.
            </p>
          </div>
        </motion.div>
      </section>
    </div>
  );
}

function MicrosoftGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <rect x="1" y="1" width="8" height="8" fill="#F25022" />
      <rect x="11" y="1" width="8" height="8" fill="#7FBA00" />
      <rect x="1" y="11" width="8" height="8" fill="#00A4EF" />
      <rect x="11" y="11" width="8" height="8" fill="#FFB900" />
    </svg>
  );
}
