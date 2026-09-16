import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  CircleHelp,
  FolderPlus,
  Keyboard,
  Menu,
  Plus,
  Search,
  Sparkles,
  Timer,
  ListPlus,
  LifeBuoy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoTooltip } from '@/components/ui/tooltip';
import { Breadcrumbs } from './Breadcrumbs';
import { NotificationPanel } from './NotificationPanel';
import { UserMenu } from './UserMenu';
import { ProjectDialog } from '@/components/common/ProjectDialog';
import { SprintDialog } from '@/components/sprints/SprintDialog';
import { useUI } from '@/providers/UIProvider';
import { featureFlags } from '@/config/env';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { toast } from 'sonner';

/** Sticky application header: context on the left, search and actions on the right. */
export function TopHeader() {
  const { setCommandPaletteOpen, setMobileNavOpen, openTaskDrawer, openPragnya } = useUI();
  const [projectOpen, setProjectOpen] = useState(false);
  const [sprintOpen, setSprintOpen] = useState(false);
  const { can, canAnywhere } = useAuth();
  const navigate = useNavigate();

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  const shortcut = isMac ? '⌘K' : 'Ctrl K';
  const pragnyaShortcut = isMac ? '⌘/' : 'Ctrl /';

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-md sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setMobileNavOpen(true)}
        aria-label="Open navigation menu"
      >
        <Menu className="h-4 w-4" />
      </Button>

      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>

      {/* Global search opens the command palette rather than a separate results page */}
      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        className={cn(
          'hidden h-8 items-center gap-2 rounded-lg border border-border bg-muted/60 px-2.5 text-xs text-muted-foreground transition-colors md:flex md:w-64 lg:w-80',
          'hover:border-primary/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">Search projects, tasks, people...</span>
        <kbd className="ml-auto shrink-0 rounded border border-border bg-surface px-1 py-0.5 font-mono text-2xs leading-none text-muted-foreground">
          {shortcut}
        </kbd>
      </button>

      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setCommandPaletteOpen(true)}
        aria-label="Search"
      >
        <Search className="h-4 w-4" />
      </Button>

      {/* Create */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" className="shrink-0">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Create</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Create new</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => openTaskDrawer()}
            disabled={!canAnywhere('task:create')}
          >
            <ListPlus />
            New Task
            <DropdownMenuShortcut>C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!can('project:create')}
            onSelect={() => setProjectOpen(true)}
          >
            <FolderPlus />
            New Project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSprintOpen(true)}>
            <Timer />
            New Sprint
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NotificationPanel />

      {featureFlags.pragnya ? (
        <InfoTooltip label={`Pragnya (${pragnyaShortcut})`}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Pragnya"
            aria-keyshortcuts={isMac ? 'Meta+/' : 'Control+/'}
            onClick={() => openPragnya()}
            className="text-highlight hover:bg-highlight-soft hover:text-highlight"
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        </InfoTooltip>
      ) : null}

      {/* Help */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Help and resources" className="hidden sm:inline-flex">
            <CircleHelp className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Help</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setCommandPaletteOpen(true)}>
            <Keyboard />
            Command palette
            <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              toast('Documentation is not implemented yet', {
                description: 'The delivery handbook lives in the Documents workspace.',
              })
            }
          >
            <BookOpen />
            Delivery handbook
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/settings/integration')}>
            <LifeBuoy />
            Integration status
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <UserMenu />

      <ProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
      <SprintDialog
        open={sprintOpen}
        onOpenChange={setSprintOpen}
        onCreated={(sprint) => navigate(`/agile?sprint=${sprint.id}`)}
      />
    </header>
  );
}
