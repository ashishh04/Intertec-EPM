import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Ellipsis, FolderKanban, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminKeys, useAdminProjects } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { invalidationGroups } from '@/lib/queryKeys';
import { formatLongDate, formatNumber } from '@/lib/utils';
import { projectWriteService } from '@/services';
import type { AdminProject } from '@/services/api/admin';
import { AdminPagination, AdminTable, CheckCell, byName } from './shared-tables';

/**
 * Every project, archived ones included, shaped like OpenProject's Projects
 * administration list. Archive, restore and delete go through the same
 * `projectWriteService` calls the project page uses, so the rules the backend
 * applies there apply here too; a refusal shows as a toast rather than a
 * hidden menu item, because the admin list carries no per-project affordances.
 */

const ALL = '__all__';

type StatusFilter = typeof ALL | 'active' | 'archived';
type Action = 'archive' | 'restore' | 'delete';

const ACTION_COPY: Record<
  Action,
  { title: (name: string) => string; description: string; confirm: string; done: string }
> = {
  archive: {
    title: (name) => `Archive ${name}?`,
    description:
      'The project and its work packages stay, but nobody can open or change them until it is restored.',
    confirm: 'Archive',
    done: 'Project archived',
  },
  restore: {
    title: (name) => `Restore ${name}?`,
    description: 'The project becomes visible and editable again for everyone who has access.',
    confirm: 'Restore',
    done: 'Project restored',
  },
  delete: {
    title: (name) => `Delete ${name}?`,
    description:
      'This removes the project permanently, along with every work package, comment and time entry in it. It cannot be undone. To keep the history, archive it instead.',
    confirm: 'Delete permanently',
    done: 'Project deleted',
  },
};

export default function ProjectsListPage() {
  const query = useAdminProjects();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [name, setName] = useState('');

  const [pending, setPending] = useState<{ action: Action; project: AdminProject }>();
  const [working, setWorking] = useState(false);

  const all = useMemo(() => query.data ?? [], [query.data]);

  const counts = useMemo(
    () => ({
      active: all.filter((project) => project.active).length,
      archived: all.filter((project) => !project.active).length,
    }),
    [all],
  );

  const items = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return all
      .filter((project) =>
        status === ALL ? true : status === 'active' ? project.active : !project.active,
      )
      .filter(
        (project) =>
          !needle ||
          project.name.toLowerCase().includes(needle) ||
          project.identifier.toLowerCase().includes(needle),
      )
      .sort(byName);
  }, [all, status, name]);

  const filtering = status !== ALL || name.trim() !== '';
  const paging = usePagination(items, { pageSize: 25, resetKey: `${status}|${name}` });

  const runAction = async () => {
    if (!pending) return;
    const { action, project } = pending;
    setWorking(true);

    const run = {
      archive: () => projectWriteService.archive(project.id),
      restore: () => projectWriteService.restore(project.id),
      delete: () => projectWriteService.remove(project.id),
    }[action];

    try {
      await run();
      toast.success(ACTION_COPY[action].done, { description: project.name });
      await queryClient.invalidateQueries({ queryKey: adminKeys.projects });
      for (const key of invalidationGroups.projectWrite) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      setPending(undefined);
    } catch (error) {
      toast.error('That could not be done', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-4">
      <ListToolbar trailing={<ResultCount count={items.length} total={all.length} label="project" />}>
        <SearchInput
          value={name}
          onValueChange={setName}
          placeholder="Filter by name"
          aria-label="Filter projects by name"
        />
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter by status">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All ({formatNumber(all.length)})</SelectItem>
            <SelectItem value="active">Active ({formatNumber(counts.active)})</SelectItem>
            <SelectItem value="archived">Archived ({formatNumber(counts.archived)})</SelectItem>
          </SelectContent>
        </Select>
      </ListToolbar>

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle="Unable to load projects"
        skeleton={<TableSkeleton columns={7} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={FolderKanban}
            title={filtering ? 'No projects match' : 'No projects'}
            description={
              filtering
                ? 'Try a different status or name.'
                : 'Projects appear here once they are created.'
            }
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="project" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Identifier</TableHead>
              <TableHead>Public</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Created on</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link
                    to={`/projects/${project.id}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {project.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-2xs text-muted-foreground">
                  {project.identifier}
                </TableCell>
                <TableCell>
                  <CheckCell value={project.public} label="Public" />
                </TableCell>
                <TableCell>
                  <Badge tone={project.active ? 'success' : 'warning'} size="sm">
                    {project.active ? 'Active' : 'Archived'}
                  </Badge>
                </TableCell>
                <TableCell className="text-2xs">
                  {project.parentName || <span className="text-muted-foreground">{'—'}</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-2xs text-muted-foreground">
                  {formatLongDate(project.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Actions for ${project.name}`}
                      >
                        <Ellipsis className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {project.active ? (
                        <DropdownMenuItem
                          onSelect={() => setPending({ action: 'archive', project })}
                        >
                          <Archive />
                          Archive
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={() => setPending({ action: 'restore', project })}
                        >
                          <ArchiveRestore />
                          Restore
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        destructive
                        onSelect={() => setPending({ action: 'delete', project })}
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && !working && setPending(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending ? ACTION_COPY[pending.action].title(pending.project.name) : ''}
            </DialogTitle>
            <DialogDescription>
              {pending ? ACTION_COPY[pending.action].description : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(undefined)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant={pending?.action === 'delete' ? 'danger' : 'default'}
              onClick={runAction}
              loading={working}
            >
              {pending ? ACTION_COPY[pending.action].confirm : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
