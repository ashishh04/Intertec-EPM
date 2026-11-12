import { t } from '@/lib/i18n';
import type { Tone } from '@/lib/domain';
import type { ProjectRequestStatus, StageGateReviewStatus } from '@/types';

/** How a project request's status reads and looks. */
export const REQUEST_STATUS: Record<ProjectRequestStatus, { label: () => string; tone: Tone }> = {
  draft: { label: () => t('Draft'), tone: 'neutral' },
  submitted: { label: () => t('Waiting for approval'), tone: 'warning' },
  approved: { label: () => t('Approved'), tone: 'success' },
  rejected: { label: () => t('Rejected'), tone: 'danger' },
  created: { label: () => t('Project created'), tone: 'accent' },
};

/** How a gate review's status reads and looks. */
export const GATE_STATUS: Record<StageGateReviewStatus, { label: () => string; tone: Tone }> = {
  submitted: { label: () => t('Waiting for approval'), tone: 'warning' },
  approved: { label: () => t('Passed'), tone: 'success' },
  rejected: { label: () => t('Not passed'), tone: 'danger' },
  withdrawn: { label: () => t('Withdrawn'), tone: 'neutral' },
};
