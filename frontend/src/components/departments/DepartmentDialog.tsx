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
import { useCreateDepartment, useUpdateDepartment } from '@/hooks/useDepartments';
import { useUsers } from '@/hooks/useUsers';
import type { EpmDepartment } from '@/services/api/departments';

/**
 * Create or edit a department.
 *
 * A hand-written form rather than a `SchemaForm`: departments are EPM-owned and
 * have no OpenProject schema to drive one. The manager list comes from the user
 * directory, and only the id is submitted — the name is OpenProject's to state.
 *
 * Validation here is for immediate feedback. The backend validates the same
 * rules and is what actually enforces them.
 */

const NO_MANAGER = '__none__';

interface DepartmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  department?: EpmDepartment;
}

export function DepartmentDialog({ open, onOpenChange, department }: DepartmentDialogProps) {
  const isEdit = Boolean(department);
  const create = useCreateDepartment();
  const update = useUpdateDepartment();
  const users = useUsers();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [managerId, setManagerId] = useState(NO_MANAGER);
  const [problem, setProblem] = useState<string>();

  // Reset each time it opens, so a cancelled edit does not leak into the next.
  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setName(department?.name ?? '');
    setCode(department?.code ?? '');
    setDescription(department?.description ?? '');
    setManagerId(department?.manager?.id ?? NO_MANAGER);
    setProblem(undefined);
  }, [open, department?.id]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    const input = {
      name: name.trim(),
      code: code.trim().toUpperCase(),
      description: description.trim() || undefined,
      managerId: managerId === NO_MANAGER ? '' : managerId,
    };

    if (!input.name) return setProblem('A name is required.');
    if (!input.code) return setProblem('A code is required.');
    if (!CODE_PATTERN.test(input.code)) return setProblem(CODE_PROBLEM);

    const onSuccess = () => {
      toast.success(isEdit ? 'Department updated' : 'Department created');
      onOpenChange(false);
    };
    const onError = (error: unknown) =>
      setProblem(error instanceof Error ? error.message : 'That could not be saved.');

    if (isEdit) {
      update.mutate({ id: department!.id, input }, { onSuccess, onError });
    } else {
      create.mutate(input, { onSuccess, onError });
    }
  };

  const people = users.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The form is the dialog's only flex child, so it has to carry the
            column layout for the body to scroll under a pinned footer. */}
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit department' : 'New department'}</DialogTitle>
            <DialogDescription>
              Departments exist only in EPM. Nothing about them leaves it.
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll -mr-1 space-y-4 py-1 pr-2">
            <div className="space-y-1.5">
              <Label htmlFor="department-name" required>
                Name
              </Label>
              <Input
                id="department-name"
                value={name}
                maxLength={120}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder="Engineering"
              />
            </div>

            <CodeField id="department-code" value={code} onChange={setCode} placeholder="ENG" />

            <div className="space-y-1.5">
              <Label htmlFor="department-manager">Manager</Label>
              {/* An empty value while loading shows the placeholder instead of
                  the "No manager" option, which would read as a settled answer. */}
              <Select
                value={users.isLoading ? '' : managerId}
                onValueChange={setManagerId}
                disabled={users.isLoading}
              >
                <SelectTrigger id="department-manager" aria-label="Select a manager">
                  <SelectValue placeholder={users.isLoading ? 'Loading…' : 'No manager'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>No manager</SelectItem>
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
              <Label htmlFor="department-description">Description</Label>
              <Textarea
                id="department-description"
                rows={3}
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this department is responsible for."
              />
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {isEdit ? 'Save changes' : 'Create department'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
