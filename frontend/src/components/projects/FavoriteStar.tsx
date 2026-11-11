import { Star } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useToggleFavoriteProject } from '@/hooks/useProjects';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { EpmProject } from '@/types';

/** Stars or unstars a project for the reader: their own favourites, first in their lists. */
export function FavoriteStar({ project, className }: { project: Pick<EpmProject, 'id' | 'name' | 'favorited'>; className?: string }) {
  const toggle = useToggleFavoriteProject();
  const on = Boolean(project.favorited);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={on}
      aria-label={on ? t('Remove {name} from favourites', { name: project.name }) : t('Add {name} to favourites', { name: project.name })}
      title={on ? t('Remove from favourites') : t('Add to favourites')}
      className={cn(on ? 'text-warning hover:text-warning' : 'text-muted-foreground', className)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle.mutate(
          { id: project.id, favorite: !on },
          { onError: (error) => toast.error(t('That could not be changed'), { description: error instanceof Error ? error.message : undefined }) },
        );
      }}
    >
      <Star className={cn('h-4 w-4', on && 'fill-current')} aria-hidden />
    </Button>
  );
}
