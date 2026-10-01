import { Fragment, useEffect } from 'react';

import { usePreferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import { setDateConventions } from '@/lib/utils';

/**
 * Makes the appearance and formatting preferences take effect.
 *
 * Renders nothing. It exists because those settings apply to the whole document
 * rather than to a component: a date format is read by a few hundred call sites,
 * table density by every table, reduced motion by everything that animates.
 * Subscribing each of them to a preference would mean a hook in every leaf that
 * renders a date — including the plain functions that are not components at all.
 *
 * So the values are pushed outward once, from here: two data attributes on
 * `<html>` that `index.css` responds to, and a module-level setting the date
 * helpers read. Mounted inside the providers, above the router, so it is in
 * place before the first route paints.
 *
 * The date format is the one that needs care. A module-level value does not
 * re-render anything on its own, so switching format would leave every date on
 * screen stale until something happened to repaint it. The fix is deliberately
 * blunt and lives here: changing it bumps a `key` on the subtree below, which
 * remounts it once. That is acceptable precisely because it is rare — somebody
 * sets their date format when they join and then never again.
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
  const { dateFormat } = preferences.locale;
  const { timeFormat } = preferences.workweek;
  const { compactTables, reduceMotion } = preferences.appearance;

  // Applied during render rather than in the effect below, so the very first
  // paint already uses the right format instead of showing the default for a
  // frame and then correcting itself.
  setDateConventions({ dateFormat, timeFormat });

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
  return <Fragment key={`${dateFormat}:${timeFormat}`}>{children}</Fragment>;
}
