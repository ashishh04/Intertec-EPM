import { addDays } from '../lib/dates.js';
import type { OpFilter } from '../openproject/client.js';

/**
 * What the words mean, once (BR-404).
 *
 * "Open", "overdue", "due soon" and "delivered" had several definitions that
 * disagreed: OpenProject's closed flag against EPM's status categories, strict
 * "before today" against OpenProject's filter that counts today, the browser's
 * calendar day against the server's. Every measure, every count asked of
 * OpenProject and every list now takes them from here.
 *
 * Days are calendar days in UTC (`lib/dates.ts`), as everywhere in the backend.
 */

/** The fields a definition reads. Both the analytics model and a mapped task carry them. */
export interface WorkState {
  isClosed: boolean;
  dueDate: string | null;
  /** EPM's reading of the status (`mapping/catalog.ts`); `done` is delivered. */
  statusCategory?: string;
}

/** How far ahead "due soon" looks, today included: the coming seven days. */
export const DUE_SOON_DAYS = 7;

/** Open: not in a closed status. Rejected work is closed — nothing is left to do — but not delivered. */
export function isOpen(work: WorkState): boolean {
  return !work.isClosed;
}

/** Overdue: open, and due before today. Work due today is due, not late. */
export function isOverdue(work: WorkState, today: string): boolean {
  return !work.isClosed && work.dueDate !== null && work.dueDate < today;
}

/** Due soon: open, and due today or in the next six days. */
export function isDueSoon(work: WorkState, today: string): boolean {
  return (
    !work.isClosed &&
    work.dueDate !== null &&
    work.dueDate >= today &&
    work.dueDate <= addDays(today, DUE_SOON_DAYS - 1)
  );
}

/** Delivered: closed in a status EPM reads as done — not Rejected, which is closed and `blocked`. */
export function isDelivered(work: WorkState): boolean {
  return work.isClosed && work.statusCategory === 'done';
}

/* -------------------------------------------------------------------------- */
/* The same definitions, asked of OpenProject                                 */
/* -------------------------------------------------------------------------- */

/** Open, as OpenProject's filter: not in a closed status. */
export const OPEN_FILTER: OpFilter = { field: 'status', operator: 'o', values: [] };

/**
 * Overdue's date half, as OpenProject's filter.
 *
 * `<t-` with N is "due on or before the end of the day N days ago" — read from
 * `Queries::Operators::MoreThanAgo` on 15.5.1, which compares `<= end_of_day(
 * today - N)`. So `0` counts work due today as overdue, which is not the
 * definition; `1` is due on or before yesterday, which is "before today".
 * Combine with `OPEN_FILTER`.
 */
export const OVERDUE_DUE_FILTER: OpFilter = { field: 'dueDate', operator: '<t-', values: ['1'] };
