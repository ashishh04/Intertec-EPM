import type { ReportPeriodPreset } from '@/types';

/**
 * The named periods a scheduled report or a saved portfolio view is counted
 * over, each counted back from the day it is read. One list, so both say a
 * period the same way.
 */
export const PERIODS: { id: ReportPeriodPreset; label: string }[] = [
  { id: 'previous-week', label: 'Previous week (Mon–Sun)' },
  { id: 'previous-month', label: 'Previous calendar month' },
  { id: 'last-4-weeks', label: 'Last 4 weeks' },
  { id: 'last-12-weeks', label: 'Last 12 weeks' },
  { id: 'month-to-date', label: 'Month to date' },
  { id: 'year-to-date', label: 'Year to date' },
];

export const periodLabel = (id: ReportPeriodPreset | undefined) => PERIODS.find((period) => period.id === id)?.label ?? id ?? '';
