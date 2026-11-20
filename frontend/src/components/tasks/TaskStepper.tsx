import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, List } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { sequenceAround } from '@/lib/task-sequence';

/**
 * Up and down through the list the task was opened from: the task before it,
 * the task after it, where it stands ("3 of 25"), and back to the list. Also K
 * and J, as long as the cursor is not in a field. Shows nothing for a task that
 * was not opened from a list.
 */
export function TaskStepper({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const place = useMemo(() => sequenceAround(taskId), [taskId]);

  useEffect(() => {
    if (!place) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      // Not over an open dialog or menu.
      if (document.querySelector('[role=dialog], [role=menu]')) return;
      const to = event.key === 'k' || event.key === 'K' ? place.previous : event.key === 'j' || event.key === 'J' ? place.next : undefined;
      if (!to) return;
      event.preventDefault();
      navigate(`/tasks/${to}`);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [place, navigate]);

  if (!place) return null;

  return (
    <div className="flex items-center gap-1" data-testid="task-stepper">
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label={t('Previous task')}
        title={`${t('Previous task')} (K)`}
        disabled={!place.previous}
        onClick={() => place.previous && navigate(`/tasks/${place.previous}`)}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label={t('Next task')}
        title={`${t('Next task')} (J)`}
        disabled={!place.next}
        onClick={() => place.next && navigate(`/tasks/${place.next}`)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <span className="px-1 text-2xs tabular-nums text-muted-foreground">
        {t('{position} of {total}', { position: formatNumber(place.position), total: formatNumber(place.total) })}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label={t('Back to the list')} title={t('Back to the list')} onClick={() => navigate(place.from)}>
        <List className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
