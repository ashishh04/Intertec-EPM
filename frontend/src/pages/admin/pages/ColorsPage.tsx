import { useMemo } from 'react';
import { Palette } from 'lucide-react';
import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { Pagination } from '@/components/common/Pagination';
import { SectionHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Card } from '@/components/ui/card';
import { useAdminPriorities, useAdminStatuses, useAdminTypes } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';

interface Swatch {
  hex: string;
  /** The items that use this colour, in position order. */
  names: string[];
}

interface SwatchGroup {
  label: string;
  swatches: Swatch[];
}

/** One swatch with the group it belongs to, so the grid can be paged as one list. */
interface GroupedSwatch {
  group: string;
  swatch: Swatch;
}

/** Bigger than the tables' page because a swatch is a small tile, not a row. */
const PAGE_SIZE = 48;

/**
 * The colours in use across types, statuses and priorities. Read-only: the
 * palette itself is edited in the delivery system, and this page shows what
 * it currently looks like, de-duplicated so one colour shared by several
 * items is one swatch with all their names.
 */
export default function ColorsPage() {
  const types = useAdminTypes();
  const statuses = useAdminStatuses();
  const priorities = useAdminPriorities();

  const groups = useMemo<SwatchGroup[]>(() => {
    const build = (label: string, items: { name: string; color: string; position: number }[] | undefined) => ({
      label,
      swatches: dedupe(items ?? []),
    });
    return [
      build('Types', types.data),
      build('Statuses', statuses.data),
      build('Priorities', priorities.data),
    ].filter((group) => group.swatches.length > 0);
  }, [types.data, statuses.data, priorities.data]);

  // Paged as one flat list so a page boundary can fall inside a group; the
  // page is regrouped for display so the headings still say which is which.
  const flat = useMemo<GroupedSwatch[]>(
    () => groups.flatMap((group) => group.swatches.map((swatch) => ({ group: group.label, swatch }))),
    [groups],
  );
  const paging = usePagination(flat, { pageSize: PAGE_SIZE });
  const pageGroups = useMemo(() => regroup(paging.items), [paging.items]);

  const isLoading = types.isLoading || statuses.isLoading || priorities.isLoading;
  const isError = types.isError || statuses.isError || priorities.isError;
  const error = types.error ?? statuses.error ?? priorities.error;
  const retry = () => {
    void types.refetch();
    void statuses.refetch();
    void priorities.refetch();
  };

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ResultCount count={flat.length} label="colour" />
      </ListToolbar>

      <QueryBoundary
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={retry}
        errorTitle="Colours could not be loaded"
        skeleton={<ListSkeleton rows={3} height="h-32" />}
        isEmpty={groups.length === 0}
        empty={
          <EmptyState
            icon={Palette}
            title="No colours are in use"
            description="Types, statuses and priorities have no colour assigned yet."
          />
        }
      >
        <Card className="overflow-hidden">
          <div className="space-y-6 p-4">
            {pageGroups.map((group) => (
              <section key={group.label} aria-labelledby={`colors-${group.label}`}>
                <SectionHeader title={group.label} className="mb-3" />
                <h2 id={`colors-${group.label}`} className="sr-only">
                  {group.label}
                </h2>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {group.swatches.map((swatch) => (
                    <li
                      key={swatch.hex}
                      className="flex flex-col gap-2 rounded-lg border border-border p-2.5 transition-colors hover:border-primary/30"
                    >
                      <span
                        className="block h-10 w-full rounded-md border border-border/60"
                        style={{ backgroundColor: swatch.hex }}
                        role="img"
                        aria-label={`Colour ${swatch.hex}`}
                      />
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                        {swatch.hex}
                      </span>
                      <span className="text-xs leading-snug" title={swatch.names.join(', ')}>
                        {swatch.names.join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="border-t border-border">
            <Pagination
              page={paging.page}
              pageSize={paging.pageSize}
              total={paging.total}
              onPageChange={paging.setPage}
              onPageSizeChange={paging.setPageSize}
              pageSizeOptions={[24, 48, 96]}
              itemLabel="colour"
            />
          </div>
        </Card>
      </QueryBoundary>
    </div>
  );
}

/** One swatch per distinct colour, carrying every name that uses it. */
function dedupe(items: { name: string; color: string; position: number }[]): Swatch[] {
  const byHex = new Map<string, Swatch>();
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    const hex = normaliseHex(item.color);
    if (!hex) continue;
    const existing = byHex.get(hex);
    if (existing) existing.names.push(item.name);
    else byHex.set(hex, { hex, names: [item.name] });
  }
  return [...byHex.values()];
}

/** The page's swatches back under their group headings, in the order they arrived. */
function regroup(items: GroupedSwatch[]): SwatchGroup[] {
  const groups: SwatchGroup[] = [];
  for (const { group, swatch } of items) {
    const last = groups[groups.length - 1];
    if (last && last.label === group) last.swatches.push(swatch);
    else groups.push({ label: group, swatches: [swatch] });
  }
  return groups;
}

/** Lower-case, hash-prefixed, or null when the item has no colour. */
function normaliseHex(color: string | null | undefined): string | null {
  if (!color) return null;
  const trimmed = color.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}
