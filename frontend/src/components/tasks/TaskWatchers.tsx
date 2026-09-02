import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import {
  useAddWatcher,
  useAvailableWatchers,
  useRemoveWatcher,
  useWatchers,
} from '@/hooks/useCollaboration';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import type { ID } from '@/types';

/**
 * Who is notified about this work package.
 *
 * Every control here is shown on an affordance OpenProject published for this
 * user and this record, and the backend re-checks the same one. Candidates come
 * from upstream too, so the picker cannot offer someone it would then refuse.
 *
 * Whether the panel appears at all is the same question: viewing watchers is a
 * distinct permission upstream, so a user who can open the task may still not
 * be allowed to see who follows it.
 */

interface TaskWatchersProps {
  workPackageId: ID;
}

export function TaskWatchers({ workPackageId }: TaskWatchersProps) {
  const { user } = useAuth();
  const state = useWatchers(workPackageId);
  const add = useAddWatcher(workPackageId);
  const remove = useRemoveWatcher(workPackageId);
  const users = useUserMap();

  const [picking, setPicking] = useState(false);
  const available = useAvailableWatchers(workPackageId, picking);

  // Not an error worth showing: this user simply may not see watchers, so the
  // section is absent rather than present and empty.
  if (state.isError) return null;

  const watchers = state.data?.watchers ?? [];
  const can = state.data?.can;

  const fail = (action: string) => (error: unknown) =>
    toast.error(`Could not ${action}`, {
      description: error instanceof Error ? error.message : undefined,
    });

  const toggleSelf = () => {
    if (!user) return;

    if (state.data?.isWatching) {
      remove.mutate(user.id, {
        onSuccess: () => toast.success('You are no longer watching this task'),
        onError: fail('stop watching'),
      });
    } else {
      add.mutate(user.id, {
        onSuccess: () => toast.success('You are now watching this task'),
        onError: fail('start watching'),
      });
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-muted-foreground" aria-hidden />
          Watchers
          {watchers.length > 0 ? (
            <span className="text-2xs font-normal text-muted-foreground">{watchers.length}</span>
          ) : null}
        </CardTitle>

        <div className="flex items-center gap-1.5">
          {can?.watchSelf ? (
            <Button
              size="sm"
              variant={state.data?.isWatching ? 'secondary' : 'ghost'}
              className="h-8"
              loading={add.isPending || remove.isPending}
              onClick={toggleSelf}
            >
              {state.data?.isWatching ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
              {state.data?.isWatching ? 'Unwatch' : 'Watch'}
            </Button>
          ) : null}

          {can?.add ? (
            <Popover open={picking} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 px-2" aria-label="Add a watcher">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>

              <PopoverContent align="end" className="w-64 p-1">
                {available.isLoading ? (
                  <div className="space-y-1 p-1">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : (available.data?.length ?? 0) === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    Everyone who can see this task is already watching it.
                  </p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto">
                    {available.data?.map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            setPicking(false);
                            add.mutate(candidate.id, {
                              onSuccess: () => toast.success(`${candidate.name} is now watching`),
                              onError: fail('add that watcher'),
                            });
                          }}
                        >
                          <UserAvatarWithTooltip user={users.get(candidate.id)} size="xs" />
                          <span className="truncate">{candidate.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="pt-4">
        {state.isLoading ? (
          <div className="flex gap-2">
            <Skeleton className="h-7 w-28 rounded-full" />
            <Skeleton className="h-7 w-28 rounded-full" />
          </div>
        ) : watchers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nobody is watching this task. Watchers are notified when it changes.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {watchers.map((watcher) => (
              <li
                key={watcher.id}
                className="flex items-center gap-1.5 rounded-full border border-border py-1 pl-1 pr-2 text-xs"
              >
                <UserAvatarWithTooltip user={users.get(watcher.id)} size="xs" />
                <span className="max-w-40 truncate">{watcher.name}</span>

                {can?.remove ? (
                  <button
                    type="button"
                    aria-label={`Remove ${watcher.name} as a watcher`}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() =>
                      remove.mutate(watcher.id, {
                        onSuccess: () => toast.success(`${watcher.name} is no longer watching`),
                        onError: fail('remove that watcher'),
                      })
                    }
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
