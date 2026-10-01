import { motion } from 'framer-motion';
import { Briefcase, Check, ClipboardList, Compass, Code2 } from 'lucide-react';
import { useLandingMotion } from './useLandingMotion';

/*
 * Four seats, because the page is read by all four and each one arrives
 * looking for a different screen. The lines under each are routes that exist
 * in the signed-in app — portfolios, capacity, the Gantt, My Work, timesheets
 * — so nobody follows a promise here to a page that isn't there.
 */
const SEATS = [
  {
    icon: Briefcase,
    seat: 'Executives & portfolio owners',
    promise: 'The position, without asking for it',
    points: [
      'Portfolio health rolled up from the work, not from a status call',
      'Budget and spend against the dates given to the customer',
      'Scheduled reports that arrive before the meeting does',
    ],
  },
  {
    icon: ClipboardList,
    seat: 'PMO & delivery managers',
    promise: 'One record to govern',
    points: [
      'Every project to the same shape, with the same fields filled in',
      'Capacity and allocation across teams and departments',
      'Risk, dependency and slip visible at the level it was promised at',
    ],
  },
  {
    icon: Compass,
    seat: 'Project managers',
    promise: 'Plan and reality in the same view',
    points: [
      'Schedule, dependencies and sprints on one timeline',
      'Who is loaded, who is free, and what moves if a date does',
      'Documents and decisions attached to the work they belong to',
    ],
  },
  {
    icon: Code2,
    seat: 'Engineers & consultants',
    promise: 'What you owe today, and nothing else',
    points: [
      'A single queue across every project you are on',
      'Boards and sprints you update once, not twice',
      'Time logged against the task rather than reconstructed on Friday',
    ],
  },
];

/**
 * Who the platform is for.
 *
 * Sits directly after the capability grid on purpose: that section answers
 * "is my part of delivery in here", this one answers "and what do I get on
 * the first morning". Same four-claim shape per seat, so the cards can be
 * compared rather than read end to end.
 */
export function RolesSection() {
  const { reveal } = useLandingMotion();

  return (
    <section id="roles" className="relative scroll-mt-24 overflow-hidden px-6 pb-28 md:pb-40">
      <div className="mx-auto max-w-6xl">
        <motion.div {...reveal(0, 0.7, { y: 30 })}>
          <p className="text-xs uppercase tracking-widest text-white/40">Who it&apos;s for</p>
          <h2 className="mt-4 text-3xl tracking-tight text-white md:text-5xl">
            Four seats, <em className="font-serif italic text-white/50">one record</em>
          </h2>
        </motion.div>

        <div className="mt-12 grid gap-6 md:grid-cols-2 md:gap-8">
          {SEATS.map((seat, index) => (
            <motion.article
              key={seat.seat}
              {...reveal(index * 0.08)}
              className="liquid-glass flex flex-col rounded-3xl p-7 transition-colors hover:bg-white/[0.04] md:p-9"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-white">
                <seat.icon className="h-4.5 w-4.5" aria-hidden />
              </span>

              <p className="mt-6 text-xs uppercase tracking-widest text-white/40">{seat.seat}</p>
              <h3 className="mt-3 text-xl tracking-tight text-white md:text-2xl">
                {seat.promise}
              </h3>

              <ul className="mt-7 space-y-3.5">
                {seat.points.map((point) => (
                  <li key={point} className="flex items-start gap-3">
                    {/* The tick is the only mark on the page that reads as a
                        guarantee, so it carries the brand violet rather than
                        the grey everything else in a list gets. */}
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-brand-to"
                      strokeWidth={2.5}
                      aria-hidden
                    />
                    <p className="text-sm leading-relaxed text-white/60">{point}</p>
                  </li>
                ))}
              </ul>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
