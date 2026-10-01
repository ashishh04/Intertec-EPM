import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { queryKeys } from '@/lib/queryKeys';
import { preferenceService } from '@/services';
import type { UserPreferences } from '@/types';

/**
 * Personal preferences.
 *
 * The record lives on the EPM backend, so it follows the person between
 * browsers and the email worker can honour it with no browser open. Every
 * surface that shows it — Settings, Profile — reads the same query, so a
 * toggle flipped on one page is already flipped on the other.
 *
 * A copy is kept in local storage purely so the first paint shows the person's
 * own values rather than the defaults for the moment before the server
 * answers. Nothing reads it once the server has.
 */

export type Preferences = UserPreferences;

/** The working week EPM assumes before anyone says otherwise. */
const DEFAULT_WORKING_DAYS: Preferences['availability']['workingDays'] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
];

export const DEFAULT_PREFERENCES: Preferences = {
  notifications: {
    assigned: true,
    mentions: true,
    statusChanges: true,
    dueReminders: true,
    digest: false,
    participating: true,
    accountable: true,
    watcher: true,
    shared: true,
    dateAlerts: true,
    pause: { enabled: false },
  },
  email: {
    enabled: true,
    assigned: true,
    mentions: true,
    membership: true,
    updates: false,
    dueReminders: true,
    digest: true,
    // The backend's own default comes from its configuration, so this is only
    // the value the very first paint shows before the server answers.
    reminderHour: 8,
    reminderDays: DEFAULT_WORKING_DAYS,
    news: true,
    wiki: false,
    meetings: true,
    documents: false,
    comments: true,
  },
  appearance: {
    compactTables: false,
    reduceMotion: false,
    showAvatars: true,
  },
  workweek: {
    startOfWeek: 'monday',
    timeFormat: '24h',
  },
  workspace: {
    landingPage: 'dashboard',
  },
  locale: {
    language: '',
    dateFormat: 'system',
  },
  availability: {
    workingDays: DEFAULT_WORKING_DAYS,
    hoursPerDay: 8,
    outOfOffice: { enabled: false },
  },
  // Mirrors the backend default, so first paint from local storage shows the
  // same Overview the server is about to confirm.
  dashboard: {
    widgets: [
      { id: 'kpis' },
      { id: 'my-work' },
      { id: 'sprint' },
      { id: 'project-health' },
      { id: 'delivery-trends' },
      { id: 'activity' },
    ],
  },
};

const STORAGE_KEY = 'epm.preferences';
let local: Preferences | null = null;

/**
 * Every section filled in from the defaults, whatever the source left out. A
 * record stored before a section existed, or a server answer from an older
 * build, therefore never leaves a switch with no value.
 */
function merge(stored: Partial<Preferences> | null | undefined): Preferences {
  return {
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...stored?.notifications },
    email: { ...DEFAULT_PREFERENCES.email, ...stored?.email },
    appearance: { ...DEFAULT_PREFERENCES.appearance, ...stored?.appearance },
    workweek: { ...DEFAULT_PREFERENCES.workweek, ...stored?.workweek },
    workspace: { ...DEFAULT_PREFERENCES.workspace, ...stored?.workspace },
    locale: { ...DEFAULT_PREFERENCES.locale, ...stored?.locale },
    availability: { ...DEFAULT_PREFERENCES.availability, ...stored?.availability },
    dashboard: { ...DEFAULT_PREFERENCES.dashboard, ...stored?.dashboard },
  };
}

function readLocal(): Preferences {
  if (local) return local;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    local = merge(raw ? (JSON.parse(raw) as Partial<Preferences>) : null);
  } catch {
    local = merge(null);
  }
  return local;
}

function writeLocal(next: Preferences) {
  local = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the query cache still drives the UI */
  }
}

// Saves in flight, across every instance of the hook. A reply is only allowed
// to replace what is on screen when it is the last one outstanding; otherwise
// an early reply would briefly undo a later toggle.
let saving = 0;

export function usePreferences(options: { enabled?: boolean } = {}) {
  const client = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.preferences,
    queryFn: async () => {
      const merged = merge(await preferenceService.get());
      writeLocal(merged);
      return merged;
    },
    /*
     * Signed out there is no record to read and the request 401s — which the
     * api client answers by navigating to /login. Every caller below the
     * router is behind RequireAuth and leaves this alone; PreferenceEffects
     * renders above it, on the public pages too, and is the one that passes
     * the gate. Without it the landing page redirects to the sign-in form
     * before anyone has read a word of it.
     */
    enabled: options.enabled ?? true,
    // The stored copy paints instantly; `isLoading` stays true until the
    // server has actually answered, which is what callers want to know.
    placeholderData: readLocal,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<Preferences>) => preferenceService.update(patch),
    onMutate: async (patch) => {
      saving += 1;
      await client.cancelQueries({ queryKey: queryKeys.preferences });
      const previous = client.getQueryData<Preferences>(queryKeys.preferences) ?? readLocal();
      const next = merge({ ...previous, ...patch });
      client.setQueryData(queryKeys.preferences, next);
      writeLocal(next);
      return { previous };
    },
    onSuccess: (server) => {
      if (saving > 1) return;
      const merged = merge(server);
      client.setQueryData(queryKeys.preferences, merged);
      writeLocal(merged);
    },
    onError: (error, _patch, context) => {
      if (context) {
        client.setQueryData(queryKeys.preferences, context.previous);
        writeLocal(context.previous);
      }
      toast.error('That preference could not be saved', {
        description: error instanceof Error ? error.message : undefined,
      });
    },
    onSettled: () => {
      saving = Math.max(0, saving - 1);
    },
  });

  const preferences = query.data ?? readLocal();
  const { mutate, mutateAsync } = mutation;

  const update = useCallback(
    <S extends keyof Preferences, K extends keyof Preferences[S]>(
      section: S,
      key: K,
      value: Preferences[S][K],
    ) => {
      const current = client.getQueryData<Preferences>(queryKeys.preferences) ?? readLocal();
      // The whole section goes up, not the one key: the server merges by
      // section, and this keeps the request shape the same for every switch.
      mutate({ [section]: { ...current[section], [key]: value } } as Partial<Preferences>);
    },
    [client, mutate],
  );

  // Returns the save so a caller can confirm it; the failure toast is already
  // handled here, so ignoring the rejection is safe.
  const reset = useCallback(() => mutateAsync(DEFAULT_PREFERENCES), [mutateAsync]);

  return {
    preferences,
    update,
    reset,
    /** True until the server has answered once this session. */
    isLoading: query.isLoading,
    /** True while any change is still being written. */
    isSaving: mutation.isPending,
  };
}
