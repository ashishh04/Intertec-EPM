import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Markdown } from '@/components/common/Markdown';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCreateNews, useUpdateNews } from '@/hooks/useCollaborationModules';
import { useProjects } from '@/hooks/useProjects';
import type { EpmNewsPost, ID } from '@/types';

/**
 * Writes or edits an announcement.
 *
 * Publishing and saving a draft are two buttons rather than a switch, because
 * they are two decisions and the difference matters: a draft is invisible to
 * everybody but its author, and somebody who meant to announce something should
 * not discover a week later that a toggle was off.
 *
 * The preview is a real tab, not a split pane. Markdown is written in prose and
 * read in prose, and a half-width editor beside a half-width preview is worse at
 * both than either is alone.
 */
interface NewsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  post?: EpmNewsPost;
  projectId?: ID;
}

export function NewsDialog({ open, onOpenChange, post, projectId }: NewsDialogProps) {
  const create = useCreateNews();
  const update = useUpdateNews();
  const pending = create.isPending || update.isPending;

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<string | undefined>();
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [problem, setProblem] = useState<string>();

  const projectsQuery = useProjects();
  const projectOptions = useMemo(
    () =>
      (projectsQuery.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        hint: project.identifier,
      })),
    [projectsQuery.data],
  );

  useEffect(() => {
    if (!open) return;
    setTitle(post?.title ?? '');
    setSummary(post?.summary ?? '');
    setBody(post?.body ?? '');
    setScope(post?.projectId ?? projectId);
    setTab('write');
    setProblem(undefined);
  }, [open, post, projectId]);

  const save = (published: boolean) => {
    setProblem(undefined);
    if (!title.trim()) return setProblem('Give the post a title.');
    if (!body.trim()) return setProblem('A post needs some text.');

    const input = {
      title: title.trim(),
      summary: summary.trim() || undefined,
      body: body.trim(),
      projectId: scope,
      published,
    };

    const failed = (error: unknown) =>
      setProblem(error instanceof Error ? error.message : 'That could not be saved.');

    const done = (message: string) => {
      toast.success(message);
      onOpenChange(false);
    };

    if (post) {
      update.mutate(
        { id: post.id, input },
        { onSuccess: () => done(published ? 'Post published' : 'Saved as a draft'), onError: failed },
      );
      return;
    }

    create.mutate(input, {
      onSuccess: () => done(published ? 'Post published' : 'Saved as a draft'),
      onError: failed,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{post ? 'Edit post' : 'Write an announcement'}</DialogTitle>
          <DialogDescription>
            {post?.publishedAt
              ? 'This post is already published. Saving updates it in place.'
              : 'A draft is visible only to you until you publish it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="epm-dialog-body space-y-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="news-title" required>
              Title
            </Label>
            <Input
              id="news-title"
              value={title}
              autoFocus
              placeholder="Release 4.2 is live"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="news-summary">Standfirst</Label>
              <Input
                id="news-summary"
                value={summary}
                placeholder="One line for the list"
                onChange={(event) => setSummary(event.target.value)}
              />
              <FieldHint>Optional. A short post is its own summary.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="news-project">Project</Label>
              <ComboSelect
                id="news-project"
                label="Project"
                options={projectOptions}
                value={scope}
                clearable
                loading={projectsQuery.isLoading}
                placeholder="Organisation-wide"
                emptyLabel="No projects match"
                onChange={setScope}
              />
              <FieldHint>Organisation-wide posts need administrator rights.</FieldHint>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="news-body" required>
                Post
              </Label>
              <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
                <TabsList>
                  <TabsTrigger value="write">Write</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {tab === 'write' ? (
              <Textarea
                id="news-body"
                rows={12}
                value={body}
                placeholder={'What changed, and what anybody reading needs to do about it.'}
                onChange={(event) => setBody(event.target.value)}
              />
            ) : (
              <div className="min-h-64 rounded-lg border border-border bg-surface p-4">
                <Markdown
                  empty={<p className="text-2xs text-muted-foreground">Nothing to preview yet.</p>}
                >
                  {body}
                </Markdown>
              </div>
            )}
            <FieldHint>Markdown. Headings, lists, links and code all work.</FieldHint>
          </div>

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {/* A published post keeps only one action: unpublishing it back to a
              draft is a different intent, and lives on the post itself. */}
          {post?.publishedAt ? null : (
            <Button variant="secondary" onClick={() => save(false)} disabled={pending}>
              Save draft
            </Button>
          )}
          <Button onClick={() => save(true)} loading={pending}>
            {post?.publishedAt ? 'Save changes' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
