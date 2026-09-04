import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Star, Trash2 } from 'lucide-react';

import { ColumnPicker } from './ColumnPicker';
import { QueryBuilder } from './QueryBuilder';
import { TaskTable, TaskTableSkeleton } from './TaskTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateQuery,
  useDeleteQuery,
  useQueryResult,
  useQuerySchema,
  useSavedQueries,
  useToggleStar,
  useUpdateQuery,
} from '@/hooks/useQueries';
import { useBulkUpdateTasks, useDeleteTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import { pluralize } from '@/lib/utils';
import { buildFilters, buildSort, type QueryFilterInstance } from '@/services/api/queries';
import type { ID, EpmProject, UpdateTaskInput } from '@/types';

/**
 * Work package workspace driven by OpenProject views.
 *
 * Filtering, sorting and paging are all resolved upstream: the table shows one
 * page of a query's results, never a client-side slice of everything. That is
 * what makes this scale, and it is why the filter set is whatever the instance
 * offers rather than the handful EPM used to hardcode.
 */

const DEFAULT_PAGE_SIZE = 15;
const AD_HOC = '__default__';
/** Radix selects cannot hold an empty value, so absence needs a sentinel. */
const NO_GROUP = '__nogroup__';

/**
 * Upstream column ids the table has a renderer for.
 *
 * The table draws the normalized task model, so a column is showable only when
 * that model carries the attribute. Everything else OpenProject offers —
 * category, duration, custom field values and so on — is reported as
 * unavailable rather than rendered blank.
 */
const RENDERABLE_COLUMNS = [
  'id',
  'subject',
  'project',
  'type',
  'status',
  'priority',
  'assignee',
  'author',
  'startDate',
  'dueDate',
  'estimatedTime',
  'spentTime',
  'percentageDone',
  'storyPoints',
  'version',
  'createdAt',
  'updatedAt',
];

/** Upstream column id -> the table's own key. */
const COLUMN_TO_TABLE: Record<string, string> = {
  id: 'key',
  subject: 'subject',
  project: 'project',
  type: 'type',
  status: 'status',
  priority: 'priority',
  assignee: 'assignee',
  author: 'author',
  startDate: 'startDate',
  dueDate: 'dueDate',
  estimatedTime: 'estimate',
  spentTime: 'spent',
  percentageDone: 'progress',
  storyPoints: 'storyPoints',
  version: 'version',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

/** Without these the row cannot be identified or opened. */
const REQUIRED_COLUMNS = ['id', 'subject'];

/** The table's own key -> the upstream column id, for sorting. */
const TABLE_TO_COLUMN: Record<string, string> = Object.fromEntries(
  Object.entries(COLUMN_TO_TABLE).map(([column, key]) => [key, column]),
);

interface QueryWorkspaceProps {
  /** Scopes to one project; omit for the portfolio-wide view. */
  projectId?: ID;
  className?: string;
}

export function QueryWorkspace({ projectId, className }: QueryWorkspaceProps) {
  const { openTaskDrawer } = useUI();
  const { canAnywhere } = useAuth();

  const [selectedQueryId, setSelectedQueryId] = useState<string>(AD_HOC);
  const [filters, setFilters] = useState<QueryFilterInstance[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<{ field: string; direction: 'asc' | 'desc' }>();
  const [newName, setNewName] = useState('');
  const [columns, setColumns] = useState<string[]>();
  const [groupBy, setGroupBy] = useState<string>();

  const schemaQuery = useQuerySchema(projectId);
  const savedQueries = useSavedQueries(projectId);

  const isAdHoc = selectedQueryId === AD_HOC;

  /**
   * Filters that are actually expressible.
   *
   * A filter is added before its value is chosen, and an operator that requires
   * values is rejected outright without them — "Status can't be blank" — which
   * would break the whole view between adding a filter and filling it in. An
   * incomplete filter is not yet a constraint, so it is left out until it is.
   */
  const appliedFilters = useMemo(() => {
    const schema = new Map((schemaQuery.data?.filters ?? []).map((entry) => [entry.id, entry]));

    return filters.filter((filter) => {
      const operator = schema.get(filter.id)?.operators.find((o) => o.id === filter.operator);
      // An unknown operator is passed through; upstream is the authority on it.
      if (!operator) return true;
      // Operators that take no values are complete on their own.
      if (!operator.valueType) return true;
      return filter.values.length > 0;
    });
  }, [filters, schemaQuery.data]);

  // Overrides are only sent when set. Omitting `filters` entirely lets a saved
  // view keep its own; sending an empty array would silently clear it.
  const overrides = useMemo(
    () => ({
      projectId,
      offset: page,
      pageSize,
      ...(isAdHoc || appliedFilters.length > 0 ? { filters: buildFilters(appliedFilters) } : {}),
      ...(sort
        ? {
            sortBy: buildSort([
              { field: TABLE_TO_COLUMN[sort.field] ?? sort.field, direction: sort.direction },
            ]),
          }
        : {}),
      ...(columns?.length ? { columns: columns.join(',') } : {}),
      ...(groupBy ? { groupBy } : {}),
    }),
    [projectId, page, pageSize, appliedFilters, sort, isAdHoc, columns, groupBy],
  );

  const result = useQueryResult(isAdHoc ? undefined : selectedQueryId, overrides);

  const projectsQuery = useProjects();
  const users = useUserMap();
  const bulkUpdate = useBulkUpdateTasks();
  const deleteTasks = useDeleteTasks();
  const createQuery = useCreateQuery();
  const deleteQuery = useDeleteQuery();
  const updateQuery = useUpdateQuery();
  const toggleStar = useToggleStar();

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projectsQuery.data ?? []).map((p) => [p.id, p])),
    [projectsQuery.data],
  );

  const current = result.data?.query;

  // Until the user picks, the view's own columns apply — which is what restores
  // a saved query's configuration on load.
  const effectiveColumns = columns ?? current?.columns.map((column) => column.id) ?? [];
  const tableColumns = effectiveColumns
    .map((id) => COLUMN_TO_TABLE[id])
    .filter((key): key is string => Boolean(key));

  // Sortability is OpenProject's answer, translated into the table's keys.
  // A column can be shown without being sortable, and vice versa.
  const sortableColumns = (schemaQuery.data?.sortable ?? [])
    .map((id) => COLUMN_TO_TABLE[id])
    .filter((key): key is string => Boolean(key));

  // As with columns and sort, the view's own grouping applies until overridden.
  const effectiveGroupBy = groupBy ?? current?.groupBy;

  // The view's own sort applies until the user chooses one.
  const activeSort =
    sort ??
    (current?.sortBy[0]
      ? { field: COLUMN_TO_TABLE[current.sortBy[0].field] ?? '', direction: current.sortBy[0].direction }
      : undefined);
  const selected = savedQueries.data?.find((q) => q.id === selectedQueryId);

  /** Switching views resets paging and adopts that view's own filters. */
  const selectQuery = (id: string) => {
    setSelectedQueryId(id);
    setPage(1);
    setSort(undefined);
    setFilters(id === AD_HOC ? [] : (savedQueries.data?.find((q) => q.id === id)?.filters ?? []));
    // Drop local overrides so the newly selected view's own configuration applies.
    setColumns(undefined);
    setGroupBy(undefined);
  };

  const save = () => {
    const name = newName.trim();
    if (!name) return;

    createQuery.mutate(
      {
        name,
        projectId,
        // The view in plain terms: column names, a grouping and filters. The
        // backend turns them into upstream links, so the shape of that API
        // never reaches the browser.
        view: {
          columns: effectiveColumns,
          groupBy: effectiveGroupBy || null,
          filters: appliedFilters.map((filter) => ({
            id: filter.id,
            operator: filter.operator,
            values: filter.values.map((value) => ({ id: String(value.id) })),
          })),
        },
      },
      {
        onSuccess: (query) => {
          toast.success(`Saved “${query.name}”`);
          setNewName('');
          if (query.id) setSelectedQueryId(query.id);
        },
        onError: (error) =>
          toast.error('Could not save this view', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const rename = () => {
    if (!selected?.id) return;

    const name = window.prompt('Rename this view', selected.name)?.trim();
    if (!name || name === selected.name) return;

    updateQuery.mutate(
      { id: selected.id, patch: { name } },
      {
        onSuccess: () => toast.success('View renamed'),
        onError: (error) =>
          toast.error('Could not rename this view', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const remove = () => {
    if (!selected?.id) return;
    if (!window.confirm(`Delete the view “${selected.name}”?`)) return;

    deleteQuery.mutate(selected.id, {
      onSuccess: () => {
        toast.success('View deleted');
        selectQuery(AD_HOC);
      },
      onError: (error) =>
        toast.error('Could not delete this view', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <div className={className}>
      <div className="mb-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedQueryId} onValueChange={selectQuery}>
            <SelectTrigger className="h-8 w-60" aria-label="View">
              <SelectValue placeholder="Select a view" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AD_HOC}>Default view</SelectItem>
              {(savedQueries.data ?? []).map((query) => (
                <SelectItem key={query.id} value={String(query.id)}>
                  {query.starred ? '★ ' : ''}
                  {query.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selected?.id ? (
            <>
              {selected.can.star || selected.can.unstar ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() =>
                    toggleStar.mutate({ id: selected.id!, starred: selected.starred })
                  }
                >
                  <Star
                    className={cnStar(selected.starred)}
                    aria-hidden
                  />
                  {selected.starred ? 'Unstar' : 'Star'}
                </Button>
              ) : null}

              {/* Offered only when OpenProject says this user may change it. */}
              {selected.can.update ? (
                <Button variant="ghost" size="sm" className="h-8" onClick={rename}>
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </Button>
              ) : null}

              {/* Offered only when OpenProject says this user may delete it. */}
              {selected.can.delete ? (
                <Button variant="ghost" size="sm" className="h-8" onClick={remove}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              ) : null}
            </>
          ) : null}

          <div className="ml-auto flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Save current filters as…"
              aria-label="New view name"
              className="h-8 w-52"
            />
            <Button
              size="sm"
              className="h-8"
              onClick={save}
              disabled={!newName.trim() || createQuery.isPending}
            >
              Save view
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <QueryBuilder
            schema={schemaQuery.data?.filters ?? []}
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
            projectId={projectId}
            isLoading={schemaQuery.isLoading}
            className="min-w-0 flex-1"
          />

          <Select
            value={effectiveGroupBy ?? NO_GROUP}
            onValueChange={(value) => {
              setGroupBy(value === NO_GROUP ? undefined : value);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-48 shrink-0" aria-label="Group by">
              <SelectValue placeholder="No grouping" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_GROUP}>No grouping</SelectItem>
              {(schemaQuery.data?.groupable ?? []).map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  Group by {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ColumnPicker
            available={schemaQuery.data?.columns ?? []}
            renderable={RENDERABLE_COLUMNS}
            selected={effectiveColumns}
            onChange={setColumns}
            required={REQUIRED_COLUMNS}
            disabled={schemaQuery.isLoading}
          />
        </div>
      </div>

      <QueryBoundary
        isLoading={result.isLoading}
        isError={result.isError}
        error={result.error}
        onRetry={() => void result.refetch()}
        skeleton={<TaskTableSkeleton />}
        isEmpty={(result.data?.tasks.length ?? 0) === 0}
        errorTitle="This view could not be loaded"
      >
        <TaskTable
          tasks={result.data?.tasks ?? []}
          projects={projectsById}
          users={users}
          total={result.data?.total ?? 0}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          sortBy={activeSort?.field}
          sortDir={activeSort?.direction}
          sortable={sortableColumns}
          // A null field is the third click: drop the override and fall back to
          // whatever order the view itself defines.
          onSortChange={(field, direction) =>
            setSort(field === null ? undefined : { field, direction })
          }
          onBulkUpdate={(ids: ID[], patch: Partial<UpdateTaskInput>) =>
            bulkUpdate.mutate(
              { ids, patch },
              {
                onSuccess: (updated) =>
                  toast.success(`Updated ${updated.length} ${pluralize(updated.length, 'task')}`),
              },
            )
          }
          onBulkDelete={
            canAnywhere('task:edit')
              ? (ids: ID[]) => {
                  if (!window.confirm(`Delete ${ids.length} ${pluralize(ids.length, 'task')}?`)) {
                    return;
                  }
                  deleteTasks.mutate(ids, { onSuccess: () => toast.success('Deleted') });
                }
              : undefined
          }
          groups={result.data?.groups}
          columns={tableColumns}
          hideProjectColumn={Boolean(projectId)}
          emptyAction={{
            label: 'New task',
            onClick: () => openTaskDrawer(projectId ? { projectId } : undefined),
          }}
        />
      </QueryBoundary>

      {current ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          {result.data?.total ?? 0} {pluralize(result.data?.total ?? 0, 'work package')} ·{' '}
          {appliedFilters.length} {pluralize(appliedFilters.length, 'filter')} applied
        </p>
      ) : null}
    </div>
  );
}

function cnStar(starred: boolean): string {
  return starred ? 'h-3.5 w-3.5 fill-warning text-warning' : 'h-3.5 w-3.5';
}
