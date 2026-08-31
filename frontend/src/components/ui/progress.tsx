import * as React from 'react';
import { cn } from '@/lib/utils';
import { TONE_FILL, type Tone } from '@/lib/domain';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  tone?: Tone;
  size?: 'xs' | 'sm' | 'default' | 'lg';
  /** Accessible name, e.g. "Sprint progress". */
  label?: string;
  animated?: boolean;
}

const HEIGHT = { xs: 'h-1', sm: 'h-1.5', default: 'h-2', lg: 'h-2.5' } as const;

/** Determinate progress bar with an animated fill and a proper ARIA role. */
function ProgressBar({
  value,
  tone = 'primary',
  size = 'default',
  label,
  animated = true,
  className,
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('w-full overflow-hidden rounded-full bg-border/70', HEIGHT[size], className)}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full',
          TONE_FILL[tone],
          animated && 'transition-[width] duration-700 ease-swift',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export { ProgressBar };
