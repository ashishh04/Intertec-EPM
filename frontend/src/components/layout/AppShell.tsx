import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';
import { CommandPalette } from './CommandPalette';
import { MobileBottomNav, MobileNavSheet } from './MobileNav';
import { TaskDrawer } from '@/components/tasks/TaskDrawer';
import { ErrorBoundary } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { useUI } from '@/providers/UIProvider';
import { usePrefersReducedMotion } from '@/hooks/useMediaQuery';

/**
 * Authenticated application shell. Every route renders inside this frame, which
 * is what keeps the product feeling like one application rather than a set of
 * separate pages.
 */
export function AppShell() {
  const location = useLocation();
  const { openTaskDrawer, taskDrawerOpen, commandPaletteOpen } = useUI();
  const reducedMotion = usePrefersReducedMotion();

  // "C" creates a task, matching the shortcut advertised in the header menu.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'c' && event.key !== 'C') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (taskDrawerOpen || commandPaletteOpen) return;

      const target = event.target as HTMLElement | null;
      const isEditable =
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');
      if (isEditable) return;

      event.preventDefault();
      openTaskDrawer();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openTaskDrawer, taskDrawerOpen, commandPaletteOpen]);

  // Scroll back to the top on navigation so long pages do not start mid-content.
  useEffect(() => {
    document.getElementById('epm-main')?.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <a
        href="#epm-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-xs focus:font-medium focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <div className="hidden h-full lg:block">
        <Sidebar />
      </div>

      <MobileNavSheet />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopHeader />

        <main
          id="epm-main"
          tabIndex={-1}
          className="epm-scroll flex-1 overflow-y-auto pb-20 focus-visible:outline-none md:pb-0"
        >
          <ErrorBoundary fallbackTitle="This page could not be displayed">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6"
              >
                <Suspense fallback={<PageSkeleton />}>
                  <Outlet />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </ErrorBoundary>
        </main>
      </div>

      <MobileBottomNav />
      <CommandPalette />
      <TaskDrawer />
    </div>
  );
}
