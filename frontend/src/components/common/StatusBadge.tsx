import { ArrowDown, ArrowUp, Minus, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  HEALTH_META,
  PROJECT_STATUS_META,
  SPRINT_STATE_META,
  TASK_PRIORITY_META,
  TASK_STATUS_META,
  TASK_TYPE_META,
  TONE_FILL,
  TONE_TEXT,
  type Tone,
} from '@/lib/domain';
import type {
  HealthLevel,
  ProjectStatus,
  SprintState,
  TaskPriority,
  TaskStatusCategory,
  TaskType,
} from '@/types';

export function StatusBadge({
  status,
  label,
  size = 'default',
  className,
}: {
  /** Drives the tone. EPM's progress category, not the workflow status. */
  status: TaskStatusCategory;
  /**
   * Text to show instead of the category's own label.
   *
   * Surfaces that display a specific work package pass OpenProject's actual
   * status name here, so the badge reads "In specification" while still being
   * coloured by the category it belongs to. Aggregate surfaces — boards,
   * charts — omit it and show the category, which is what they group by.
   */
  label?: string;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const meta = TASK_STATUS_META[status];
  return (
    <Badge
      tone={meta.tone}
      size={size}
      dot
      className={className}
      // When a real status is shown, the category becomes the explanation of
      // the colour rather than the label itself.
      title={label ? `${meta.label} — ${meta.description}` : meta.description}
    >
      {label ?? meta.label}
    </Badge>
  );
}

export function ProjectStatusBadge({
  status,
  size = 'default',
  className,
}: {
  status: ProjectStatus;
  size?: 'sm' | 'default';
  className?: string;
}) {
  const meta = PROJECT_STATUS_META[status];
  return (
    <Badge tone={meta.tone} size={size} dot className={className} title={meta.description}>
      {meta.label}
    </Badge>
  );
}

/**
 * Priority is expressed with a bar glyph as well as colour, so it stays legible
 * for colour-blind users and in monochrome print.
 */
export function PriorityBadge({
  priority,
  variant = 'inline',
  className,
}: {
  priority: TaskPriority;
  variant?: 'inline' | 'badge';
  className?: string;
}) {
  const meta = TASK_PRIORITY_META[priority];
  const bars = 4 - meta.rank;

  if (variant === 'badge') {
    return (
      <Badge tone={meta.tone} size="sm" className={className}>
        {priority === 'critical' ? <ShieldAlert className="h-3 w-3" aria-hidden /> : null}
        {meta.label}
      </Badge>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1.5', TONE_TEXT[meta.tone], className)}
      title={`${meta.label} priority`}
    >
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={cn(
              'w-[3px] rounded-[1px]',
              index < bars ? TONE_FILL[meta.tone] : 'bg-border',
              index === 0 ? 'h-1.5' : index === 1 ? 'h-2' : index === 2 ? 'h-2.5' : 'h-3',
            )}
          />
        ))}
      </span>
      <span className="text-2xs font-medium">{meta.label}</span>
    </span>
  );
}

export function TypeBadge({ type, className }: { type: TaskType; className?: string }) {
  const meta = TASK_TYPE_META[type];
  return (
    <Badge tone={meta.tone} size="sm" className={className}>
      {meta.label}
    </Badge>
  );
}

export function SprintStateBadge({ state, className }: { state: SprintState; className?: string }) {
  const meta = SPRINT_STATE_META[state];
  return (
    <Badge tone={meta.tone} size="sm" dot className={className}>
      {meta.label}
    </Badge>
  );
}

/** Health indicator that pairs a coloured dot with an explicit word. */
export function HealthIndicator({
  level,
  label,
  className,
}: {
  level: HealthLevel;
  label?: string;
  className?: string;
}) {
  const meta = HEALTH_META[level];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_FILL[meta.tone])} aria-hidden />
      <span className={cn('font-medium', TONE_TEXT[meta.tone])}>{label ?? meta.label}</span>
    </span>
  );
}

/** Trend chip used on metric cards. */
export function TrendChip({
  changePct,
  direction,
  positiveIsUp,
  periodLabel,
  className,
}: {
  changePct: number;
  direction: 'up' | 'down' | 'flat';
  positiveIsUp: boolean;
  periodLabel?: string;
  className?: string;
}) {
  const isGood = direction === 'flat' ? true : (direction === 'up') === positiveIsUp;
  const tone: Tone = direction === 'flat' ? 'neutral' : isGood ? 'success' : 'danger';
  const Icon = direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus;

  return (
    <span className={cn('inline-flex items-center gap-1 text-2xs font-medium', className)}>
      <span className={cn('inline-flex items-center gap-0.5', TONE_TEXT[tone])}>
        <Icon className="h-3 w-3" aria-hidden />
        {direction === 'flat' ? 'No change' : `${Math.abs(changePct)}%`}
      </span>
      {periodLabel ? <span className="text-muted-foreground">{periodLabel}</span> : null}
    </span>
  );
}
