import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The brand band every signed-out screen sits on.
 *
 * The same crimson-to-violet sweep the site runs behind its calls to action.
 * Depth comes from two soft glows drawn from the gradient's own stops and a
 * faint grid. None of them carry meaning, so all three stay out of the
 * accessibility tree.
 *
 * Shared rather than copied: sign-in and "choose your password" are one
 * continuous moment for the person using them, and the second screen sitting on
 * a bare grey page read as a different, half-finished product.
 */
export function AuthBackdrop({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative flex min-h-screen flex-col overflow-hidden bg-brand-to',
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand-from via-highlight to-brand-to"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-[-16rem] h-[42rem] w-[42rem] rounded-full bg-white/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-48 bottom-[-18rem] h-[46rem] w-[46rem] rounded-full bg-brand-to/60 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07] [mask-image:radial-gradient(ellipse_at_50%_40%,black,transparent_75%)]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.9) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.9) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />

      {children}
    </div>
  );
}
