import { useState } from 'react';
import { toast } from 'sonner';
import { Megaphone, Plus } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { Markdown } from '@/components/common/Markdown';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { NewsDialog } from '@/components/news/NewsDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useDeleteNews, useNews, useUpdateNews } from '@/hooks/useCollaborationModules';
import { useUserMap } from '@/hooks/useUsers';
import { formatLongDate, formatRelative } from '@/lib/utils';
import type { EpmNewsPost, ID } from '@/types';

/**
 * The news feed, full posts rather than a list of links.
 *
 * Announcements are short and there are few of them, so making somebody click
 * into each one to find out whether it concerns them is the wrong trade. A long
 * post is clamped with a "read the rest" control instead.
 *
 * Shared by the News page and a project's own tab, so the two cannot drift.
 */
export function NewsFeed({
  projectId,
  scoped = false,
}: {
  projectId?: ID;
  scoped?: boolean;
}) {
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EpmNewsPost | null>(null);
  const [deleting, setDeleting] = useState<EpmNewsPost | null>(null);

  const query = useNews({ projectId, includeDrafts, page, pageSize });
  const update = useUpdateNews();
  const remove = useDeleteNews();
  const users = useUserMap();

  const posts = query.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="news-drafts"
            checked={includeDrafts}
            onCheckedChange={(checked) => {
              setIncludeDrafts(checked);
              setPage(1);
            }}
          />
          {/* "My drafts", not "drafts": the backend will only ever include this
              person's own, and a label saying otherwise would promise more. */}
          <Label htmlFor="news-drafts" className="text-2xs text-muted-foreground">
            Include my drafts
          </Label>
        </div>

        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" />
          Write a post
        </Button>
      </div>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle="Unable to load the news"
        skeleton={
          <div className="space-y-3">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-40 w-full" />
            ))}
          </div>
        }
        isEmpty={posts.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={Megaphone}
              title="Nothing announced yet"
              description="Post here when something happens that people need to know about rather than find out."
              action={{ label: 'Write a post', onClick: () => setCreating(true) }}
            />
          </Card>
        }
      >
        <ul className="space-y-3">
          {posts.map((post) => (
            <li key={post.id}>
              <NewsCard
                post={post}
                showProject={!scoped}
                author={users.get(post.authorId)}
                onEdit={() => setEditing(post)}
                onDelete={() => setDeleting(post)}
                onUnpublish={() =>
                  update.mutate(
                    { id: post.id, input: { published: false } },
                    {
                      onSuccess: () => toast.success('Returned to a draft'),
                      onError: (error) =>
                        toast.error('That could not be unpublished', {
                          description: error instanceof Error ? error.message : undefined,
                        }),
                    },
                  )
                }
                onPublish={() =>
                  update.mutate(
                    { id: post.id, input: { published: true } },
                    {
                      onSuccess: () => toast.success('Post published'),
                      onError: (error) =>
                        toast.error('That could not be published', {
                          description: error instanceof Error ? error.message : undefined,
                        }),
                    },
                  )
                }
              />
            </li>
          ))}
        </ul>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={query.data?.total ?? posts.length}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          pageSizeOptions={[5, 10, 25]}
          itemLabel="post"
        />
      </QueryBoundary>

      <NewsDialog open={creating} onOpenChange={setCreating} projectId={projectId} />

      {editing ? (
        <NewsDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          post={editing}
          projectId={projectId}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this post?"
        description={deleting ? `"${deleting.title}" will be removed. This cannot be undone.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Post deleted');
              setDeleting(null);
            },
            onError: (error) =>
              toast.error('That post could not be deleted', {
                description: error instanceof Error ? error.message : undefined,
              }),
          });
        }}
      />
    </div>
  );
}

function NewsCard({
  post,
  showProject,
  author,
  onEdit,
  onDelete,
  onPublish,
  onUnpublish,
}: {
  post: EpmNewsPost;
  showProject: boolean;
  author?: Parameters<typeof UserAvatar>[0]['user'];
  onEdit: () => void;
  onDelete: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}) {
  // Long posts are clamped until asked for. Per card rather than a global
  // setting: a reader expands the one they are interested in.
  const [expanded, setExpanded] = useState(false);
  const long = post.body.length > 900;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-sm font-semibold tracking-[-0.02em]">{post.title}</h3>
              {!post.publishedAt ? (
                <Badge tone="warning" size="sm">
                  Draft
                </Badge>
              ) : null}
              {showProject ? (
                <Badge tone="neutral" size="sm">
                  {post.projectName ?? (post.projectId ? 'Project' : 'Organisation-wide')}
                </Badge>
              ) : null}
            </div>

            <p className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
              <UserAvatar user={author} size="xs" />
              {post.authorName ?? 'Unknown'}
              {' · '}
              {post.publishedAt
                ? `${formatLongDate(post.publishedAt)} (${formatRelative(post.publishedAt)})`
                : `Written ${formatRelative(post.createdAt)}`}
            </p>
          </div>

          <div className="flex shrink-0 gap-1">
            {post.can.update && !post.publishedAt ? (
              <Button variant="secondary" size="sm" onClick={onPublish}>
                Publish
              </Button>
            ) : null}
            {post.can.update && post.publishedAt ? (
              <Button variant="ghost" size="sm" onClick={onUnpublish}>
                Unpublish
              </Button>
            ) : null}
            {post.can.update ? (
              <Button variant="ghost" size="sm" onClick={onEdit}>
                Edit
              </Button>
            ) : null}
            {post.can.delete ? (
              <Button variant="ghost" size="sm" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
          </div>
        </div>

        {post.summary ? (
          <p className="text-xs font-medium text-muted-foreground">{post.summary}</p>
        ) : null}

        <div className={long && !expanded ? 'relative max-h-48 overflow-hidden' : undefined}>
          <Markdown>{post.body}</Markdown>
          {long && !expanded ? (
            // A fade rather than a hard cut, so it reads as "there is more"
            // instead of as content that failed to render.
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
          ) : null}
        </div>

        {long ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-2xs"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Show less' : 'Read the rest'}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
