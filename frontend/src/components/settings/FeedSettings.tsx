import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Rss, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjects } from '@/hooks/useProjects';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import { apiClient } from '@/services/api/client';

interface FeedTokenState {
  exists: boolean;
  createdAt?: string;
  lastUsedAt?: string;
}

interface FeedAddresses {
  token: string;
  notifications: string;
  /** With {projectId} to replace. */
  project: string;
}

const copy = (value: string) =>
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success(t('Copied')))
    .catch(() => toast.error(t('Copy it by hand: the browser did not allow it.')));

/**
 * Atom feeds, for a feed reader: the person's notifications, and the activity
 * of a project they are a member of. The address carries a secret of their
 * own, shown once when it is made; making a new one ends the old.
 */
export function FeedSettings() {
  const client = useQueryClient();
  const projects = useProjects();
  const state = useQuery({ queryKey: ['feeds', 'token'], queryFn: () => apiClient.get<FeedTokenState>('/feeds/token') });
  const [addresses, setAddresses] = useState<FeedAddresses>();
  const [projectId, setProjectId] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const make = useMutation({
    mutationFn: () => apiClient.post<FeedAddresses>('/feeds/token'),
    onSuccess: (made) => {
      setAddresses(made);
      void client.invalidateQueries({ queryKey: ['feeds'] });
    },
    onError: (error) => toast.error(t('That could not be changed'), { description: error instanceof Error ? error.message : undefined }),
  });
  const revoke = useMutation({
    mutationFn: () => apiClient.delete<void>('/feeds/token'),
    onSuccess: () => {
      setAddresses(undefined);
      setRevoking(false);
      toast.success(t('Feed addresses switched off'));
      void client.invalidateQueries({ queryKey: ['feeds'] });
    },
  });

  const projectUrl = addresses && projectId ? addresses.project.replace('{projectId}', projectId) : undefined;

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle className="flex items-center gap-2">
          <Rss className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Feeds')}
        </CardTitle>
        <CardDescription>
          {t('Follow your notifications, or a project you are a member of, in a feed reader (Atom). The address holds a secret of yours: keep it to yourself.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.isLoading ? (
          <Skeleton className="h-10 rounded-md" />
        ) : addresses ? (
          <div className="space-y-3">
            <Alert tone="warning">{t('Copy the addresses now: they are shown only this once. Making new ones ends these.')}</Alert>
            <FeedAddress label={t('My notifications')} value={addresses.notifications} />
            <div className="space-y-1.5">
              <Label htmlFor="feed-project">{t('A project’s activity')}</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="feed-project">
                  <SelectValue placeholder={t('Select a project')} />
                </SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {projectUrl ? <FeedAddress label={t('Its feed')} value={projectUrl} /> : null}
              <p className="text-2xs text-muted-foreground">{t('A project’s feed shows its activity to its members only.')}</p>
            </div>
          </div>
        ) : state.data?.exists ? (
          <p className="text-xs text-muted-foreground">
            {t('You have feed addresses, made {made}.', { made: formatDateTime(state.data.createdAt!) })}{' '}
            {state.data.lastUsedAt ? t('Last read {when}.', { when: formatDateTime(state.data.lastUsedAt) }) : t('Not read yet.')}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('You have no feed addresses yet.')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={make.isPending} onClick={() => make.mutate()}>
            <Rss className="h-3.5 w-3.5" />
            {state.data?.exists ? t('Make new addresses') : t('Make feed addresses')}
          </Button>
          {state.data?.exists ? (
            <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setRevoking(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('Switch the feeds off')}
            </Button>
          ) : null}
        </div>
      </CardContent>
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t('Switch your feeds off?')}
        description={t('Every feed reader following your addresses stops getting anything new.')}
        confirmLabel={t('Switch off')}
        tone="danger"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
    </Card>
  );
}

function FeedAddress({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} dir="ltr" className="font-mono text-2xs" onFocus={(event) => event.currentTarget.select()} />
        <Button size="icon-sm" variant="secondary" className="h-9 w-9 shrink-0" aria-label={t('Copy {what}', { what: label })} onClick={() => void copy(value)}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
