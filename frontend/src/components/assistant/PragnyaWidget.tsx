import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import { useUI } from '@/providers/UIProvider';
import { usePrefersReducedMotion } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import type { ID } from '@/types';
import { PragnyaPanel } from './PragnyaPanel';

const PANEL_ID = 'pragnya-panel';
const DESCRIPTION_ID = 'pragnya-panel-description';

/**
 * Until `md` the mobile bottom navigation owns the foot of the screen, so the
 * launcher is lifted clear of that bar (and of the phone's home indicator);
 * from `md` up the bar is gone and the button drops into the corner.
 */
const LAUNCHER_POSITION =
  'bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 md:bottom-6 md:right-6';

/** The popup sits just above the launcher, so it follows the same two offsets. */
const PANEL_POSITION = cn(
  'sm:bottom-[calc(8.75rem+env(safe-area-inset-bottom))] sm:right-4 sm:max-h-[calc(100dvh-12rem)]',
  'md:bottom-[5.5rem] md:right-6 md:max-h-[calc(100dvh-8rem)]',
);

/**
 * Pragnya, the in-app assistant, as a launcher pinned to the bottom-right
 * corner and the popup it opens.
 *
 * The popup is deliberately not modal: no scrim, no focus trap, `role="dialog"`
 * without `aria-modal`. The page underneath stays readable and clickable while
 * a question is in flight, which is the whole point of a popup over a sheet —
 * so Radix's Dialog, which traps focus, would be the wrong primitive here.
 */
export function PragnyaWidget() {
  const { pragnyaOpen, openPragnya, closePragnya } = useUI();
  const reducedMotion = usePrefersReducedMotion();

  // The conversation outlives the popup: closing and reopening should come
  // back to the thread rather than to a blank chat.
  const [conversationId, setConversationId] = useState<ID | null>(null);

  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Hand focus back to the launcher on close — but only if the popup was
  // holding it. Closing with Ctrl+/ from a field elsewhere should leave the
  // reader where they were typing.
  const wasOpen = useRef(pragnyaOpen);
  useEffect(() => {
    const closed = wasOpen.current && !pragnyaOpen;
    wasOpen.current = pragnyaOpen;
    if (!closed) return;
    const active = document.activeElement;
    if (!active || active === document.body || panelRef.current?.contains(active)) {
      launcherRef.current?.focus();
    }
  }, [pragnyaOpen]);

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => (pragnyaOpen ? closePragnya() : openPragnya())}
        aria-label={pragnyaOpen ? 'Close Pragnya' : 'Open Pragnya'}
        aria-expanded={pragnyaOpen}
        aria-controls={PANEL_ID}
        className={cn(
          'fixed z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-diagonal text-white shadow-floating',
          'transition-transform duration-150 ease-swift hover:-translate-y-0.5 active:scale-95',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          LAUNCHER_POSITION,
        )}
      >
        {pragnyaOpen ? (
          <X className="h-6 w-6" aria-hidden />
        ) : (
          <Sparkles className="h-6 w-6" aria-hidden />
        )}
      </button>

      <AnimatePresence>
        {pragnyaOpen ? (
          <motion.div
            ref={panelRef}
            id={PANEL_ID}
            role="dialog"
            aria-label="Pragnya"
            aria-describedby={DESCRIPTION_ID}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: reducedMotion ? 0.01 : 0.2, ease: [0.32, 0.72, 0, 1] }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              closePragnya();
            }}
            className={cn(
              // Full-bleed on a phone, a corner popup from `sm` up.
              'fixed inset-0 z-40 flex flex-col overflow-hidden border-border bg-surface shadow-floating',
              'origin-bottom pb-[env(safe-area-inset-bottom)]',
              'sm:inset-auto sm:h-[34rem] sm:w-[26rem] sm:origin-bottom-right sm:rounded-2xl sm:border sm:pb-0',
              PANEL_POSITION,
            )}
          >
            <p id={DESCRIPTION_ID} className="sr-only">
              Ask questions about projects, tasks, sprints and people. Answers come from EPM data.
            </p>
            <PragnyaPanel
              conversationId={conversationId}
              onConversationChange={setConversationId}
              onClose={closePragnya}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
