import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
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
  TableFooter,
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
import { usePriorities, useStatuses } from '@/hooks/useCatalog';
import {
  cn,
  describeDueDate,
  formatHours,
  formatLongDate,
  formatNumber,
  formatPercent,
  formatShortDate,
} from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { ID, EpmProject, EpmTask, EpmUser, TaskFilters, UpdateTaskInput } from '@/types';
import type { TaskTree } from '@/services/api/queries';

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
  get key() { return t('ID'); },
  get subject() { return t('Task'); },
  get project() { return t('Project'); },
  get type() { return t('Type'); },
  get status() { return t('Status'); },
  get priority() { return t('Priority'); },
  get assignee() { return t('Assignee'); },
  get author() { return t('Author'); },
  get startDate() { return t('Start date'); },
  get dueDate() { return t('Finish date'); },
  get estimate() { return t('Work'); },
  get spent() { return t('Spent time'); },
  get progress() { return t('% Complete'); },
  get storyPoints() { return t('Story points'); },
  get version() { return t('Version'); },
  get createdAt() { return t('Created on'); },
  get updatedAt() { return t('Updated on'); },
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
const NUMERIC_COLUMNS = new Set<string>(['estimate', 'spent', 'progress', 'storyPoints']);

/** A custom field column: `customField4`. Its values travel with each task. */
const isCustomField = (column: string) => /^customField\d+$/.test(column);

/** A sum as upstream sends it: a number, an ISO 8601 duration, or formatted money. */
function formatSum(value: number | string): string {
  if (typeof value === 'number') return formatNumber(value);
  const duration = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?)?$/.exec(value);
  if (duration && value !== 'P' && value !== 'PT') {
    const [, days = '0', hours = '0', minutes = '0'] = duration;
    return formatHours(Number(days) * 24 + Number(hours) + Number(minutes) / 60);
  }
  return value;
}

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
   * Custom fields are given by their upstream id, `customField4`.
   */
  columns?: string[];
  /** Headers for custom field columns, which the instance names. */
  columnLabels?: Record<string, string>;
  /**
   * Totals over the whole result, keyed by column. Shown in a footer row when
   * given; a column without one is left blank there.
   */
  sums?: Record<string, number | string>;
  emptyAction?: { label: string; onClick: () => void };
  /**
   * Indent rows under a parent that is also on this page.
   *
   * Paired with the query's own hierarchy mode, which is what puts those
   * parents there. Off means a flat list, which is what grouping and a sorted
   * view want — a tree and a sort order are different claims about the rows.
   */
  showHierarchy?: boolean;
  /**
   * The rows as a tree, ordered and measured by the server, all of them at
   * once: rows with children can be collapsed, and pages are cut from the rows
   * that can be seen. Takes over from `showHierarchy`.
   */
  tree?: TaskTree;
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
  tree,
  columns: controlledColumns,
  columnLabels,
  sums,
  sortable,
  groups,
  emptyAction,
}: TaskTableProps) {
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  // The bulk menus offer the instance's own statuses and priorities, the names
  // every row, filter and task page shows. EPM's categories are a grouping for
  // display: offered here, they listed "Backlog" and "Review" beside a task
  // page with no such status, and saved whichever status stood for the
  // category — or none, where no status did, while reporting the task updated.
  const statuses = useStatuses();
  const priorities = usePriorities();
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(
    hideProjectColumn ? DEFAULT_COLUMNS.filter((column) => column !== 'project') : DEFAULT_COLUMNS,
  );

  // A controlled selection keeps the query's own order; the internal one keeps
  // the table's declaration order so toggling does not reshuffle headers.
  const columns = useMemo((): string[] => {
    const renderable = new Set<string>(Object.keys(COLUMN_LABEL));

    if (controlledColumns) {
      return controlledColumns.filter(
        (column) =>
          (renderable.has(column) || isCustomField(column)) && !(hideProjectColumn && column === 'project'),
      );
    }

    return (Object.keys(COLUMN_LABEL) as ColumnKey[]).filter(
      (column) => visibleColumns.includes(column) && !(hideProjectColumn && column === 'project'),
    );
  }, [controlledColumns, visibleColumns, hideProjectColumn]);

  const labelOf = (column: string) =>
    COLUMN_LABEL[column as ColumnKey] ?? columnLabels?.[column] ?? column;

  // A custom field is a figure when its values are, or when upstream sums it.
  const numericColumns = useMemo(() => {
    const numeric = new Set(NUMERIC_COLUMNS);
    for (const column of columns) {
      if (!isCustomField(column)) continue;
      if (sums?.[column] !== undefined || tasks.some((task) => typeof task.customValues?.[column] === 'number')) {
        numeric.add(column);
      }
    }
    return numeric;
  }, [columns, sums, tasks]);

  const depths = useMemo(
    () =>
      tree
        ? new Map<ID, number>(Object.entries(tree.depth))
        : showHierarchy
          ? hierarchyDepths(tasks)
          : new Map<ID, number>(),
    [tree, showHierarchy, tasks],
  );

  // Rows whose children are folded away. Kept across pages: an id is an id.
  const [collapsed, setCollapsed] = useState<Set<ID>>(new Set());
  const parents = useMemo(() => (tree ? tasks.filter((task) => (tree.children[task.id] ?? 0) > 0).map((task) => task.id) : []), [tree, tasks]);
  const outside = useMemo(() => new Set(tree?.parentOutside ?? []), [tree]);
  const toggleCollapsed = (id: ID) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // A row is hidden while any of its ancestors is folded; the whole tree is on the page.
  const visibleTasks = useMemo(() => {
    if (!tree || collapsed.size === 0) return tasks;
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks.filter((task) => {
      let parentId = task.parentId;
      for (let guard = 0; parentId && byId.has(parentId) && guard < tasks.length; guard += 1) {
        if (collapsed.has(parentId)) return false;
        parentId = byId.get(parentId)?.parentId;
      }
      return true;
    });
  }, [tree, collapsed, tasks]);

  /*
   * As a tree, the whole result is here and pages are cut from the rows that
   * can be seen: so many rows a page whatever is expanded, and folding a branch
   * re-pages at once without asking the server again. In the groups' order when
   * grouped.
   */
  const visibleOrder = useMemo(() => {
    if (!tree) return visibleTasks;
    if (!groups?.length) return visibleTasks;
    const byId = new Map(visibleTasks.map((task) => [task.id, task]));
    return groups.flatMap((group) => group.taskIds.map((id) => byId.get(id)).filter((task): task is EpmTask => task !== undefined));
  }, [tree, groups, visibleTasks]);
  const pageTasks = useMemo(
    () => (tree ? visibleOrder.slice((page - 1) * pageSize, page * pageSize) : tasks),
    [tree, visibleOrder, page, pageSize, tasks],
  );
  // Folding a branch can leave the page past the end: back to the last one.
  const lastPage = Math.max(1, Math.ceil(visibleOrder.length / pageSize));
  useEffect(() => {
    if (tree && page > lastPage) onPageChange(lastPage);
  }, [tree, page, lastPage, onPageChange]);

  /**
   * The body's rows: either a flat list, or group headers interleaved with the
   * rows belonging to each group.
   *
   * Groups with nothing on this page are still rendered, because their count is
   * real and omitting them would make the page look like the whole result —
   * except as a tree, where pages run through the groups in order, so a group
   * with nothing here is wholly on another page and its header would be noise.
   */
  const rows = useMemo(() => {
    if (!groups?.length) {
      return (tree ? pageTasks : visibleTasks).map((task) => ({ kind: 'task' as const, task }));
    }

    const byId = new Map((tree ? pageTasks : visibleTasks).map((task) => [task.id, task]));

    return groups.flatMap((group) => {
      const members = group.taskIds.map((id) => byId.get(id)).filter((task): task is EpmTask => task !== undefined);
      if (tree && members.length === 0) return [];
      return [{ kind: 'group' as const, group }, ...members.map((task) => ({ kind: 'task' as const, task }))];
    });
  }, [groups, tree, pageTasks, visibleTasks]);

  // Selecting all is the rows on this page.
  const allSelected = pageTasks.length > 0 && pageTasks.every((task) => selected.has(task.id));
  const someSelected = selected.size > 0 && !allSelected;
  const selectedIds = [...selected];

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(pageTasks.map((task) => task.id)));
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
  const handleSort = (column: string) => {
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
              {t('{count, plural, one {# task selected} other {# tasks selected}}', { count: selected.size })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('Clear')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <BulkValueMenu
              label={t('Change status')}
              heading={t('Set status')}
              values={statuses.data}
              loading={statuses.isLoading}
              onPick={(statusId) => {
                onBulkUpdate?.(selectedIds, { statusId });
                setSelected(new Set());
              }}
            />

            <BulkValueMenu
              label={t('Priority')}
              heading={t('Set priority')}
              values={priorities.data}
              loading={priorities.isLoading}
              onPick={(priorityId) => {
                onBulkUpdate?.(selectedIds, { priorityId });
                setSelected(new Set());
              }}
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary">
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('Assign')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel>{t('Assign to')}</DropdownMenuLabel>
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
                {t('Delete')}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="px-1 text-2xs text-muted-foreground">
            {total === 0
              ? t('No results')
              : tree
                ? t('{items, plural, one {# top-level item} other {# top-level items}} · {count, plural, one {# task} other {# tasks}} in all', { items: total, count: tree.rows })
                : t('{count, plural, one {# task} other {# tasks}}', { count: total })}
            {tree?.truncated ? ` · ${t('Only the first {count} are shown as a tree: filter to narrow it.', { count: tree.rows })}` : ''}
          </p>
          <div className="flex items-center gap-1.5">
            {tree && parents.length > 0 ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                  {t('Expand all')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(parents))}>
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                  {t('Collapse all')}
                </Button>
              </>
            ) : null}
            {/* Hidden when a query owns the columns — two pickers editing the
                same thing, only one of which is saved, invites confusion. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className={cn(controlledColumns && 'hidden')}>
                  <Columns3 className="h-3.5 w-3.5" />
                  {t('Columns')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t('Visible columns')}</DropdownMenuLabel>
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
                {t('Export')}
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
        page={tree ? Math.min(page, lastPage) : page}
        pageSize={pageSize}
        total={tree ? visibleOrder.length : total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        pageSizeOptions={[15, 25, 50, 100]}
        itemLabel={tree ? t('row') : t('task')}
        itemLabelPlural={tree ? t('rows') : t('tasks')}
      />
    ) : undefined;

  return (
    <TableCard toolbar={toolbar} footer={footer}>
      {tasks.length === 0 ? (
        <EmptyState
          title={t('No tasks found')}
          description={t('Nothing matches the current filters. Adjust them, or create the first task.')}
          action={emptyAction}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pe-0">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={toggleAll}
                  aria-label={t('Select all tasks on this page')}
                />
              </TableHead>
              {columns.map((column) => {
                const sortKey = sortableColumns.has(column) ? column : undefined;
                const isSorted = sortKey !== undefined && sortBy === column;
                return (
                  <TableHead
                    key={column}
                    numeric={numericColumns.has(column)}
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
                        {labelOf(column)}
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
                      labelOf(column)
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
                          {group.value ?? t('None')}
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
              const depth = tree || showHierarchy ? (depths.get(task.id) ?? 0) : 0;
              const childCount = tree?.children[task.id] ?? 0;

              return (
                <TableRow key={task.id} data-state={isSelected ? 'selected' : undefined}>
                  <TableCell className="pe-0">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleOne(task.id)}
                      aria-label={t('Select {key}', { key: task.key })}
                    />
                  </TableCell>

                  {columns.map((column) => (
                    <TableCell key={column} numeric={numericColumns.has(column)}>
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
                              className="me-2 h-4 w-3 shrink-0 border-s border-border"
                            />
                          ))}
                          {tree ? (
                            childCount > 0 ? (
                              <button
                                type="button"
                                className="me-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                aria-expanded={!collapsed.has(task.id)}
                                aria-label={collapsed.has(task.id) ? t('Show the {count} items under {task}', { count: childCount, task: task.subject }) : t('Hide the {count} items under {task}', { count: childCount, task: task.subject })}
                                onClick={() => toggleCollapsed(task.id)}
                              >
                                {collapsed.has(task.id) ? <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              </button>
                            ) : (
                              <span aria-hidden className="me-1 h-5 w-5 shrink-0" />
                            )
                          ) : null}
                          <Link
                            to={`/tasks/${task.id}`}
                            dir="auto"
                            className={cn(
                              'truncate text-foreground underline-offset-2 hover:text-primary hover:underline',
                              tree && childCount > 0 ? 'font-semibold' : 'font-medium',
                            )}
                          >
                            {task.subject}
                          </Link>
                          {tree && childCount > 0 ? (
                            <span className="ms-1.5 shrink-0 text-2xs text-muted-foreground">({childCount})</span>
                          ) : null}
                          {outside.has(task.id) ? (
                            <span className="ms-1.5 shrink-0 text-2xs text-muted-foreground" title={t('Its parent is filtered out of this view, or listed under another group.')}>
                              {t('parent not listed here')}
                            </span>
                          ) : null}
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
                            {assignee?.name ?? t('Unassigned')}
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
                      ) : isCustomField(column) ? (
                        <CustomValueCell value={task.customValues?.[column]} />
                      ) : null}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
          {sums ? (
            <TableFooter>
              <TableRow>
                <TableCell className="pe-0 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('Sum')}
                </TableCell>
                {columns.map((column) => (
                  <TableCell key={column} numeric={numericColumns.has(column)} className="font-medium">
                    {sums[column] === undefined ? null : formatSum(sums[column]!)}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      )}
    </TableCard>
  );
}

/** A bulk action that sets one of the instance's values on every selected task. */
function BulkValueMenu({
  label,
  heading,
  values,
  loading,
  onPick,
}: {
  label: string;
  heading: string;
  values?: { id: ID; name: string }[];
  loading: boolean;
  onPick: (id: ID) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary">
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        {(values ?? []).map((value) => (
          <DropdownMenuItem key={value.id} onSelect={() => onPick(value.id)}>
            {value.name}
          </DropdownMenuItem>
        ))}
        {!values?.length ? (
          <DropdownMenuItem disabled>{loading ? t('Loading…') : t('Nothing to choose from.')}</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A custom field's value as the view shows it; a dash when it has none. */
function CustomValueCell({ value }: { value?: number | boolean | string }) {
  if (value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'boolean') return <span className="text-muted-foreground">{value ? t('Yes') : t('No')}</span>;
  if (typeof value === 'number') return <span className="text-muted-foreground">{formatNumber(value)}</span>;
  return <span className="block max-w-56 truncate text-muted-foreground" title={value}>{value}</span>;
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
