import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CircleAlert, CircleCheck, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/domain';

type AlertTone = Extract<Tone, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'>;

const TONE_CLASS: Record<AlertTone, { box: string; icon: string }> = {
  neutral: { box: 'border-border bg-muted/60', icon: 'text-muted-foreground' },
  primary: { box: 'border-primary/20 bg-primary-soft', icon: 'text-primary' },
  success: { box: 'border-success/25 bg-success-soft', icon: 'text-success' },
  warning: { box: 'border-warning/25 bg-warning-soft', icon: 'text-warning' },
  danger: { box: 'border-danger/25 bg-danger-soft', icon: 'text-danger' },
};

const TONE_ICON: Record<AlertTone, LucideIcon> = {
  neutral: Info,
  primary: Info,
  success: CircleCheck,
  warning: AlertTriangle,
  danger: CircleAlert,
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone;
  /** Short bold lead-in. Optional: most notices are one sentence. */
  title?: string;
  /** Overrides the tone's default icon. Pass `null` to drop the icon. */
  icon?: LucideIcon | null;
  /** Controls aligned to the end, e.g. a retry or dismiss button. */
  actions?: React.ReactNode;
}

/**
 * Inline notice. One shape for every "you should know this" block in the
 * product — refusal reasons, environment warnings, security notes — so they
 * read as a family rather than as hand-built boxes.
 */
function Alert({
  tone = 'neutral',
  title,
  icon,
  actions,
  className,
  children,
  ...props
}: AlertProps) {
  const Icon = icon === undefined ? TONE_ICON[tone] : icon;
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-3 text-xs',
        TONE_CLASS[tone].box,
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_CLASS[tone].icon)} aria-hidden />
      ) : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        <div className={cn('leading-relaxed', title ? 'text-muted-foreground' : 'text-foreground')}>
          {children}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export { Alert };
