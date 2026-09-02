import { useMemo, useState } from 'react';
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
import { useDocuments, useUploadDocument } from '@/hooks/useDocuments';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { useDebounce } from '@/hooks/useDebounce';
import type { ID, EpmProject } from '@/types';

const ALL = '__all__';

/** Workspace document library. */
export default function DocumentsPage() {
  const [search, setSearch] = useState('');
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

  const openPreview = (name: string) =>
    toast('Preview is not implemented yet', { description: name });

  const renderGrid = (items: typeof documents, emptyTitle: string) => (
    <QueryBoundary
      isLoading={documentsQuery.isLoading}
      isError={documentsQuery.isError}
      error={documentsQuery.error}
      onRetry={() => documentsQuery.refetch()}
      errorTitle="Unable to load documents"
      skeleton={<DocumentGridSkeleton />}
      isEmpty={items.length === 0}
      empty={
        <Card>
          <EmptyState
            icon={FileText}
            title={emptyTitle}
            description="Upload a file or adjust the filters to see documents here."
          />
        </Card>
      }
    >
      <PaginatedDocumentGrid
        documents={items}
        users={users}
        projects={projectsById}
        resetKey={`${debouncedSearch}|${projectId}`}
        onOpen={(document) => openPreview(document.name)}
      />
    </QueryBoundary>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Documents"
        description="Specifications, plans, evidence and reporting packs across the workspace."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search documents..."
            aria-label="Search documents"
            className="h-8 pl-8 text-xs"
          />
        </div>

        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-8 w-auto min-w-40 text-xs" aria-label="Filter by project">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
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
          <TabsTrigger value="project">Project Documents</TabsTrigger>
          <TabsTrigger value="recent">Recent Files</TabsTrigger>
          <TabsTrigger value="shared">Shared</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>

        <TabsContent value="project" className="mt-4">
          {renderGrid(grouped.project, 'No project documents')}
        </TabsContent>
        <TabsContent value="recent" className="mt-4">
          {renderGrid(grouped.recent, 'Nothing recent')}
        </TabsContent>
        <TabsContent value="shared" className="mt-4">
          {renderGrid(grouped.shared, 'Nothing shared with you')}
        </TabsContent>
        <TabsContent value="all" className="mt-4">
          {renderGrid(grouped.all, 'No documents yet')}
        </TabsContent>
      </Tabs>

      <section className="space-y-3">
        <SectionHeader title="Upload" description="Add a file to the workspace library" />
        <DocumentUpload
          pending={upload.isPending}
          onUpload={(file) =>
            upload.mutate(
              { ...file, projectId: projectId === ALL ? undefined : projectId },
              {
                onSuccess: (created) =>
                  toast.success('Document uploaded', { description: created.name }),
                onError: () => toast.error('Unable to upload the document'),
              },
            )
          }
        />
      </section>
    </div>
  );
}
