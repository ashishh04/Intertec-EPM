import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { TONE_FILL, TONE_SOFT, type Tone } from '@/lib/domain';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors whitespace-nowrap',
  {
    variants: {
      size: {
        sm: 'px-1.5 py-0.5 text-2xs',
        default: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

/** Filled counterpart of `TONE_SOFT`, for counters that must stand out. */
const TONE_SOLID: Record<Tone, string> = {
  neutral: 'border-transparent bg-neutral text-white',
  primary: 'border-transparent bg-primary text-primary-foreground',
  success: 'border-transparent bg-success text-success-foreground',
  warning: 'border-transparent bg-warning text-warning-foreground',
  danger: 'border-transparent bg-danger text-danger-foreground',
  accent: 'border-transparent bg-accent text-accent-foreground',
  highlight: 'border-transparent bg-highlight text-highlight-foreground',
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  tone?: Tone;
  /** `solid` fills the pill; reserved for counters and unread markers. */
  variant?: 'soft' | 'solid';
  /** Renders a leading dot so state is legible without relying on colour. */
  dot?: boolean;
}

/**
 * Soft status pill used across the product. Always renders a readable text
 * label, so colour is reinforcement rather than the only signal.
 */
function Badge({
  className,
  tone = 'neutral',
  variant = 'soft',
  size,
  dot = false,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        badgeVariants({ size }),
        variant === 'solid' ? TONE_SOLID[tone] : TONE_SOFT[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_FILL[tone])} aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

/**
 * Small round counter — unread notifications, active filters. Renders nothing
 * at zero so callers do not have to guard it.
 */
function CountBadge({
  count,
  max = 99,
  tone = 'danger',
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> & {
  count: number;
  max?: number;
  tone?: Tone;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-2xs font-semibold tabular-nums leading-none',
        TONE_SOLID[tone],
        className,
      )}
      {...props}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}

export { Badge, CountBadge, badgeVariants };
