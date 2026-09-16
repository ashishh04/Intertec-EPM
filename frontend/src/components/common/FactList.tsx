import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface Fact {
  label: string;
  value: ReactNode;
  /** Values that are identifiers, dates or numbers read better in mono. */
  mono?: boolean;
}

/**
 * Label / value rows for settings and detail panels. The same block appears in
 * administration, integration status and project details, so it lives here.
 */
export function FactList({
  facts,
  className,
  emptyLabel = 'Nothing to show',
}: {
  facts: Fact[];
  className?: string;
  emptyLabel?: string;
}) {
  if (facts.length === 0) {
    return <p className={cn('text-xs text-muted-foreground', className)}>{emptyLabel}</p>;
  }

  return (
    <dl className={cn('divide-y divide-border rounded-lg border border-border', className)}>
      {facts.map((fact) => (
        <div
          key={fact.label}
          className="flex items-start justify-between gap-4 px-3 py-2.5 sm:items-center"
        >
          <dt className="shrink-0 text-xs text-muted-foreground">{fact.label}</dt>
          <dd
            className={cn(
              'min-w-0 text-right text-xs text-foreground',
              fact.mono !== false && 'font-mono text-2xs tabular-nums',
            )}
          >
            {fact.value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}
