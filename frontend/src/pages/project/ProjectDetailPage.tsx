import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { Ellipsis, Pencil, Plus, Share2, Star, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { ErrorState } from '@/components/common/ErrorState';
import { ProjectStatusBadge } from '@/components/common/StatusBadge';
import { AvatarGroup, UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PROJECT_TABS } from '@/config/navigation';
import { useProject } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { ProjectDialog } from '@/components/common/ProjectDialog';
import { invalidationGroups } from '@/lib/queryKeys';
import { projectWriteService } from '@/services';
import { WorkPackageDialog } from '@/components/tasks/WorkPackageDialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { toast } from 'sonner';

const prototypeAction = (label: string) =>
  toast(`${label} is not implemented yet`, {
    description: 'This action will call the EPM backend in a connected workspace.',
  });

/**
 * Project workspace frame. The header and tab strip persist across every
 * project sub-route so context is never lost while navigating.
 */
export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const { canInProject } = useAuth();
  const queryClient = useQueryClient();

  /**
   * Archives rather than deletes: OpenProject deletion is asynchronous and
   * irreversible, and archiving is what the action has always meant here.
   */
  const archiveProject = async () => {
    if (!project) return;
    if (!window.confirm(`Archive ${project.name}? It will no longer appear in the portfolio.`)) {
      return;
    }

    try {
      await projectWriteService.archive(project.id);
      toast.success('Project archived');
      for (const key of invalidationGroups.projectWrite) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    } catch (error) {
      toast.error('Could not archive project', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const [editOpen, setEditOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { data: project, isLoading, isError, refetch } = useProject(projectId);
  const users = useUserMap();

  if (isError) {
    return (
      <ErrorState
        title="Unable to load project"
        description="Something went wrong while loading this project."
        onRetry={() => refetch()}
      />
    );
  }

  if (isLoading || !project) {
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-3 w-96" />
        </div>
        <Skeleton className="h-9 w-full max-w-2xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  const owner = users.get(project.ownerId);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <span className="font-mono">{project.identifier}</span>
            <span aria-hidden>·</span>
            <span>{project.portfolio}</span>
          </span>
        }
        title={project.name}
        description={project.description}
        meta={<ProjectStatusBadge status={project.status} />}
        actions={
          <>
            <div className="hidden items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 sm:flex">
              <UserAvatar user={owner} size="sm" />
              <div className="text-left">
                <p className="epm-eyebrow">Owner</p>
                <p className="text-2xs font-medium">{owner?.name ?? 'Unassigned'}</p>
              </div>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditOpen(true)}
              disabled={!canInProject(projectId, 'project:edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              onClick={() => setNewTaskOpen(true)}
              disabled={!canInProject(projectId, 'task:create')}
            >
              <Plus className="h-4 w-4" />
              Add Task
            </Button>
            <Button variant="secondary" size="sm" onClick={() => prototypeAction('Inviting members')}>
              <UserPlus className="h-3.5 w-3.5" />
              Invite
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More project actions">
                  <Ellipsis className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => prototypeAction('Following a project')}>
                  <Star />
                  Follow project
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => prototypeAction('Sharing a project')}>
                  <Share2 />
                  Share
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => void archiveProject()}
                  disabled={!canInProject(projectId, 'project:archive')}
                  destructive
                >
                  Archive project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="flex items-center gap-3">
        <AvatarGroup users={project.memberIds.map((id) => users.get(id))} max={6} size="sm" />
        <span className="text-2xs text-muted-foreground">{project.memberIds.length} members</span>
      </div>

      {/* Project navigation */}
      <nav aria-label="Project sections" className="epm-scroll -mx-1 overflow-x-auto">
        <ul className="flex min-w-max items-center gap-4 border-b border-border px-1">
          {PROJECT_TABS.map((tab) => (
            <li key={tab.segment || 'overview'}>
              <NavLink
                to={tab.segment ? `/projects/${project.id}/${tab.segment}` : `/projects/${project.id}`}
                end={!tab.segment}
                className={({ isActive }) =>
                  cn(
                    '-mb-px block border-b-2 px-0.5 pb-2.5 pt-1 text-xs font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <Outlet />

      <ProjectDialog open={editOpen} onOpenChange={setEditOpen} projectId={project.id} />
      <WorkPackageDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={project.id}
      />
    </div>
  );
}
