import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { Input, type InputProps } from '@/components/ui/input';
import { cn, formatNumber, pluralize } from '@/lib/utils';

/**
 * The control strip above every list: search on the left, filters beside it,
 * view switches and secondary actions on the right. One layout for projects,
 * people, teams and administration, so the eye knows where to look.
 */
export function ListToolbar({
  children,
  trailing,
  className,
}: {
  children?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2',
        className,
      )}
    >
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-1">
        {children}
      </div>
      {/* On a phone the filters wrap onto several rows, so the count and
          view controls take a row of their own instead of wedging between them. */}
      {trailing ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">{trailing}</div>
      ) : null}
    </div>
  );
}

/** Search field with the magnifier and a clear button. Sized for the toolbar. */
export function SearchInput({
  value,
  onValueChange,
  className,
  placeholder = 'Search',
  ...props
}: Omit<InputProps, 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        className="h-8 pl-8 pr-7 text-xs [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onValueChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/**
 * "12 people" / "3 of 48 projects" beside a list. Reads the filtered count
 * against the total so a narrowed view says so.
 */
export function ResultCount({
  count,
  total,
  label,
  plural,
  className,
}: {
  count: number;
  total?: number;
  /** Singular noun, e.g. "project". */
  label: string;
  /** Plural form when it is not just `label + "s"`, e.g. "statuses". */
  plural?: string;
  className?: string;
}) {
  const filtered = typeof total === 'number' && total !== count;
  return (
    <p className={cn('text-2xs text-muted-foreground', className)} aria-live="polite">
      <span className="font-mono font-medium tabular-nums text-foreground">
        {formatNumber(count)}
      </span>
      {filtered ? (
        <>
          {' '}
          of{' '}
          <span className="font-mono font-medium tabular-nums text-foreground">
            {formatNumber(total)}
          </span>
        </>
      ) : null}{' '}
      {pluralize(filtered ? total : count, label, plural)}
    </p>
  );
}
