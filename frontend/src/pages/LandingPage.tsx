import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Lock, ScrollText, Server, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EpmLogo } from '@/components/common/EpmLogo';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { ProductPreview } from '@/components/landing/ProductPreview';
import { HeroLattice } from '@/components/landing/plates/HeroLattice';
import { HeroMesh } from '@/components/landing/plates/HeroMesh';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { LandingCanvas, LandingRule } from '@/components/landing/LandingCanvas';
import { AboutSection } from '@/components/landing/AboutSection';
import { FeaturedTimelineSection } from '@/components/landing/FeaturedTimelineSection';
import { PhilosophySection } from '@/components/landing/PhilosophySection';
import { CapabilitiesSection } from '@/components/landing/CapabilitiesSection';
import { RolesSection } from '@/components/landing/RolesSection';
import { IntegrationsSection } from '@/components/landing/IntegrationsSection';
import { FaqSection } from '@/components/landing/FaqSection';
import { ScrollProgress } from '@/components/landing/ScrollProgress';
import { BackToTop } from '@/components/landing/BackToTop';
import { useLandingMotion } from '@/components/landing/useLandingMotion';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME } from '@/config/env';

/** Illustrative figures for the hero strip — not read from the API. */
const ILLUSTRATIVE_STATS = [
  { value: '12', label: 'Portfolios' },
  { value: '148', label: 'Active projects' },
  { value: '1,204', label: 'Sprints tracked' },
  { value: '37', label: 'Teams' },
];

/*
 * The three steps walk the brand gradient — crimson, its magenta midpoint,
 * violet — one stop per step, so the row reads as the sweep even though each
 * numeral is a flat colour. `epm-gradient-text` on a 24px glyph would sample
 * only the first stop of a 90deg ramp and come out flat crimson anyway; this
 * spends the gradient across the sequence, where it means something.
 *
 * Classes are written out in full: Tailwind only ships what it can find in
 * the source, so `text-${tone}` would be purged.
 */
const STEPS = [
  {
    number: '01',
    title: 'Sign in with your Intertec account',
    body: 'Access is provisioned by IT; there is no self-registration.',
    numeral: 'text-brand-from',
    dot: 'bg-brand-from',
    ring: 'border-brand-from',
    sweep: 'via-brand-from',
  },
  {
    number: '02',
    title: 'Your projects, teams and work queue are already there',
    body: 'Membership and roles follow you from the directory.',
    numeral: 'text-highlight',
    dot: 'bg-highlight',
    ring: 'border-highlight',
    sweep: 'via-highlight',
  },
  {
    number: '03',
    title: 'Plan, track and report from one place',
    body: 'Boards, schedules and reporting share the same delivery record.',
    numeral: 'text-brand-to',
    dot: 'bg-brand-to',
    ring: 'border-brand-to',
    sweep: 'via-brand-to',
  },
];

/*
 * Each claim here is something the backend actually does — the session cookie
 * flags in app.ts, the BFF boundary documented in config/env.ts, the per-project
 * permission resolution in auth/capabilities.ts. Nothing aspirational: this
 * page is read by the people whose data it describes.
 */
const TRUST_POINTS = [
  { icon: Lock, text: 'Nothing sensitive is ever stored in your browser' },
  { icon: Server, text: `Your data never leaves ${ORG_NAME}` },
  { icon: UserCheck, text: 'Permissions follow your role, checked on every request' },
  { icon: ScrollText, text: 'Every change is recorded against the person who made it' },
];

/**
 * Public entry point at "/". Signed-out staff land here, learn what EPM covers
 * and sign in; there is no self-registration, so every call to action on the
 * page leads to /login rather than a signup flow.
 *
 * This is the one dark surface in the product. It follows the atmosphere of
 * intertecsystems.com — near-black, footage under glass, the crimson-to-violet
 * sweep used sparingly — while the signed-in app keeps the light identity. The
 * treatment is scoped to `src/components/landing`, so the two never mix.
 */
export default function LandingPage() {
  const { rise, reveal, drawRule, press } = useLandingMotion();

  // Gates the hero video by width rather than hiding it with CSS: a `<video>`
  // set to `display: none` still fetches, and the whole point is not to spend
  // 7.5 MB of someone's phone data on decoration.
  const wideEnoughForVideo = useMediaQuery('(min-width: 768px)');

  // The canvas paints the page, but the body underneath is still the app's
  // near-white. Without this, an overscroll bounce flashes light at the edges.
  useEffect(() => {
    const previous = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#08070d';
    return () => {
      document.body.style.backgroundColor = previous;
    };
  }, []);

  return (
    <div className="relative min-h-screen">
      <ScrollProgress />
      <LandingCanvas />
      <LandingHeader />

      {/* Everything from here up sits over the canvas; no section paints its
          own background, or the atmosphere stops at its top edge. */}
      <main className="relative z-10">
        {/* ---- Hero ------------------------------------------------------ */}
        <section
          id="platform"
          className="relative flex min-h-screen scroll-mt-24 flex-col overflow-hidden"
        >
          {/* The mesh on a real screen, the drawn lattice on a phone — the
              clip is a 7.5 MB download and nobody on mobile data asked for
              decoration. They occupy the same ground, so only ever one. */}
          {wideEnoughForVideo ? <HeroMesh /> : <HeroLattice />}

          {/* The brand bloom over the top is what makes the hero read as
              Intertec rather than as a generic dark page. */}
          <div
            aria-hidden
            className="landing-aurora pointer-events-none absolute inset-0 mix-blend-screen"
          />
          <div
            aria-hidden
            // Heaviest behind the headline and lightest at the floor, where the
            // lattice is: the type needs the contrast, the field needs the air.
            className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/85 via-black/55 to-black/45"
          />

          <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-10 pt-28 text-center md:pb-16 md:pt-32">
            <motion.h1
              {...rise(0.12, 0.7, { y: 24 })}
              // Steps down hard on narrow screens: at 5xl the headline runs to
              // six lines on a phone and pushes the sign-in pill off the fold.
              className="max-w-4xl text-balance text-4xl leading-[1.08] tracking-tight text-white sm:text-5xl md:text-6xl lg:text-7xl lg:leading-[1.05]"
            >
              The connection point between projects, people and{' '}
              <em className="font-serif italic text-white/70">delivery</em>.
            </motion.h1>

            <motion.p
              {...rise(0.18, 0.7, { y: 20 })}
              className="mt-6 max-w-xl text-sm leading-relaxed text-white/60"
            >
              Every project, sprint, dependency and delivery signal in a single operating picture —
              connected to the systems teams already work in.
            </motion.p>

            {/* Shaped like the site's subscribe field, but it is a single
                link: EPM has no self-registration, so there is nothing here
                to type. */}
            <motion.div {...rise(0.24, 0.7, { y: 20 })} className="mt-10 w-full max-w-xl">
              <Link
                to="/login"
                className="liquid-glass group flex items-center justify-between gap-3 rounded-full py-2 pl-6 pr-2 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <span className="font-display text-sm font-medium text-white">
                  Sign in to {APP_NAME} with your Intertec account
                </span>
                <span
                  aria-hidden
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-white transition-transform group-hover:translate-x-0.5"
                >
                  <ArrowRight className="h-5 w-5" />
                </span>
              </Link>
            </motion.div>

            <motion.a
              {...rise(0.3, 0.7, { y: 20 })}
              href="#capabilities"
              className="liquid-glass mt-6 rounded-full px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-white/5"
            >
              See what&apos;s inside
            </motion.a>
          </div>

          {/* ---- Hero foot: the scale the platform runs at ---------------- */}
          <motion.div
            {...rise(0.38, 0.7, { y: 20 })}
            // Its own scrim: the caption is 11px grey and the lattice runs a
            // crimson bar straight under it often enough to matter.
            className="relative z-10 flex flex-col items-center gap-4 bg-gradient-to-t from-black/85 via-black/60 to-transparent px-6 pb-12 pt-10"
          >
            <p className="text-2xs text-white/40">
              Used across delivery, PMO and engineering teams at {ORG_NAME}.
            </p>
            <dl className="flex flex-wrap items-center justify-center gap-3">
              {ILLUSTRATIVE_STATS.map((stat) => (
                <div
                  key={stat.label}
                  className="liquid-glass flex items-baseline gap-2 rounded-full px-5 py-2.5"
                >
                  <dt className="sr-only">{stat.label}</dt>
                  <dd className="font-mono text-sm font-semibold tracking-tight text-white">
                    {stat.value}
                  </dd>
                  <span aria-hidden className="text-xs text-white/50">
                    {stat.label}
                  </span>
                </div>
              ))}
            </dl>
          </motion.div>
        </section>

        <AboutSection />
        <FeaturedTimelineSection />
        <PhilosophySection />
        <LandingRule />
        <CapabilitiesSection />
        <RolesSection />

        {/* ---- The product itself ---------------------------------------- */}
        <section className="overflow-hidden px-6 pb-28 md:pb-40">
          <div className="mx-auto max-w-5xl">
            <motion.div {...reveal(0, 0.7, { y: 30 })}>
              <p className="text-xs uppercase tracking-widest text-white/40">Inside the platform</p>
              <h2 className="mt-4 text-3xl tracking-tight text-white md:text-5xl">
                The picture you sign in to
              </h2>
            </motion.div>

            {/* The app window keeps its light identity inside the dark frame:
                it is what people actually see after /login, and reversing it
                out would be showing them a product that does not exist. */}
            <motion.div
              {...reveal(0.1, 0.9, { y: 50 })}
              className="liquid-glass mt-10 rounded-3xl p-3 md:p-4"
            >
              <ProductPreview className="rounded-2xl" />
            </motion.div>
          </div>
        </section>

        <LandingRule />

        {/* ---- How it works ---------------------------------------------- */}
        <section
          id="how-it-works"
          className="overflow-hidden px-6 py-28 scroll-mt-24 md:py-40"
        >
          <div className="mx-auto max-w-6xl">
            <motion.div {...reveal(0, 0.7, { y: 30 })}>
              <p className="text-xs uppercase tracking-widest text-white/40">How it works</p>
              <h2 className="mt-4 text-3xl tracking-tight text-white md:text-5xl">
                Three steps, <em className="font-serif italic text-white/50">no setup</em>
              </h2>
            </motion.div>

            <ol className="mt-16 grid gap-10 lg:grid-cols-3 lg:gap-8">
              {STEPS.map((step, index) => (
                <motion.li key={step.number} {...reveal(index * 0.08, 0.7, { y: 30 })}>
                  <div className="relative pt-6">
                    {/* The rail. Its own rule rather than a border, because it
                        has to clip the pulse travelling along it. */}
                    <span
                      aria-hidden
                      className="absolute inset-x-0 top-0 h-px overflow-hidden bg-white/10"
                    >
                      <motion.span
                        {...drawRule(index * 0.12)}
                        className="absolute inset-0 origin-left bg-white/25"
                      />
                      {/* One shared 6s clock; each step enters it 1.4s later
                          than the one before, so the pulse reads as 01 → 03. */}
                      <span
                        className={`epm-step-sweep absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent to-transparent ${step.sweep}`}
                        style={{ animationDelay: `${index * 1.4}s` }}
                      />
                    </span>

                    <span aria-hidden className="absolute -top-[3px] left-0 h-1.5 w-1.5">
                      <span className={`absolute inset-0 rounded-full ${step.dot}`} />
                      <span
                        className={`epm-step-ping absolute inset-0 rounded-full border ${step.ring}`}
                        style={{ animationDelay: `${index * 1.4}s` }}
                      />
                    </span>

                    <p
                      className={`font-display text-2xl font-semibold leading-none ${step.numeral}`}
                    >
                      {step.number}
                    </p>
                    <h3 className="mt-4 text-base font-semibold tracking-tight text-white">
                      {step.title}
                    </h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-white/50">{step.body}</p>
                  </div>
                </motion.li>
              ))}
            </ol>
          </div>
        </section>

        <LandingRule />

        <IntegrationsSection />

        <LandingRule />

        <FaqSection />

        {/* ---- Security & trust ------------------------------------------ */}
        <section id="security" className="overflow-hidden scroll-mt-24 px-6 pb-28 md:pb-40">
          <motion.div
            {...reveal(0, 0.8, { y: 40 })}
            className="liquid-glass liquid-glass-brand mx-auto max-w-6xl rounded-3xl p-8 md:p-14"
          >
            <p className="text-xs uppercase tracking-widest text-white/60">Security &amp; trust</p>
            <h2 className="mt-4 text-3xl tracking-tight text-white md:text-5xl">
              Built for <em className="font-serif italic text-white/70">internal use</em>
            </h2>

            <ul className="mt-10 grid gap-5 sm:grid-cols-2 sm:gap-x-10">
              {TRUST_POINTS.map((point) => (
                <li key={point.text} className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white">
                    <point.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <p className="pt-2 text-sm leading-relaxed text-white/80">{point.text}</p>
                </li>
              ))}
            </ul>

            <motion.div {...press} className="mt-12 inline-block">
              <Button asChild size="lg" className="ring-offset-black" arrow>
                <Link to="/login">Sign in to {APP_NAME}</Link>
              </Button>
            </motion.div>
          </motion.div>
        </section>
      </main>

      {/* ---- Footer ------------------------------------------------------ */}
      <footer className="relative z-10 border-t border-white/10 bg-black/40 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-10 lg:flex-row lg:justify-between">
          <EpmLogo className="text-white [&_span[aria-hidden]]:bg-white/20" />
          <p className="order-last text-center text-2xs text-white/40 lg:order-none">
            © {new Date().getFullYear()} {ORG_NAME}. {APP_DESCRIPTOR}. Internal platform —
            authorised users only.
          </p>
          <ul className="flex items-center gap-6">
            <li>
              <Link
                to="/login"
                className="rounded text-xs text-white/50 transition-colors hover:text-white"
              >
                Sign in
              </Link>
            </li>
            {/* TODO: point these at the real support desk and status page once they exist. */}
            <li>
              <a
                href="#"
                className="rounded text-xs text-white/50 transition-colors hover:text-white"
              >
                Support
              </a>
            </li>
            <li>
              <a
                href="#"
                className="rounded text-xs text-white/50 transition-colors hover:text-white"
              >
                Status
              </a>
            </li>
          </ul>
        </div>
      </footer>

      <BackToTop />
    </div>
  );
}
