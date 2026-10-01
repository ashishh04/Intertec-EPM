import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  Pencil,
  Plus,
  Share2,
  Trash2,
  UserPlus,
} from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MemberDialog } from '@/components/projects/MemberDialog';
import { ProjectDialog } from '@/components/common/ProjectDialog';
import { exceptDetailOf, invalidationGroups } from '@/lib/queryKeys';
import { projectWriteService } from '@/services';
import { WorkPackageDialog } from '@/components/tasks/WorkPackageDialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import { toast } from 'sonner';

/**
 * Project workspace frame. The header and tab strip persist across every
 * project sub-route so context is never lost while navigating.
 */
export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { canInProject } = useAuth();
  const queryClient = useQueryClient();

  /**
   * Archive, restore and delete.
   *
   * Confirmed through a dialog rather than `window.confirm`: the native one is
   * inconsistent with every other confirmation here, and a browser that has
   * been told to block further dialogs silently swallows it — which reads as
   * the action being broken.
   */
  const [pendingAction, setPendingAction] = useState<'archive' | 'restore' | 'delete'>();
  const [working, setWorking] = useState(false);

  const runAction = async () => {
    if (!project || !pendingAction) return;
    setWorking(true);

    const verbs = {
      archive: { run: () => projectWriteService.archive(project.id), done: 'Project archived' },
      restore: { run: () => projectWriteService.restore(project.id), done: 'Project restored' },
      delete: { run: () => projectWriteService.remove(project.id), done: 'Project deleted' },
    } as const;

    try {
      await verbs[pendingAction].run();
      toast.success(verbs[pendingAction].done);
      setPendingAction(undefined);

      // A deleted project has no page left to be on. `replace`, so the back
      // button does not return to a URL that now 404s.
      const deletedId = pendingAction === 'delete' ? project.id : undefined;
      if (deletedId) navigate('/projects', { replace: true });

      /*
       * Refresh everything a project write touches — except the project that has
       * just been deleted.
       *
       * `projectWrite` invalidates `['projects']`, and this page's own detail
       * query is `['projects', 'detail', id]` — underneath it. So a plain
       * invalidation refetched the record that had just been removed, got a 404,
       * and painted "Unable to load project" over the page. The navigation above
       * could not save it: these were awaited first, so the error state rendered
       * before the route changed.
       *
       * `exceptDetailOf` is the fix, and it does not depend on timing — see the
       * note on it for why reordering alone would not have been enough.
       */
      await Promise.all(
        invalidationGroups.projectWrite.map((key) =>
          queryClient.invalidateQueries({
            queryKey: key,
            predicate: deletedId ? exceptDetailOf('projects', deletedId) : undefined,
          }),
        ),
      );
    } catch (error) {
      toast.error('That could not be done', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setWorking(false);
    }
  };
  const [editOpen, setEditOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
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
            <Button
              variant="secondary"
              size="sm"
              disabled={!canInProject(projectId, 'member:manage')}
              onClick={() => setInviteOpen(true)}
            >
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
                {/* Sharing a project *is* giving someone access to it —
                    upstream has no separate concept — so this opens the same
                    dialog the Invite button does rather than pretending to be
                    a different feature. */}
                <DropdownMenuItem onSelect={() => setInviteOpen(true)}>
                  <Share2 />
                  Share with someone
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                {project.status === 'paused' ? (
                  <DropdownMenuItem onSelect={() => setPendingAction('restore')}>
                    <ArchiveRestore />
                    Restore project
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={() => setPendingAction('archive')}
                    disabled={!project.can.archive}
                  >
                    <Archive />
                    Archive project
                  </DropdownMenuItem>
                )}

                {/* Offered only where upstream published the affordance, which
                    it withholds unless the caller may really do it. */}
                {project.can.remove ? (
                  <DropdownMenuItem destructive onSelect={() => setPendingAction('delete')}>
                    <Trash2 />
                    Delete project
                  </DropdownMenuItem>
                ) : null}
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
      <MemberDialog open={inviteOpen} onOpenChange={setInviteOpen} projectId={project.id} />

      <Dialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => !open && setPendingAction(undefined)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingAction === 'delete'
                ? `Delete ${project.name}?`
                : pendingAction === 'restore'
                  ? `Restore ${project.name}?`
                  : `Archive ${project.name}?`}
            </DialogTitle>
            <DialogDescription>
              {pendingAction === 'delete'
                ? 'This removes the project permanently, along with every work package, comment and time entry in it. It cannot be undone. Archiving keeps all of that and can be reversed.'
                : pendingAction === 'restore'
                  ? 'It becomes active again and reappears in the project list.'
                  : 'It stops appearing in the active project list and its work is put aside. You can restore it afterwards.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingAction(undefined)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant={pendingAction === 'restore' ? 'default' : 'danger'}
              onClick={() => void runAction()}
              disabled={working}
            >
              {pendingAction === 'delete'
                ? 'Delete permanently'
                : pendingAction === 'restore'
                  ? 'Restore'
                  : 'Archive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
