import { t } from '@/lib/i18n';
import type { Tone } from '@/lib/domain';
import { formatNumber } from '@/lib/utils';
import type { CapacityBand, ResourceThresholds } from '@/types';

/**
 * How a capacity band reads (BR-314): one tone, one label, and the threshold
 * behind it — so the legend, the cells and the drill-through say the same.
 */

export const BAND_TONE: Record<CapacityBand, Tone> = {
  none: 'neutral',
  under: 'primary',
  healthy: 'success',
  full: 'warning',
  over: 'danger',
};

export const BAND_LABEL: Record<CapacityBand, string> = {
  get none() {
    return t('Nothing asked');
  },
  get under() {
    return t('Spare capacity');
  },
  get healthy() {
    return t('Healthy');
  },
  get full() {
    return t('Full');
  },
  get over() {
    return t('Over capacity');
  },
};

/** Cell backgrounds: soft for the calm bands, strong for the ones to act on. */
export const BAND_CELL: Record<CapacityBand, string> = {
  none: 'bg-surface text-muted-foreground',
  under: 'bg-primary-soft text-primary-dark',
  healthy: 'bg-success-soft text-success-strong',
  full: 'bg-warning-soft text-warning-strong',
  over: 'bg-danger text-danger-foreground',
};

export function bandRange(band: CapacityBand, thresholds: ResourceThresholds): string {
  switch (band) {
    case 'under':
      return t('below {under}%', { under: thresholds.under });
    case 'healthy':
      return t('{under}–{full}%', { under: thresholds.under, full: thresholds.full });
    case 'full':
      return t('{full}–{over}%', { full: thresholds.full, over: thresholds.over });
    case 'over':
      return t('above {over}%', { over: thresholds.over });
    default:
      return t('no hours either way');
  }
}

export const hours = (value: number) => t('{hours} h', { hours: formatNumber(Math.round(value * 10) / 10) });

export const percent = (value: number | null) => (value === null ? '—' : `${formatNumber(Math.round(value))}%`);
