import type { ID, ScheduleItem } from '@/types';

/**
 * How a scheduled item reads on a critical path view (BR-102).
 *
 * - `critical`: total float of nought or less. Any slip moves the finish.
 * - `near`: not critical, but with total float at or below the threshold the
 *   viewer chose — the work that becomes critical after a small slip.
 * - `other`: everything else.
 *
 * The threshold is the viewer's; the float is the server's. Highlighting is
 * therefore exactly "total float at or below the threshold", whoever reads it.
 */
export type FloatBand = 'critical' | 'near' | 'other';

export function floatBand(item: Pick<ScheduleItem, 'critical' | 'totalFloat'> | undefined, threshold: number): FloatBand | undefined {
  if (!item) return undefined;
  if (item.critical || item.totalFloat <= 0) return 'critical';
  return item.totalFloat <= threshold ? 'near' : 'other';
}

/** The items a critical path view highlights: total float at or below the threshold. */
export function highlightedIds(items: ScheduleItem[], threshold: number): Set<ID> {
  return new Set(items.filter((item) => floatBand(item, threshold) !== 'other').map((item) => item.id));
}

/** The thresholds offered, in working days. The server's default is added if it is not one of them. */
export const NEAR_CRITICAL_CHOICES = [0, 1, 2, 3, 5, 10, 15, 20];

/** "3 days", "1 day", "no float". */
export function floatLabel(days: number): string {
  if (days <= 0) return 'no float';
  return `${days} working ${days === 1 ? 'day' : 'days'}`;
}
