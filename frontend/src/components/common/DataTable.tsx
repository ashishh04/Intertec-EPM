import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination, type PaginationProps } from './Pagination';
import { cn } from '@/lib/utils';

/**
 * The frame every tabular list sits in: a card, a horizontal scroll region so
 * wide tables never break the page, and an optional footer that holds the
 * pagination on its own divider.
 *
 * `maxHeight` bounds the scroll region vertically so a sticky header has
 * something to stick to; leave it unset for short lists that should grow.
 */
export function TableCard({
  children,
  footer,
  toolbar,
  maxHeight,
  className,
}: {
  children: ReactNode;
  /** Usually `<Pagination />`. Rendered on its own divider. */
  footer?: ReactNode;
  /** Rendered above the table inside the card, e.g. a bulk-action strip. */
  toolbar?: ReactNode;
  maxHeight?: string;
  className?: string;
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      {toolbar ? <div className="border-b border-border">{toolbar}</div> : null}
      <div
        className={cn('epm-scroll relative overflow-x-auto', maxHeight && 'overflow-y-auto')}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>
      {footer ? <div className="border-t border-border">{footer}</div> : null}
    </Card>
  );
}

/** Pagination inside a `TableCard` footer, with the default table label. */
export function TablePagination(props: PaginationProps) {
  return <Pagination {...props} />;
}

/**
 * Loading stand-in that is a real table, so column widths and row height do
 * not jump when the data arrives. Pass the same column count as the table.
 */
export function TableSkeleton({
  columns = 5,
  rows = 6,
  className,
}: {
  columns?: number;
  rows?: number;
  className?: string;
}) {
  const widths = ['w-32', 'w-24', 'w-20', 'w-28', 'w-16', 'w-24', 'w-20', 'w-12'];
  return (
    <TableCard className={className}>
      <Table aria-hidden>
        <TableHeader>
          <TableRow>
            {Array.from({ length: columns }, (_, index) => (
              <TableHead key={index}>
                <Skeleton className={cn('h-2.5', widths[index % widths.length])} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <TableRow key={rowIndex} className="hover:bg-transparent">
              {Array.from({ length: columns }, (_, columnIndex) => (
                <TableCell key={columnIndex}>
                  <Skeleton
                    className={cn(
                      'h-3',
                      widths[(rowIndex + columnIndex) % widths.length],
                      columnIndex === 0 && 'w-40',
                    )}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/** Loading stand-in for a list of cards or rows of a known height. */
export function ListSkeleton({
  rows = 4,
  height = 'h-16',
  className,
}: {
  rows?: number;
  height?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn('w-full rounded-xl', height)} />
      ))}
    </div>
  );
}
