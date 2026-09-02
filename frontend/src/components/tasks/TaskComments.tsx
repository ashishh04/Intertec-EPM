import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Textarea } from '@/components/ui/input';
import { UserAvatar } from '@/components/common/UserAvatar';
import { ActivityTimelineSkeleton } from '@/components/common/ActivityTimeline';
import { useAddComment, useComments, useEditComment } from '@/hooks/useComments';
import { usePagination } from '@/hooks/usePagination';
import { useUserMap } from '@/hooks/useUsers';
import { formatRelative } from '@/lib/utils';
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
  const add = useAddComment(workPackageId);
  const edit = useEditComment(workPackageId);
  const users = useUserMap();

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<ID>();
  const [editDraft, setEditDraft] = useState('');

  const page = usePagination(comments.data ?? [], { pageSize: 10, resetKey: workPackageId });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    add.mutate(body, {
      onSuccess: () => {
        setDraft('');
        toast.success('Comment added');
      },
      onError: (error) =>
        toast.error('Could not add that comment', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  const saveEdit = (comment: EpmComment) => {
    const body = editDraft.trim();
    if (!body) return;

    edit.mutate(
      { commentId: comment.id, body },
      {
        onSuccess: () => {
          setEditingId(undefined);
          toast.success('Comment updated');
        },
        onError: (error) =>
          toast.error('Could not update that comment', {
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
        errorTitle="Unable to load comments"
        skeleton={<ActivityTimelineSkeleton rows={3} />}
        isEmpty={(comments.data?.length ?? 0) === 0}
        empty={
          <EmptyState
            size="inline"
            title="No comments yet"
            description={
              canComment
                ? 'Start the discussion for this work package.'
                : 'Nobody has commented on this work package.'
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
                  <time className="text-2xs text-muted-foreground">
                    {formatRelative(comment.createdAt)}
                  </time>
                  {comment.updatedAt ? (
                    <span className="text-2xs text-muted-foreground">
                      · edited {formatRelative(comment.updatedAt)}
                    </span>
                  ) : null}

                  {comment.editable && editingId !== comment.id ? (
                    <button
                      type="button"
                      aria-label={`Edit comment by ${comment.author.name}`}
                      className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        setEditingId(comment.id);
                        setEditDraft(comment.body);
                      }}
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                </div>

                {editingId === comment.id ? (
                  <div className="mt-1 space-y-2">
                    <Textarea
                      rows={3}
                      value={editDraft}
                      aria-label="Edit comment"
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingId(undefined)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!editDraft.trim()}
                        loading={edit.isPending}
                        onClick={() => saveEdit(comment)}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  // Markdown source shown as written. `whitespace-pre-wrap`
                  // keeps line breaks without interpreting any of it as markup.
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/70 px-3 py-2 text-xs leading-relaxed text-foreground">
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
          itemLabel="comment"
          variant="compact"
          className="mt-3 justify-end border-t border-border pt-2"
        />
      </QueryBoundary>

      {canComment ? (
        <form onSubmit={submit} className="mt-4 space-y-2 border-t border-border pt-4">
          <label htmlFor="task-comment" className="sr-only">
            Add a comment
          </label>
          <Textarea
            id="task-comment"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a comment, decision or blocker..."
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!draft.trim()} loading={add.isPending}>
              <Send className="h-3.5 w-3.5" />
              Comment
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
