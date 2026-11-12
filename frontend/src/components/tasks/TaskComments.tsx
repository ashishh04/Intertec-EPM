import { useState } from 'react';
import { toast } from 'sonner';
import { Lock, Pencil, Send, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { UserAvatar } from '@/components/common/UserAvatar';
import { ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { useAddComment, useComments, useEditComment, useInternalCommentMutations, useInternalComments } from '@/hooks/useComments';
import { usePagination } from '@/hooks/usePagination';
import { useUserMap } from '@/hooks/useUsers';
import { formatRelative } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { EpmComment } from '@/services/api/comments';
import type { ID } from '@/types';

/**
 * The discussion on a work package.
 *
 * Editing appears only where the backend reported the affordance, and the
 * backend refuses it regardless of what is shown. There is no delete: upstream
 * publishes no such action, so none is offered.
 *
 * Bodies are markdown source rendered as text. OpenProject also returns
 * rendered html, which the backend withholds — see the note there.
 *
 * Paging is done here because upstream ignores page parameters and returns the
 * whole journal in one response.
 */

interface TaskCommentsProps {
  workPackageId: ID;
  /** Whether this user may comment, from their project permissions. */
  canComment: boolean;
}

export function TaskComments({ workPackageId, canComment }: TaskCommentsProps) {
  const comments = useComments(workPackageId);
  const internal = useInternalComments(workPackageId);
  const add = useAddComment(workPackageId);
  const edit = useEditComment(workPackageId);
  const internalWrites = useInternalCommentMutations(workPackageId);
  const users = useUserMap();

  const [draft, setDraft] = useState('');
  const [internalDraft, setInternalDraft] = useState(false);
  const [editingId, setEditingId] = useState<ID>();
  const [editDraft, setEditDraft] = useState('');

  // The discussion and the internal comments, in the order they were written.
  const all = [...(comments.data ?? []), ...(internal.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const page = usePagination(all, { pageSize: 10, resetKey: workPackageId });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    (internalDraft ? internalWrites.add : add).mutate(body, {
      onSuccess: () => {
        setDraft('');
        toast.success(internalDraft ? t('Internal comment added') : t('Comment added'));
      },
      onError: (error) =>
        toast.error(t('Could not add that comment'), {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const saveEdit = (comment: EpmComment) => {
    const body = editDraft.trim();
    if (!body) return;

    (comment.internal ? internalWrites.edit : edit).mutate(
      { commentId: comment.id, body },
      {
        onSuccess: () => {
          setEditingId(undefined);
          toast.success(t('Comment updated'));
        },
        onError: (error) =>
          toast.error(t('Could not update that comment'), {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <>
      <QueryBoundary
        isLoading={comments.isLoading}
        isError={comments.isError}
        onRetry={() => comments.refetch()}
        errorTitle={t('Unable to load comments')}
        skeleton={<ActivityTimelineSkeleton rows={3} />}
        isEmpty={all.length === 0}
        empty={
          <EmptyState
            size="inline"
            title={t('No comments yet')}
            description={
              canComment
                ? t('Start the discussion for this work package.')
                : t('Nobody has commented on this work package.')
            }
          />
        }
      >
        <ul className="space-y-4">
          {page.items.map((comment) => (
            <li key={comment.id} className="flex gap-3">
              {/* The backend supplies the author's name; the directory is only
                  consulted for the avatar, which it may not have. */}
              <UserAvatar user={users.get(comment.author.id)} size="default" />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium">{comment.author.name}</span>
                  {comment.internal ? (
                    <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 text-2xs font-medium text-warning-strong" title={t('Only the organisation’s own people see this comment.')}>
                      <Lock className="h-2.5 w-2.5" aria-hidden />
                      {t('Internal')}
                    </span>
                  ) : null}
                  <time className="text-2xs text-muted-foreground">
                    {formatRelative(comment.createdAt)}
                  </time>
                  {comment.updatedAt ? (
                    <span className="text-2xs text-muted-foreground">
                      · {t('edited {when}', { when: formatRelative(comment.updatedAt) })}
                    </span>
                  ) : null}

                  {comment.editable && editingId !== comment.id ? (
                    <button
                      type="button"
                      aria-label={t('Edit comment by {name}', { name: comment.author.name })}
                      className="ms-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        setEditingId(comment.id);
                        setEditDraft(comment.body);
                      }}
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                  {comment.internal && comment.deletable && editingId !== comment.id ? (
                    <button
                      type="button"
                      aria-label={t('Delete comment by {name}', { name: comment.author.name })}
                      className={`${comment.editable ? '' : 'ms-auto '}rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                      onClick={() =>
                        internalWrites.remove.mutate(comment.id, {
                          onSuccess: () => toast.success(t('Comment deleted')),
                          onError: (error) => toast.error(t('That could not be deleted'), { description: error instanceof Error ? error.message : undefined }),
                        })
                      }
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                </div>

                {editingId === comment.id ? (
                  <div className="mt-1 space-y-2">
                    <Textarea
                      rows={3}
                      value={editDraft}
                      aria-label={t('Edit comment')}
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingId(undefined)}
                      >
                        {t('Cancel')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!editDraft.trim()}
                        loading={edit.isPending || internalWrites.edit.isPending}
                        onClick={() => saveEdit(comment)}
                      >
                        {t('Save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  // Markdown source shown as written. `whitespace-pre-wrap`
                  // keeps line breaks without interpreting any of it as markup.
                  <p dir="auto" className={`mt-1 whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed text-foreground ${comment.internal ? 'border border-warning/30 bg-warning-soft/40' : 'bg-muted/70'}`}>
                    {comment.body}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>

        <Pagination
          page={page.page}
          pageSize={page.pageSize}
          total={page.total}
          onPageChange={page.setPage}
          itemLabel={t('comment')}
          itemLabelPlural={t('comments')}
          variant="compact"
          className="mt-3 justify-end border-t border-border pt-2"
        />
      </QueryBoundary>

      {canComment ? (
        <form onSubmit={submit} className="mt-4 space-y-2 border-t border-border pt-4">
          <label htmlFor="task-comment" className="sr-only">
            {t('Add comment')}
          </label>
          <Textarea
            id="task-comment"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('Add a comment, decision or blocker...')}
          />
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-2xs text-muted-foreground">
              <Switch checked={internalDraft} onCheckedChange={setInternalDraft} aria-label={t('Internal comment')} />
              <Lock className="h-3 w-3" aria-hidden />
              {t('Internal: only our own people see it')}
            </label>
            <Button type="submit" size="sm" disabled={!draft.trim()} loading={add.isPending || internalWrites.add.isPending}>
              <Send className="h-3.5 w-3.5" />
              {internalDraft ? t('Add internal comment') : t('Comment')}
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
