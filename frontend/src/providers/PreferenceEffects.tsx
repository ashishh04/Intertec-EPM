import { Fragment, useEffect, useState } from 'react';
import { DirectionProvider } from '@radix-ui/react-direction';

import { usePreferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import { setDateConventions } from '@/lib/utils';
import {
  direction,
  isLanguageLoaded,
  loadLanguage,
  setConventions,
  toLanguage,
  type Language,
} from '@/lib/i18n';

/**
 * Makes the appearance, language and formatting preferences take effect.
 *
 * Renders nothing of its own. It exists because those settings apply to the
 * whole document rather than to a component: a date format is read by a few
 * hundred call sites, the language by every string, table density by every
 * table, reduced motion by everything that animates. Subscribing each of them
 * to a preference would mean a hook in every leaf that renders text —
 * including the plain functions that are not components at all.
 *
 * So the values are pushed outward once, from here: attributes on `<html>`
 * that `index.css` and the browser respond to (`lang`, `dir`, density, motion),
 * and module-level settings the date, number and message helpers read. Mounted
 * inside the providers, above the router, so it is in place before the first
 * route paints.
 *
 * A module-level value does not re-render anything on its own, so switching
 * language or format would leave every string on screen stale until something
 * happened to repaint it. The fix is deliberately blunt and lives here:
 * changing one bumps a `key` on the subtree below, which remounts it once. That
 * is acceptable precisely because it is rare — somebody sets their language and
 * date format when they join and then never again.
 */
export function PreferenceEffects({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();

  // Asked for only once a session exists. This renders above the router, so it
  // is mounted on the public pages as well — and a signed-out request for a
  // person's preferences 401s, which the api client turns into a navigation to
  // /login. Ungated, that redirects every visitor off the landing page before
  // it paints. Until then the values come from the local copy, which is what
  // the first paint of a signed-in session uses anyway.
  const { preferences } = usePreferences({ enabled: isAuthenticated });
  const { dateFormat, calendar, numerals } = preferences.locale;
  const { timeFormat } = preferences.workweek;
  const { compactTables, reduceMotion } = preferences.appearance;

  // The language shown is the one chosen once its catalogue is here. Until then
  // the current one stays: a page that switches direction and then waits for its
  // words would flash right-to-left English. `main.tsx` preloads the stored
  // language, so the first paint is already right.
  const wanted = toLanguage(preferences.locale.language);
  const [language, setLanguage] = useState<Language>(() => (isLanguageLoaded(wanted) ? wanted : 'en'));

  useEffect(() => {
    if (wanted === language) return;
    let cancelled = false;
    loadLanguage(wanted)
      .then(() => {
        if (!cancelled) setLanguage(wanted);
      })
      .catch(() => {
        // Offline, or a deploy removed the chunk: stay in the current language
        // rather than show a page with no words.
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, language]);

  // Applied during render rather than in an effect, so the very first paint
  // already uses the right language and format instead of showing the default
  // for a frame and then correcting itself.
  setConventions({ language, calendar, numerals });
  setDateConventions({ dateFormat, timeFormat });

  const dir = direction(language);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = language;
    root.dir = dir;
  }, [language, dir]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = compactTables ? 'compact' : 'default';

    // Only ever set to `reduced`, never to `full`: the operating system's own
    // `prefers-reduced-motion` is honoured by the same stylesheet, and writing
    // an explicit "motion on" here would look like permission to override it.
    if (reduceMotion) {
      root.dataset.motion = 'reduced';
    } else {
      delete root.dataset.motion;
    }
  }, [compactTables, reduceMotion]);

  // A keyed Fragment, not a keyed element: this needs to remount the subtree
  // without putting a box in the layout. `display: contents` would also work and
  // brings its own problems — it removes the element from the accessibility tree
  // in some engines, and the app's grid would gain a stray participant.
  //
  // The direction provider tells the Radix primitives (menus, selects, tabs,
  // sheets) which way is "start", so submenus open and arrow keys move the way
  // the page reads.
  return (
    <DirectionProvider dir={dir}>
      <Fragment key={`${language}:${calendar}:${numerals}:${dateFormat}:${timeFormat}`}>{children}</Fragment>
    </DirectionProvider>
  );
}
