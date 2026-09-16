import { motion } from 'framer-motion';
import { useLandingMotion } from './useLandingMotion';

/**
 * The first thing below the fold: one editorial sentence saying what the
 * platform is for. Deliberately a single idea and no controls — the hero has
 * just asked for a decision, and this is the page drawing breath.
 *
 * The serif italic is the accent voice throughout the page: Poppins carries
 * the statement, Instrument Serif carries the part worth dwelling on.
 */
export function AboutSection() {
  const { reveal } = useLandingMotion();

  return (
    <section className="relative overflow-hidden px-6 pb-10 pt-32 md:pb-14 md:pt-44">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_hsl(var(--brand-to)/0.14)_0%,_transparent_70%)]"
      />

      <div className="relative mx-auto max-w-6xl">
        <motion.p
          {...reveal(0, 0.6, { y: 20 })}
          className="text-sm uppercase tracking-widest text-white/40"
        >
          About EPM
        </motion.p>

        <motion.h2
          {...reveal(0.1)}
          className="mt-8 text-4xl leading-[1.1] tracking-tight text-white md:text-6xl lg:text-7xl"
        >
          One record for <em className="font-serif italic text-white/60">every project</em>, and for
          <br className="hidden md:block" /> every team that{' '}
          <em className="font-serif italic text-white/60">plans, builds and reports on it.</em>
        </motion.h2>
      </div>
    </section>
  );
}
