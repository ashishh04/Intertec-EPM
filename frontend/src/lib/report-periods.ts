import { t } from '@/lib/i18n';
import type { ReportPeriodPreset } from '@/types';

/**
 * The named periods a scheduled report or a saved portfolio view is counted
 * over, each counted back from the day it is read. One list, so both say a
 * period the same way.
 */
export const PERIODS: { id: ReportPeriodPreset; label: string }[] = [
  { id: 'previous-week', get label() { return t('Previous week (Mon–Sun)'); } },
  { id: 'previous-month', get label() { return t('Previous calendar month'); } },
  { id: 'last-4-weeks', get label() { return t('Last 4 weeks'); } },
  { id: 'last-12-weeks', get label() { return t('Last 12 weeks'); } },
  { id: 'month-to-date', get label() { return t('Month to date'); } },
  { id: 'year-to-date', get label() { return t('Year to date'); } },
];

export const periodLabel = (id: ReportPeriodPreset | undefined) => PERIODS.find((period) => period.id === id)?.label ?? id ?? '';
