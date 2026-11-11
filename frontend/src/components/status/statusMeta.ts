import { t } from '@/lib/i18n';
import type { Tone } from '@/lib/domain';
import type { StatusRating } from '@/types';

export const STATUS_RATINGS: StatusRating[] = ['on_track', 'at_risk', 'off_track'];

export function ratingWord(rating: StatusRating): string {
  switch (rating) {
    case 'on_track':
      return t('On track');
    case 'at_risk':
      return t('At risk');
    default:
      return t('Off track');
  }
}

export const RATING_TONE: Record<StatusRating, Tone> = {
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'danger',
};

/** The dimensions a report rates besides the overall status. */
export const STATUS_DIMENSIONS = ['schedule', 'budget', 'scope', 'resources'] as const;
export type StatusDimension = (typeof STATUS_DIMENSIONS)[number];

export function dimensionWord(dimension: StatusDimension): string {
  switch (dimension) {
    case 'schedule':
      return t('Schedule');
    case 'budget':
      return t('Budget');
    case 'scope':
      return t('Scope');
    default:
      return t('Resources');
  }
}
