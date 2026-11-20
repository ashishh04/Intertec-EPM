import { t } from '@/lib/i18n';
import type { EpmSprint } from '@/types';

/**
 * What a sprint is counted in: story points where its work has them, else the
 * estimated hours, else its tasks. The server decides (EpmSprint.unit); an
 * older one sends none, and counted points.
 */
export type SprintUnit = NonNullable<EpmSprint['unit']>;

export const unitOf = (sprint: Pick<EpmSprint, 'unit'>): SprintUnit => sprint.unit ?? 'points';

/** The short word after a sprint's figure. */
export const unitSuffix = (unit: SprintUnit): string => (unit === 'hours' ? t('h') : unit === 'tasks' ? t('tasks') : t('pts'));

/** What the committed figure stands for, under it. */
export const committedSupport = (unit: SprintUnit): string =>
  unit === 'hours'
    ? t('Estimated hours of the work in it: its work has no story points')
    : unit === 'tasks'
      ? t('Tasks in it: its work has no story points or estimates')
      : t('Scope agreed at planning');

/** The burndown's description. */
export const burndownDescription = (unit: SprintUnit): string =>
  unit === 'hours'
    ? t('Remaining estimated hours vs. the ideal line')
    : unit === 'tasks'
      ? t('Remaining tasks vs. the ideal line')
      : t('Remaining points vs. the ideal line');
