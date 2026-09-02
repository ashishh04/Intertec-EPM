import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { cn, formatNumber } from '@/lib/utils';
import { TONE_SOFT, type Tone } from '@/lib/domain';
import { TrendChip } from './StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import type { MetricTrend } from '@/types';

interface MetricCardProps {
  label: string;
  value: number | string;
  /** Short supporting line, e.g. "8 due this week". */
  support?: string;
  icon: LucideIcon;
  tone?: Tone;
  trend?: MetricTrend;
  suffix?: string;
  onClick?: () => void;
  className?: string;
}

/**
 * KPI tile. Clickable variants navigate to the filtered list behind the number,
 * so the metric is a route into the work rather than decoration.
 */
function MetricCard({
  label,
  value,
  support,
  icon: Icon,
  tone = 'primary',
  trend,
  suffix,
  onClick,
  className,
}: MetricCardProps) {
  const interactive = Boolean(onClick);

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
              onClick,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onClick?.();
                }
              },
            }
          : {})}
        className={cn(
          'group flex h-full flex-col justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm transition-all',
          interactive &&
            'cursor-pointer hover:border-primary/30 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="epm-eyebrow">{label}</span>
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
              TONE_SOFT[tone],
            )}
            aria-hidden
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        </div>

        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
            {typeof value === 'number' ? formatNumber(value) : value}
          </span>
          {suffix ? <span className="text-sm font-medium text-muted-foreground">{suffix}</span> : null}
        </div>

        <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1">
          {trend ? <TrendChip {...trend} /> : null}
          {support ? <span className="text-2xs text-muted-foreground">{support}</span> : null}
        </div>
      </div>
    </motion.div>
  );
}

function MetricCardSkeleton() {
  return (
    <div className="flex h-full flex-col justify-between gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-7 rounded-lg" />
      </div>
      <Skeleton className="h-7 w-16" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

export { MetricCard, MetricCardSkeleton };
