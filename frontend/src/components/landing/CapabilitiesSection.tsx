import { motion } from 'framer-motion';
import {
  ArrowUpRight,
  Bell,
  FileText,
  FolderKanban,
  GanttChartSquare,
  KanbanSquare,
  Layers,
  ListChecks,
  TrendingUp,
  Users,
} from 'lucide-react';
import { BoardPlate } from './plates/BoardPlate';
import { PortfolioPlate } from './plates/PortfolioPlate';
import { useLandingMotion } from './useLandingMotion';

const CARDS = [
  {
    tag: 'Plan',
    title: 'Portfolios, projects & schedules',
    body: 'Scope, budget, dependencies and dates in one place, rolled up so portfolio health is a consequence of the work rather than a slide assembled on Thursday.',
    Plate: PortfolioPlate,
  },
  {
    tag: 'Deliver',
    title: 'Boards, sprints & reporting',
    body: 'Backlogs, sprint execution and velocity written to the same record the Gantt, the capacity view and the board report all read from.',
    Plate: BoardPlate,
  },
];

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
  { icon: ListChecks, title: 'Tasks & My Work', body: 'A single queue of what each person owes today.' },
  { icon: KanbanSquare, title: 'Agile boards & sprints', body: 'Backlogs, boards and sprint execution.' },
  { icon: GanttChartSquare, title: 'Gantt & calendar', body: 'Dependencies and dates, planned against reality.' },
  { icon: Users, title: 'Teams, departments & people', body: 'Capacity and allocation across the org.' },
  { icon: FileText, title: 'Documents', body: 'Delivery artefacts attached where the work lives.' },
  { icon: TrendingUp, title: 'Reports & analytics', body: 'Velocity, health and trend, scheduled or on demand.' },
  {
    icon: Bell,
    title: 'Notifications',
    body: 'Watchers, mentions and escalations routed to the right people.',
  },
];

/**
 * What the platform actually covers: two cards for the halves people come
 * looking for, then the full surface as a grid so nobody has to guess whether
 * their part of delivery is in here.
 */
export function CapabilitiesSection() {
  const { reveal } = useLandingMotion();

  return (
    <section id="capabilities" className="relative scroll-mt-24 overflow-hidden px-6 py-28 md:py-40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_hsl(var(--brand-from)/0.1)_0%,_transparent_60%)]"
      />

      <div className="relative mx-auto max-w-6xl">
        <motion.div {...reveal(0, 0.7, { y: 30 })} className="flex items-end justify-between gap-6">
          <h2 className="text-3xl tracking-tight text-white md:text-5xl">
            What&apos;s <em className="font-serif italic text-white/50">inside</em>
          </h2>
          <p className="hidden text-sm text-white/40 md:block">The platform</p>
        </motion.div>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-8">
          {CARDS.map((card, index) => (
            <motion.article
              key={card.tag}
              {...reveal(index * 0.15)}
              className="liquid-glass group rounded-3xl"
            >
              <div className="relative aspect-video overflow-hidden">
                <div className="h-full w-full transition-transform duration-700 group-hover:scale-105">
                  <card.Plate />
                </div>
                <div
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent"
                />
              </div>

              <div className="p-6 md:p-8">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-xs uppercase tracking-widest text-white/40">{card.tag}</p>
                  <span aria-hidden className="liquid-glass rounded-full p-2 text-white">
                    <ArrowUpRight className="h-4 w-4" />
                  </span>
                </div>
                <h3 className="mb-3 mt-4 text-xl tracking-tight text-white md:text-2xl">
                  {card.title}
                </h3>
                <p className="text-sm leading-relaxed text-white/50">{card.body}</p>
              </div>
            </motion.article>
          ))}
        </div>

        <ul className="mt-6 grid gap-4 sm:grid-cols-2 md:mt-8 lg:grid-cols-3">
          {CAPABILITIES.map((capability, index) => (
            <motion.li
              key={capability.title}
              // The stagger is capped: past the sixth tile the delay stops
              // reading as sequence and starts reading as lag.
              {...reveal(Math.min(index, 5) * 0.05, 0.6, { y: 24 })}
              className="liquid-glass rounded-2xl p-5 transition-colors hover:bg-white/[0.04]"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
                <capability.icon className="h-4.5 w-4.5" aria-hidden />
              </span>
              <h3 className="mt-4 text-sm font-semibold tracking-tight text-white">
                {capability.title}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-white/50">{capability.body}</p>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}
