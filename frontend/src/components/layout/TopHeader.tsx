import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  CircleHelp,
  Info,
  Keyboard,
  Menu,
  Search,
  Sparkles,
  LifeBuoy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoTooltip } from '@/components/ui/tooltip';
import { Breadcrumbs } from './Breadcrumbs';
import { NotificationPanel } from './NotificationPanel';
import { UserMenu } from './UserMenu';
import { CreateMenu } from './CreateMenu';
import { TimerIndicator } from '@/components/time/TimerIndicator';
import { ShortcutsDialog } from './ShortcutsDialog';
import { AboutDialog } from './AboutDialog';
import { useUI } from '@/providers/UIProvider';
import { APP_NAME, featureFlags } from '@/config/env';
import { shortcutHint } from '@/config/shortcuts';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';

/** Sticky application header: context on the left, search and actions on the right. */
export function TopHeader() {
  const { setCommandPaletteOpen, setMobileNavOpen, openPragnya } = useUI();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const { can } = useAuth();
  const navigate = useNavigate();

  // Read from the shortcut registry rather than written here, so the chip on
  // this header and the reference dialog can never disagree about the key.
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  const shortcut = shortcutHint(['Ctrl', 'K'], isMac);
  const pragnyaShortcut = shortcutHint(['Ctrl', '/'], isMac);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-md sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setMobileNavOpen(true)}
        aria-label={t('Open navigation menu')}
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
        <span className="truncate">{t('Search projects, tasks, people...')}</span>
        <kbd className="ms-auto shrink-0 rounded border border-border bg-surface px-1 py-0.5 font-mono text-2xs leading-none text-muted-foreground">
          {shortcut}
        </kbd>
      </button>

      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setCommandPaletteOpen(true)}
        aria-label={t('Search')}
      >
        <Search className="h-4 w-4" />
      </Button>

      {/* Create: every kind of thing a person can start from anywhere. */}
      <CreateMenu />

      {/* A running timer, while there is one. */}
      <TimerIndicator />

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
          <Button variant="ghost" size="icon" aria-label={t('Help and resources')} className="hidden sm:inline-flex">
            <CircleHelp className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{t('Help')}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setCommandPaletteOpen(true)}>
            <Search />
            {t('Search and commands')}
            <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
            <Keyboard />
            {t('Keyboard shortcuts')}
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('Documentation')}</DropdownMenuLabel>
          {/* The handbook is a wiki page now that EPM has a wiki, which is what a
              handbook wants to be: editable by the people who know, and linkable
              from a ticket. A page that has not been written yet lands on the
              wiki's own "create this page" state rather than on an error. */}
          <DropdownMenuItem onSelect={() => navigate('/wiki/delivery-handbook')}>
            <BookOpen />
            {t('Delivery handbook')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/wiki')}>
            <BookOpen />
            {t('Browse the wiki')}
          </DropdownMenuItem>

          {/* Integration status is administration. Offered only to people who can
              open it — it used to be here for everybody and sent the rest to a
              Forbidden page. */}
          {can('users:manage') ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate('/settings/integration')}>
                <LifeBuoy />
                {t('Integration status')}
              </DropdownMenuItem>
            </>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
            <Info />
            {t('About {app}', { app: APP_NAME })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <UserMenu />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />

    </header>
  );
}
