import type { Prisma } from '@prisma/client';
import { z } from 'zod';

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

export const DEFAULT_PREFERENCES: UserPreferences = {
  notifications: {
    assigned: true,
    mentions: true,
    statusChanges: true,
    dueReminders: true,
    digest: false,
  },
  email: {
    enabled: true,
    assigned: true,
    mentions: true,
    membership: true,
    updates: false,
    dueReminders: true,
    digest: true,
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
};

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
      })
      .partial(),
    email: z
      .object({
        enabled: z.boolean(),
        assigned: z.boolean(),
        mentions: z.boolean(),
        updates: z.boolean(),
        dueReminders: z.boolean(),
        digest: z.boolean(),
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
    workspace: z
      .object({
        landingPage: z.enum(['dashboard', 'my-work', 'projects']),
      })
      .partial(),
  })
  .partial();

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/** Two levels deep, which is the whole shape: sections of scalar keys. */
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
