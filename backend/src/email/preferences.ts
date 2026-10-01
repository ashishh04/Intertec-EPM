import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { UserPreferences } from '../types/epm.js';

/**
 * A person's own settings.
 *
 * Stored as one JSON document per person and read back through the defaults,
 * so a key added after someone saved their settings simply takes its default
 * rather than being undefined — and a row written by an older build of the
 * frontend is still valid. The Settings page owns every key; the only reader
 * on this side is the email pipeline, which needs the `email` section.
 */

/** The working week EPM assumes before anyone says otherwise. */
const DEFAULT_WORKING_DAYS: UserPreferences['availability']['workingDays'] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
];

export const DEFAULT_PREFERENCES: UserPreferences = {
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
    // The deployment's configured hour, which is also what anyone who never
    // opens Settings gets. Read in the recipient's own timezone where EPM knows
    // it, so a single number still lands as a sensible local morning.
    reminderHour: env.EPM_DUE_REMINDER_HOUR_UTC,
    reminderDays: DEFAULT_WORKING_DAYS,
    // News is on, the rest off. An announcement is occasional and addressed to
    // you; a wiki edit or a document upload is neither, and defaulting those to
    // on is how an inbox becomes something people filter to a folder.
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
  locale: {
    // Empty rather than 'en': the instance has its own default language, and
    // claiming one here would override it for everyone who never chose.
    language: '',
    dateFormat: 'system',
  },
  availability: {
    workingDays: DEFAULT_WORKING_DAYS,
    hoursPerDay: 8,
    outOfOffice: { enabled: false },
  },
  workspace: {
    landingPage: 'dashboard',
  },
  /*
   * The default Overview, in the order the page has always rendered.
   *
   * Stored explicitly rather than left empty, so "reset to defaults" and "never
   * customised" produce the same page, and so an empty list can mean what it
   * says: a person who removed every widget gets an empty Overview rather than
   * silently getting everything back.
   */
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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are written 2026-09-29.');

const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sun', 'sat']);

/** Order-preserving de-duplication. A day cannot be in a week twice. */
const uniqueDays = <T extends string>(days: T[]): T[] => [...new Set(days)];

/**
 * Any subset of sections, each any subset of keys. Unknown keys are dropped
 * rather than refused, so the endpoint tolerates a frontend one release ahead.
 */
export const preferencesPatchSchema = z
  .object({
    notifications: z
      .object({
        assigned: z.boolean(),
        mentions: z.boolean(),
        membership: z.boolean(),
        statusChanges: z.boolean(),
        dueReminders: z.boolean(),
        digest: z.boolean(),
        participating: z.boolean(),
        accountable: z.boolean(),
        watcher: z.boolean(),
        shared: z.boolean(),
        dateAlerts: z.boolean(),
        pause: z.object({
          enabled: z.boolean(),
          from: isoDate.optional(),
          to: isoDate.optional(),
        }),
      })
      .partial(),
    email: z
      .object({
        enabled: z.boolean(),
        assigned: z.boolean(),
        mentions: z.boolean(),
        membership: z.boolean(),
        updates: z.boolean(),
        dueReminders: z.boolean(),
        digest: z.boolean(),
        reminderHour: z.number().int().min(0).max(23),
        reminderDays: z.array(weekday).max(7).transform(uniqueDays),
        news: z.boolean(),
        wiki: z.boolean(),
        meetings: z.boolean(),
        documents: z.boolean(),
        comments: z.boolean(),
      })
      .partial(),
    appearance: z
      .object({
        compactTables: z.boolean(),
        reduceMotion: z.boolean(),
        showAvatars: z.boolean(),
      })
      .partial(),
    workweek: z
      .object({
        startOfWeek: z.enum(['monday', 'sunday']),
        timeFormat: z.enum(['24h', '12h']),
      })
      .partial(),
    locale: z
      .object({
        // Whatever the instance accepts, checked by the instance when the
        // profile write forwards it. An empty string means "follow the
        // instance default", which is the state everybody starts in.
        language: z.string().max(16),
        dateFormat: z.enum(['system', 'iso', 'dmy', 'mdy']),
      })
      .partial(),
    availability: z
      .object({
        workingDays: z.array(weekday).max(7).transform(uniqueDays),
        // 24 is the physical bound. Zero is allowed: somebody on no hours this
        // quarter still has a schedule.
        hoursPerDay: z.number().min(0).max(24),
        outOfOffice: z.object({
          enabled: z.boolean(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          note: z.string().max(280).optional(),
        }),
      })
      .partial(),
    workspace: z
      .object({
        landingPage: z.enum(['dashboard', 'my-work', 'projects']),
      })
      .partial(),
    /*
     * The Overview layout.
     *
     * Widget ids are the frontend's, and are deliberately not enumerated here:
     * the catalogue lives with the components that render it, and restating it
     * would mean a backend release for every new widget. Length and shape are
     * bounded instead, which is what this side actually has an opinion about —
     * and duplicates are collapsed, because a widget cannot be in two places.
     */
    dashboard: z
      .object({
        widgets: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              width: z.enum(['half', 'full']).optional(),
            }),
          )
          .max(24)
          .transform((widgets) => {
            const seen = new Set<string>();
            return widgets.filter((widget) => {
              if (seen.has(widget.id)) return false;
              seen.add(widget.id);
              return true;
            });
          }),
      })
      .partial(),
  })
  .partial();

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/**
 * Two levels deep, which is the whole shape: sections of keys.
 *
 * A key's value replaces whatever was there, including when it is an array. The
 * dashboard layout depends on that: a list of widgets has meaning as a list, so
 * merging it element-wise would leave a removed widget behind at whatever index
 * the shorter new array did not reach.
 */
export function mergePreferences(base: UserPreferences, patch: PreferencesPatch): UserPreferences {
  const merged = structuredClone(base) as UserPreferences & Record<string, Record<string, unknown>>;

  for (const [section, values] of Object.entries(patch)) {
    if (!values || !(section in merged)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) merged[section]![key] = value;
    }
  }

  return merged;
}

/** Whatever was stored, read leniently: a corrupt row means the defaults. */
function fromStored(data: unknown): UserPreferences {
  const parsed = preferencesPatchSchema.safeParse(data);
  return parsed.success ? mergePreferences(DEFAULT_PREFERENCES, parsed.data) : DEFAULT_PREFERENCES;
}

export async function getPreferences(userId: string): Promise<UserPreferences> {
  const row = await prisma.userPreference
    .findUnique({ where: { openProjectId: userId }, select: { data: true } })
    .catch(() => null);

  return row ? fromStored(row.data) : DEFAULT_PREFERENCES;
}

export async function setPreferences(userId: string, patch: PreferencesPatch): Promise<UserPreferences> {
  const next = mergePreferences(await getPreferences(userId), patch);
  // Prisma's JSON input type wants an index signature the interface lacks;
  // the document is plain data and round-trips through `fromStored` above.
  const data = next as unknown as Prisma.InputJsonObject;

  await prisma.userPreference.upsert({
    where: { openProjectId: userId },
    create: { openProjectId: userId, data },
    update: { data },
  });

  return next;
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

interface Window {
  enabled: boolean;
  from?: string;
  to?: string;
}

/**
 * Whether a dated window covers `day`.
 *
 * An absent bound is open-ended, which is what makes "pause from Monday" and
 * "pause until I say otherwise" both expressible with one shape. Switched off,
 * the dates are ignored entirely rather than remembered as active — somebody who
 * sets a window and then turns it off has turned it off.
 */
export function windowCovers(window: Window | undefined, day: string): boolean {
  if (!window?.enabled) return false;
  if (window.from && day < window.from) return false;
  if (window.to && day > window.to) return false;
  return true;
}

/** True while this person has asked for nothing to reach them. */
export function notificationsPaused(preferences: UserPreferences, day: string): boolean {
  return windowCovers(preferences.notifications.pause, day);
}

/** True while this person is away. */
export function outOfOffice(preferences: UserPreferences, day: string): boolean {
  return windowCovers(preferences.availability.outOfOffice, day);
}
