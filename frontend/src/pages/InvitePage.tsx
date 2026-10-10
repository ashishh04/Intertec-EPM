import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Layers,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, FieldHint, FieldError } from '@/components/ui/label';
import { Skeleton, LoadingAnnouncement } from '@/components/ui/skeleton';
import { EpmLogo, EpmMark } from '@/components/common/EpmLogo';
import { ApiError } from '@/services/api/client';
import { inviteService } from '@/services';
import { queryKeys } from '@/lib/queryKeys';
import { formatLongDate } from '@/lib/utils';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME } from '@/config/env';
import { t } from '@/lib/i18n';

const PILLARS = [
  {
    icon: Layers,
    get title() { return t('Portfolio in one view'); },
    get body() { return t('Every project, sprint and dependency in a single operating picture.'); },
  },
  {
    icon: TrendingUp,
    get title() { return t('Delivery intelligence'); },
    get body() { return t('Velocity, health and risk surfaced before they become escalations.'); },
  },
  {
    icon: GitBranch,
    get title() { return t('Connected to your tools'); },
    get body() { return t('Work packages are read and written live in the delivery system your teams already use.'); },
  },
];

/** The server enforces the same floor; saying it first saves a round trip. */
const MIN_PASSWORD_LENGTH = 12;

const GRID_BACKGROUND =
  'linear-gradient(to right, rgba(255,255,255,0.9) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.9) 1px, transparent 1px)';

/**
 * Where an invitation email lands. Public: the person has no account they can
 * sign in to yet, and the token in the address is the only proof of who they
 * are. It is sent to the backend and nowhere else — never rendered, never
 * echoed in a message.
 *
 * Same two panels as sign-in, so the first thing a new person sees is the
 * thing they will see every morning.
 */
export default function InvitePage() {
  const { token = '' } = useParams<{ token: string }>();
  const reduceMotion = useReducedMotion();

  const invite = useQuery({
    queryKey: queryKeys.invite(token),
    queryFn: () => inviteService.get(token),
    enabled: token !== '',
    // An unknown or spent token stays that way; retrying only delays the answer.
    retry: false,
    staleTime: Infinity,
  });

  const accept = useMutation({
    mutationFn: (password: string) => inviteService.accept(token, password),
  });

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [problem, setProblem] = useState<string>();

  const rise = (delay = 0) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.4, delay, ease: [0.32, 0.72, 0, 1] as const },
        };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setProblem(t('Use at least {count, number} characters.', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmation) {
      setProblem(t('The two passwords do not match.'));
      return;
    }

    accept.mutate(password, {
      onError: (error) => {
        // Gone between loading and submitting: the server now knows whether
        // it expired or was used, and the page should say which.
        if (error instanceof ApiError && error.status === 410) {
          void invite.refetch();
          return;
        }
        setProblem(error instanceof Error ? error.message : t('That password was not accepted.'));
      },
    });
  };

  const notFound = invite.error instanceof ApiError && invite.error.isNotFound;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,34rem)]">
      {/* ---- Brand panel ------------------------------------------------- */}
      <section className="relative hidden overflow-hidden bg-brand-to p-10 text-white lg:flex lg:flex-col lg:justify-between xl:p-14">
        {/* The brand band, the same crimson-to-violet sweep the site runs
            behind its calls to action. Depth comes from two soft glows drawn
            from the gradient's own stops and a faint grid. None of them carry
            meaning, so all three stay out of the accessibility tree. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand-from via-highlight to-brand-to"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -start-32 top-[-10rem] h-[34rem] w-[34rem] rounded-full bg-white/15 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -end-40 bottom-[-12rem] h-[36rem] w-[36rem] rounded-full bg-brand-to/50 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.06] [mask-image:radial-gradient(ellipse_at_30%_30%,black,transparent_70%)]"
          style={{ backgroundImage: GRID_BACKGROUND, backgroundSize: '44px 44px' }}
        />

        <motion.div {...rise()} className="relative">
          <Link
            to="/"
            className="inline-flex items-center gap-3 rounded-lg"
            aria-label={t('{app} home', { app: APP_NAME })}
          >
            <EpmMark className="h-9 w-9" monochrome />
            <span>
              <span className="block text-sm font-semibold tracking-tight">{APP_NAME}</span>
              <span className="block text-2xs text-white">{ORG_NAME}</span>
            </span>
          </Link>
        </motion.div>

        <motion.div {...rise(0.08)} className="relative max-w-xl space-y-9">
          <div className="space-y-3">
            <p className="epm-eyebrow text-white">{t('Internal platform')}</p>
            <h1 className="text-balance text-4xl font-semibold leading-[1.12] tracking-tight">
              {t('The connection point between projects, people and delivery.')}
            </h1>
            <p className="text-sm text-white">{t(APP_DESCRIPTOR)}</p>
          </div>

          <ul className="space-y-3">
            {PILLARS.map((pillar, index) => (
              <motion.li
                key={pillar.title}
                {...rise(0.16 + index * 0.06)}
                className="flex gap-3.5 rounded-xl border border-white/10 bg-white/[0.06] p-3.5 backdrop-blur-sm"
              >
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-inset ring-white/15"
                  aria-hidden
                >
                  <pillar.icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium">{pillar.title}</p>
                  <p className="mt-1 max-w-md text-xs leading-relaxed text-white">
                    {pillar.body}
                  </p>
                </div>
              </motion.li>
            ))}
          </ul>
        </motion.div>

        <p className="relative text-2xs text-white">
          {t('Internal platform · {org} · Authorised users only', { org: ORG_NAME })}
        </p>
      </section>

      {/* ---- Invitation panel -------------------------------------------- */}
      <section className="relative flex items-center justify-center bg-background px-5 py-10 sm:px-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-primary/[0.06] to-transparent"
        />
        <motion.div
          {...rise()}
          className="relative w-full max-w-sm space-y-6 rounded-2xl border border-border bg-surface p-7 shadow-elevated sm:p-8"
        >
          <div className="lg:hidden">
            <Link to="/" className="inline-block rounded-lg" aria-label={t('{app} home', { app: APP_NAME })}>
              <EpmLogo variant="full" showDescriptor />
            </Link>
          </div>

          {invite.isLoading ? (
            <div className="space-y-6">
              <LoadingAnnouncement label={t('Checking your invitation')} />
              <div className="space-y-2">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-11 w-full" />
                </div>
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-11 w-full" />
                </div>
                <Skeleton className="h-11 w-full" />
              </div>
            </div>
          ) : invite.isError ? (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold tracking-tight">
                  {notFound ? t('Invitation not found') : t('Unable to check this invitation')}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {notFound
                    ? t('This invitation link is not valid.')
                    : t('Something went wrong on the way to the server.')}
                </p>
              </div>
              {notFound ? (
                <Alert tone="warning">
                  {t('Check the link in your email is complete, or ask an administrator to send a new one.')}
                </Alert>
              ) : (
                <Alert
                  tone="danger"
                  actions={
                    <Button variant="secondary" size="sm" onClick={() => invite.refetch()}>
                      {t('Try again')}
                    </Button>
                  }
                >
                  {invite.error instanceof Error
                    ? invite.error.message
                    : t('The invitation could not be checked.')}
                </Alert>
              )}
              <SignInLink />
            </div>
          ) : accept.isSuccess ? (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold tracking-tight">{t('Your password is set')}</h2>
                <p className="text-xs text-muted-foreground">
                  {t('Your {app} account is ready. Sign in with your username to get started.', {
                    app: APP_NAME,
                  })}
                </p>
              </div>
              <Alert tone="success" title={t('Username')}>
                <span className="font-mono">{accept.data.login}</span>
              </Alert>
              <Button asChild size="lg" className="h-11 w-full">
                <Link to="/login">
                  {t('Sign in')}
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          ) : invite.data?.state === 'expired' ? (
            <div className="space-y-5">
              <Greeting firstName={invite.data.firstName} email={invite.data.email} />
              <Alert tone="warning">
                {t('This invitation has expired. Ask an administrator to send a new one.')}
              </Alert>
              <SignInLink />
            </div>
          ) : invite.data?.state === 'used' ? (
            <div className="space-y-5">
              <Greeting firstName={invite.data.firstName} email={invite.data.email} />
              <Alert tone="neutral">
                {t('This invitation has already been used. If that was you, sign in with the password you chose.')}
              </Alert>
              <Button asChild size="lg" className="h-11 w-full">
                <Link to="/login">
                  {t('Sign in')}
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          ) : invite.data ? (
            <>
              <Greeting firstName={invite.data.firstName} email={invite.data.email} />

              <form className="space-y-4" onSubmit={submit} noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="invite-password" required>
                    {t('Password')}
                  </Label>
                  <div className="relative">
                    <Input
                      id="invite-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      autoFocus
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      invalid={Boolean(problem)}
                      className="h-11 pe-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((shown) => !shown)}
                      aria-label={showPassword ? t('Hide password') : t('Show password')}
                      aria-pressed={showPassword}
                      className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                  <FieldHint>
                    {t(
                      'At least {count, number} characters. A few unrelated words is easier to remember than a short one with symbols.',
                      { count: MIN_PASSWORD_LENGTH },
                    )}
                  </FieldHint>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="invite-confirm" required>
                    {t('Confirm password')}
                  </Label>
                  <Input
                    id="invite-confirm"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    invalid={Boolean(problem)}
                    className="h-11"
                  />
                </div>

                {problem ? <FieldError>{problem}</FieldError> : null}

                <Button type="submit" size="lg" className="h-11 w-full" loading={accept.isPending}>
                  {t('Set password and continue')}
                  <ArrowRight />
                </Button>

                <FieldHint>
                  {t('This link expires on {date}.', { date: formatLongDate(invite.data.expiresAt) })}
                </FieldHint>
              </form>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t(
                    'Your password is stored by the {app} backend only. Nobody at {org} can see it, including whoever invited you.',
                    { app: APP_NAME, org: invite.data.organisation || ORG_NAME },
                  )}
                </p>
              </div>
            </>
          ) : null}
        </motion.div>
      </section>
    </div>
  );
}

/** The one line that says who this is for, before any state or form. */
function Greeting({ firstName, email }: { firstName: string; email: string }) {
  return (
    <div className="space-y-1.5">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <KeyRound className="h-4 w-4 text-primary" aria-hidden />
        {t('Welcome, {name}', { name: firstName })}
      </h2>
      {/* One sentence, so it translates whole; the address is no longer set in
          heavier type, which would split it into fragments. */}
      <p className="text-xs text-muted-foreground">
        {t('Set a password to finish setting up your {app} account for {email}.', {
          app: APP_NAME,
          email,
        })}
      </p>
    </div>
  );
}

function SignInLink() {
  return (
    <Link
      to="/login"
      className="inline-block rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {t('Already have a password? Sign in')}
    </Link>
  );
}
