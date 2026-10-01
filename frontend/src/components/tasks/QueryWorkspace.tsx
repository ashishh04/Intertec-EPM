import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ListTree, Pencil, Star, Trash2 } from 'lucide-react';

import { ColumnPicker } from './ColumnPicker';
import { QueryBuilder } from './QueryBuilder';
import { TaskTable, TaskTableSkeleton } from './TaskTable';
import { ConfirmDialog, PromptDialog } from '@/components/common/ConfirmDialog';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoTooltip } from '@/components/ui/tooltip';
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
import { cn, formatNumber, pluralize } from '@/lib/utils';
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
  /*
   * Show the rows as a tree, as OpenProject's own list does by default.
   *
   * Mutually exclusive with grouping and with an explicit sort below: each is a
   * different claim about the order of the rows, and letting two of them apply
   * at once produces an arrangement that answers to neither.
   */
  const [hierarchy, setHierarchy] = useState(true);
  // Which confirmation is open. Bulk delete carries the ids so the dialog can
  // say how many rows are about to go.
  const [renaming, setRenaming] = useState(false);
  const [deletingView, setDeletingView] = useState(false);
  const [deletingTasks, setDeletingTasks] = useState<ID[]>();

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

  // Grouping and sorting each impose their own order, so the tree yields to
  // either rather than fighting it.
  const treeMode = hierarchy && !groupBy && !sort;

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
      showHierarchies: treeMode,
    }),
    [projectId, page, pageSize, appliedFilters, sort, isAdHoc, columns, groupBy, treeMode],
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

  const rename = (name: string) => {
    if (!selected?.id) return;
    if (name === selected.name) {
      setRenaming(false);
      return;
    }

    updateQuery.mutate(
      { id: selected.id, patch: { name } },
      {
        onSuccess: () => {
          toast.success('View renamed');
          setRenaming(false);
        },
        onError: (error) =>
          toast.error('Could not rename this view', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const remove = () => {
    if (!selected?.id) return;

    deleteQuery.mutate(selected.id, {
      onSuccess: () => {
        toast.success('View deleted');
        setDeletingView(false);
        selectQuery(AD_HOC);
      },
      onError: (error) =>
        toast.error('Could not delete this view', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const removeTasks = () => {
    if (!deletingTasks?.length) return;

    deleteTasks.mutate(deletingTasks, {
      onSuccess: () => {
        toast.success('Deleted');
        setDeletingTasks(undefined);
      },
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
                  <span className="inline-flex items-center gap-1.5">
                    {query.starred ? (
                      <Star className="h-3 w-3 fill-warning text-warning" aria-label="Starred" />
                    ) : null}
                    {query.name}
                  </span>
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
                  onClick={() =>
                    toggleStar.mutate({ id: selected.id!, starred: selected.starred })
                  }
                >
                  <Star
                    className={cn('h-3.5 w-3.5', selected.starred && 'fill-warning text-warning')}
                    aria-hidden
                  />
                  {selected.starred ? 'Unstar' : 'Star'}
                </Button>
              ) : null}

              {/* Offered only when OpenProject says this user may change it. */}
              {selected.can.update ? (
                <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </Button>
              ) : null}

              {/* Offered only when OpenProject says this user may delete it. */}
              {selected.can.delete ? (
                <Button variant="ghost" size="sm" onClick={() => setDeletingView(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              ) : null}
            </>
          ) : null}

          {/*
            The button is disabled until the view has a name, which is correct —
            a saved view with no name cannot be found again. What was missing is
            that it said so: a permanently grey button beside an empty box reads
            as broken rather than as waiting for input, and was reported as such.
            The title carries the reason for a pointer, and the hint below states
            it outright.
          */}
          <div className="ml-auto flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Save current filters as…"
                aria-label="New view name"
                className="h-8 w-52"
              />
              <Button
                size="sm"
                onClick={save}
                disabled={!newName.trim() || createQuery.isPending}
                title={newName.trim() ? undefined : 'Give the view a name to save it'}
              >
                Save view
              </Button>
            </div>
            {!newName.trim() ? (
              <p className="text-2xs text-muted-foreground">Name the view to save it.</p>
            ) : null}
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

          {/* Disabled rather than hidden while grouping or sorting is on, so
              the reason the tree is not showing stays on screen. */}
          <InfoTooltip
            label={
              groupBy || sort
                ? 'Grouping and sorting each impose their own order, so the tree is off while either is set.'
                : 'Show sub-items nested under their parent.'
            }
          >
            <span>
              <Button
                variant={treeMode ? 'secondary' : 'ghost'}
                size="sm"
                className="shrink-0"
                aria-pressed={treeMode}
                disabled={Boolean(groupBy || sort)}
                onClick={() => {
                  setHierarchy((on) => !on);
                  setPage(1);
                }}
              >
                <ListTree className="h-3.5 w-3.5" />
                Hierarchy
              </Button>
            </span>
          </InfoTooltip>

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
        // No `empty` here on purpose: the table draws its own empty state so
        // the toolbar and column controls stay put when a filter matches nothing.
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
          showHierarchy={treeMode}
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
          onBulkDelete={canAnywhere('task:edit') ? (ids: ID[]) => setDeletingTasks(ids) : undefined}
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
          {formatNumber(result.data?.total ?? 0)}{' '}
          {pluralize(result.data?.total ?? 0, 'work package')} ·{' '}
          {formatNumber(appliedFilters.length)} {pluralize(appliedFilters.length, 'filter')}{' '}
          applied
        </p>
      ) : null}

      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename this view"
        label="Name"
        initialValue={selected?.name ?? ''}
        confirmLabel="Rename"
        pending={updateQuery.isPending}
        onSubmit={rename}
      />

      <ConfirmDialog
        open={deletingView}
        onOpenChange={setDeletingView}
        title={`Delete the view “${selected?.name ?? ''}”?`}
        description="This cannot be undone."
        confirmLabel="Delete view"
        tone="danger"
        pending={deleteQuery.isPending}
        onConfirm={remove}
      />

      <ConfirmDialog
        open={Boolean(deletingTasks)}
        onOpenChange={(open) => {
          if (!open) setDeletingTasks(undefined);
        }}
        title={`Delete ${formatNumber(deletingTasks?.length ?? 0)} ${pluralize(deletingTasks?.length ?? 0, 'task')}?`}
        description="This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        pending={deleteTasks.isPending}
        onConfirm={removeTasks}
      />
    </div>
  );
}
