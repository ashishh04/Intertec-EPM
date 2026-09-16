import { motion } from 'framer-motion';
import { TimelinePlate } from './plates/TimelinePlate';
import { useLandingMotion } from './useLandingMotion';

/**
 * The wide plate, with the page's thesis floating on glass over it. Pairs with
 * AboutSection above — that one states what EPM is, this one says why it is
 * built the way it is, over a schedule doing exactly what the copy describes.
 */
export function FeaturedTimelineSection() {
  const { reveal, press } = useLandingMotion();

  return (
    <section className="overflow-hidden px-6 pb-20 pt-6 md:pb-32 md:pt-10">
      <motion.div
        {...reveal(0, 0.9, { y: 60 })}
        className="relative mx-auto aspect-video max-w-6xl overflow-hidden rounded-3xl"
      >
        <TimelinePlate />

        {/* Darkens the foot of the plate so the card below never loses its
            edges against a bar passing underneath. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"
        />

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-6 p-6 md:flex-row md:items-end md:justify-between md:p-10">
          <div className="liquid-glass max-w-md rounded-2xl p-6 md:p-8">
            <p className="mb-3 text-xs uppercase tracking-widest text-white/50">Our approach</p>
            <p className="text-sm leading-relaxed text-white md:text-base">
              Delivery rarely fails in the plan — it fails in the gaps between the people running
              it. EPM closes them: one record from portfolio down to task, shared by everyone who
              touches the work.
            </p>
          </div>

          <motion.a
            {...press}
            href="#capabilities"
            className="liquid-glass shrink-0 self-start rounded-full px-8 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-white/5 md:self-auto"
          >
            Explore the platform
          </motion.a>
        </div>
      </motion.div>
    </section>
  );
}
