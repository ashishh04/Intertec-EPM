import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Bell,
  FileText,
  FolderKanban,
  GanttChartSquare,
  KanbanSquare,
  Layers,
  ListChecks,
  Lock,
  ScrollText,
  ShieldCheck,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EpmLogo } from '@/components/common/EpmLogo';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { ProductPreview } from '@/components/landing/ProductPreview';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME } from '@/config/env';

const CAPABILITIES = [
  {
    icon: Layers,
    title: 'Portfolios',
    body: 'Roll delivery up from task to portfolio, with health and risk visible at every level.',
  },
  {
    icon: FolderKanban,
    title: 'Projects',
    body: 'Scope, schedule, budget and membership per project in one record.',
  },
  {
    icon: ListChecks,
    title: 'Tasks & My Work',
    body: 'A single queue of what each person owes today.',
  },
  {
    icon: KanbanSquare,
    title: 'Agile boards & sprints',
    body: 'Backlogs, boards and sprint execution.',
  },
  {
    icon: GanttChartSquare,
    title: 'Gantt & calendar',
    body: 'Dependencies and dates, planned against reality.',
  },
  {
    icon: Users,
    title: 'Teams, departments & people',
    body: 'Capacity and allocation across the org.',
  },
  {
    icon: FileText,
    title: 'Documents',
    body: 'Delivery artefacts attached where the work lives.',
  },
  {
    icon: TrendingUp,
    title: 'Reports & analytics',
    body: 'Velocity, health and trend, scheduled or on demand.',
  },
  {
    icon: Bell,
    title: 'Notifications',
    body: 'Watchers, mentions and escalations routed to the right people.',
  },
];

/** Illustrative figures for the trust strip — not read from the API. */
const ILLUSTRATIVE_STATS = [
  { value: '12', label: 'Portfolios' },
  { value: '148', label: 'Active projects' },
  { value: '1,204', label: 'Sprints tracked' },
  { value: '37', label: 'Teams' },
];

const STEPS = [
  {
    number: '01',
    title: 'Sign in with your Intertec account',
    body: 'Access is provisioned by IT; there is no self-registration.',
  },
  {
    number: '02',
    title: 'Your projects, teams and work queue are already there',
    body: 'Membership and roles follow you from the directory.',
  },
  {
    number: '03',
    title: 'Plan, track and report from one place',
    body: 'Boards, schedules and reporting share the same delivery record.',
  },
];

const TRUST_POINTS = [
  { icon: Lock, text: 'Credentials are verified server-side and never stored in the browser' },
  { icon: ShieldCheck, text: `Sessions are issued by the ${APP_NAME} backend` },
  { icon: UserCheck, text: 'Role-based access to projects, teams and people data' },
  { icon: ScrollText, text: 'Every change is attributable and auditable' },
];

/** The dot field behind the hero. Decorative, so it stays out of the a11y tree. */
const DOT_FIELD =
  'radial-gradient(circle at 1px 1px, hsl(var(--foreground) / 0.14) 1px, transparent 0)';

const EASE_SWIFT = [0.32, 0.72, 0, 1] as const;

/**
 * Public entry point at "/". Signed-out staff land here, learn what EPM covers
 * and sign in; there is no self-registration, so every call to action on the
 * page leads to /login rather than a signup flow.
 */
export default function LandingPage() {
  const reduceMotion = useReducedMotion();

  // framer-motion animates via JS transforms, so the global
  // prefers-reduced-motion CSS rule never reaches it — collapse the movement
  // here instead of relying on that rule.
  const rise = (delay = 0) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.42, delay, ease: EASE_SWIFT },
        };

  const riseInView = (delay = 0) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 12 },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true, margin: '-80px' },
          transition: { duration: 0.42, delay, ease: EASE_SWIFT },
        };

  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />

      <main>
        {/* ---- Hero ------------------------------------------------------ */}
        <section id="platform" className="relative scroll-mt-20 overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_50%_0%,black,transparent_75%)]"
            style={{ backgroundImage: DOT_FIELD, backgroundSize: '28px 28px' }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[32rem] bg-gradient-to-br from-primary/5 via-transparent to-accent/5"
          />

          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-12 lg:gap-10 lg:py-24">
            <motion.div {...rise()} className="lg:col-span-5">
              <p className="epm-eyebrow">{ORG_NAME} · Internal platform</p>
              <h1 className="mt-4 text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
                The connection point between projects, people and delivery.
              </h1>
              <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
                Every project, sprint, dependency and delivery signal in a single operating picture
                — connected to the systems teams already work in.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button asChild size="lg">
                  <Link to="/login">
                    Sign in to {APP_NAME}
                    <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="lg">
                  <a href="#capabilities">See what&apos;s inside</a>
                </Button>
              </div>

              <p className="mt-6 max-w-sm text-2xs text-muted-foreground">
                Company account required · Sessions issued by the {APP_NAME} backend · Authorised
                users only
              </p>
            </motion.div>

            <motion.div {...rise(0.1)} className="lg:col-span-7">
              <ProductPreview />
            </motion.div>
          </div>
        </section>

        {/* ---- Trust strip ----------------------------------------------- */}
        <section className="border-y border-border bg-surface">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-6 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-xs text-muted-foreground">
              Used across delivery, PMO and engineering teams at {ORG_NAME}.
            </p>
            <dl className="flex flex-wrap items-baseline gap-x-10 gap-y-3">
              {ILLUSTRATIVE_STATS.map((stat) => (
                <div key={stat.label} className="flex items-baseline gap-2">
                  <dt className="sr-only">{stat.label}</dt>
                  <dd className="font-mono text-sm font-semibold tracking-tight">{stat.value}</dd>
                  <span aria-hidden className="text-xs text-muted-foreground">
                    {stat.label}
                  </span>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ---- Capabilities ---------------------------------------------- */}
        <section id="capabilities" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            <motion.div {...riseInView()}>
              <p className="epm-eyebrow">Capabilities</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                One platform, the whole delivery surface
              </h2>
            </motion.div>

            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((capability, index) => (
                <motion.li
                  key={capability.title}
                  // Cap the stagger so the last cards do not sit visibly idle.
                  {...riseInView(Math.min(index, 5) * 0.04)}
                  className="rounded-xl border border-border bg-surface p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary">
                    <capability.icon className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold tracking-tight">{capability.title}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {capability.body}
                  </p>
                </motion.li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---- How it works ---------------------------------------------- */}
        <section id="how-it-works" className="scroll-mt-20 border-t border-border bg-surface-sunken">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            <motion.div {...riseInView()}>
              <p className="epm-eyebrow">How it works</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                Three steps, no setup
              </h2>
            </motion.div>

            <ol className="mt-12 grid gap-10 lg:grid-cols-3 lg:gap-8">
              {STEPS.map((step, index) => (
                <motion.li key={step.number} {...riseInView(index * 0.06)} className="relative">
                  <div className="border-t border-border pt-5">
                    <span
                      aria-hidden
                      className="absolute -top-[3px] left-0 h-1.5 w-1.5 rounded-full bg-accent"
                    />
                    <p className="font-mono text-xs font-medium text-primary">{step.number}</p>
                    <h3 className="mt-2.5 text-sm font-semibold tracking-tight">{step.title}</h3>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
                  </div>
                </motion.li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---- Security & trust ------------------------------------------ */}
        <section id="security" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            <motion.div
              {...riseInView()}
              className="rounded-xl border border-border bg-primary-soft/50 p-8 sm:p-10"
            >
              <p className="epm-eyebrow">Security &amp; trust</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                Built for internal use
              </h2>

              <ul className="mt-8 grid gap-5 sm:grid-cols-2 sm:gap-x-10">
                {TRUST_POINTS.map((point) => (
                  <li key={point.text} className="flex items-start gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-accent">
                      <point.icon className="h-4 w-4" aria-hidden />
                    </span>
                    <p className="pt-1.5 text-xs leading-relaxed text-foreground">{point.text}</p>
                  </li>
                ))}
              </ul>

              <Button asChild size="lg" className="mt-9">
                <Link to="/login">Sign in</Link>
              </Button>
            </motion.div>
          </div>
        </section>
      </main>

      {/* ---- Footer ------------------------------------------------------ */}
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-5 py-8 sm:px-8 lg:flex-row lg:justify-between">
          <EpmLogo />
          <p className="order-last text-center text-2xs text-muted-foreground lg:order-none">
            © {new Date().getFullYear()} {ORG_NAME}. {APP_DESCRIPTOR}. Internal platform —
            authorised users only.
          </p>
          <ul className="flex items-center gap-6">
            <li>
              <Link
                to="/login"
                className="rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
            </li>
            {/* TODO: point these at the real support desk and status page once they exist. */}
            <li>
              <a
                href="#"
                className="rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Support
              </a>
            </li>
            <li>
              <a
                href="#"
                className="rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Status
              </a>
            </li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
