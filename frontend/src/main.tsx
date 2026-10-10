import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { persistOptions, PERSIST_MAX_AGE } from './lib/queryPersister';
import { App } from './App';
import { AuthProvider } from './providers/AuthProvider';
import { UIProvider } from './providers/UIProvider';
import { PreferenceEffects } from './providers/PreferenceEffects';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/toaster';
import { storedPreferences } from './hooks/usePreferences';
import { direction, loadLanguage, toLanguage } from './lib/i18n';
import './index.css';

/**
 * Query defaults tuned for an operational dashboard: results stay warm for a
 * short window, refetch on focus is off so the UI does not flicker while the
 * user reads, and failed reads retry once before surfacing an error state.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Must exceed the persister's maxAge. A restored query is garbage
      // collected the moment nothing observes it, so a shorter gcTime would
      // discard the persisted cache before the page that needs it mounts —
      // the restore would silently do nothing.
      gcTime: PERSIST_MAX_AGE,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/*
        Restores the last known data before the first request goes out, then
        revalidates. The skeletons only appear on a genuinely first visit.
      */}
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <AuthProvider>
          <UIProvider>
            <TooltipProvider delayDuration={300} skipDelayDuration={200}>
              <BrowserRouter>
                {/* Inside the router so a preference change repaints the routes,
                    and inside AuthProvider because the preferences it reads are
                    the signed-in person's. The toasts are inside too, so they
                    take the page's language and side. */}
                <PreferenceEffects>
                  <App />
                  <Toaster />
                </PreferenceEffects>
              </BrowserRouter>
            </TooltipProvider>
          </UIProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </StrictMode>,
  );
}

// The language this browser last used is loaded before the first paint, and the
// page direction set with it, so an Arabic reader never sees a frame of English
// laid out left to right. English needs nothing loaded and renders at once; a
// failed load renders in English rather than not at all.
const storedLanguage = toLanguage(storedPreferences().locale.language);
document.documentElement.lang = storedLanguage;
document.documentElement.dir = direction(storedLanguage);
void loadLanguage(storedLanguage).catch(() => undefined).finally(render);
