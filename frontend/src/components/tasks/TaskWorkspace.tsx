import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FilterBar } from './FilterBar';
import { TaskTable, TaskTableSkeleton } from './TaskTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { useBulkUpdateTasks, useDeleteTasks, useTasks } from '@/hooks/useTasks';
import { useProjects } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
import { useUserMap, useUsers } from '@/hooks/useUsers';
import { useDebounce } from '@/hooks/useDebounce';
import { useUI } from '@/providers/UIProvider';
import { pluralize } from '@/lib/utils';
import type { ID, NexusProject, TaskFilters, UpdateTaskInput } from '@/types';

interface TaskWorkspaceProps {
  /** Locks the workspace to one project and hides the project selector. */
  projectId?: ID;
  initialFilters?: TaskFilters;
  className?: string;
}

/**
 * Filterable, sortable, paginated work-package workspace.
 *
 * Shared by the global Tasks page and the per-project Tasks tab so both behave
 * identically, including bulk actions and pagination.
 */
export function TaskWorkspace({ projectId, initialFilters, className }: TaskWorkspaceProps) {
  const { openTaskDrawer } = useUI();
  const [filters, setFilters] = useState<TaskFilters>({
    projectId,
    page: 1,
    pageSize: 15,
    sortBy: 'dueDate',
    sortDir: 'asc',
    ...initialFilters,
  });

  const debouncedSearch = useDebounce(filters.search ?? '', 250);
  const query = useTasks({ ...filters, search: debouncedSearch || undefined });

  const projectsQuery = useProjects();
  const sprintsQuery = useSprints();
  const { data: userList } = useUsers();
  const users = useUserMap();
  const bulkUpdate = useBulkUpdateTasks();
  const deleteTasks = useDeleteTasks();

  const projectsById = useMemo(
    () => new Map<ID, NexusProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  const handleBulkUpdate = (ids: ID[], patch: Partial<UpdateTaskInput>) => {
    bulkUpdate.mutate(
      { ids, patch },
      {
        onSuccess: (updated) =>
          toast.success(`${updated.length} ${pluralize(updated.length, 'task')} updated`),
        onError: () => toast.error('Unable to save changes'),
      },
    );
  };

  const handleBulkDelete = (ids: ID[]) => {
    // Destructive actions are confirmed before they run.
    const confirmed = window.confirm(
      `Delete ${ids.length} ${pluralize(ids.length, 'task')}? This cannot be undone.`,
    );
    if (!confirmed) return;

    deleteTasks.mutate(ids, {
      onSuccess: () => toast.success(`${ids.length} ${pluralize(ids.length, 'task')} deleted`),
      onError: () => toast.error('Unable to delete the selected tasks'),
    });
  };

  return (
    <div className={className}>
      <FilterBar
        filters={filters}
        onChange={setFilters}
        projects={projectsQuery.data ?? []}
        users={userList ?? []}
        sprints={sprintsQuery.data ?? []}
        hide={projectId ? ['project'] : []}
        className="mb-4"
      />

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle="Unable to load tasks"
        skeleton={<TaskTableSkeleton />}
      >
        <TaskTable
          tasks={query.data?.items ?? []}
          projects={projectsById}
          users={users}
          total={query.data?.total ?? 0}
          page={filters.page ?? 1}
          pageSize={filters.pageSize ?? 15}
          onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
          onPageSizeChange={(pageSize) =>
            setFilters((current) => ({ ...current, pageSize, page: 1 }))
          }
          sortBy={filters.sortBy}
          sortDir={filters.sortDir}
          onSortChange={(sortBy, sortDir) =>
            setFilters((current) => ({ ...current, sortBy, sortDir, page: 1 }))
          }
          onBulkUpdate={handleBulkUpdate}
          onBulkDelete={handleBulkDelete}
          onExport={() =>
            toast('Export runs on the Nexus backend', {
              description: 'Connected workspaces generate a CSV from the current filter set.',
            })
          }
          hideProjectColumn={Boolean(projectId)}
          emptyAction={{
            label: 'Create a task',
            onClick: () => openTaskDrawer({ projectId }),
          }}
        />
      </QueryBoundary>
    </div>
  );
}
