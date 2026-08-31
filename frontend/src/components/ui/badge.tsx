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

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  tone?: Tone;
  /** Renders a leading dot so state is legible without relying on colour. */
  dot?: boolean;
}

/**
 * Soft status pill used across the product. Always renders a readable text
 * label, so colour is reinforcement rather than the only signal.
 */
function Badge({ className, tone = 'neutral', size, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ size }), TONE_SOFT[tone], className)} {...props}>
      {dot ? (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_FILL[tone])} aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
