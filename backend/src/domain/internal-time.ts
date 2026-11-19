import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { msg, t, type Language } from '../lib/i18n.js';

/**
 * Time that belongs to no project: a daily scrum, a follow-up, support.
 *
 * OpenProject keeps every hour on a work package, so time somebody spends in
 * the morning stand-up — no one project's, often several at once — had to be
 * put on some project's task or not logged at all. It is EPM's own instead:
 * kept here, and merged with OpenProject's time wherever time is shown, so a
 * person's week, timesheet, utilisation and the reports all count it. No
 * project's spend or health does, because it is no project's.
 *
 * An entry's id carries a prefix, `internal:`, so the time entry routes can
 * tell it from one of OpenProject's and send each edit to the right place.
 */

export const INTERNAL_PREFIX = 'internal:';

export type InternalActivity = 'daily' | 'follow_up' | 'support';

export const INTERNAL_ACTIVITIES: readonly InternalActivity[] = ['daily', 'follow_up', 'support'];

/** What each activity is called, in English; the stand-in for a task's subject. */
const ACTIVITY_LABEL: Record<InternalActivity, string> = {
  daily: msg('Daily scrum'),
  follow_up: msg('Follow-up'),
  support: msg('Support'),
};

export function activityLabel(activity: string, language: Language = 'en'): string {
  return t(language, ACTIVITY_LABEL[activity as InternalActivity] ?? ACTIVITY_LABEL.daily);
}

let version = 0;
/**
 * Moves on with every change. No refresh of the analytics model follows one
 * (that model is OpenProject's), so its facts read this time again when it moves.
 */
export const internalTimeVersion = (): number => version;
const changed = () => {
  version += 1;
};

export const isInternalId = (id: string): boolean => id.startsWith(INTERNAL_PREFIX);
export const internalIdOf = (id: string): string => id.slice(INTERNAL_PREFIX.length);

export interface InternalEntry {
  id: string;
  userId: string;
  spentOn: string;
  hours: number;
  activity: InternalActivity;
  comment?: string;
  createdAt: string;
  updatedAt: string;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

function toEntry(row: { id: string; userId: string; spentOn: Date; hours: number; activity: string; comment: string | null; createdAt: Date; updatedAt: Date }): InternalEntry {
  return {
    id: `${INTERNAL_PREFIX}${row.id}`,
    userId: row.userId,
    spentOn: day(row.spentOn),
    hours: row.hours,
    activity: (INTERNAL_ACTIVITIES as readonly string[]).includes(row.activity) ? (row.activity as InternalActivity) : 'daily',
    comment: row.comment ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** People's entries between two days, both included; everyone's when `userIds` is absent. */
export async function internalEntries(options: { userIds?: string[]; from?: string; to?: string }): Promise<InternalEntry[]> {
  if (options.userIds && options.userIds.length === 0) return [];
  const rows = await prisma.internalTimeEntry
    .findMany({
      where: {
        ...(options.userIds ? { userId: { in: options.userIds } } : {}),
        ...(options.from || options.to
          ? { spentOn: { ...(options.from ? { gte: asDate(options.from) } : {}), ...(options.to ? { lte: asDate(options.to) } : {}) } }
          : {}),
      },
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
    })
    // The table arrived with this release: until its migration has run, a read
    // finds none rather than failing every page that shows time.
    .catch(() => []);
  return rows.map(toEntry);
}

export async function internalEntry(id: string): Promise<InternalEntry> {
  const row = await prisma.internalTimeEntry.findUnique({ where: { id: internalIdOf(id) } });
  if (!row) throw EpmError.notFound('That time entry');
  return toEntry(row);
}

export async function createInternal(input: {
  userId: string;
  spentOn: string;
  hours: number;
  activity: InternalActivity;
  comment?: string;
}): Promise<InternalEntry> {
  const row = await prisma.internalTimeEntry.create({
    data: {
      userId: input.userId,
      spentOn: asDate(input.spentOn),
      hours: input.hours,
      activity: input.activity,
      comment: input.comment?.trim() || null,
    },
  });
  changed();
  return toEntry(row);
}

export async function updateInternal(
  id: string,
  patch: { spentOn?: string; hours?: number; comment?: string; activity?: InternalActivity },
): Promise<InternalEntry> {
  const row = await prisma.internalTimeEntry.update({
    where: { id: internalIdOf(id) },
    data: {
      ...(patch.spentOn ? { spentOn: asDate(patch.spentOn) } : {}),
      ...(patch.hours !== undefined ? { hours: patch.hours } : {}),
      ...(patch.comment !== undefined ? { comment: patch.comment.trim() || null } : {}),
      ...(patch.activity ? { activity: patch.activity } : {}),
    },
  });
  changed();
  return toEntry(row);
}

export async function deleteInternal(id: string): Promise<void> {
  await prisma.internalTimeEntry.delete({ where: { id: internalIdOf(id) } });
  changed();
}

/** Each person's hours between two days, for lists that only need the total. */
export async function internalHoursByUser(from: string, to: string): Promise<Map<string, number>> {
  const groups = await prisma.internalTimeEntry
    .groupBy({ by: ['userId'], where: { spentOn: { gte: asDate(from), lte: asDate(to) } }, _sum: { hours: true } })
    .catch(() => []);
  return new Map(groups.map((group) => [group.userId, group._sum.hours ?? 0]));
}
