import { intlLocale, t } from '@/lib/i18n';
import { formatLongDate, formatMonthYear, formatShortDate, formatWeekdayDate } from '@/lib/utils';
import type { CapacityMeasure, CapacityScale } from '@/types';

/**
 * The capacity heatmap's periods — days, weeks or months — as the controls
 * choose them and the headings write them.
 */

/** How many columns each scale offers, and how many it shows unless chosen. */
export const LENGTHS: Record<CapacityScale, { usual: number; options: number[] }> = {
  day: { usual: 14, options: [7, 14, 31] },
  week: { usual: 12, options: [8, 12, 26] },
  month: { usual: 6, options: [3, 6, 12] },
};

/**
 * The heatmap's first day, as `YYYY-MM-DD`: `count` periods with the current
 * one last when logged time alone counts — it looks back, nothing being logged
 * ahead — and first when assigned work counts too, which looks ahead; moved
 * `offset` whole windows.
 *
 * Days in whole weeks (7 or 14) are calendar weeks, Monday to Sunday — the
 * working week first, its weekend after — with the current week last (logged
 * time) or first (assigned work). Counted back from today, seven days began on
 * whatever weekday today is not: on a Monday, the Tuesday before.
 */
export function firstDay(scale: CapacityScale, count: number, measure: CapacityMeasure, offset: number): string {
  const now = new Date();
  const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const shift = (measure === 'logged' ? 1 - count : 0) + offset * count;
  if (scale === 'day' && count % 7 === 0) {
    const weeks = count / 7;
    // This week's Monday, then whole weeks back or on.
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + ((measure === 'logged' ? 1 - weeks : 0) + offset * weeks) * 7);
  } else if (scale === 'day') {
    day.setUTCDate(day.getUTCDate() + shift);
  } else if (scale === 'week') {
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + shift * 7);
  } else {
    day.setUTCDate(1);
    day.setUTCMonth(day.getUTCMonth() + shift);
  }
  return day.toISOString().slice(0, 10);
}

const noon = (day: string) => new Date(`${day}T12:00:00Z`);

/** "Mon": a day column's weekday. */
export const weekdayOf = (day: string): string =>
  noon(day).toLocaleDateString(intlLocale(), { weekday: 'short', timeZone: 'UTC' });

/** "Nov 2026": a month column — Gregorian, as the months counted are. */
export const monthOf = (day: string): string =>
  noon(day).toLocaleDateString(intlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC', calendar: 'gregory' });

/** A period as a heading: "Monday, 17 November 2026", "Week of 17 Nov", "November 2026". */
export function periodTitle(scale: CapacityScale, start: string): string {
  if (scale === 'day') return formatWeekdayDate(start);
  if (scale === 'month') return formatMonthYear(start);
  return t('Week of {date}', { date: formatShortDate(start) });
}

/** The heatmap's span: "3 Nov 2026 – 16 Nov 2026", or "Jun 2026 – Nov 2026". */
export function spanOf(scale: CapacityScale, first: { start: string }, last: { start: string; end: string }): string {
  if (scale === 'month') return `${monthOf(first.start)} – ${monthOf(last.start)}`;
  return `${formatLongDate(first.start)} – ${formatLongDate(last.end)}`;
}

/** The current period's name. */
export const currentName = (scale: CapacityScale): string =>
  scale === 'day' ? t('Today') : scale === 'week' ? t('This week') : t('This month');
