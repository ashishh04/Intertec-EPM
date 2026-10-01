import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';
import { CommandPalette } from './CommandPalette';
import { MobileBottomNav, MobileNavSheet } from './MobileNav';
import { TaskDrawer } from '@/components/tasks/TaskDrawer';
import { PragnyaWidget } from '@/components/assistant';
import { featureFlags } from '@/config/env';
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
  const {
    openTaskDrawer,
    taskDrawerOpen,
    commandPaletteOpen,
    pragnyaOpen,
    openPragnya,
    closePragnya,
  } = useUI();
  const reducedMotion = usePrefersReducedMotion();

  // "C" creates a task, matching the shortcut advertised in the header menu.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'c' && event.key !== 'C') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (taskDrawerOpen || commandPaletteOpen || pragnyaOpen) return;

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
  }, [openTaskDrawer, taskDrawerOpen, commandPaletteOpen, pragnyaOpen]);

  // Ctrl+/ (Cmd+/ on a Mac) toggles Pragnya from anywhere, editable or not:
  // the modifier keeps it from colliding with typing.
  useEffect(() => {
    if (!featureFlags.pragnya) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      if (pragnyaOpen) closePragnya();
      else openPragnya();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pragnyaOpen, openPragnya, closePragnya]);

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

      {/* `epm-no-print` on the shell furniture: none of it is part of the
          document somebody prints or saves as a PDF, and left in it would take a
          column of the page and print the navigation as a list. */}
      <div className="epm-no-print hidden h-full lg:block">
        <Sidebar />
      </div>

      <MobileNavSheet />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="epm-no-print">
          <TopHeader />
        </div>

        {/*
          `relative` is load-bearing, not decoration.

          A scroll container only clips what it is the containing block for.
          Left static, every absolutely positioned descendant — the hidden input
          behind each checkbox, every `sr-only` span — resolves against the
          initial containing block instead, escapes this element's overflow and
          stretches the *document*. A long form then paints a second scrollbar
          beside this one and scrolls the whole app off-screen; the roles page,
          with 122 checkboxes, pushed the document to 4002px.

          Every scroll container in the app carries this for the same reason.
        */}
        <main
          id="epm-main"
          tabIndex={-1}
          className="epm-scroll relative flex-1 overflow-y-auto pb-20 focus-visible:outline-none md:pb-0"
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

      <div className="epm-no-print">
        <MobileBottomNav />
        <CommandPalette />
        <TaskDrawer />
        {featureFlags.pragnya ? <PragnyaWidget /> : null}
      </div>
    </div>
  );
}
