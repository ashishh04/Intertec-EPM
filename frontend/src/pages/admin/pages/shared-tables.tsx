import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { TableCard } from '@/components/common/DataTable';
import { Pagination } from '@/components/common/Pagination';
import { Table } from '@/components/ui/table';
import type { PaginationState } from '@/hooks/usePagination';

/**
 * Small pieces shared by the administration list pages: the card that wraps a
 * table, the pagination that sits in its footer, a colour swatch and a yes/no
 * cell. Kept here so each page file stays about its own data.
 */

/**
 * A table inside the product's `TableCard`, so administration lists scroll,
 * frame and page the same way every other list does. `footer` is usually
 * `<AdminPagination />`; `toolbar` sits above the table inside the card.
 */
export function AdminTable({
  children,
  footer,
  toolbar,
  maxHeight,
  className,
}: {
  children: ReactNode;
  footer?: ReactNode;
  toolbar?: ReactNode;
  maxHeight?: string;
  className?: string;
}) {
  return (
    <TableCard footer={footer} toolbar={toolbar} maxHeight={maxHeight} className={className}>
      <Table>{children}</Table>
    </TableCard>
  );
}

/**
 * The footer every admin table shares: the product's pagination wired to a
 * `usePagination` result, so the pages do not each repeat the six props.
 */
export function AdminPagination({
  paging,
  itemLabel,
  itemLabelPlural,
}: {
  paging: PaginationState<unknown>;
  /** Singular noun for the summary line, e.g. "user". */
  itemLabel: string;
  /** Plural form when it is not just `itemLabel + "s"`, e.g. "statuses". */
  itemLabelPlural?: string;
}) {
  return (
    <Pagination
      page={paging.page}
      pageSize={paging.pageSize}
      total={paging.total}
      onPageChange={paging.setPage}
      onPageSizeChange={paging.setPageSize}
      itemLabel={itemLabel}
      itemLabelPlural={itemLabelPlural}
    />
  );
}

/** A colour swatch beside its name, for types, statuses and priorities. */
export function ColorSwatch({ color, name }: { color: string | null | undefined; name: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-sm border border-border"
        style={color ? { backgroundColor: color } : undefined}
        aria-hidden
      />
      <span className="font-medium">{name}</span>
    </span>
  );
}

/** A tick when true, a quiet dash otherwise, with text for screen readers. */
export function CheckCell({ value, label }: { value: boolean; label: string }) {
  return value ? (
    <span className="inline-flex items-center text-success">
      <Check className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{label}: yes</span>
    </span>
  ) : (
    <span className="text-muted-foreground">
      <span aria-hidden>{'—'}</span>
      <span className="sr-only">{label}: no</span>
    </span>
  );
}

/** Locale-aware, case-insensitive name ordering. */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
