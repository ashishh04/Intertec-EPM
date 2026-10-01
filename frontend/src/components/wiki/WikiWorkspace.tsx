import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  BookOpen,
  ChevronRight,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { Markdown } from '@/components/common/Markdown';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useCreateWikiPage,
  useDeleteWikiPage,
  useRestoreWikiRevision,
  useUpdateWikiPage,
  useWikiPage,
  useWikiRevisions,
  useWikiTree,
} from '@/hooks/useCollaborationModules';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import type { ID, WikiTreeNode } from '@/types';

/**
 * The wiki: a navigation tree beside one page.
 *
 * The page being read is held in the URL by its slug, not by an id, because that
 * is what makes a wiki link durable — somebody pastes `/wiki/deployment` into a
 * ticket and it keeps working. The caller owns that part of the URL and passes the
 * slug in, so this component works the same on the organisation wiki and inside a
 * project.
 *
 * "Not found" is a first-class state, not an error. Following a link to a page
 * nobody has written yet is the normal way a wiki grows, so that case offers to
 * create it at that exact slug rather than apologising.
 */
export function WikiWorkspace({
  projectId,
  slug,
  onNavigate,
}: {
  /** Absent for the organisation-wide wiki. */
  projectId?: ID;
  /** The page to show. Absent means the scope's landing page. */
  slug?: string;
  /** Called with a slug to move to, so the caller owns the address. */
  onNavigate: (slug?: string) => void;
}) {
  const tree = useWikiTree(projectId);

  // With no slug asked for, the first root page is the landing page. A wiki has
  // no natural "home" unless somebody names one, and picking the first root is
  // less surprising than an empty pane beside a populated tree.
  const landing = tree.data?.[0]?.slug;
  const effectiveSlug = slug ?? landing;

  const page = useWikiPage(effectiveSlug, projectId);
  const revisions = useWikiRevisions(page.data?.id);

  const create = useCreateWikiPage();
  const update = useUpdateWikiPage();
  const restore = useRestoreWikiRevision();
  const remove = useDeleteWikiPage();

  const [mode, setMode] = useState<'read' | 'edit' | 'history'>('read');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [creating, setCreating] = useState<{ parentId?: ID } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string>();

  // Re-seeded when the page changes or is saved elsewhere, and never on every
  // render — the editor is being typed into.
  useEffect(() => {
    setDraftTitle(page.data?.title ?? '');
    setDraftBody(page.data?.body ?? '');
    setMode('read');
    setPreview(false);
    setProblem(undefined);
  }, [page.data?.id, page.data?.updatedAt]);

  const dirty =
    Boolean(page.data) &&
    (draftTitle !== (page.data?.title ?? '') || draftBody !== (page.data?.body ?? ''));

  const missing = page.isError && Boolean(effectiveSlug);
  const emptyWiki = (tree.data?.length ?? 0) === 0 && !tree.isLoading;

  const save = () => {
    if (!page.data) return;
    setProblem(undefined);
    if (!draftTitle.trim()) return setProblem('A page needs a title.');

    update.mutate(
      { id: page.data.id, input: { title: draftTitle.trim(), body: draftBody } },
      {
        onSuccess: (saved) => {
          toast.success('Page saved');
          setMode('read');
          // The slug does not change on a title edit — links to it exist — so
          // navigation here is only for the case where the server re-slugged.
          if (saved.slug !== page.data?.slug) onNavigate(saved.slug);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Navigation */}
      <Card className="lg:sticky lg:top-20 lg:self-start">
        <CardHeader
          variant="compact"
          actions={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New page"
              onClick={() => setCreating({})}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <CardTitle>Pages</CardTitle>
        </CardHeader>
        <CardContent className="p-2">
          {tree.isLoading ? (
            <div className="space-y-1.5 p-1">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-5 w-full" />
              ))}
            </div>
          ) : emptyWiki ? (
            <p className="p-2 text-2xs text-muted-foreground">No pages yet.</p>
          ) : (
            <WikiTree
              nodes={tree.data ?? []}
              activeSlug={effectiveSlug}
              onSelect={onNavigate}
              onAddChild={(parentId) => setCreating({ parentId })}
            />
          )}
        </CardContent>
      </Card>

      {/* The page */}
      <div className="min-w-0">
        {emptyWiki ? (
          <Card>
            <EmptyState
              icon={BookOpen}
              title="This wiki is empty"
              description="Write the first page. Anything a team keeps re-explaining belongs here."
              action={{ label: 'Write the first page', onClick: () => setCreating({}) }}
            />
          </Card>
        ) : missing ? (
          <Card>
            <EmptyState
              icon={BookOpen}
              title={`There is no page called "${effectiveSlug}"`}
              description="Following a link to a page nobody has written yet is how a wiki grows. Create it at this address and the link starts working."
              action={{ label: 'Create this page', onClick: () => setCreating({}) }}
            />
          </Card>
        ) : (
          <QueryBoundary
            isLoading={page.isLoading || tree.isLoading}
            isError={false}
            skeleton={<Skeleton className="h-96 w-full" />}
          >
            {page.data ? (
              <Card>
                <CardHeader
                  variant="compact"
                  actions={
                    <div className="flex items-center gap-1">
                      {mode === 'edit' ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setDraftTitle(page.data!.title);
                              setDraftBody(page.data!.body);
                              setMode('read');
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                          <Button size="sm" loading={update.isPending} disabled={!dirty} onClick={save}>
                            <Save className="h-3.5 w-3.5" />
                            Save
                          </Button>
                        </>
                      ) : (
                        <>
                          {page.data.revisionCount > 0 ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setMode(mode === 'history' ? 'read' : 'history')}
                            >
                              <History className="h-3.5 w-3.5" />
                              {page.data.revisionCount}
                            </Button>
                          ) : null}
                          {page.data.can.update ? (
                            <Button variant="secondary" size="sm" onClick={() => setMode('edit')}>
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                          ) : null}
                          {page.data.can.delete ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete page"
                              onClick={() => setDeleting(true)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  }
                >
                  <CardTitle>{mode === 'edit' ? 'Editing' : page.data.title}</CardTitle>
                  <CardDescription className="text-2xs">
                    <span className="font-mono">/{page.data.slug}</span> &middot; last edited by{' '}
                    {page.data.updatedByName ?? 'someone who has since left'}{' '}
                    {formatRelative(page.data.updatedAt)}
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-3 p-4">
                  {mode === 'edit' ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="wiki-title" required>
                          Title
                        </Label>
                        <Input
                          id="wiki-title"
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                        />
                        <FieldHint>
                          The address stays <span className="font-mono">/{page.data.slug}</span>, so
                          existing links keep working.
                        </FieldHint>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="wiki-body">Page</Label>
                          <Tabs
                            value={preview ? 'preview' : 'write'}
                            onValueChange={(value) => setPreview(value === 'preview')}
                          >
                            <TabsList>
                              <TabsTrigger value="write">Write</TabsTrigger>
                              <TabsTrigger value="preview">Preview</TabsTrigger>
                            </TabsList>
                          </Tabs>
                        </div>

                        {preview ? (
                          <div className="min-h-80 rounded-lg border border-border bg-surface p-4">
                            <Markdown
                              empty={
                                <p className="text-2xs text-muted-foreground">
                                  Nothing to preview yet.
                                </p>
                              }
                            >
                              {draftBody}
                            </Markdown>
                          </div>
                        ) : (
                          <Textarea
                            id="wiki-body"
                            rows={22}
                            value={draftBody}
                            className="font-mono text-2xs"
                            onChange={(event) => setDraftBody(event.target.value)}
                          />
                        )}
                        <FieldHint>
                          Markdown. Link another page with{' '}
                          <span className="font-mono">[label](/wiki/slug)</span>.
                        </FieldHint>
                      </div>

                      {problem ? <Alert tone="danger">{problem}</Alert> : null}
                    </>
                  ) : mode === 'history' ? (
                    <WikiHistory
                      revisions={revisions.data ?? []}
                      loading={revisions.isLoading}
                      canRestore={page.data.can.update}
                      pending={restore.isPending}
                      onRestore={(revisionId) =>
                        restore.mutate(
                          { id: page.data!.id, revisionId },
                          {
                            onSuccess: () => {
                              toast.success('Version restored');
                              setMode('read');
                            },
                            onError: (error) =>
                              toast.error('That version could not be restored', {
                                description: error instanceof Error ? error.message : undefined,
                              }),
                          },
                        )
                      }
                    />
                  ) : (
                    <Markdown
                      empty={
                        <p className="text-2xs text-muted-foreground">
                          This page is empty. {page.data.can.update ? 'Press Edit to write it.' : ''}
                        </p>
                      }
                    >
                      {page.data.body}
                    </Markdown>
                  )}
                </CardContent>
              </Card>
            ) : null}
          </QueryBoundary>
        )}
      </div>

      {creating ? (
        <NewPageDialog
          open
          onOpenChange={(open) => !open && setCreating(null)}
          parentId={creating.parentId}
          pending={create.isPending}
          onCreate={(input) =>
            create.mutate(
              { ...input, projectId, parentId: creating.parentId },
              {
                onSuccess: (created) => {
                  toast.success('Page created');
                  setCreating(null);
                  onNavigate(created.slug);
                },
                onError: (error) =>
                  toast.error('That page could not be created', {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              },
            )
          }
          // A link followed to nothing pre-fills the slug it was looking for, so
          // creating the page makes that exact link work.
          suggestedSlug={missing ? effectiveSlug : undefined}
        />
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this page?"
        description={
          page.data
            ? `"${page.data.title}" and its history will be removed. Any subpages move to the top level rather than being deleted with it.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => {
          if (!page.data) return;
          remove.mutate(page.data.id, {
            onSuccess: () => {
              toast.success('Page deleted');
              setDeleting(false);
              onNavigate(undefined);
            },
            onError: (error) =>
              toast.error('That page could not be deleted', {
                description: error instanceof Error ? error.message : undefined,
              }),
          });
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tree                                                                       */
/* -------------------------------------------------------------------------- */

function WikiTree({
  nodes,
  activeSlug,
  onSelect,
  onAddChild,
  depth = 0,
}: {
  nodes: WikiTreeNode[];
  activeSlug?: string;
  onSelect: (slug: string) => void;
  onAddChild: (parentId: ID) => void;
  depth?: number;
}) {
  return (
    <ul className={cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-border pl-2')}>
      {nodes.map((node) => (
        <li key={node.id}>
          <div className="group flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onSelect(node.slug)}
              aria-current={node.slug === activeSlug ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-2xs transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                node.slug === activeSlug
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {node.children.length > 0 ? (
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className="truncate">{node.title}</span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Add a page under ${node.title}`}
              className="h-6 w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => onAddChild(node.id)}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>

          {/* Always expanded. A wiki tree is small enough to read whole, and
              collapsing hides exactly the page somebody is looking for. */}
          {node.children.length > 0 ? (
            <WikiTree
              nodes={node.children}
              activeSlug={activeSlug}
              onSelect={onSelect}
              onAddChild={onAddChild}
              depth={depth + 1}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

function WikiHistory({
  revisions,
  loading,
  canRestore,
  pending,
  onRestore,
}: {
  revisions: { id: ID; title: string; body: string; authorName?: string; createdAt: string }[];
  loading: boolean;
  canRestore: boolean;
  pending: boolean;
  onRestore: (revisionId: ID) => void;
}) {
  const [open, setOpen] = useState<ID | null>(null);

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (revisions.length === 0) {
    return <p className="text-2xs text-muted-foreground">This page has never been edited.</p>;
  }

  return (
    <div className="space-y-2">
      <Alert tone="neutral" icon={History}>
        Each entry is what the page said <em>before</em> that edit. Restoring one saves the current
        text as a new version first, so a restore can itself be undone.
      </Alert>

      <ul className="divide-y divide-border">
        {revisions.map((revision) => (
          <li key={revision.id} className="space-y-2 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-2xs font-medium">{revision.title}</p>
                <p className="text-2xs text-muted-foreground">
                  {revision.authorName ?? 'Unknown'} &middot; {formatDateTime(revision.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-2xs"
                  onClick={() => setOpen(open === revision.id ? null : revision.id)}
                >
                  {open === revision.id ? 'Hide' : 'View'}
                </Button>
                {canRestore ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-2xs"
                    disabled={pending}
                    onClick={() => onRestore(revision.id)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore
                  </Button>
                ) : null}
              </div>
            </div>

            {open === revision.id ? (
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <Markdown>{revision.body}</Markdown>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* New page                                                                   */
/* -------------------------------------------------------------------------- */

function NewPageDialog({
  open,
  onOpenChange,
  parentId,
  pending,
  suggestedSlug,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId?: ID;
  pending: boolean;
  /** The slug a broken link was looking for, so creating it makes that link work. */
  suggestedSlug?: string;
  onCreate: (input: { title: string; body: string; slug?: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    // A suggested slug usually reads as a title with hyphens in it, which is a
    // better starting point than an empty box.
    setTitle(suggestedSlug ? suggestedSlug.replace(/-/g, ' ') : '');
    setSlug(suggestedSlug ?? '');
    setBody('');
    setProblem(undefined);
  }, [open, suggestedSlug]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    if (!title.trim()) return setProblem('Give the page a title.');
    onCreate({ title: title.trim(), body, slug: slug.trim() || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{parentId ? 'New subpage' : 'New page'}</DialogTitle>
            <DialogDescription>
              {parentId
                ? 'It appears under the page you added it from.'
                : 'It appears at the top level of this wiki.'}
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body space-y-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-wiki-title" required>
              Title
            </Label>
            <Input
              id="new-wiki-title"
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-wiki-slug">Address</Label>
            <Input
              id="new-wiki-slug"
              value={slug}
              placeholder="Derived from the title"
              onChange={(event) => setSlug(event.target.value)}
            />
            <FieldHint>
              What the page is linked as. Left empty it comes from the title, and a clash gets a number.
            </FieldHint>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-wiki-body">Page</Label>
            <Textarea
              id="new-wiki-body"
              rows={8}
              value={body}
              className="font-mono text-2xs"
              placeholder={'## What this covers\n\nMarkdown.'}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
