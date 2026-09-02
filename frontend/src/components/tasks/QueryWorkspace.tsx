import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Star, Trash2 } from 'lucide-react';

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
} from '@/hooks/useQueries';
import { useBulkUpdateTasks, useDeleteTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import { pluralize } from '@/lib/utils';
import { buildFilters, buildSort, type QueryFilterInstance } from '@/services/api/queries';
import type { ID, EpmProject, TaskFilters, UpdateTaskInput } from '@/types';

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

  const schemaQuery = useQuerySchema(projectId);
  const savedQueries = useSavedQueries(projectId);

  const isAdHoc = selectedQueryId === AD_HOC;

  // Overrides are only sent when set. Omitting `filters` entirely lets a saved
  // view keep its own; sending an empty array would silently clear it.
  const overrides = useMemo(
    () => ({
      projectId,
      offset: page,
      pageSize,
      ...(isAdHoc || filters.length > 0 ? { filters: buildFilters(filters) } : {}),
      ...(sort ? { sortBy: buildSort([sort]) } : {}),
    }),
    [projectId, page, pageSize, filters, sort, isAdHoc],
  );

  const result = useQueryResult(isAdHoc ? undefined : selectedQueryId, overrides);

  const projectsQuery = useProjects();
  const users = useUserMap();
  const bulkUpdate = useBulkUpdateTasks();
  const deleteTasks = useDeleteTasks();
  const createQuery = useCreateQuery();
  const deleteQuery = useDeleteQuery();
  const toggleStar = useToggleStar();

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projectsQuery.data ?? []).map((p) => [p.id, p])),
    [projectsQuery.data],
  );

  const current = result.data?.query;
  const selected = savedQueries.data?.find((q) => q.id === selectedQueryId);

  /** Switching views resets paging and adopts that view's own filters. */
  const selectQuery = (id: string) => {
    setSelectedQueryId(id);
    setPage(1);
    setSort(undefined);
    setFilters(id === AD_HOC ? [] : (savedQueries.data?.find((q) => q.id === id)?.filters ?? []));
  };

  const save = () => {
    const name = newName.trim();
    if (!name) return;

    createQuery.mutate(
      {
        name,
        projectId,
        payload: {
          // OpenProject persists filters in HAL form, unlike the query-string
          // shorthand used for ad-hoc runs.
          filters: filters.map((filter) => ({
            _links: {
              filter: { href: `/api/v3/queries/filters/${filter.id}` },
              operator: { href: `/api/v3/queries/operators/${encodeURIComponent(filter.operator)}` },
              values: filter.values.map((value) => ({ href: String(value.id) })),
            },
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

        <QueryBuilder
          schema={schemaQuery.data?.filters ?? []}
          filters={filters}
          onChange={(next) => {
            setFilters(next);
            setPage(1);
          }}
          projectId={projectId}
          isLoading={schemaQuery.isLoading}
        />
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
          sortBy={sort?.field as TaskFilters['sortBy']}
          sortDir={sort?.direction}
          onSortChange={(field, direction) => setSort({ field, direction })}
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
          {filters.length} {pluralize(filters.length, 'filter')} applied
        </p>
      ) : null}
    </div>
  );
}

function cnStar(starred: boolean): string {
  return starred ? 'h-3.5 w-3.5 fill-warning text-warning' : 'h-3.5 w-3.5';
}
