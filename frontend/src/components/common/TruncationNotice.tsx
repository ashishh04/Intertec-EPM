import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn, formatNumber, pluralize } from '@/lib/utils';

/**
 * Shown under a board, chart or timeline that was built from a capped page of
 * work packages. Silence here would mean the counts are wrong and nothing says
 * so. Renders nothing when everything is loaded.
 */
export function TruncationNotice({
  shown,
  total,
  itemLabel,
  itemLabelPlural,
  onLoadMore,
  loading = false,
  step,
  /** What the reader should know the numbers cover, e.g. "The column counts". */
  affected = t('The figures'),
  className,
}: {
  shown: number;
  total: number;
  /** Singular noun, translated by the caller. Omit for tasks, the default. */
  itemLabel?: string;
  /** Plural form of `itemLabel`, translated by the caller. */
  itemLabelPlural?: string;
  onLoadMore?: () => void;
  loading?: boolean;
  /** How many more will load on click; used for the button label. */
  step?: number;
  affected?: string;
  className?: string;
}) {
  const hidden = total - shown;
  if (hidden <= 0) return null;

  const noun = itemLabel
    ? pluralize(total, itemLabel, itemLabelPlural)
    : t('{count, plural, one {task} other {tasks}}', { count: total });

  return (
    <Card
      className={cn('flex flex-wrap items-center justify-between gap-3 px-4 py-3', className)}
      role="status"
    >
      <p className="text-2xs text-muted-foreground">
        {t('Showing {shown} of {total} {noun}.', {
          shown: formatNumber(shown),
          total: formatNumber(total),
          noun,
        })}{' '}
        {t('{affected} cover what is loaded.', { affected })}
      </p>
      {onLoadMore ? (
        <Button size="sm" variant="secondary" disabled={loading} onClick={onLoadMore}>
          {loading
            ? t('Loading…')
            : t('Load {count} more', { count: formatNumber(Math.min(hidden, step ?? hidden)) })}
        </Button>
      ) : null}
    </Card>
  );
}
