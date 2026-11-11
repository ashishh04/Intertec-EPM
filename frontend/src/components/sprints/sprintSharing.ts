import { t } from '@/lib/i18n';
import type { SprintSharing } from '@/types';

export const SPRINT_SHARINGS: SprintSharing[] = ['none', 'descendants', 'hierarchy', 'tree', 'system'];

/** Who may plan work into a sprint besides its own project, in words. */
export function sharingLabel(sharing: SprintSharing): string {
  switch (sharing) {
    case 'descendants':
      return t('Its sub-projects');
    case 'hierarchy':
      return t('Its parent and sub-projects');
    case 'tree':
      return t('Every project in its tree');
    case 'system':
      return t('Every project');
    default:
      return t('Only its own project');
  }
}
