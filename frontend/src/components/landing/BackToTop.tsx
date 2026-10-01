import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUp } from 'lucide-react';

/** Roughly one screen down — far enough that the hero's own nav is long gone. */
const APPEAR_AFTER_PX = 700;

/**
 * The way back to the sign-in call to action without scrolling the whole page.
 *
 * The header is fixed, so getting back up is never impossible — but the
 * decision the page is asking for lives in the hero, and on a phone that is
 * six screens of scrolling away. The pill is the shortcut.
 *
 * A real `<button>`, not an anchor to `#top`: there is no `#top` to land on,
 * and a hash would leave a dead fragment in the address bar after the scroll.
 */
export function BackToTop() {
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > APPEAR_AFTER_PX);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.button
          type="button"
          onClick={() =>
            // `smooth` on a page this tall is a long ride; for anyone who asked
            // for less motion it is also exactly the kind of movement they
            // turned off, so they get the jump instead.
            window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
          }
          aria-label="Back to top"
          initial={reduceMotion ? undefined : { opacity: 0, y: 12 }}
          animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: 12 }}
          transition={{ duration: 0.25 }}
          whileHover={reduceMotion ? undefined : { scale: 1.06 }}
          whileTap={reduceMotion ? undefined : { scale: 0.94 }}
          // Clears the mobile bottom rail's height on small screens, so it
          // never covers a sign-in control on a phone.
          className="liquid-glass fixed bottom-6 right-5 z-40 grid h-11 w-11 place-items-center rounded-full text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 sm:bottom-8 sm:right-8"
        >
          <ArrowUp className="h-4.5 w-4.5" aria-hidden />
        </motion.button>
      ) : null}
    </AnimatePresence>
  );
}
