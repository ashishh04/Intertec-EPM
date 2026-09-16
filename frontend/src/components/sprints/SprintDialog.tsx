import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjects } from '@/hooks/useProjects';
import { useCreateSprint } from '@/hooks/useSprints';
import type { ID } from '@/types';

/**
 * Creates a sprint.
 *
 * A sprint is an OpenProject version, and a version is defined by a project —
 * which is why one has to be chosen rather than inferred. Dates are optional:
 * a version with none is a backlog, and that is a legitimate thing to make.
 */
interface SprintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the sprint exists, so the opener can show it straight away. */
  onCreated?: (sprint: { id: ID; name: string }) => void;
}

export function SprintDialog({ open, onOpenChange, onCreated }: SprintDialogProps) {
  const projects = useProjects();

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName('');
    setProjectId('');
    setStartDate('');
    setEndDate('');
    setProblem(undefined);
  }, [open]);

  const create = useCreateSprint();

  const submit = () => {
    setProblem(undefined);

    if (!name.trim()) {
      setProblem('Give the sprint a name.');
      return;
    }
    if (!projectId) {
      setProblem('Choose the project it belongs to.');
      return;
    }
    // Caught here because upstream accepts the pair and the result is a sprint
    // that can never contain anything sensible.
    if (startDate && endDate && endDate < startDate) {
      setProblem('The end date is before the start date.');
      return;
    }

    create.mutate(
      {
        name: name.trim(),
        projectId,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      },
      {
        onSuccess: (created) => {
          toast.success(`${created.name} created`);
          onOpenChange(false);
          onCreated?.(created);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be created.'),
      },
    );
  };

  const available = projects.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New sprint</DialogTitle>
          <DialogDescription>
            A sprint belongs to a project and can be shared from it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sprint-name" required>
              Name
            </Label>
            <Input
              id="sprint-name"
              autoFocus
              placeholder="Sprint 12"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sprint-project" required>
              Project
            </Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={projects.isLoading}>
              <SelectTrigger id="sprint-project" aria-label="Select a project">
                <SelectValue placeholder={projects.isLoading ? 'Loading…' : 'Choose a project'} />
              </SelectTrigger>
              <SelectContent>
                {available.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!projects.isLoading && available.length === 0 ? (
              <FieldHint>No projects to put a sprint in. Create one first.</FieldHint>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sprint-start">Start date</Label>
              <Input
                id="sprint-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sprint-end">End date</Label>
              <Input
                id="sprint-end"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </div>
          </div>
          <FieldHint>Leave both empty for a backlog rather than a timeboxed sprint.</FieldHint>

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Create sprint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
