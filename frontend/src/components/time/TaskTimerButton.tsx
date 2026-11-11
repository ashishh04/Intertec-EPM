import { toast } from 'sonner';
import { Play, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useRunningTimer, useTimerMutations } from '@/hooks/useTimeEntries';
import { formatLocalNumber, t } from '@/lib/i18n';
import type { ID } from '@/types';
import { elapsedLabel, useNow } from './TimerIndicator';

/**
 * Start a timer on this task, or stop the one running on it. A timer running on
 * another task is said so rather than replaced: one runs at a time.
 */
export function TaskTimerButton({ workPackageId, disabled }: { workPackageId: ID; disabled?: boolean }) {
  const timer = useRunningTimer();
  const { start, stop } = useTimerMutations();
  const running = timer.data;
  const here = running?.workPackageId === workPackageId;
  const now = useNow(here);

  if (here && running) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="font-mono tabular-nums text-danger"
        loading={stop.isPending}
        onClick={() =>
          stop.mutate(undefined, {
            onSuccess: (entry) => toast.success(t('Logged {hours} h', { hours: formatLocalNumber(entry.hours, { maximumFractionDigits: 2 }) })),
            onError: (error) => toast.error(t('The time could not be logged'), { description: error instanceof Error ? error.message : undefined }),
          })
        }
      >
        <Square className="h-3.5 w-3.5" />
        {t('Stop {elapsed}', { elapsed: elapsedLabel(now - Date.parse(running.startedAt)) })}
      </Button>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled || Boolean(running)}
      title={running ? t('A timer is already running on another task.') : undefined}
      loading={start.isPending}
      onClick={() =>
        start.mutate(workPackageId, {
          onSuccess: () => toast.success(t('Timer started')),
          onError: (error) => toast.error(t('The timer could not start'), { description: error instanceof Error ? error.message : undefined }),
        })
      }
    >
      <Play className="h-3.5 w-3.5" />
      {t('Start timer')}
    </Button>
  );
}
