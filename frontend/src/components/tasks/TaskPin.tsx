import { useState } from 'react';
import { Pin, PinOff } from 'lucide-react';
import { toast } from 'sonner';

import { PromptDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { usePinWorkPackage, useWorkPackagePin } from '@/hooks/useResources';
import { useTask } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { ID } from '@/types';

/**
 * Pinning a work package (BR-111): levelling will not move it — a contractual
 * milestone, say. Pinning also switches it to manual scheduling, so its
 * predecessors cannot push it either; unpinning puts its mode back.
 */
export function TaskPin({ workPackageId }: { workPackageId: ID }) {
  const pin = useWorkPackagePin(workPackageId);
  const task = useTask(workPackageId);
  const users = useUserMap();
  const { canInProject } = useAuth();
  const change = usePinWorkPackage(workPackageId);
  const [asking, setAsking] = useState(false);
  const mayEdit = task.data ? canInProject(task.data.projectId, 'task:edit') : false;
  const current = pin.data?.pin ?? null;

  const act = (pinned: boolean, reason?: string) =>
    change.mutate(
      { pinned, reason },
      {
        onSuccess: () => {
          setAsking(false);
          toast.success(pinned ? t('Pinned: levelling will not move it') : t('Unpinned'));
        },
        onError: (error) => toast.error(pinned ? t('It was not pinned') : t('It was not unpinned'), { description: error instanceof Error ? error.message : undefined }),
      },
    );

  if (pin.isLoading) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-2xs" data-testid="task-pin">
      <p className="text-muted-foreground">
        {current
          ? t('Pinned {when} by {who}: levelling will not move it, and its predecessors cannot push it.', {
              when: formatRelative(current.pinnedAt),
              who: users.get(current.pinnedBy)?.name ?? t('someone'),
            })
          : t('Not pinned: levelling may move it to fit its assignee.')}
        {current?.reason ? (
          <span className="block text-foreground" dir="auto">
            “{current.reason}”
          </span>
        ) : null}
      </p>
      {mayEdit ? (
        current ? (
          <Button size="sm" variant="ghost" loading={change.isPending} onClick={() => act(false)}>
            <PinOff className="h-3.5 w-3.5" />
            {t('Unpin')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
            <Pin className="h-3.5 w-3.5" />
            {t('Pin dates')}
          </Button>
        )
      ) : null}
      <PromptDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('Pin these dates?')}
        description={t('Levelling will not move it, and it is switched to manual scheduling so its predecessors cannot push it. Unpinning puts the mode back.')}
        label={t('Why')}
        placeholder={t('e.g. Contractual delivery date')}
        confirmLabel={t('Pin dates')}
        pending={change.isPending}
        onSubmit={(reason) => act(true, reason)}
      />
    </div>
  );
}
