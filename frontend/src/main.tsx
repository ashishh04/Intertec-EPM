import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { persistOptions, PERSIST_MAX_AGE } from './lib/queryPersister';
import { App } from './App';
import { AuthProvider } from './providers/AuthProvider';
import { UIProvider } from './providers/UIProvider';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/toaster';
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
              <App />
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </UIProvider>
      </AuthProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
);
