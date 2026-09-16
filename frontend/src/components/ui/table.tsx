import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Enterprise table shell. Wrap in a container with `overflow-x-auto` so wide
 * tables scroll inside their own region instead of breaking the page — or use
 * `TableCard` from `components/common/DataTable`, which does that and frames
 * the table in a card.
 */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table
      ref={ref}
      className={cn('w-full caption-bottom border-collapse text-sm', className)}
      {...props}
    />
  ),
);
Table.displayName = 'Table';

/**
 * `sticky` keeps the column headings visible while a long page of rows scrolls
 * inside its container. Needs a scroll container with a bounded height.
 */
const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }
>(({ className, sticky, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn('bg-surface-sunken/60', sticky && 'sticky top-0 z-10 bg-surface-sunken', className)}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <tbody ref={ref} className={cn(className)} {...props} />);
TableBody.displayName = 'TableBody';

/**
 * Every body row gets a quiet hover so the eye can track across wide tables.
 * `interactive` adds the pointer and a stronger hover for rows that open
 * something, and `data-state="selected"` highlights checked rows.
 */
const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }
>(({ className, interactive, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border transition-colors last:border-b-0',
      '[tbody>&]:hover:bg-muted/40 data-[state=selected]:bg-primary-soft/60',
      interactive && 'cursor-pointer [tbody>&]:hover:bg-muted/70',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

/** `numeric` right-aligns a column of figures so the digits line up. */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }
>(({ className, numeric, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-9 whitespace-nowrap border-b border-border px-3 text-left align-middle text-2xs font-semibold uppercase tracking-wide text-muted-foreground',
      numeric && 'text-right',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

/** `numeric` renders figures right-aligned, monospaced and tabular. */
const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }
>(({ className, numeric, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'px-3 py-2.5 align-middle text-xs',
      numeric && 'text-right font-mono text-2xs tabular-nums',
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
