import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Rendered above the title, e.g. a project code or portfolio name. */
  eyebrow?: React.ReactNode;
  /** Badges or metadata shown beside the title. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/** Consistent page-level heading block used by every route. */
function PageHeader({ title, description, eyebrow, meta, actions, className }: PageHeaderProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? <div className="epm-eyebrow">{eyebrow}</div> : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-display text-xl font-bold tracking-[-0.03em] text-foreground">{title}</h1>
          {meta}
        </div>
        {description ? (
          <p className="max-w-2xl text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </motion.header>
  );
}

/** Smaller heading used for sections within a page. */
function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="font-display text-sm font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export { PageHeader, SectionHeader };
