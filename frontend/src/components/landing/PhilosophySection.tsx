import { motion } from 'framer-motion';
import { CapacityPlate } from './plates/CapacityPlate';
import { useLandingMotion } from './useLandingMotion';

const BLOCKS = [
  {
    label: 'Plan with intent',
    body: 'Every commitment begins somewhere — a portfolio decision, a budget, a date given to a customer. EPM keeps that thread intact from the portfolio down to the task, so a slip three levels down is visible to the person who made the promise.',
  },
  {
    label: 'Deliver with evidence',
    body: 'Status is only worth having if it comes from the work itself. Boards, sprints, timesheets and documents all write to the same record, so velocity, health and capacity are read from delivery rather than reassembled for a meeting.',
  },
];

/**
 * The page's midpoint. Footage on one side, the two halves of the argument on
 * the other — planning and evidence, which is the whole product in two
 * paragraphs.
 */
export function PhilosophySection() {
  const { reveal } = useLandingMotion();

  return (
    <section className="overflow-hidden px-6 py-28 md:py-40">
      <div className="mx-auto max-w-6xl">
        <motion.h2
          {...reveal()}
          className="mb-16 text-5xl tracking-tight text-white md:mb-24 md:text-7xl lg:text-8xl"
        >
          Plan <em className="font-serif italic text-white/40">×</em> Deliver
        </motion.h2>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:gap-12">
          {/* The plate is lifted off the page rather than cut into it: a deep,
              soft shadow and a hairline, so it reads as a panel of the product
              sitting on the page. */}
          <motion.div
            {...reveal(0, 0.8, { x: -40 })}
            className="aspect-[4/3] overflow-hidden rounded-3xl shadow-[0_40px_90px_-40px_rgba(0,0,0,0.95)] ring-1 ring-white/10"
          >
            <CapacityPlate />
          </motion.div>

          <motion.div
            {...reveal(0, 0.8, { x: 40 })}
            className="flex flex-col justify-center gap-10"
          >
            {BLOCKS.map((block, index) => (
              <div key={block.label}>
                {index > 0 ? <div aria-hidden className="mb-10 h-px w-full bg-white/10" /> : null}
                <p className="mb-4 text-xs uppercase tracking-widest text-white/40">
                  {block.label}
                </p>
                <p className="text-base leading-relaxed text-white/70 md:text-lg">{block.body}</p>
              </div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
