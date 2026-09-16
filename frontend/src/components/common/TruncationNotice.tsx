import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn, formatNumber, pluralize } from '@/lib/utils';

/**
 * Shown under a board, chart or timeline that was built from a capped page of
 * work packages. Silence here would mean the counts are wrong and nothing says
 * so. Renders nothing when everything is loaded.
 */
export function TruncationNotice({
  shown,
  total,
  itemLabel = 'task',
  onLoadMore,
  loading = false,
  step,
  /** What the reader should know the numbers cover, e.g. "The column counts". */
  affected = 'The figures',
  className,
}: {
  shown: number;
  total: number;
  itemLabel?: string;
  onLoadMore?: () => void;
  loading?: boolean;
  /** How many more will load on click; used for the button label. */
  step?: number;
  affected?: string;
  className?: string;
}) {
  const hidden = total - shown;
  if (hidden <= 0) return null;

  return (
    <Card
      className={cn('flex flex-wrap items-center justify-between gap-3 px-4 py-3', className)}
      role="status"
    >
      <p className="text-2xs text-muted-foreground">
        Showing{' '}
        <span className="font-mono font-medium tabular-nums text-foreground">
          {formatNumber(shown)}
        </span>{' '}
        of{' '}
        <span className="font-mono font-medium tabular-nums text-foreground">
          {formatNumber(total)}
        </span>{' '}
        {pluralize(total, itemLabel)}. {affected} cover what is loaded.
      </p>
      {onLoadMore ? (
        <Button size="sm" variant="secondary" disabled={loading} onClick={onLoadMore}>
          {loading ? 'Loading…' : `Load ${formatNumber(Math.min(hidden, step ?? hidden))} more`}
        </Button>
      ) : null}
    </Card>
  );
}
