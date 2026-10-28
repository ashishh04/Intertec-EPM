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

import { t } from '@/lib/i18n';

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
    get title() { return t('Getting around'); },
    shortcuts: [
      {
        keys: ['Ctrl', 'K'],
        get label() { return t('Open search and the command palette'); },
        get detail() { return t('Suggests actions, projects, tasks and pages before you finish typing.'); },
      },
      {
        keys: ['Ctrl', '/'],
        get label() { return t('Open or close Pragnya'); },
        get detail() { return t('Works from anywhere, including while you are typing in a field.'); },
        flag: 'pragnya',
      },
      {
        keys: ['Esc'],
        get label() { return t('Close whatever is open'); },
        get detail() { return t('Dialogs, drawers and the palette.'); },
      },
    ],
  },
  {
    get title() { return t('Creating'); },
    shortcuts: [
      {
        keys: ['C'],
        get label() { return t('Create task'); },
        get detail() { return t('Only when the cursor is not in a field, so typing a "c" never opens it.'); },
      },
    ],
  },
  {
    get title() { return t('In the command palette'); },
    shortcuts: [
      { keys: ['↑', '↓'], get label() { return t('Move through the results'); } },
      { keys: ['Enter'], get label() { return t('Open the highlighted result'); } },
      { keys: ['Ctrl', 'K'], get label() { return t('Close it again'); } },
    ],
  },
  {
    get title() { return t('In a list or table'); },
    shortcuts: [
      { keys: ['Tab'], get label() { return t('Move to the next control'); } },
      { keys: ['Space'], get label() { return t('Tick the focused checkbox'); } },
      { keys: ['Enter'], get label() { return t('Open the focused row'); } },
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
