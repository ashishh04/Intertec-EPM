import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CODE_PATTERN, CODE_PROBLEM, CodeField } from '@/components/common/CodeField';
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
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateTeam, useUpdateTeam } from '@/hooks/useTeams';
import { useDepartments } from '@/hooks/useDepartments';
import { useUsers } from '@/hooks/useUsers';
import type { EpmTeam } from '@/services/api/teams';

/**
 * Create or edit a team.
 *
 * A hand-written form, as for departments: teams are EPM-owned and have no
 * OpenProject schema to drive a `SchemaForm`.
 *
 * Only active departments are offered. A team already in an archived one keeps
 * that association — the backend leaves it alone — but forming a new one into a
 * department being retired is refused server-side, so it is not offered here.
 */

const NONE = '__none__';

interface TeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  team?: EpmTeam;
  /** Preselected department, when creating from a filtered list. */
  defaultDepartmentId?: string;
}

export function TeamDialog({ open, onOpenChange, team, defaultDepartmentId }: TeamDialogProps) {
  const isEdit = Boolean(team);
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const departments = useDepartments();
  const users = useUsers();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState(NONE);
  const [leadId, setLeadId] = useState(NONE);
  const [problem, setProblem] = useState<string>();

  // Reset each time it opens, so a cancelled edit does not leak into the next.
  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? '');
    setCode(team?.code ?? '');
    setDescription(team?.description ?? '');
    setDepartmentId(team?.department?.id ?? defaultDepartmentId ?? NONE);
    setLeadId(team?.lead?.id ?? NONE);
    setProblem(undefined);
  }, [open, team?.id, defaultDepartmentId]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    const input = {
      name: name.trim(),
      code: code.trim().toUpperCase(),
      description: description.trim() || undefined,
      departmentId: departmentId === NONE ? '' : departmentId,
      leadId: leadId === NONE ? '' : leadId,
    };

    if (!input.name) return setProblem('A name is required.');
    if (!input.code) return setProblem('A code is required.');
    if (!CODE_PATTERN.test(input.code)) return setProblem(CODE_PROBLEM);

    const onSuccess = () => {
      toast.success(isEdit ? 'Team updated' : 'Team created');
      onOpenChange(false);
    };
    const onError = (error: unknown) =>
      setProblem(error instanceof Error ? error.message : 'That could not be saved.');

    if (isEdit) {
      update.mutate({ id: team!.id, input }, { onSuccess, onError });
    } else {
      create.mutate(input, { onSuccess, onError });
    }
  };

  // A team can sit in an archived department; that option stays selectable so
  // an edit does not silently move it out.
  const options = (departments.data ?? []).filter(
    (department) => department.active || department.id === team?.department?.id,
  );
  const people = users.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The form is the dialog's only flex child, so it has to carry the
            column layout for the body to scroll under a pinned footer. */}
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit team' : 'New team'}</DialogTitle>
            <DialogDescription>
              Teams exist only in EPM. Nothing about them leaves it.
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll -mr-1 space-y-4 py-1 pr-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name" required>
                Name
              </Label>
              <Input
                id="team-name"
                value={name}
                maxLength={120}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder="Platform Delivery"
              />
            </div>

            <CodeField id="team-code" value={code} onChange={setCode} placeholder="PLAT" />

            <div className="space-y-1.5">
              <Label htmlFor="team-department">Department</Label>
              {/* An empty value while loading shows the placeholder instead of
                  the "No department" option, which would read as a settled answer. */}
              <Select
                value={departments.isLoading ? '' : departmentId}
                onValueChange={setDepartmentId}
                disabled={departments.isLoading}
              >
                <SelectTrigger id="team-department" aria-label="Select a department">
                  <SelectValue
                    placeholder={departments.isLoading ? 'Loading…' : 'No department'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No department</SelectItem>
                  {options.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.name}
                      {department.active ? '' : ' (archived)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>
                {!departments.isLoading && options.length === 0
                  ? 'No departments yet. A team may exist without one.'
                  : 'A team may exist without one.'}
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-lead">Lead</Label>
              <Select
                value={users.isLoading ? '' : leadId}
                onValueChange={setLeadId}
                disabled={users.isLoading}
              >
                <SelectTrigger id="team-lead" aria-label="Select a lead">
                  <SelectValue placeholder={users.isLoading ? 'Loading…' : 'No lead'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No lead</SelectItem>
                  {people.map((user) => (
                    <SelectItem key={user.id} value={String(user.id)}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!users.isLoading && people.length === 0 ? (
                <FieldHint>Nobody in the directory to choose from.</FieldHint>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-description">Description</Label>
              <Textarea
                id="team-description"
                rows={3}
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this team delivers."
              />
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {isEdit ? 'Save changes' : 'Create team'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
