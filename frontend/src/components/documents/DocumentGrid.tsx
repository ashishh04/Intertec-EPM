import { useRef } from 'react';
import { motion } from 'framer-motion';
import {
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  Share2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/common/Pagination';
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
 */
export function PaginatedDocumentGrid({
  documents,
  pageSize = 9,
  resetKey,
  className,
  ...rest
}: PaginatedDocumentGridProps) {
  const paged = usePagination(documents, { pageSize, resetKey });

  return (
    <div className="space-y-4">
      <DocumentGrid documents={paged.items} className={className} {...rest} />
      <Pagination
        page={paged.page}
        pageSize={paged.pageSize}
        total={paged.total}
        onPageChange={paged.setPage}
        onPageSizeChange={paged.setPageSize}
        pageSizeOptions={[9, 18, 36]}
        itemLabel="document"
        className="rounded-xl border border-border bg-surface"
      />
    </div>
  );
}

/** Card grid of project files. */
export function DocumentGrid({ documents, users, projects, onOpen, className }: DocumentGridProps) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {documents.map((document) => {
        const meta = DOCUMENT_KIND_META[document.kind];
        const Icon = KIND_ICON[document.kind];
        const owner = users.get(document.ownerId);
        const project = document.projectId ? projects?.get(document.projectId) : undefined;

        return (
          <motion.button
            key={document.id}
            type="button"
            onClick={() => onOpen?.(document)}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.16 }}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 text-left shadow-sm transition-colors hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
                {project?.name ?? 'Workspace library'}
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
  onUpload: (file: { name: string; sizeBytes: number }) => void;
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
          onUpload({ name: file.name, sizeBytes: file.size });
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
        <div key={index} className="flex gap-3 rounded-xl border border-border bg-surface p-3.5">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}
