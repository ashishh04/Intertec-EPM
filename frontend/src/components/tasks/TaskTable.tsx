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
import { Badge } from '@/components/ui/badge';
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
import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { ALL_TASK_PRIORITIES, ALL_TASK_STATUSES, TASK_PRIORITY_META, TASK_STATUS_META } from '@/lib/domain';
import {
  cn,
  describeDueDate,
  formatHours,
  formatLongDate,
  formatNumber,
  formatPercent,
  formatShortDate,
  pluralize,
} from '@/lib/utils';
import type { ID, EpmProject, EpmTask, EpmUser, TaskFilters, UpdateTaskInput } from '@/types';

type ColumnKey =
  | 'key'
  | 'subject'
  | 'project'
  | 'type'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'author'
  | 'startDate'
  | 'dueDate'
  | 'estimate'
  | 'spent'
  | 'progress'
  | 'storyPoints'
  | 'version'
  | 'createdAt'
  | 'updatedAt';

const COLUMN_LABEL: Record<ColumnKey, string> = {
  key: 'ID',
  subject: 'Task',
  project: 'Project',
  type: 'Type',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  author: 'Author',
  startDate: 'Start date',
  dueDate: 'Finish date',
  estimate: 'Work',
  spent: 'Spent time',
  progress: '% Complete',
  storyPoints: 'Story points',
  version: 'Version',
  createdAt: 'Created on',
  updatedAt: 'Updated on',
};

/**
 * Fallback sortable set, used only when no query supplies one.
 *
 * With a query the sortable columns come from OpenProject, which knows far more
 * than this: it can sort by story points, custom fields and dates that were
 * never in this list. These four remain for the surfaces that render the table
 * without a query behind it.
 */
const FALLBACK_SORTABLE: ColumnKey[] = ['subject', 'status', 'priority', 'dueDate'];

const DEFAULT_COLUMNS: ColumnKey[] = [
  'key',
  'subject',
  'project',
  'status',
  'priority',
  'assignee',
  'dueDate',
];

/** Figures are right-aligned so the digits line up down the column. */
const NUMERIC_COLUMNS = new Set<ColumnKey>(['estimate', 'spent', 'progress', 'storyPoints']);

/**
 * How deep each row sits, counted only through parents present on this page.
 *
 * A page is a window on the tree, so a child whose parent was not returned is
 * a root here — indenting it under an ancestor that is not on screen would
 * claim a structure the reader cannot see. Asking upstream for hierarchy mode
 * is what keeps those parents in the page; this only measures what arrived.
 *
 * The walk is bounded by the row count, so a cycle in the data cannot hang it.
 */
function hierarchyDepths(tasks: EpmTask[]): Map<ID, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map<ID, number>();

  for (const task of tasks) {
    let depth = 0;
    let parentId = task.parentId;
    while (parentId && byId.has(parentId) && depth < tasks.length) {
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    depths.set(task.id, depth);
  }

  return depths;
}

export interface TaskTableProps {
  tasks: EpmTask[];
  projects: Map<ID, EpmProject>;
  users: Map<ID, EpmUser>;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  /**
   * Sort key, as a column key rather than a fixed union — a query can sort by
   * anything OpenProject offers, which is more than this table once allowed.
   */
  sortBy?: string;
  sortDir?: TaskFilters['sortDir'];
  /** `null` clears the sort, which is the third state of the header cycle. */
  onSortChange: (sortBy: string | null, sortDir: 'asc' | 'desc') => void;
  /** Columns that may be sorted. Defaults to the fallback set. */
  sortable?: string[];
  /**
   * Groups to render the rows under, in order.
   *
   * Counts are for the whole result set while the rows are one page, so a
   * group can show more than it contributes here — that is the upstream
   * semantics, not a discrepancy to paper over.
   */
  groups?: { value: string | null; count: number; taskIds: ID[] }[];
  onBulkUpdate?: (ids: ID[], patch: Partial<UpdateTaskInput>) => void;
  onBulkDelete?: (ids: ID[]) => void;
  onExport?: () => void;
  /** Hide the project column when the table already lives inside one project. */
  hideProjectColumn?: boolean;
  /**
   * Columns to show, driven by the query. When given, the table's own column
   * menu is hidden: the query owns the configuration and it is what gets saved.
   */
  columns?: string[];
  emptyAction?: { label: string; onClick: () => void };
  /**
   * Indent rows under a parent that is also on this page.
   *
   * Paired with the query's own hierarchy mode, which is what puts those
   * parents there. Off means a flat list, which is what grouping and a sorted
   * view want — a tree and a sort order are different claims about the rows.
   */
  showHierarchy?: boolean;
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
  showHierarchy = false,
  columns: controlledColumns,
  sortable,
  groups,
  emptyAction,
}: TaskTableProps) {
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(
    hideProjectColumn ? DEFAULT_COLUMNS.filter((column) => column !== 'project') : DEFAULT_COLUMNS,
  );

  // A controlled selection keeps the query's own order; the internal one keeps
  // the table's declaration order so toggling does not reshuffle headers.
  const columns = useMemo(() => {
    const renderable = new Set(Object.keys(COLUMN_LABEL) as ColumnKey[]);

    if (controlledColumns) {
      return controlledColumns.filter(
        (column): column is ColumnKey =>
          renderable.has(column as ColumnKey) && !(hideProjectColumn && column === 'project'),
      );
    }

    return (Object.keys(COLUMN_LABEL) as ColumnKey[]).filter(
      (column) => visibleColumns.includes(column) && !(hideProjectColumn && column === 'project'),
    );
  }, [controlledColumns, visibleColumns, hideProjectColumn]);

  const depths = useMemo(
    () => (showHierarchy ? hierarchyDepths(tasks) : new Map<ID, number>()),
    [showHierarchy, tasks],
  );

  /**
   * The body's rows: either a flat list, or group headers interleaved with the
   * rows belonging to each group.
   *
   * Groups with nothing on this page are still rendered, because their count is
   * real and omitting them would make the page look like the whole result.
   */
  const rows = useMemo(() => {
    if (!groups?.length) {
      return tasks.map((task) => ({ kind: 'task' as const, task }));
    }

    const byId = new Map(tasks.map((task) => [task.id, task]));

    return groups.flatMap((group) => [
      { kind: 'group' as const, group },
      ...group.taskIds
        .map((id) => byId.get(id))
        .filter((task): task is EpmTask => task !== undefined)
        .map((task) => ({ kind: 'task' as const, task })),
    ]);
  }, [groups, tasks]);

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

  const sortableColumns = useMemo(
    () => new Set<string>(sortable ?? FALLBACK_SORTABLE),
    [sortable],
  );

  /**
   * Ascending, then descending, then cleared.
   *
   * The third click removing the sort is what lets a user get back to the
   * view's own order without reloading it.
   */
  const handleSort = (column: ColumnKey) => {
    if (!sortableColumns.has(column)) return;

    if (sortBy !== column) return onSortChange(column, 'asc');
    if (sortDir === 'asc') return onSortChange(column, 'desc');
    return onSortChange(null, 'asc');
  };

  // Toolbar: bulk actions replace the default controls while rows are selected.
  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      {selected.size > 0 ? (
        <>
          <div className="flex items-center gap-2 text-xs">
            <ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden />
            <span className="font-medium">
              {formatNumber(selected.size)} {pluralize(selected.size, 'task')} selected
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
            {total === 0 ? 'No results' : `${formatNumber(total)} ${pluralize(total, 'task')}`}
          </p>
          <div className="flex items-center gap-1.5">
            {/* Hidden when a query owns the columns — two pickers editing the
                same thing, only one of which is saved, invites confusion. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className={cn(controlledColumns && 'hidden')}>
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
  );

  const footer =
    total > 0 ? (
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        pageSizeOptions={[15, 25, 50, 100]}
        itemLabel="task"
      />
    ) : undefined;

  return (
    <TableCard toolbar={toolbar} footer={footer}>
      {tasks.length === 0 ? (
        <EmptyState
          title="No tasks found"
          description="Nothing matches the current filters. Adjust them, or create the first task."
          action={emptyAction}
        />
      ) : (
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
                const sortKey = sortableColumns.has(column) ? column : undefined;
                const isSorted = sortKey !== undefined && sortBy === column;
                return (
                  <TableHead
                    key={column}
                    numeric={NUMERIC_COLUMNS.has(column)}
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
            {rows.map((row) => {
              if (row.kind === 'group') {
                const { group } = row;
                return (
                  <TableRow key={`group-${group.value ?? '__none__'}`} className="bg-muted/50">
                    <TableCell colSpan={columns.length + 1} className="py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {/* An unset attribute is a real group, not a failure
                              to look one up, so it says so plainly. */}
                          {group.value ?? 'None'}
                        </span>
                        <Badge tone="neutral" size="sm">
                          {formatNumber(group.count)}
                        </Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              }

              const { task } = row;
              const project = projects.get(task.projectId);
              const assignee = task.assigneeId ? users.get(task.assigneeId) : undefined;
              const due = describeDueDate(task.dueDate, task.statusCategory === 'done');
              const isSelected = selected.has(task.id);
              const depth = showHierarchy ? (depths.get(task.id) ?? 0) : 0;

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
                    <TableCell key={column} numeric={NUMERIC_COLUMNS.has(column)}>
                      {column === 'key' ? (
                        <span className="font-mono text-2xs text-muted-foreground">{task.key}</span>
                      ) : column === 'subject' ? (
                        <span className="flex min-w-0 items-center">
                          {/* One rule per level, so the depth is countable
                              rather than guessed at from the offset. */}
                          {Array.from({ length: depth }, (_, level) => (
                            <span
                              key={level}
                              aria-hidden
                              className="mr-2 h-4 w-3 shrink-0 border-l border-border"
                            />
                          ))}
                          <Link
                            to={`/tasks/${task.id}`}
                            className="truncate font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
                          >
                            {task.subject}
                          </Link>
                        </span>
                      ) : column === 'project' ? (
                        <span className="text-muted-foreground">{project?.name ?? '—'}</span>
                      ) : column === 'type' ? (
                        <TypeBadge type={task.type} label={task.typeRef.name} />
                      ) : column === 'status' ? (
                        <StatusBadge
                          status={task.statusCategory}
                          label={task.status.name}
                          size="sm"
                        />
                      ) : column === 'priority' ? (
                        <PriorityBadge priority={task.priority} label={task.priorityRef.name} />
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
                        <span className="text-muted-foreground">
                          {formatHours(task.estimatedHours)}
                        </span>
                      ) : column === 'author' ? (
                        <div className="flex items-center gap-1.5">
                          <UserAvatarWithTooltip user={users.get(task.authorId)} size="xs" />
                          <span className="truncate text-muted-foreground">
                            {users.get(task.authorId)?.name ?? '—'}
                          </span>
                        </div>
                      ) : column === 'startDate' ? (
                        <DateCell value={task.startDate} />
                      ) : column === 'spent' ? (
                        <span className="text-muted-foreground">
                          {formatHours(task.spentHours)}
                        </span>
                      ) : column === 'progress' ? (
                        <span className="text-muted-foreground">
                          {formatPercent(task.progress)}
                        </span>
                      ) : column === 'storyPoints' ? (
                        <span className="text-muted-foreground">
                          {task.storyPoints === undefined || task.storyPoints === null
                            ? '—'
                            : formatNumber(task.storyPoints)}
                        </span>
                      ) : column === 'version' ? (
                        <span className="truncate text-muted-foreground">
                          {task.version ?? '—'}
                        </span>
                      ) : column === 'createdAt' ? (
                        <DateCell value={task.createdAt} />
                      ) : column === 'updatedAt' ? (
                        <DateCell value={task.updatedAt} />
                      ) : null}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}

/** A date column: short in the cell, the full date on hover. */
function DateCell({ value }: { value?: string | null }) {
  if (!value) return <span className="font-mono text-2xs text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-2xs text-muted-foreground" title={formatLongDate(value)}>
      {formatShortDate(value)}
    </span>
  );
}

/**
 * Loading stand-in with the default column set plus the selection checkbox,
 * so the real table lands without the page jumping.
 */
export function TaskTableSkeleton({ rows = 8, columns }: { rows?: number; columns?: number }) {
  return <TableSkeleton rows={rows} columns={(columns ?? DEFAULT_COLUMNS.length) + 1} />;
}
