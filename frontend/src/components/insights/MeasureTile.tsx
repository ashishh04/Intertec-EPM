import { motion } from 'framer-motion';
import { ArrowUpRight, Info } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
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
              'aria-label': t('{label}: {value}. Show what is behind it', {
                label: measure.label,
                value: formatMeasure(measure.value, measure.unit),
              }),
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
                aria-label={t('How {label} is defined', { label: measure.label })}
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
            'font-display text-2xl font-bold tracking-[-0.03em] tabular-nums',
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
      return t('{met, number} met, {missed, number} missed', { met: parts.met ?? 0, missed: parts.missed ?? 0 });
    case 'health.greenPct':
      return t('{green, number} of {assessed, number} assessed projects', {
        green: parts.green ?? 0,
        assessed: parts.assessed ?? 0,
      });
    case 'utilisation':
      return t('{logged} of {capacity}', {
        logged: formatMeasure(parts.logged ?? 0, 'hours'),
        capacity: formatMeasure(parts.capacity ?? 0, 'hours'),
      });
    case 'work.progress':
      return t('{closed, number} of {total, number} closed', { closed: parts.closed ?? 0, total: parts.total ?? 0 });
    case 'work.throughput':
      return t('{delivered, number} delivered', { delivered: parts.delivered ?? 0 });
    case 'cost.actual':
      return parts.uncostedHours
        ? t('{hours} not costed', { hours: formatMeasure(parts.uncostedHours, 'hours') })
        : '';
    case 'budget.consumed':
      return t('{actual} of {budget}', {
        actual: formatMeasure(parts.actual ?? 0, 'money'),
        budget: formatMeasure(parts.budget ?? 0, 'money'),
      });
    case 'sprint.velocity':
      return t('{sprints, plural, one {over # sprint} other {over # sprints}}', { sprints: parts.sprints ?? 0 });
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
