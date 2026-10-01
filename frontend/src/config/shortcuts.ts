/**
 * Every keyboard shortcut the application binds, in one place.
 *
 * This is the registry, not a description of one. The header's hint chips, the
 * command palette's hint and the shortcuts reference all read from here, so a
 * shortcut cannot be advertised in one place and bound differently in another —
 * which is the failure mode of a help page written by hand: it drifts, and then
 * it teaches people keys that do nothing.
 *
 * The handlers still live with the components that own them; what is centralised
 * is the *published* key and its description. Anything bound and not listed here
 * is undiscoverable, so listing it is part of adding it.
 */

export interface Shortcut {
  /** The keys, written for a PC. `formatKeys` swaps in the Mac equivalents. */
  keys: string[];
  label: string;
  /** Why it exists, for the reference page. */
  detail?: string;
  /** Only shown where the feature is on. */
  flag?: 'pragnya';
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Getting around',
    shortcuts: [
      {
        keys: ['Ctrl', 'K'],
        label: 'Open search and the command palette',
        detail: 'Suggests actions, projects, tasks and pages before you finish typing.',
      },
      {
        keys: ['Ctrl', '/'],
        label: 'Open or close Pragnya',
        detail: 'Works from anywhere, including while you are typing in a field.',
        flag: 'pragnya',
      },
      { keys: ['Esc'], label: 'Close whatever is open', detail: 'Dialogs, drawers and the palette.' },
    ],
  },
  {
    title: 'Creating',
    shortcuts: [
      {
        keys: ['C'],
        label: 'Create a task',
        detail: 'Only when the cursor is not in a field, so typing a "c" never opens it.',
      },
    ],
  },
  {
    title: 'In the command palette',
    shortcuts: [
      { keys: ['↑', '↓'], label: 'Move through the results' },
      { keys: ['Enter'], label: 'Open the highlighted result' },
      { keys: ['Ctrl', 'K'], label: 'Close it again' },
    ],
  },
  {
    title: 'In a list or table',
    shortcuts: [
      { keys: ['Tab'], label: 'Move to the next control' },
      { keys: ['Space'], label: 'Tick the focused checkbox' },
      { keys: ['Enter'], label: 'Open the focused row' },
    ],
  },
];

/** True on a Mac, where the modifier is Command and the symbols differ. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `platform` is deprecated but is the only one of the three that is accurate
  // across the browsers this runs in; `userAgentData` is Chromium-only.
  return /Mac|iPhone|iPad/.test(navigator.platform ?? '');
}

const MAC_KEYS: Record<string, string> = {
  Ctrl: '⌘',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↩',
  Esc: '⎋',
};

/** One shortcut's keys, written for the platform it will be pressed on. */
export function formatKeys(keys: string[], mac = isMacPlatform()): string[] {
  return mac ? keys.map((key) => MAC_KEYS[key] ?? key) : keys;
}

/** The compact form used on a menu row, e.g. `⌘K` or `Ctrl K`. */
export function shortcutHint(keys: string[], mac = isMacPlatform()): string {
  const formatted = formatKeys(keys, mac);
  // No separator on a Mac: ⌘K is how the platform writes it, and "⌘ K" reads
  // as two keys rather than one chord.
  return mac ? formatted.join('') : formatted.join(' ');
}
