import { t } from '@/lib/i18n';
import type { Tone } from '@/lib/domain';
import type { RiskCategory, RiskEntry, RiskRating, RiskResponse, RiskStage, TaskPriority } from '@/types';

/**
 * The register's vocabulary: the scales, categories, responses, ratings and
 * stages, with their words and tones. The banding matches the backend's, so a
 * score previewed in the dialog is the score the register then shows.
 */

export const SCALE = [1, 2, 3, 4, 5] as const;

export function probabilityLabel(value: number): string {
  switch (value) {
    case 1:
      return t('Rare');
    case 2:
      return t('Unlikely');
    case 3:
      return t('Possible');
    case 4:
      return t('Likely');
    default:
      return t('Almost certain');
  }
}

export function impactLabel(value: number): string {
  switch (value) {
    case 1:
      return t('Negligible');
    case 2:
      return t('Minor');
    case 3:
      return t('Moderate');
    case 4:
      return t('Major');
    default:
      return t('Severe');
  }
}

export const CATEGORIES: RiskCategory[] = [
  'schedule',
  'cost',
  'scope',
  'quality',
  'resources',
  'technical',
  'external',
  'compliance',
  'security',
  'other',
];

export function categoryLabel(category: RiskCategory): string {
  switch (category) {
    case 'schedule':
      return t('Schedule');
    case 'cost':
      return t('Cost');
    case 'scope':
      return t('Scope');
    case 'quality':
      return t('Quality');
    case 'resources':
      return t('Resources');
    case 'technical':
      return t('Technical');
    case 'external':
      return t('External');
    case 'compliance':
      return t('Compliance');
    case 'security':
      return t('Security');
    default:
      return t('Other');
  }
}

export const RESPONSES: RiskResponse[] = ['avoid', 'mitigate', 'transfer', 'accept', 'escalate'];

export function responseLabel(response: RiskResponse): string {
  switch (response) {
    case 'avoid':
      return t('Avoid');
    case 'mitigate':
      return t('Mitigate');
    case 'transfer':
      return t('Transfer');
    case 'accept':
      return t('Accept');
    default:
      return t('Escalate');
  }
}

/** What each response asks of the owner, for the picker. */
export function responseHint(response: RiskResponse): string {
  switch (response) {
    case 'avoid':
      return t('Change the plan so the risk cannot happen.');
    case 'mitigate':
      return t('Act now to make it less likely or less harmful.');
    case 'transfer':
      return t('Pass it to someone better placed: a supplier, insurer or client.');
    case 'accept':
      return t('Take the risk knowingly, and watch it.');
    default:
      return t('Raise it to whoever can decide beyond the project.');
  }
}

/** Probability times impact, banded: 1-4 low, 5-9 medium, 10-14 high, 15-25 critical. */
export function ratingOf(score: number | null): RiskRating | null {
  if (score === null) return null;
  if (score >= 15) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

export const RATINGS: RiskRating[] = ['critical', 'high', 'medium', 'low'];

export function ratingLabel(rating: RiskRating): string {
  switch (rating) {
    case 'critical':
      return t('Critical');
    case 'high':
      return t('High');
    case 'medium':
      return t('Medium');
    default:
      return t('Low');
  }
}

export const RATING_TONE: Record<RiskRating, Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

/** The priority a rating sets on the risk, as the backend does. */
export const PRIORITY_OF_RATING: Record<RiskRating, TaskPriority> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
};

/** A heat map cell's colour, by the band its score falls in. */
export function cellClass(score: number): string {
  switch (ratingOf(score)) {
    case 'critical':
      return 'bg-danger text-danger-foreground';
    case 'high':
      return 'bg-danger-soft text-danger-strong';
    case 'medium':
      return 'bg-warning-soft text-warning-strong';
    default:
      return 'bg-success-soft text-success-strong';
  }
}

export function stageLabel(entry: Pick<RiskEntry, 'stage'> & { assessment: { response: RiskResponse | null } }): string {
  const stage: RiskStage = entry.stage;
  switch (stage) {
    case 'identified':
      return t('Identified');
    case 'analysed':
      return t('Analysed');
    case 'review':
      return t('Due for review');
    case 'closed':
      return t('Closed');
    default:
      switch (entry.assessment.response) {
        case 'avoid':
          return t('Avoiding');
        case 'mitigate':
          return t('Mitigating');
        case 'transfer':
          return t('Transferring');
        case 'accept':
          return t('Accepted');
        case 'escalate':
          return t('Escalated');
        default:
          return t('Responding');
      }
  }
}

export const STAGE_TONE: Record<RiskStage, Tone> = {
  identified: 'neutral',
  analysed: 'accent',
  responding: 'primary',
  review: 'warning',
  closed: 'success',
};
