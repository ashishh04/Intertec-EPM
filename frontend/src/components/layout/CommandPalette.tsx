import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3,
  CalendarDays,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListPlus,
  ListTodo,
  Settings,
  SquareKanban,
  Timer,
  Users,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { StatusBadge } from '@/components/common/StatusBadge';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useUI } from '@/providers/UIProvider';
import { useProjects } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useUsers } from '@/hooks/useUsers';
import { useTeams } from '@/hooks/useTeams';
import { useDebounce } from '@/hooks/useDebounce';

/**
 * Global command palette. Opens on Ctrl/Cmd+K from anywhere and searches
 * projects, tasks, people and teams alongside the standard actions.
 */
export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, openTaskDrawer } = useUI();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);

  // Search is only issued once the palette is open, keeping the app start light.
  const { data: projects } = useProjects();
  const { data: users } = useUsers();
  const { data: teams } = useTeams();
  const { data: taskPage } = useTasks({
    search: debouncedQuery || undefined,
    pageSize: 6,
    sortBy: 'updatedAt',
    sortDir: 'desc',
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) setQuery('');
  }, [commandPaletteOpen]);

  const run = (action: () => void) => {
    setCommandPaletteOpen(false);
    // Defer so the dialog close animation is not interrupted by navigation.
    requestAnimationFrame(action);
  };

  const matchedProjects = (projects ?? [])
    .filter((project) =>
      debouncedQuery
        ? `${project.name} ${project.identifier} ${project.portfolio}`
            .toLowerCase()
            .includes(debouncedQuery.toLowerCase())
        : true,
    )
    .slice(0, 5);

  const matchedUsers = (users ?? [])
    .filter((user) =>
      debouncedQuery
        ? `${user.name} ${user.role} ${user.department}`
            .toLowerCase()
            .includes(debouncedQuery.toLowerCase())
        : false,
    )
    .slice(0, 4);

  const matchedTeams = (teams ?? [])
    .filter((team) =>
      debouncedQuery ? team.name.toLowerCase().includes(debouncedQuery.toLowerCase()) : false,
    )
    .slice(0, 3);

  const matchedTasks = taskPage?.items.slice(0, 6) ?? [];

  return (
    <CommandDialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search projects, tasks, people..."
      />
      <CommandList>
        <CommandEmpty>No results for “{query}”.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem value="create task new" onSelect={() => run(() => openTaskDrawer())}>
            <ListPlus />
            Create task
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
          <CommandItem value="my work" onSelect={() => run(() => navigate('/my-work'))}>
            <ListTodo />
            Open my work
          </CommandItem>
          <CommandItem value="current sprint agile" onSelect={() => run(() => navigate('/agile'))}>
            <Timer />
            Open current sprint
          </CommandItem>
          <CommandItem value="reports" onSelect={() => run(() => navigate('/reports'))}>
            <FileText />
            Open reports
          </CommandItem>
          <CommandItem value="analytics insights" onSelect={() => run(() => navigate('/analytics'))}>
            <BarChart3 />
            Open delivery intelligence
          </CommandItem>
          <CommandItem value="settings" onSelect={() => run(() => navigate('/settings'))}>
            <Settings />
            Open settings
          </CommandItem>
        </CommandGroup>

        {matchedProjects.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {matchedProjects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`project ${project.name} ${project.identifier}`}
                  onSelect={() => run(() => navigate(`/projects/${project.id}`))}
                >
                  <FolderKanban />
                  <span className="truncate">{project.name}</span>
                  <CommandShortcut>{project.identifier}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {matchedTasks.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {matchedTasks.map((task) => (
                <CommandItem
                  key={task.id}
                  value={`task ${task.key} ${task.subject}`}
                  onSelect={() => run(() => navigate(`/tasks/${task.id}`))}
                >
                  <SquareKanban />
                  <span className="truncate">{task.subject}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    <StatusBadge status={task.statusCategory} size="sm" />
                    <span className="font-mono text-2xs text-muted-foreground">{task.key}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {matchedUsers.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="People">
              {matchedUsers.map((user) => (
                <CommandItem
                  key={user.id}
                  value={`person ${user.name} ${user.role}`}
                  onSelect={() => run(() => navigate(`/my-work?assignee=${user.id}`))}
                >
                  <UserAvatar user={user} size="xs" />
                  <span className="truncate">{user.name}</span>
                  <CommandShortcut>{user.role}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {matchedTeams.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Teams">
              {matchedTeams.map((team) => (
                <CommandItem
                  key={team.id}
                  value={`team ${team.name}`}
                  onSelect={() => run(() => navigate(`/teams/${team.id}`))}
                >
                  <Users />
                  <span className="truncate">{team.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Navigate">
          <CommandItem value="dashboard overview" onSelect={() => run(() => navigate('/dashboard'))}>
            <LayoutDashboard />
            Overview
          </CommandItem>
          <CommandItem value="calendar" onSelect={() => run(() => navigate('/calendar'))}>
            <CalendarDays />
            Calendar
          </CommandItem>
          <CommandItem value="teams" onSelect={() => run(() => navigate('/teams'))}>
            <Users />
            Teams
          </CommandItem>
          <CommandItem value="documents" onSelect={() => run(() => navigate('/documents'))}>
            <FileText />
            Documents
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
