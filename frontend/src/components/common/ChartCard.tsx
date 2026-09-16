import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
 *
 * Built on `Card` with the compact header so a chart's title row is the same
 * one a table or list uses. The motion wrapper is the section landmark and
 * sits outside the card, so the card itself stays a plain surface.
 */
function ChartCard({ title, description, actions, height = 240, className, children }: ChartCardProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
      className={cn('min-w-0', className)}
    >
      <Card className="h-full">
        <CardHeader variant="compact" actions={actions}>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription className="text-2xs">{description}</CardDescription> : null}
        </CardHeader>
        <div className="p-3" style={{ height }}>
          {children}
        </div>
      </Card>
    </motion.section>
  );
}

function ChartCardSkeleton({ height = 240, className }: { height?: number; className?: string }) {
  return (
    <Card className={className} aria-hidden>
      <CardHeader variant="compact">
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <div className="flex items-end gap-2 p-4" style={{ height }}>
        {[60, 80, 45, 92, 70, 100, 55].map((value, index) => (
          <Skeleton key={index} className="flex-1" style={{ height: `${value}%` }} />
        ))}
      </div>
    </Card>
  );
}

export { ChartCard, ChartCardSkeleton };
