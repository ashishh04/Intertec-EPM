import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import {
  DocumentGridSkeleton,
  DocumentUpload,
  PaginatedDocumentGrid,
} from '@/components/documents/DocumentGrid';
import { SectionHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Card } from '@/components/ui/card';
import { useDocuments, useUploadDocument } from '@/hooks/useDocuments';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import type { ID, NexusProject } from '@/types';

/** Files attached to a project. */
export default function ProjectDocumentsTab() {
  const { projectId } = useParams();
  const documentsQuery = useDocuments({ projectId });
  const projectsQuery = useProjects();
  const upload = useUploadDocument();
  const users = useUserMap();

  const projectsById = useMemo(
    () => new Map<ID, NexusProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  const documents = documentsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <SectionHeader title="Documents" description="Specifications, plans and evidence for this project" />

      <QueryBoundary
        isLoading={documentsQuery.isLoading}
        isError={documentsQuery.isError}
        error={documentsQuery.error}
        onRetry={() => documentsQuery.refetch()}
        errorTitle="Unable to load documents"
        skeleton={<DocumentGridSkeleton cards={3} />}
        isEmpty={documents.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={FileText}
              title="No documents yet"
              description="Upload the first specification or plan for this project."
            />
          </Card>
        }
      >
        <PaginatedDocumentGrid
          documents={documents}
          resetKey={projectId}
          users={users}
          projects={projectsById}
          onOpen={(document) =>
            toast('Preview is not available in the demo', { description: document.name })
          }
        />
      </QueryBoundary>

      <DocumentUpload
        pending={upload.isPending}
        onUpload={(file) =>
          upload.mutate(
            { ...file, projectId },
            {
              onSuccess: (created) =>
                toast.success('Document uploaded', { description: created.name }),
              onError: () => toast.error('Unable to upload the document'),
            },
          )
        }
      />
    </div>
  );
}
