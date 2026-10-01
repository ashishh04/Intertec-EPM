import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useDeleteDocument } from '@/hooks/useDocuments';
import { usePagination } from '@/hooks/usePagination';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatarWithTooltip } from '@/components/common/UserAvatar';
import { DOCUMENT_KIND_META, TONE_SOFT } from '@/lib/domain';
import { cn, formatBytes, formatRelative, truncate } from '@/lib/utils';
import type { DocumentKind, ID, EpmDocument, EpmProject, EpmUser } from '@/types';

const KIND_ICON: Record<DocumentKind, typeof FileText> = {
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slide: Presentation,
  image: FileImage,
  archive: FileArchive,
  markdown: FileCode,
};

interface DocumentGridProps {
  documents: EpmDocument[];
  users: Map<ID, EpmUser>;
  projects?: Map<ID, EpmProject>;
  onOpen?: (document: EpmDocument) => void;
  /**
   * Asks to remove one. The grid itself never deletes anything — it offers the
   * action and reports the intent, so the confirmation and the mutation live in
   * one place above instead of once per page that renders a grid.
   */
  onDelete?: (document: EpmDocument) => void;
  className?: string;
}

interface PaginatedDocumentGridProps extends DocumentGridProps {
  /** Cards per page. */
  pageSize?: number;
  /** Changing this returns the reader to page 1 — a new filter or project. */
  resetKey?: string;
}

/**
 * Document grid that owns its page state, so every library tab and project
 * pages independently instead of sharing one cursor.
 *
 * It owns deletion for the same reason: the workspace library and a project's
 * Documents tab are the same grid over a different scope, and a confirmation
 * written once per page is two confirmations that drift until one of them
 * forgets to say the file is gone for good. Every caller of this component gets
 * the action, which is why the project tab has it without asking.
 */
export function PaginatedDocumentGrid({
  documents,
  pageSize = 9,
  resetKey,
  className,
  onDelete,
  ...rest
}: PaginatedDocumentGridProps) {
  const paged = usePagination(documents, { pageSize, resetKey });
  const [deleting, setDeleting] = useState<EpmDocument | null>(null);
  const remove = useDeleteDocument();

  return (
    <div className="space-y-3">
      <DocumentGrid
        documents={paged.items}
        className={className}
        // A caller may still handle it themselves; the dialog below is the
        // default rather than the only way.
        onDelete={onDelete ?? setDeleting}
        {...rest}
      />
      {/* The pager sits on its own card, the same footer the tables use, so a
          grid pages the way a list does. */}
      <Card>
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
          pageSizeOptions={[9, 18, 36]}
          itemLabel="document"
        />
      </Card>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this document?"
        description={
          deleting
            ? `"${deleting.name}" will be removed from the library and the file itself deleted. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          const { name, id } = deleting;
          remove.mutate(id, {
            onSuccess: () => {
              toast.success('Document deleted', { description: name });
              setDeleting(null);
            },
            onError: (error) =>
              toast.error('That document could not be deleted', {
                description: error instanceof Error ? error.message : undefined,
              }),
          });
        }}
      />
    </div>
  );
}

/** Card grid of project files. */
export function DocumentGrid({
  documents,
  users,
  projects,
  onOpen,
  onDelete,
  className,
}: DocumentGridProps) {
  if (documents.length === 0) {
    return (
      <Card className={className}>
        <EmptyState
          icon={FileText}
          title="No documents"
          description="Upload a file or adjust the filters to see documents here."
        />
      </Card>
    );
  }

  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {documents.map((document) => {
        const meta = DOCUMENT_KIND_META[document.kind];
        const Icon = KIND_ICON[document.kind];
        const owner = users.get(document.ownerId);
        const project = document.projectId ? projects?.get(document.projectId) : undefined;

        // Offered where OpenProject published the affordance, and nowhere else.
        // The same signal the endpoint checks, so a visible button cannot mean
        // a refusal on click.
        const deletable = Boolean(onDelete) && document.can.delete;

        return (
          // The tile is a button, so the delete control cannot live inside it:
          // a button nested in a button is invalid and the browser swallows the
          // inner click. A positioning wrapper puts them side by side instead.
          <div key={document.id} className="relative">
            {/* A button, not a Card: the tile is the click target and the
                hover lift animates the element itself, so it carries the card
                surface classes rather than wrapping a static Card. */}
            <motion.button
              type="button"
              onClick={() => onOpen?.(document)}
              whileHover={{ y: -2 }}
              transition={{ duration: 0.16 }}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border border-border bg-surface p-3.5 text-left text-foreground transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                // Room for the control in the corner, reserved rather than
                // claimed on hover: a tile that reflows under the pointer is
                // how a reader clicks the wrong thing.
                deletable && 'pr-11',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                  TONE_SOFT[meta.tone],
                )}
                aria-hidden
              >
                <Icon className="h-4 w-4" />
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {truncate(document.name, 46)}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                  {/* Which project this belongs to. A document with a project
                      the reader cannot see is still not in the workspace
                      library, so it says so rather than claiming otherwise. */}
                  {project?.name ?? (document.projectId ? 'Another project' : 'Workspace library')}
                </span>

                <span className="mt-2 flex items-center gap-2">
                  <UserAvatarWithTooltip user={owner} size="xs" />
                  <span className="font-mono text-2xs text-muted-foreground">
                    {formatBytes(document.sizeBytes)}
                  </span>
                  <span className="text-2xs text-muted-foreground/80">
                    {formatRelative(document.updatedAt)}
                  </span>
                  {document.shared ? (
                    <Badge size="sm" tone="accent" className="ml-auto">
                      <Share2 className="h-2.5 w-2.5" aria-hidden />
                      Shared
                    </Badge>
                  ) : null}
                </span>
              </span>
            </motion.button>

            {deletable ? (
              // Always visible, not revealed on hover: an action a reader has to
              // discover by waving the pointer around is one they cannot find on
              // a touch screen at all. Muted until pointed at, so a grid of files
              // does not read as a row of warnings.
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${document.name}`}
                className="absolute right-1.5 top-1.5 text-muted-foreground hover:bg-danger-soft hover:text-danger"
                onClick={() => onDelete?.(document)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Upload affordance. Records the file locally without transferring it. */
export function DocumentUpload({
  onUpload,
  pending = false,
  className,
}: {
  onUpload: (file: File) => void;
  pending?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface px-6 py-8 text-center',
        className,
      )}
    >
      <span
        className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <Upload className="h-4 w-4" />
      </span>
      <div>
        <p className="text-xs font-medium">Upload a document</p>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          Files are stored by the EPM backend and linked to the project.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        aria-label="Choose a file to upload"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          // The File itself, so the browser streams the bytes. Sending name and
          // size alone recorded a document with nothing behind it.
          onUpload(file);
          event.target.value = '';
        }}
      />

      <Button size="sm" variant="secondary" loading={pending} onClick={() => inputRef.current?.click()}>
        Choose file
      </Button>
    </div>
  );
}

export function DocumentGridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: cards }).map((_, index) => (
        <Card key={index} className="flex gap-3 p-3.5">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-4 w-24" />
          </div>
        </Card>
      ))}
    </div>
  );
}
