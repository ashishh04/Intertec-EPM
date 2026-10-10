import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  CalendarDays,
  Clock,
  Coins,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListPlus,
  Megaphone,
  ListTodo,
  Loader2,
  Settings,
  Sparkles,
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
import { featureFlags } from '@/config/env';
import { t } from '@/lib/i18n';

/** Each group shows this many before asking for a narrower search. */
const LIMITS = { projects: 5, tasks: 6, users: 4, teams: 3 };

/**
 * Global command palette. Opens on Ctrl/Cmd+K from anywhere and searches
 * projects, tasks, people and teams alongside the standard actions.
 */
export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, openTaskDrawer, openPragnya } = useUI();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);

  // Search is only issued once the palette is open, keeping the app start light.
  const { data: projects } = useProjects();
  const { data: users } = useUsers();
  const { data: teams } = useTeams();
  const { data: taskPage, isFetching: searchingTasks } = useTasks({
    search: debouncedQuery || undefined,
    pageSize: LIMITS.tasks,
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

  // Each group is capped, and remembers how many it left out so the reader
  // knows to narrow the search rather than assume that was everything.
  const projectMatches = (projects ?? []).filter((project) =>
    debouncedQuery
      ? `${project.name} ${project.identifier} ${project.portfolio}`
          .toLowerCase()
          .includes(debouncedQuery.toLowerCase())
      : true,
  );
  const matchedProjects = projectMatches.slice(0, LIMITS.projects);

  const userMatches = (users ?? []).filter((user) =>
    debouncedQuery
      ? `${user.name} ${user.role} ${user.department}`
          .toLowerCase()
          .includes(debouncedQuery.toLowerCase())
      : false,
  );
  const matchedUsers = userMatches.slice(0, LIMITS.users);

  const teamMatches = (teams ?? []).filter((team) =>
    debouncedQuery ? team.name.toLowerCase().includes(debouncedQuery.toLowerCase()) : false,
  );
  const matchedTeams = teamMatches.slice(0, LIMITS.teams);

  const matchedTasks = taskPage?.items.slice(0, LIMITS.tasks) ?? [];
  // Tasks are searched server-side, so the overflow comes from the page total.
  const moreTasks = Math.max(0, (taskPage?.total ?? 0) - matchedTasks.length);

  return (
    <CommandDialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('Search projects, tasks, people...')}
      />
      <CommandList>
        <CommandEmpty>{t('No results for “{query}”.', { query })}</CommandEmpty>

        <CommandGroup heading={t('Actions')}>
          <CommandItem value="create task new" onSelect={() => run(() => openTaskDrawer())}>
            <ListPlus />
            {t('Create task')}
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
          {featureFlags.pragnya ? (
            // The value carries the query so this stays visible whatever is
            // typed: any search can be turned into a question.
            <CommandItem
              value={`pragnya assistant ask ${query}`}
              onSelect={() => run(() => openPragnya(query.trim() || undefined))}
            >
              <Sparkles />
              {query.trim() ? (
                <span className="truncate">
                  Pragnya: <span dir="auto" className="text-muted-foreground">“{query.trim()}”</span>
                </span>
              ) : (
                'Pragnya'
              )}
              <CommandShortcut>Ctrl /</CommandShortcut>
            </CommandItem>
          ) : null}
          <CommandItem value="my work" onSelect={() => run(() => navigate('/my-work'))}>
            <ListTodo />
            {t('Open my work')}
          </CommandItem>
          <CommandItem
            value="my time timesheet log hours"
            onSelect={() => run(() => navigate('/my-time'))}
          >
            <Clock />
            {t('Open my timesheet')}
          </CommandItem>
          <CommandItem value="current sprint agile" onSelect={() => run(() => navigate('/agile'))}>
            <Timer />
            {t('Open current sprint')}
          </CommandItem>
          <CommandItem value="reports" onSelect={() => run(() => navigate('/reports'))}>
            <FileText />
            {t('Open reports')}
          </CommandItem>
          <CommandItem
            value="time and costs cost report hours spend"
            onSelect={() => run(() => navigate('/time-and-costs'))}
          >
            <Coins />
            {t('Open time and costs')}
          </CommandItem>
          <CommandItem value="analytics insights" onSelect={() => run(() => navigate('/analytics'))}>
            <BarChart3 />
            {t('Open delivery intelligence')}
          </CommandItem>
          <CommandItem value="settings" onSelect={() => run(() => navigate('/settings'))}>
            <Settings />
            {t('Open settings')}
          </CommandItem>
        </CommandGroup>

        {matchedProjects.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('Projects')}>
              {matchedProjects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`project ${project.name} ${project.identifier}`}
                  onSelect={() => run(() => navigate(`/projects/${project.id}`))}
                >
                  <FolderKanban />
                  <span dir="auto" className="truncate">{project.name}</span>
                  <CommandShortcut>{project.identifier}</CommandShortcut>
                </CommandItem>
              ))}
              <MoreResults count={projectMatches.length - matchedProjects.length} />
            </CommandGroup>
          </>
        ) : null}

        {/* Outside the group: cmdk hides a group with no matching items, and
            the search may still be in flight before there are any. */}
        {searchingTasks ? (
          <div
            role="status"
            className="flex items-center gap-2.5 px-2.5 py-2 text-xs text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            {t('Searching…')}
          </div>
        ) : null}

        {matchedTasks.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('Tasks')}>
              {matchedTasks.map((task) => (
                <CommandItem
                  key={task.id}
                  value={`task ${task.key} ${task.subject}`}
                  onSelect={() => run(() => navigate(`/tasks/${task.id}`))}
                >
                  <SquareKanban />
                  <span dir="auto" className="truncate">{task.subject}</span>
                  <span className="ms-auto flex shrink-0 items-center gap-2">
                    <StatusBadge status={task.statusCategory} size="sm" />
                    <span className="font-mono text-2xs text-muted-foreground">{task.key}</span>
                  </span>
                </CommandItem>
              ))}
              <MoreResults count={moreTasks} />
            </CommandGroup>
          </>
        ) : null}

        {matchedUsers.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('People')}>
              {matchedUsers.map((user) => (
                <CommandItem
                  key={user.id}
                  value={`person ${user.name} ${user.role}`}
                  onSelect={() => run(() => navigate(`/my-work?assignee=${user.id}`))}
                >
                  <UserAvatar user={user} size="xs" />
                  <span dir="auto" className="truncate">{user.name}</span>
                  <CommandShortcut>{user.role}</CommandShortcut>
                </CommandItem>
              ))}
              <MoreResults count={userMatches.length - matchedUsers.length} />
            </CommandGroup>
          </>
        ) : null}

        {matchedTeams.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('Teams')}>
              {matchedTeams.map((team) => (
                <CommandItem
                  key={team.id}
                  value={`team ${team.name}`}
                  onSelect={() => run(() => navigate(`/teams/${team.id}`))}
                >
                  <Users />
                  <span dir="auto" className="truncate">{team.name}</span>
                </CommandItem>
              ))}
              <MoreResults count={teamMatches.length - matchedTeams.length} />
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading={t('Navigate')}>
          <CommandItem value="dashboard overview" onSelect={() => run(() => navigate('/dashboard'))}>
            <LayoutDashboard />
            {t('Overview')}
          </CommandItem>
          <CommandItem value="calendar" onSelect={() => run(() => navigate('/calendar'))}>
            <CalendarDays />
            {t('Calendar')}
          </CommandItem>
          <CommandItem value="teams" onSelect={() => run(() => navigate('/teams'))}>
            <Users />
            {t('Teams')}
          </CommandItem>
          <CommandItem value="documents" onSelect={() => run(() => navigate('/documents'))}>
            <FileText />
            {t('Documents')}
          </CommandItem>
          {/* The collaboration modules belong here too. A palette that knows
              about every page but the three newest is a palette people stop
              trusting to find things. */}
          <CommandItem
            value="meetings agenda minutes"
            onSelect={() => run(() => navigate('/meetings'))}
          >
            <CalendarClock />
            {t('Meetings')}
          </CommandItem>
          <CommandItem
            value="news announcements"
            onSelect={() => run(() => navigate('/news'))}
          >
            <Megaphone />
            {t('News')}
          </CommandItem>
          <CommandItem
            value="wiki documentation handbook pages"
            onSelect={() => run(() => navigate('/wiki'))}
          >
            <BookOpen />
            {t('Wiki')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/**
 * Quiet trailer for a capped group. A plain div rather than a `CommandItem`,
 * because cmdk would filter an item out whenever its text did not match the
 * search — and this one never will.
 */
function MoreResults({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="px-2.5 py-1.5 text-2xs text-muted-foreground" aria-live="polite">
      {t('{count, plural, other {# more — refine your search}}', { count })}
    </p>
  );
}
