import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Square, Timer, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useRunningTimer, useTimerMutations } from '@/hooks/useTimeEntries';
import { formatLocalNumber, t } from '@/lib/i18n';

/** `h:mm:ss` from milliseconds. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Re-renders every second while `active`, for a clock. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [active]);
  return now;
}

/**
 * The running timer, in the header: how long it has run and on which task,
 * with Stop (which logs the time) and Discard. Nothing at all while no timer
 * runs.
 */
export function TimerIndicator() {
  const timer = useRunningTimer();
  const { stop, discard } = useTimerMutations();
  const running = timer.data;
  const now = useNow(Boolean(running));
  if (!running) return null;
  const elapsed = elapsedLabel(now - Date.parse(running.startedAt));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5 font-mono text-xs tabular-nums text-danger hover:text-danger"
          aria-label={t('Timer running: {elapsed} on {task}', { elapsed, task: running.workPackageSubject ?? t('a task') })}
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
          <Timer className="h-3.5 w-3.5" aria-hidden />
          {elapsed}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div>
          <p className="text-2xs text-muted-foreground">{t('Timer running on')}</p>
          <Link to={`/tasks/${running.workPackageId}`} className="block truncate text-sm font-medium hover:text-primary" dir="auto">
            {running.workPackageSubject ?? t('A task')}
          </Link>
          {running.projectName ? <p className="truncate text-2xs text-muted-foreground" dir="auto">{running.projectName}</p> : null}
        </div>
        <p className="font-mono text-2xl font-semibold tabular-nums">{elapsed}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            loading={stop.isPending}
            onClick={() =>
              stop.mutate(undefined, {
                onSuccess: (entry) =>
                  toast.success(t('Logged {hours} h on {task}', { hours: formatLocalNumber(entry.hours, { maximumFractionDigits: 2 }), task: entry.workPackageSubject ?? t('the task') })),
                onError: (error) => toast.error(t('The time could not be logged'), { description: error instanceof Error ? error.message : undefined }),
              })
            }
          >
            <Square className="h-3.5 w-3.5" />
            {t('Stop and log')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('Discard the timer')}
            title={t('Discard the timer')}
            loading={discard.isPending}
            onClick={() =>
              discard.mutate(undefined, {
                onSuccess: () => toast.success(t('Timer discarded')),
                onError: (error) => toast.error(t('The timer could not be discarded'), { description: error instanceof Error ? error.message : undefined }),
              })
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-2xs text-muted-foreground">{t('Stopping logs the time it ran on the day it started, under the usual timesheet rules.')}</p>
      </PopoverContent>
    </Popover>
  );
}
