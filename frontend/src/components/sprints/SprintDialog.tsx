import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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
import { apiClient } from '@/services/api/client';
import { useProjects } from '@/hooks/useProjects';
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
}

export function SprintDialog({ open, onOpenChange }: SprintDialogProps) {
  const projects = useProjects();
  const client = useQueryClient();

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

  const create = useMutation({
    mutationFn: (input: { name: string; projectId: ID; startDate?: string; endDate?: string }) =>
      apiClient.post<{ id: ID; name: string }>('/sprints', input),
    onSuccess: (created) => {
      void client.invalidateQueries({ queryKey: ['sprints'] });
      toast.success(`${created.name} created`);
      onOpenChange(false);
    },
    onError: (error) =>
      setProblem(error instanceof Error ? error.message : 'That could not be created.'),
  });

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

    create.mutate({
      name: name.trim(),
      projectId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New sprint</DialogTitle>
          <DialogDescription>
            A sprint belongs to a project and can be shared from it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
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
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="sprint-project" aria-label="Select a project">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {(projects.data ?? []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

          {problem ? <p className="text-2xs text-danger">{problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            Create sprint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
