import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface ChartCardProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Fixed chart height so the responsive container has something to fill. */
  height?: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * Wrapper for every chart on the platform. Animates in when it enters the
 * viewport, once, so dashboards feel alive without becoming distracting.
 */
function ChartCard({ title, description, actions, height = 240, className, children }: ChartCardProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
      className={cn('rounded-xl border border-border bg-surface shadow-sm', className)}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-2xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className="p-3" style={{ height }}>
        {children}
      </div>
    </motion.section>
  );
}

function ChartCardSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="flex items-end gap-2 p-4" style={{ height }}>
        {[60, 80, 45, 92, 70, 100, 55].map((value, index) => (
          <Skeleton key={index} className="flex-1" style={{ height: `${value}%` }} />
        ))}
      </div>
    </div>
  );
}

export { ChartCard, ChartCardSkeleton };
