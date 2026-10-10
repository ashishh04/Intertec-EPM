import { currentLanguage, formatLocalNumber, t } from '@/lib/i18n';
import { formatCurrency, formatNumber } from '@/lib/utils';
import type { MeasureUnit } from '@/types';

/** At most one decimal, in the reader's digits and grouping. */
const oneDecimal = (value: number) => formatLocalNumber(value, { maximumFractionDigits: 1 });

/**
 * A measure's value as people read it, by its unit. Null is "—": the semantic
 * layer returns null when there is nothing to measure, and a zero there would
 * read as a result.
 */
export function formatMeasure(value: number | null | undefined, unit: MeasureUnit | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  switch (unit) {
    case 'percent':
      // "42.5%" in English, as before; elsewhere the locale's own percent ("٤٢٫٥٪").
      return currentLanguage() === 'en'
        ? `${oneDecimal(value)}%`
        : formatLocalNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 });
    case 'money':
      return formatCurrency(value);
    case 'hours':
      return t('{hours} h', { hours: oneDecimal(value) });
    case 'days':
      return t('{days} d', { days: oneDecimal(value) });
    case 'perWeek':
      return t('{count} / wk', { count: oneDecimal(value) });
    case 'points':
      return t('{points} pts', { points: oneDecimal(value) });
    case 'index':
      return formatLocalNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    default:
      return formatNumber(value);
  }
}

/** The unit in words, for an axis or a column heading. Read when shown, in the reader's language. */
export const UNIT_WORDS: Record<MeasureUnit, string> = {
  get count() { return t('count'); },
  percent: '%',
  get hours() { return t('hours'); },
  get money() { return t('amount'); },
  get days() { return t('days'); },
  get perWeek() { return t('per week'); },
  get points() { return t('points'); },
  get index() { return t('index'); },
};

/** A scope as a URL carries it, and back. */
export function scopeKey(scope: { kind: string; id?: string } | undefined): string {
  if (!scope || scope.kind === 'instance' || !scope.id) return 'instance';
  return `${scope.kind}:${scope.id}`;
}
