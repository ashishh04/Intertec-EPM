import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatNumber, pluralize } from '@/lib/utils';

export interface PaginationProps {
  /** 1-indexed current page. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the rows-per-page control. */
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  /** Singular noun used in the summary line, e.g. "task". */
  itemLabel?: string;
  /** `compact` drops the summary line, for use inside narrow cards. */
  variant?: 'default' | 'compact';
  className?: string;
}

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100];

/**
 * Builds the page list with ellipses: always the first and last page, the
 * current page and its neighbours, and a gap marker for everything else.
 */
function pageItems(page: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((value) => pages.add(value));
  if (page >= totalPages - 2) {
    [totalPages - 1, totalPages - 2, totalPages - 3].forEach((value) => pages.add(value));
  }

  const sorted = [...pages].filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);

  const result: (number | 'gap')[] = [];
  let previous = 0;
  for (const value of sorted) {
    if (previous && value - previous > 1) result.push('gap');
    result.push(value);
    previous = value;
  }
  return result;
}

/**
 * Shared pagination control.
 *
 * Used for both server-driven pages (work package tables) and client-side
 * collections, so paging behaves and reads the same everywhere in the product.
 * Renders nothing when everything already fits on one page and the page size is
 * not adjustable.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  itemLabel = 'item',
  variant = 'default',
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);

  if (totalPages <= 1 && !onPageSizeChange) return null;

  const rangeStart = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const rangeEnd = Math.min(current * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
        variant === 'default' ? 'px-3 py-2' : 'px-2 py-1.5',
        className,
      )}
    >
      {variant === 'default' ? (
        <p className="text-2xs text-muted-foreground">
          {total === 0 ? (
            'No results'
          ) : (
            <>
              Showing{' '}
              <span className="font-mono font-medium text-foreground">
                {formatNumber(rangeStart)}–{formatNumber(rangeEnd)}
              </span>{' '}
              of <span className="font-mono font-medium text-foreground">{formatNumber(total)}</span>{' '}
              {pluralize(total, itemLabel)}
            </>
          )}
        </p>
      ) : (
        <p className="font-mono text-2xs text-muted-foreground">
          {current} / {totalPages}
        </p>
      )}

      <div className="flex items-center gap-2">
        {onPageSizeChange ? (
          <div className="hidden items-center gap-1.5 sm:flex">
            <label htmlFor="pagination-size" className="text-2xs text-muted-foreground">
              Per page
            </label>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => onPageSizeChange(Number(value))}
            >
              <SelectTrigger id="pagination-size" className="h-7 w-16 text-2xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous page"
              disabled={current <= 1}
              onClick={() => onPageChange(current - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>

            {pageItems(current, totalPages).map((item, index) =>
              item === 'gap' ? (
                <span
                  key={`gap-${index}`}
                  aria-hidden
                  className="px-1 text-2xs text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <Button
                  key={item}
                  variant={item === current ? 'default' : 'ghost'}
                  size="icon-sm"
                  aria-label={`Page ${item}`}
                  aria-current={item === current ? 'page' : undefined}
                  onClick={() => onPageChange(item)}
                  className="font-mono text-2xs"
                >
                  {item}
                </Button>
              ),
            )}

            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next page"
              disabled={current >= totalPages}
              onClick={() => onPageChange(current + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
