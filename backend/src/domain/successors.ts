import { listOf, message } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import { notifyPeople } from './notifications.js';

/**
 * BR-113: what follows a work package, and what moving it moved.
 *
 * OpenProject moves automatically scheduled successors inside the write that
 * moves their predecessor, and says nothing about them. So they are read before
 * the write and again after it, and whoever made the change is told what moved,
 * by how many working days.
 */

export interface FollowerDates {
  id: string;
  subject: string;
  start: string | null;
  finish: string | null;
}

export interface MovedFollower extends FollowerDates {
  /** Working days, by the finish: negative when it moved earlier. */
  days: number;
}

type OpDated = {
  id: number;
  subject: string;
  startDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  ignoreNonWorkingDays?: boolean;
  _links?: { parent?: HalLink | null };
};

interface OpRelation {
  type: string;
  _links: { from?: HalLink; to?: HalLink };
}

/** The fields of a write that can move a work package, and so what follows it. */
const DATE_FIELDS = ['startDate', 'dueDate', 'date', 'duration', 'scheduleManually', 'ignoreNonWorkingDays'];

export const movesDates = (payload: object | null | undefined): boolean =>
  DATE_FIELDS.some((field) => payload !== null && payload !== undefined && field in payload);

const datesOf = (work: OpDated): FollowerDates => ({
  id: String(work.id),
  subject: work.subject,
  // A milestone renders only `date`.
  start: work.startDate ?? work.date ?? null,
  finish: work.dueDate ?? work.date ?? null,
});

/**
 * Who directly follows a work package.
 *
 * From the relations collection: `/work_packages/:id/relations` is only a 308 to
 * it, whose target this client cannot follow. Reading that address failed every
 * time, and with the failure swallowed no move ever reported a follower.
 */
async function directSuccessors(id: string, signal?: AbortSignal): Promise<string[]> {
  const relations = await openProject
    .getCollection<OpRelation>('/relations', { filters: [{ field: 'involved', operator: '=', values: [id] }], pageSize: 100 }, signal)
    .catch((error: unknown) => {
      appLog.warn({ err: error, workPackageId: id }, 'What follows a work package could not be read');
      return null;
    });
  const ids: string[] = [];
  for (const relation of relations?._embedded?.elements ?? []) {
    const from = idFromHref(relation._links.from?.href);
    const to = idFromHref(relation._links.to?.href);
    if (relation.type === 'follows' && to === id && from) ids.push(from);
    if (relation.type === 'precedes' && from === id && to) ids.push(to);
  }
  return ids;
}

/**
 * A work package and the parents above it. A child's dates carry its parent's,
 * so moving a child moves what follows the parent as well.
 */
async function withParents(id: string, signal?: AbortSignal): Promise<string[]> {
  const chain = [id];
  for (let at = id; chain.length < 20; ) {
    const work = await openProject.request<OpDated>(`/work_packages/${at}`, { signal }).catch(() => null);
    const parent = idFromHref(work?._links?.parent?.href);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    at = parent;
  }
  return chain;
}

/** Everything that follows this one, directly or down the chain, with its dates now: at most 50. */
export async function followerDates(id: string, signal?: AbortSignal): Promise<FollowerDates[]> {
  const queue = await withParents(id, signal);
  const seen = new Set<string>(queue);
  const out: FollowerDates[] = [];
  while (queue.length > 0 && out.length < 50) {
    for (const follower of await directSuccessors(queue.shift()!, signal)) {
      if (seen.has(follower) || out.length >= 50) continue;
      seen.add(follower);
      const work = await openProject.request<OpDated>(`/work_packages/${follower}`, { signal }).catch(() => null);
      if (!work) continue;
      out.push(datesOf(work));
      queue.push(follower);
    }
  }
  return out;
}

/** The instance's calendar over these days: whether each is worked. Empty where it cannot be read. */
async function workedDays(from: string, to: string, signal?: AbortSignal): Promise<Map<string, boolean>> {
  const days = await openProject
    .getCollection<{ date: string; working: boolean }>('/days', { filters: [{ field: 'date', operator: '<>d', values: [from, to] }] }, signal)
    .catch((error: unknown) => {
      appLog.warn({ err: error }, 'The working calendar could not be read');
      return null;
    });
  return new Map((days?._embedded?.elements ?? []).map((day) => [day.date, day.working]));
}

const nextDay = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Working days from one date to another, negative backwards: the first day is not counted, the last is. */
function workingDaysBetween(from: string, to: string, isWorked: (iso: string) => boolean): number {
  const [low, high, sign] = from <= to ? [from, to, 1] : [to, from, -1];
  let count = 0;
  for (let at = nextDay(low); at <= high; at = nextDay(at)) if (isWorked(at)) count += 1;
  return sign * count;
}

/** Of those, the ones whose dates have since moved, and by how many working days. */
export async function movedSince(before: FollowerDates[], signal?: AbortSignal): Promise<MovedFollower[]> {
  const changed: { old: FollowerDates; now: FollowerDates; everyDay: boolean }[] = [];
  for (const old of before) {
    const work = await openProject.request<OpDated>(`/work_packages/${old.id}`, { signal }).catch(() => null);
    if (!work) continue;
    const now = datesOf(work);
    if (now.start !== old.start || now.finish !== old.finish) changed.push({ old, now, everyDay: Boolean(work.ignoreNonWorkingDays) });
  }
  if (changed.length === 0) return [];

  const dates = changed.flatMap(({ old, now }) => [old.start, old.finish, now.start, now.finish]).filter((date): date is string => Boolean(date)).sort();
  const calendar = await workedDays(dates[0]!, dates.at(-1)!, signal);
  // Monday to Friday if the calendar could not be read: a count near enough to say what moved.
  const isWorked = (iso: string) => calendar.get(iso) ?? ![0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());

  return changed.map(({ old, now, everyDay }) => {
    const counted = everyDay ? () => true : isWorked;
    const days =
      old.finish && now.finish
        ? workingDaysBetween(old.finish, now.finish, counted)
        : old.start && now.start
          ? workingDaysBetween(old.start, now.start, counted)
          : 0;
    return { ...now, days };
  });
}

/** Tells whoever moved the work what moved with it (BR-113). Never fails the write it follows. */
export async function tellWhatMoved(input: {
  actorId: string | undefined;
  workPackageId: string;
  subject: string;
  version: number;
  moved: MovedFollower[];
}): Promise<void> {
  if (input.moved.length === 0 || !input.actorId) return;
  await notifyPeople({
    recipients: [input.actorId],
    category: 'project_update',
    title: message('Moving {subject} moved {count, plural, one {# work package} other {# work packages}} that follow it', {
      subject: input.subject,
      count: input.moved.length,
    }),
    body: message('{moved}.', {
      moved: listOf(input.moved.map((item) => message('{subject} by {days, plural, one {# day} other {# days}}', { subject: item.subject, days: item.days }))),
    }),
    link: `/tasks/${input.workPackageId}`,
    severity: 'info',
    dedupeKey: `successors-moved:${input.workPackageId}:${input.version}`,
  }).catch(() => 0);
}
