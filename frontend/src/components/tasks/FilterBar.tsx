import { Filter, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ALL_TASK_PRIORITIES,
  ALL_TASK_STATUSES,
  TASK_PRIORITY_META,
  TASK_STATUS_META,
} from '@/lib/domain';
import { cn } from '@/lib/utils';
import type {
  ID,
  EpmProject,
  EpmSprint,
  EpmUser,
  TaskFilters,
  TaskPriority,
  TaskStatusCategory,
} from '@/types';

export interface FilterBarProps {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  projects?: EpmProject[];
  users?: EpmUser[];
  sprints?: EpmSprint[];
  /** Hide selectors that are implied by the surrounding page. */
  hide?: ('project' | 'assignee' | 'sprint')[];
  searchPlaceholder?: string;
  className?: string;
  /** Extra controls rendered on the right, e.g. a view switcher. */
  trailing?: React.ReactNode;
}

const ALL = '__all__';

/**
 * Shared filter toolbar. Multi-value filters live in dropdown checklists,
 * single-value scopes in selects, and every active filter is summarised as a
 * removable chip so the current view is always legible.
 */
export function FilterBar({
  filters,
  onChange,
  projects = [],
  users = [],
  sprints = [],
  hide = [],
  searchPlaceholder = 'Search tasks...',
  className,
  trailing,
}: FilterBarProps) {
  const set = (patch: Partial<TaskFilters>) => onChange({ ...filters, ...patch, page: 1 });

  const toggleStatus = (status: TaskStatusCategory) => {
    const current = filters.status ?? [];
    set({
      status: current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    });
  };

  const togglePriority = (priority: TaskPriority) => {
    const current = filters.priority ?? [];
    set({
      priority: current.includes(priority)
        ? current.filter((item) => item !== priority)
        : [...current, priority],
    });
  };

  // A dimension the page has locked (e.g. the project on a project board) is
  // context, not a filter the user set — so it must not be counted or cleared.
  const activeCount =
    (filters.status?.length ?? 0) +
    (filters.priority?.length ?? 0) +
    (!hide.includes('project') && filters.projectId ? 1 : 0) +
    (!hide.includes('assignee') && filters.assigneeId ? 1 : 0) +
    (!hide.includes('sprint') && filters.sprintId ? 1 : 0);

  const clearAll = () =>
    onChange({
      ...filters,
      status: undefined,
      priority: undefined,
      projectId: hide.includes('project') ? filters.projectId : undefined,
      assigneeId: hide.includes('assignee') ? filters.assigneeId : undefined,
      sprintId: hide.includes('sprint') ? filters.sprintId : undefined,
      page: 1,
    });

  const selectedProject = projects.find((project) => project.id === filters.projectId);
  const selectedUser = users.find((user) => user.id === filters.assigneeId);
  const selectedSprint = sprints.find((sprint) => sprint.id === filters.sprintId);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filters.search ?? ''}
            onChange={(event) => set({ search: event.target.value })}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary">
              <Filter className="h-3.5 w-3.5" />
              Filter
              {activeCount > 0 ? (
                <Badge tone="primary" size="sm" className="ml-0.5 px-1.5">
                  {activeCount}
                </Badge>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>Status</DropdownMenuLabel>
            {ALL_TASK_STATUSES.map((status) => (
              <DropdownMenuCheckboxItem
                key={status}
                checked={filters.status?.includes(status) ?? false}
                onCheckedChange={() => toggleStatus(status)}
                onSelect={(event) => event.preventDefault()}
              >
                {TASK_STATUS_META[status].label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Priority</DropdownMenuLabel>
            {ALL_TASK_PRIORITIES.map((priority) => (
              <DropdownMenuCheckboxItem
                key={priority}
                checked={filters.priority?.includes(priority) ?? false}
                onCheckedChange={() => togglePriority(priority)}
                onSelect={(event) => event.preventDefault()}
              >
                {TASK_PRIORITY_META[priority].label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {!hide.includes('project') && projects.length > 0 ? (
          <Select
            value={filters.projectId ?? ALL}
            onValueChange={(value) => set({ projectId: value === ALL ? undefined : (value as ID) })}
          >
            <SelectTrigger className="h-8 w-auto min-w-36 text-xs" aria-label="Filter by project">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {!hide.includes('assignee') && users.length > 0 ? (
          <Select
            value={filters.assigneeId ?? ALL}
            onValueChange={(value) => set({ assigneeId: value === ALL ? undefined : (value as ID) })}
          >
            <SelectTrigger className="h-8 w-auto min-w-36 text-xs" aria-label="Filter by assignee">
              <SelectValue placeholder="Anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Anyone</SelectItem>
              {users.map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {!hide.includes('sprint') && sprints.length > 0 ? (
          <Select
            value={filters.sprintId ?? ALL}
            onValueChange={(value) => set({ sprintId: value === ALL ? undefined : (value as ID) })}
          >
            <SelectTrigger className="h-8 w-auto min-w-32 text-xs" aria-label="Filter by sprint">
              <SelectValue placeholder="All sprints" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sprints</SelectItem>
              {sprints.map((sprint) => (
                <SelectItem key={sprint.id} value={sprint.id}>
                  {sprint.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
      </div>

      {activeCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.status?.map((status) => (
            <FilterChip
              key={`status-${status}`}
              label={TASK_STATUS_META[status].label}
              onRemove={() => toggleStatus(status)}
            />
          ))}
          {filters.priority?.map((priority) => (
            <FilterChip
              key={`priority-${priority}`}
              label={TASK_PRIORITY_META[priority].label}
              onRemove={() => togglePriority(priority)}
            />
          ))}
          {selectedProject && !hide.includes('project') ? (
            <FilterChip
              label={selectedProject.name}
              onRemove={() => set({ projectId: undefined })}
            />
          ) : null}
          {selectedUser && !hide.includes('assignee') ? (
            <FilterChip label={selectedUser.name} onRemove={() => set({ assigneeId: undefined })} />
          ) : null}
          {selectedSprint && !hide.includes('sprint') ? (
            <FilterChip label={selectedSprint.name} onRemove={() => set({ sprintId: undefined })} />
          ) : null}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-2xs text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
