import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FileText, Search } from 'lucide-react';
import { PageHeader, SectionHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import {
  DocumentGridSkeleton,
  DocumentUpload,
  PaginatedDocumentGrid,
} from '@/components/documents/DocumentGrid';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { documentDownloadUrl, useDocuments, useUploadDocument } from '@/hooks/useDocuments';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { useDebounce } from '@/hooks/useDebounce';
import { t } from '@/lib/i18n';
import type { ID, EpmDocument, EpmProject } from '@/types';

const ALL = '__all__';

/** Workspace document library. */
export default function DocumentsPage() {
  // Seeded from the URL so a link can land on a particular document — the
  // Help menu's "Delivery handbook" points here with `?search=handbook`.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const [projectId, setProjectId] = useState<string>(ALL);
  const debouncedSearch = useDebounce(search, 250);

  const documentsQuery = useDocuments({
    search: debouncedSearch || undefined,
    projectId: projectId === ALL ? undefined : projectId,
  });
  const projectsQuery = useProjects();
  const upload = useUploadDocument();
  const users = useUserMap();

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  const documents = documentsQuery.data ?? [];

  const grouped = useMemo(() => {
    const sorted = [...documents].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return {
      all: sorted,
      project: sorted.filter((document) => Boolean(document.projectId)),
      recent: sorted.slice(0, 6),
      shared: sorted.filter((document) => document.shared),
    };
  }, [documents]);

  /*
   * Opens the file itself, streamed back through EPM.
   *
   * A new tab rather than an in-page viewer: the backend serves every document
   * as an attachment with `nosniff`, precisely so an uploaded HTML or SVG can
   * never execute in EPM's own origin, and rendering one inline here would give
   * back exactly what that header exists to prevent.
   */
  const openDocument = (document: EpmDocument) =>
    window.open(documentDownloadUrl(document.id), '_blank', 'noopener,noreferrer');

  const renderGrid = (items: typeof documents, emptyTitle: string) => (
    <QueryBoundary
      isLoading={documentsQuery.isLoading}
      isError={documentsQuery.isError}
      error={documentsQuery.error}
      onRetry={() => documentsQuery.refetch()}
      errorTitle={t('Unable to load documents')}
      skeleton={<DocumentGridSkeleton />}
      isEmpty={items.length === 0}
      empty={
        <Card>
          <EmptyState
            icon={FileText}
            title={emptyTitle}
            description={t('Upload a file or adjust the filters to see documents here.')}
          />
        </Card>
      }
    >
      <PaginatedDocumentGrid
        documents={items}
        users={users}
        projects={projectsById}
        resetKey={`${debouncedSearch}|${projectId}`}
        onOpen={openDocument}
      />
    </QueryBoundary>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Documents')}
        description={t('Specifications, plans, evidence and reporting packs across the workspace.')}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('Search documents...')}
            aria-label={t('Search documents')}
            className="h-8 ps-8 text-xs"
          />
        </div>

        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-8 w-auto min-w-40 text-xs" aria-label={t('Filter by project')}>
            <SelectValue placeholder={t('All projects')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('All projects')}</SelectItem>
            {(projectsQuery.data ?? []).map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="project">
        <TabsList>
          <TabsTrigger value="project">{t('Project Documents')}</TabsTrigger>
          <TabsTrigger value="recent">{t('Recent Files')}</TabsTrigger>
          <TabsTrigger value="shared">{t('Shared')}</TabsTrigger>
          <TabsTrigger value="all">{t('All')}</TabsTrigger>
        </TabsList>

        <TabsContent value="project" className="mt-4">
          {renderGrid(grouped.project, t('No project documents'))}
        </TabsContent>
        <TabsContent value="recent" className="mt-4">
          {renderGrid(grouped.recent, t('Nothing recent'))}
        </TabsContent>
        <TabsContent value="shared" className="mt-4">
          {renderGrid(grouped.shared, t('Nothing shared with you'))}
        </TabsContent>
        <TabsContent value="all" className="mt-4">
          {renderGrid(grouped.all, t('No documents yet'))}
        </TabsContent>
      </Tabs>

      <section className="space-y-3">
        <SectionHeader title={t('Upload')} description={t('Add a file to the workspace library')} />
        <DocumentUpload
          pending={upload.isPending}
          onUpload={(file) =>
            upload.mutate(
              { file, projectId: projectId === ALL ? undefined : projectId },
              {
                onSuccess: (created) =>
                  toast.success(t('Document uploaded'), { description: created.name }),
                onError: (error) =>
                  toast.error(t('Unable to upload the document'), {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              },
            )
          }
        />
      </section>
    </div>
  );
}
