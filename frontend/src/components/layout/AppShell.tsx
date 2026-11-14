import { Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
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
import { prefetchPages } from '@/lib/pages';
import { t } from '@/lib/i18n';

/**
 * What the page content is keyed by. A project's tabs share one key, so moving
 * between them swaps the tab and keeps the project's header and tab bar in place
 * instead of rebuilding the whole project page; every other address is its own.
 */
const contentKey = (pathname: string) => /^\/projects\/[^/]+/.exec(pathname)?.[0] ?? pathname;

/**
 * Authenticated application shell. Every route renders inside this frame, which
 * is what keeps the product feeling like one application rather than a set of
 * separate pages.
 */
export function AppShell() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const {
    openTaskDrawer,
    closeTaskDrawer,
    taskDrawerOpen,
    commandPaletteOpen,
    pragnyaOpen,
    openPragnya,
    closePragnya,
  } = useUI();

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

  /*
   * Scroll like a browser does. A new page starts at the top; Back and Forward
   * return to where that page was left. Each history entry's position is kept
   * as the person scrolls, under the entry's own key. A change that stays on the
   * same page (a filter, a tab held in the query string) keeps the position.
   */
  const scrollPositions = useRef(new Map<string, number>());
  const entryKey = useRef(location.key);
  const lastPathname = useRef(location.pathname);

  useEffect(() => {
    const main = document.getElementById('epm-main');
    if (!main) return undefined;
    const remember = () => scrollPositions.current.set(entryKey.current, main.scrollTop);
    main.addEventListener('scroll', remember, { passive: true });
    return () => main.removeEventListener('scroll', remember);
  }, []);

  // Before paint, so a restored page never shows a frame at the wrong place.
  useLayoutEffect(() => {
    entryKey.current = location.key;
    const main = document.getElementById('epm-main');
    const changedPage = lastPathname.current !== location.pathname;
    lastPathname.current = location.pathname;
    if (!main) return;

    const saved = navigationType === 'POP' ? scrollPositions.current.get(location.key) : undefined;
    if (saved !== undefined) {
      main.scrollTo({ top: saved });
      // The page may still be laying out what it read from the cache: try again
      // on the next two frames, until the content is tall enough to hold it.
      requestAnimationFrame(() => {
        main.scrollTo({ top: saved });
        requestAnimationFrame(() => main.scrollTo({ top: saved }));
      });
    } else if (changedPage) {
      main.scrollTo({ top: 0 });
    }
  }, [location.key, location.pathname, navigationType]);

  // The create-task panel belongs to the page it was opened on: moving to
  // another page, Back included, closes it rather than leaving it over a page
  // it was not opened from.
  const pathnameAtOpen = useRef(location.pathname);
  useEffect(() => {
    if (pathnameAtOpen.current !== location.pathname) {
      pathnameAtOpen.current = location.pathname;
      closeTaskDrawer();
    }
  }, [location.pathname, closeTaskDrawer]);

  // Once the person is in and the first page has had its turn, fetch the other
  // pages in the background, so opening any of them never waits on a download.
  useEffect(() => {
    const timer = window.setTimeout(prefetchPages, 2_500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <a
        href="#epm-main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-xs focus:font-medium focus:text-primary-foreground"
      >
        {t('Skip to main content')}
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
          {/* The boundary resets with the address, so one page that fails does
              not keep showing its error over every page opened after it. */}
          <ErrorBoundary fallbackTitle={t('This page could not be displayed')} resetKey={location.pathname}>
            {/* No exit animation and no waiting for one: the next page renders
                at once and only fades in (index.css, .epm-page-in), so a click
                is never held back by the page it leaves. */}
            <div
              key={contentKey(location.pathname)}
              className="epm-page-in mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6"
            >
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </div>
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
