import { formatCurrency, formatNumber } from '@/lib/utils';
import type { MeasureUnit } from '@/types';

/**
 * A measure's value as people read it, by its unit. Null is "—": the semantic
 * layer returns null when there is nothing to measure, and a zero there would
 * read as a result.
 */
export function formatMeasure(value: number | null | undefined, unit: MeasureUnit | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  switch (unit) {
    case 'percent':
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}%`;
    case 'money':
      return formatCurrency(value);
    case 'hours':
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)} h`;
    case 'days':
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)} d`;
    case 'perWeek':
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)} / wk`;
    case 'points':
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)} pts`;
    case 'index':
      return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    default:
      return formatNumber(value);
  }
}

/** The unit in words, for an axis or a column heading. */
export const UNIT_WORDS: Record<MeasureUnit, string> = {
  count: 'count',
  percent: '%',
  hours: 'hours',
  money: 'amount',
  days: 'days',
  perWeek: 'per week',
  points: 'points',
  index: 'index',
};

/** A scope as a URL carries it, and back. */
export function scopeKey(scope: { kind: string; id?: string } | undefined): string {
  if (!scope || scope.kind === 'instance' || !scope.id) return 'instance';
  return `${scope.kind}:${scope.id}`;
}
