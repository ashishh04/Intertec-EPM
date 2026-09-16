import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronRight, FolderTree, Pencil } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjectChildren, useProjects, useSetProjectParent } from '@/hooks/useProjects';
import { useAuth } from '@/providers/AuthProvider';
import { pluralize } from '@/lib/utils';
import type { EpmProject } from '@/types';

/**
 * Where a project sits in the delivery hierarchy.
 *
 * The hierarchy is the instance's own `parent` link, not an EPM grouping — a
 * structure built directly upstream shows here unchanged, and a move made here
 * is a real move upstream. That is the difference between this and the
 * portfolio card next to it, which associates without touching the project.
 *
 * A project may not move under itself or under anything already beneath it;
 * both would detach that branch from the tree. Those options are withheld here
 * and refused by the backend regardless of what is rendered.
 */

const NONE = '__none__';

interface ProjectHierarchyCardProps {
  project: EpmProject;
}

export function ProjectHierarchyCard({ project }: ProjectHierarchyCardProps) {
  const { canInProject } = useAuth();
  const mayEdit = canInProject(project.id, 'project:edit');

  const projects = useProjects();
  const children = useProjectChildren(project.id);
  const setParent = useSetProjectParent();

  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(NONE);
  const [problem, setProblem] = useState<string>();

  const openDialog = () => {
    setChoice(project.parentId ?? NONE);
    setProblem(undefined);
    setOpen(true);
  };

  const save = () => {
    setProblem(undefined);

    setParent.mutate(
      { id: project.id, parentId: choice === NONE ? '' : choice },
      {
        onSuccess: () => {
          toast.success(choice === NONE ? 'Moved to the top level' : 'Parent project updated');
          setOpen(false);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  const childItems = children.data ?? [];

  /**
   * Every project except this one and anything already beneath it.
   *
   * Moving a project under its own descendant would cut that branch out of the
   * tree, so those are not offered. Walked from the list already loaded rather
   * than fetched per level, and the backend refuses the same moves anyway.
   */
  const options = useMemo(() => {
    const all = projects.data ?? [];

    const descendants = new Set<string>([project.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of all) {
        if (!candidate.parentId) continue;
        if (!descendants.has(candidate.parentId) || descendants.has(candidate.id)) continue;
        descendants.add(candidate.id);
        grew = true;
      }
    }

    return all.filter((candidate) => !descendants.has(candidate.id));
  }, [projects.data, project.id]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-muted-foreground" aria-hidden />
          Hierarchy
        </CardTitle>
        {mayEdit ? (
          <Button size="sm" variant="ghost" className="h-8" onClick={openDialog}>
            <Pencil className="h-3.5 w-3.5" />
            Change
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <div>
          <p className="epm-eyebrow">Parent project</p>
          {project.parentId ? (
            <Link
              to={`/projects/${project.parentId}`}
              className="mt-1 inline-flex text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {project.parentName ?? project.parentId}
            </Link>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              This is a top-level project.
            </p>
          )}
        </div>

        <div>
          <p className="epm-eyebrow">
            Subprojects
            {childItems.length > 0 ? (
              <span className="ml-1.5 font-mono normal-case tracking-normal text-muted-foreground">
                {childItems.length} {pluralize(childItems.length, 'project')}
              </span>
            ) : null}
          </p>

          {children.isLoading ? (
            <p className="mt-1 text-xs text-muted-foreground">Loading…</p>
          ) : childItems.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No projects sit beneath this one.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {childItems.map((child) => (
                <li key={child.id}>
                  <Link
                    to={`/projects/${child.id}`}
                    className="group flex items-center gap-1 rounded-sm text-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="truncate">{child.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change parent project</DialogTitle>
            <DialogDescription>
              Which project {project.name} sits under. This moves it in the delivery hierarchy;
              its subprojects move with it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-parent">Parent project</Label>
              {/* An empty value while loading shows the placeholder instead of
                  the "No parent" option, which would read as a settled answer. */}
              <Select
                value={projects.isLoading ? '' : choice}
                onValueChange={setChoice}
                disabled={projects.isLoading}
              >
                <SelectTrigger id="project-parent" aria-label="Select a parent project">
                  <SelectValue
                    placeholder={projects.isLoading ? 'Loading…' : 'No parent (top level)'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No parent (top level)</SelectItem>
                  {options.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!projects.isLoading && options.length === 0 ? (
                <FieldHint>
                  There is no other project this one could sit under.
                </FieldHint>
              ) : (
                <FieldHint>
                  This project and anything already beneath it are not offered.
                </FieldHint>
              )}
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" loading={setParent.isPending} onClick={save}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
