import { motion } from 'framer-motion';
import { ArrowUpRight, Info } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { MeasureResult } from '@/types';
import { formatMeasure } from './format';

/**
 * One measure of the semantic layer as a tile (BR-404).
 *
 * The definition sits behind the info mark: what the figure counts, word for
 * word as the catalogue defines it, so nobody has to guess whether "overdue"
 * includes today. A measure with members opens on them — the drill-through
 * (BR-405) — and says so with the arrow. A value that is not there says why,
 * instead of showing a zero.
 */
export function MeasureTile({
  measure,
  onOpen,
  className,
}: {
  measure: MeasureResult;
  /** Opens the items behind the value; omitted for a figure with none. */
  onOpen?: () => void;
  className?: string;
}) {
  const interactive = Boolean(onOpen && measure.memberKind && measure.applicable && measure.value !== null);
  const missing = measure.value === null;

  return (
    <motion.div
      whileHover={interactive ? { y: -2 } : undefined}
      transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
      className={cn('h-full', className)}
    >
      <div
        {...(interactive
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${measure.label}: ${formatMeasure(measure.value, measure.unit)}. Show what is behind it`,
              onClick: onOpen,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen?.();
                }
              },
            }
          : {})}
        className={cn(
          'group flex h-full flex-col justify-between gap-2 rounded-lg border border-border bg-surface p-4 transition-all',
          interactive &&
            'cursor-pointer hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="epm-eyebrow">{measure.label}</span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <InfoTooltip label={measure.definition}>
              <span
                tabIndex={0}
                aria-label={`How ${measure.label} is defined`}
                className="rounded p-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => event.stopPropagation()}
              >
                <Info className="h-3.5 w-3.5" />
              </span>
            </InfoTooltip>
            {interactive ? (
              <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            ) : null}
          </span>
        </div>

        <span
          className={cn(
            'whitespace-nowrap font-display font-bold tracking-[-0.03em] tabular-nums',
            // A long figure — a negative sum of money — steps down rather than wrap its sign onto a line of its own.
            formatMeasure(measure.value, measure.unit).length > 11 ? 'text-xl' : 'text-2xl',
            missing ? 'text-muted-foreground' : 'text-primary',
          )}
        >
          {formatMeasure(measure.value, measure.unit)}
        </span>

        <p className="min-h-4 text-2xs leading-snug text-muted-foreground">{measure.note ?? partsLine(measure)}</p>
      </div>
    </motion.div>
  );
}

/** The figures a value was made from, where they help read it: "3 met, 1 missed". */
function partsLine(measure: MeasureResult): string {
  const parts = measure.parts ?? {};
  switch (measure.id) {
    case 'milestones.onTime':
      return `${parts.met ?? 0} met, ${parts.missed ?? 0} missed`;
    case 'health.greenPct':
      return `${parts.green ?? 0} of ${parts.assessed ?? 0} assessed projects`;
    case 'utilisation':
      return `${formatMeasure(parts.logged ?? 0, 'hours')} of ${formatMeasure(parts.capacity ?? 0, 'hours')}`;
    case 'work.progress':
      return `${parts.closed ?? 0} of ${parts.total ?? 0} closed`;
    case 'work.throughput':
      return `${parts.delivered ?? 0} delivered`;
    case 'cost.actual':
      return parts.uncostedHours ? `${formatMeasure(parts.uncostedHours, 'hours')} not costed` : '';
    case 'budget.consumed':
      return `${formatMeasure(parts.actual ?? 0, 'money')} of ${formatMeasure(parts.budget ?? 0, 'money')}`;
    case 'sprint.velocity':
      return `over ${parts.sprints ?? 0} sprint${parts.sprints === 1 ? '' : 's'}`;
    case 'evm.pv':
    case 'evm.ev':
      return `of ${formatMeasure(parts.bac ?? 0, 'money')} budget`;
    case 'evm.eac':
      return `against ${formatMeasure(parts.bac ?? 0, 'money')} budget`;
    case 'evm.spi':
      return measure.value === null ? '' : measure.value < 1 ? 'behind plan' : 'on or ahead of plan';
    case 'evm.cpi':
      return measure.value === null ? '' : measure.value < 1 ? 'over cost' : 'on or under cost';
    case 'evm.tcpi':
      return measure.value === null ? '' : measure.value > 1 ? 'harder than planned' : 'within the plan';
    default:
      return '';
  }
}

export function MeasureTileSkeleton() {
  return (
    <div className="flex h-full flex-col justify-between gap-3 rounded-lg border border-border bg-surface p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-16" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}
