import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The shared ground under every motion plate.
 *
 * Near-black with a delivery grid — days across, weeks down — and two brand
 * blooms so the plates belong to the same page as the glass above them. The
 * lit top edge and inset hairline are what stop a plate reading as a flat
 * black rectangle with things drawn on it: they give it a surface, the same
 * way the liquid-glass panes elsewhere on the page have one.
 *
 * Plates are decoration — the section copy beside each one says what it shows
 * in words — so the whole frame stays out of the accessibility tree.
 */
export function PlateFrame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      aria-hidden
      className={cn(
        'relative h-full w-full overflow-hidden bg-[#06060a] ring-1 ring-inset ring-white/[0.07]',
        className,
      )}
    >
      <div className="epm-plate-grid absolute inset-0 opacity-70" />
      <div className="absolute inset-0 bg-[radial-gradient(75%_65%_at_50%_115%,hsl(var(--brand-to)/0.38)_0%,transparent_72%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(45%_55%_at_8%_-10%,hsl(var(--brand-from)/0.22)_0%,transparent_70%)]" />

      {/* The light falling on the top of the pane. */}
      <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/[0.055] to-transparent" />

      {children}

      {/* Keeps the composition off its own edges, so a plate cropped by a
          rounded corner still reads as a frame rather than as a cut-off chart. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_50%,transparent_55%,rgba(0,0,0,0.55)_100%)]" />
    </div>
  );
}
