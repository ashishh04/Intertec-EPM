import { Share2 } from 'lucide-react';
import { toast } from 'sonner';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSetSprintSharing } from '@/hooks/useSprints';
import { t } from '@/lib/i18n';
import type { EpmSprint, SprintSharing } from '@/types';
import { SPRINT_SHARINGS, sharingLabel } from './sprintSharing';

/**
 * Who may plan work into a sprint besides its own project. Changeable by whoever
 * may change the sprint; read-only for everyone else.
 */
export function SprintSharingSelect({ sprint }: { sprint: EpmSprint }) {
  const setSharing = useSetSprintSharing();
  if (!sprint.canEdit) {
    return sprint.sharing === 'none' ? null : (
      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
        <Share2 className="h-3 w-3" aria-hidden />
        {t('Shared with: {who}', { who: sharingLabel(sprint.sharing) })}
      </span>
    );
  }
  return (
    <Select
      value={sprint.sharing}
      disabled={setSharing.isPending}
      onValueChange={(value) =>
        setSharing.mutate(
          { id: sprint.id, sharing: value as SprintSharing },
          {
            onSuccess: () => toast.success(t('Sharing changed')),
            onError: (error) => toast.error(t('The sharing was not changed'), { description: error instanceof Error ? error.message : undefined }),
          },
        )
      }
    >
      <SelectTrigger className="h-7 w-auto gap-1.5 text-2xs" aria-label={t('Shared with')}>
        <Share2 className="h-3 w-3" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SPRINT_SHARINGS.map((value) => (
          <SelectItem key={value} value={value}>
            {sharingLabel(value)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
