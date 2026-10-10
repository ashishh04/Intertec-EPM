import { formatLocalNumber, t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { CalculatedResultType } from '@/types';

/** What a calculated field holds, as the screens name it. */
export const RESULT_TYPE_LABELS: Record<CalculatedResultType, string> = {
  get number() {
    return t('Number');
  },
  get date() {
    return t('Date');
  },
  get text() {
    return t('Text');
  },
  get boolean() {
    return t('Yes or no');
  },
};

/**
 * A calculated value for reading: a number in the reader's digits to the
 * field's places, a date in their calendar, yes or no, or the text itself.
 */
export function formatCalculatedValue(type: CalculatedResultType | string | undefined, value: unknown, decimals?: number): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'number':
      return typeof value === 'number' || !Number.isNaN(Number(value))
        ? formatLocalNumber(Number(value), { maximumFractionDigits: decimals ?? 2 })
        : String(value);
    case 'date':
      return formatShortDate(String(value).slice(0, 10));
    case 'boolean':
      return value === true || value === 't' || value === 'true' ? t('Yes') : t('No');
    default:
      return String(value);
  }
}
