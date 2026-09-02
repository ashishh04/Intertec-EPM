import { cn } from '@/lib/utils';
import { APP_DESCRIPTOR, APP_NAME, ORG_NAME } from '@/config/env';

/**
 * EPM mark: an "E" with connected orbit nodes, expressing the product idea of
 * a central connection point between projects, people and delivery.
 */
function EpmMark({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={`${APP_NAME} mark`}
      className={cn('h-8 w-8', className)}
      {...props}
    >
      <rect width="64" height="64" rx="14" className="fill-primary" />
      <path d="M20 19h22v5.2H25.6v5.2H38v5.2H25.6v5.2H42V45H20V19Z" className="fill-primary-foreground" />
      <circle cx="47" cy="20" r="4.5" className="fill-accent" />
      <circle cx="17" cy="44" r="3" className="fill-accent/75" />
    </svg>
  );
}

interface EpmLogoProps {
  /** `full` shows the wordmark and organization, `compact` is the mark alone. */
  variant?: 'full' | 'compact';
  className?: string;
  showDescriptor?: boolean;
}

function EpmLogo({ variant = 'full', className, showDescriptor = false }: EpmLogoProps) {
  if (variant === 'compact') {
    return <EpmMark className={cn('h-8 w-8', className)} />;
  }

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <EpmMark className="h-8 w-8 shrink-0" />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold leading-tight tracking-tight">{APP_NAME}</div>
        <div className="truncate text-2xs leading-tight text-muted-foreground">
          {showDescriptor ? APP_DESCRIPTOR : ORG_NAME}
        </div>
      </div>
    </div>
  );
}

export { EpmLogo, EpmMark };
