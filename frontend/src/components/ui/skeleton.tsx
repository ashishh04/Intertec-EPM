import { cn } from '@/lib/utils';

/** Base shimmer block. Compose these into page-shaped loading states. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('relative overflow-hidden rounded-md bg-muted skeleton-shimmer', className)}
      {...props}
    />
  );
}

/** Screen-reader announcement paired with a visual skeleton. */
function LoadingAnnouncement({ label }: { label: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );
}

export { Skeleton, LoadingAnnouncement };
