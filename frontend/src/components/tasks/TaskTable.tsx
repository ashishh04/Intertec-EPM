import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Columns3,
  Download,
  ListChecks,
  Trash2,
  UserPlus,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PriorityBadge, StatusBadge, TypeBadge } from '@/components/common/StatusBadge';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { ALL_TASK_PRIORITIES, ALL_TASK_STATUSES, TASK_PRIORITY_META, TASK_STATUS_META } from '@/lib/domain';
import { cn, describeDueDate, formatHours, pluralize } from '@/lib/utils';
import type { ID, NexusProject, NexusTask, NexusUser, TaskFilters, UpdateTaskInput } from '@/types';

type ColumnKey =
  | 'key'
  | 'subject'
  | 'project'
  | 'type'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'dueDate'
  | 'estimate';

const COLUMN_LABEL: Record<ColumnKey, string> = {
  key: 'ID',
  subject: 'Task',
  project: 'Project',
  type: 'Type',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  dueDate: 'Due date',
  estimate: 'Estimate',
};

const SORTABLE: Partial<Record<ColumnKey, NonNullable<TaskFilters['sortBy']>>> = {
  subject: 'subject',
  status: 'status',
  priority: 'priority',
  dueDate: 'dueDate',
};

const DEFAULT_COLUMNS: ColumnKey[] = [
  'key',
  'subject',
  'project',
  'status',
  'priority',
  'assignee',
  'dueDate',
];

export interface TaskTableProps {
  tasks: NexusTask[];
  projects: Map<ID, NexusProject>;
  users: Map<ID, NexusUser>;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  sortBy?: TaskFilters['sortBy'];
  sortDir?: TaskFilters['sortDir'];
  onSortChange: (sortBy: NonNullable<TaskFilters['sortBy']>, sortDir: 'asc' | 'desc') => void;
  onBulkUpdate?: (ids: ID[], patch: Partial<UpdateTaskInput>) => void;
  onBulkDelete?: (ids: ID[]) => void;
  onExport?: () => void;
  /** Hide the project column when the table already lives inside one project. */
  hideProjectColumn?: boolean;
  emptyAction?: { label: string; onClick: () => void };
}

/**
 * Enterprise work-package table: sortable headers, row selection with bulk
 * actions, configurable columns and server-driven pagination.
 */
export function TaskTable({
  tasks,
  projects,
  users,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  sortBy,
  sortDir = 'asc',
  onSortChange,
  onBulkUpdate,
  onBulkDelete,
  onExport,
  hideProjectColumn = false,
  emptyAction,
}: TaskTableProps) {
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(
    hideProjectColumn ? DEFAULT_COLUMNS.filter((column) => column !== 'project') : DEFAULT_COLUMNS,
  );

  const columns = useMemo(
    () =>
      (Object.keys(COLUMN_LABEL) as ColumnKey[]).filter(
        (column) =>
          visibleColumns.includes(column) && !(hideProjectColumn && column === 'project'),
      ),
    [visibleColumns, hideProjectColumn],
  );

  const allSelected = tasks.length > 0 && tasks.every((task) => selected.has(task.id));
  const someSelected = selected.size > 0 && !allSelected;
  const selectedIds = [...selected];

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(tasks.map((task) => task.id)));
  };

  const toggleOne = (id: ID) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSort = (column: ColumnKey) => {
    const key = SORTABLE[column];
    if (!key) return;
    onSortChange(key, sortBy === key && sortDir === 'asc' ? 'desc' : 'asc');
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      {/* Toolbar: bulk actions replace the default controls while rows are selected */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        {selected.size > 0 ? (
          <>
            <div className="flex items-center gap-2 text-xs">
              <ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden />
              <span className="font-medium">
                {selected.size} {pluralize(selected.size, 'task')} selected
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary">
                    Change status
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Set status</DropdownMenuLabel>
                  {ALL_TASK_STATUSES.map((status) => (
                    <DropdownMenuItem
                      key={status}
                      onSelect={() => {
                        onBulkUpdate?.(selectedIds, { status });
                        setSelected(new Set());
                      }}
                    >
                      {TASK_STATUS_META[status].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary">
                    Priority
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Set priority</DropdownMenuLabel>
                  {ALL_TASK_PRIORITIES.map((priority) => (
                    <DropdownMenuItem
                      key={priority}
                      onSelect={() => {
                        onBulkUpdate?.(selectedIds, { priority });
                        setSelected(new Set());
                      }}
                    >
                      {TASK_PRIORITY_META[priority].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary">
                    <UserPlus className="h-3.5 w-3.5" />
                    Assign
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                  <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                  {[...users.values()].map((user) => (
                    <DropdownMenuItem
                      key={user.id}
                      onSelect={() => {
                        onBulkUpdate?.(selectedIds, { assigneeId: user.id });
                        setSelected(new Set());
                      }}
                    >
                      {user.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {onBulkDelete ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:bg-danger-soft hover:text-danger"
                  onClick={() => {
                    onBulkDelete(selectedIds);
                    setSelected(new Set());
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <p className="px-1 text-2xs text-muted-foreground">
              {total === 0 ? 'No results' : `${total} ${pluralize(total, 'task')}`}
            </p>
            <div className="flex items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost">
                    <Columns3 className="h-3.5 w-3.5" />
                    Columns
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {(Object.keys(COLUMN_LABEL) as ColumnKey[])
                    .filter((column) => !(hideProjectColumn && column === 'project'))
                    .map((column) => (
                      <DropdownMenuCheckboxItem
                        key={column}
                        checked={visibleColumns.includes(column)}
                        disabled={column === 'subject'}
                        onCheckedChange={(checked) =>
                          setVisibleColumns((current) =>
                            checked
                              ? [...current, column]
                              : current.filter((item) => item !== column),
                          )
                        }
                      >
                        {COLUMN_LABEL[column]}
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {onExport ? (
                <Button size="sm" variant="ghost" onClick={onExport}>
                  <Download className="h-3.5 w-3.5" />
                  Export
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>

      {tasks.length === 0 ? (
        <EmptyState
          title="No tasks found"
          description="Nothing matches the current filters. Adjust them, or create the first task."
          action={emptyAction}
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pr-0">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAll}
                    aria-label="Select all tasks on this page"
                  />
                </TableHead>
                {columns.map((column) => {
                  const sortKey = SORTABLE[column];
                  const isSorted = sortKey && sortBy === sortKey;
                  return (
                    <TableHead
                      key={column}
                      aria-sort={
                        isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                      }
                      className={cn(column === 'subject' && 'min-w-64')}
                    >
                      {sortKey ? (
                        <button
                          type="button"
                          onClick={() => handleSort(column)}
                          className="inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {COLUMN_LABEL[column]}
                          {isSorted ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" aria-hidden />
                            ) : (
                              <ArrowDown className="h-3 w-3" aria-hidden />
                            )
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        COLUMN_LABEL[column]
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>

            <TableBody>
              {tasks.map((task) => {
                const project = projects.get(task.projectId);
                const assignee = task.assigneeId ? users.get(task.assigneeId) : undefined;
                const due = describeDueDate(task.dueDate, task.status === 'done');
                const isSelected = selected.has(task.id);

                return (
                  <TableRow key={task.id} data-state={isSelected ? 'selected' : undefined}>
                    <TableCell className="pr-0">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleOne(task.id)}
                        aria-label={`Select ${task.key}`}
                      />
                    </TableCell>

                    {columns.map((column) => (
                      <TableCell key={column}>
                        {column === 'key' ? (
                          <span className="font-mono text-2xs text-muted-foreground">{task.key}</span>
                        ) : column === 'subject' ? (
                          <Link
                            to={`/tasks/${task.id}`}
                            className="font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
                          >
                            {task.subject}
                          </Link>
                        ) : column === 'project' ? (
                          <span className="text-muted-foreground">{project?.name ?? '—'}</span>
                        ) : column === 'type' ? (
                          <TypeBadge type={task.type} />
                        ) : column === 'status' ? (
                          <StatusBadge status={task.status} size="sm" />
                        ) : column === 'priority' ? (
                          <PriorityBadge priority={task.priority} />
                        ) : column === 'assignee' ? (
                          <div className="flex items-center gap-1.5">
                            <UserAvatarWithTooltip user={assignee} size="xs" />
                            <span className="truncate text-muted-foreground">
                              {assignee?.name ?? 'Unassigned'}
                            </span>
                          </div>
                        ) : column === 'dueDate' ? (
                          <span
                            className={cn(
                              'font-mono text-2xs',
                              due.tone === 'overdue'
                                ? 'font-medium text-danger'
                                : due.tone === 'today'
                                  ? 'font-medium text-warning'
                                  : 'text-muted-foreground',
                            )}
                          >
                            {due.label}
                          </span>
                        ) : column === 'estimate' ? (
                          <span className="font-mono text-2xs text-muted-foreground">
                            {formatHours(task.estimatedHours)}
                          </span>
                        ) : null}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {total > 0 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          pageSizeOptions={[15, 25, 50, 100]}
          itemLabel="task"
          className="border-t border-border"
        />
      ) : null}
    </div>
  );
}

export function TaskTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-3 py-2.5">
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 px-3 py-3">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-5 w-20 rounded-md" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-6 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
