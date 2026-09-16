import * as React from 'react';
import { cn } from '@/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // Flat white on a hairline, the way the brand sets its cards. Depth is
    // reserved for things that genuinely float above the page.
    <div
      ref={ref}
      className={cn('rounded-lg border border-border bg-surface text-foreground', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * `compact` is the title row used on data cards — tables, charts, lists —
   * where the header is a label for the content below it rather than a block
   * of its own. It draws a divider so the content starts on its own surface.
   */
  variant?: 'default' | 'compact';
  /** Controls aligned to the end of the header, opposite the title. */
  actions?: React.ReactNode;
}

const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, variant = 'default', actions, children, ...props }, ref) => {
    const body = (
      <div className={cn('flex min-w-0 flex-col', variant === 'compact' ? 'gap-0.5' : 'gap-1')}>
        {children}
      </div>
    );

    return (
      <div
        ref={ref}
        className={cn(
          variant === 'compact'
            ? 'flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3'
            : actions
              ? 'flex flex-wrap items-start justify-between gap-3 p-5'
              : 'flex flex-col gap-1 p-5',
          className,
        )}
        {...props}
      >
        {actions || variant === 'compact' ? body : children}
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    );
  },
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('font-display text-sm font-semibold tracking-[-0.02em]', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-5 pt-0', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-2 p-5 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
