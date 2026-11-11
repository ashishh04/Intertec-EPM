import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { MeetingFrequency, MeetingSeriesInfo } from '@/types';

/** How often a meeting repeats, as the picker and the badge say it. */
export function frequencyLabel(frequency: MeetingFrequency): string {
  switch (frequency) {
    case 'daily':
      return t('Every day');
    case 'workdays':
      return t('Every weekday');
    case 'weekly':
      return t('Every week');
    case 'fortnightly':
      return t('Every two weeks');
    default:
      return t('Every month');
  }
}

/** "Every week, until 31 Dec 2026" or "Every week". */
export function seriesLabel(series: MeetingSeriesInfo): string {
  return series.until
    ? t('{frequency}, until {date}', { frequency: frequencyLabel(series.frequency), date: formatShortDate(series.until) })
    : frequencyLabel(series.frequency);
}
