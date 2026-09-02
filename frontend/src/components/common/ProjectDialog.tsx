import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { SchemaForm } from '@/components/common/SchemaForm';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { invalidationGroups } from '@/lib/queryKeys';
import { formService, projectWriteService } from '@/services';
import type { ID } from '@/types';

/**
 * Create or edit a project with every field the instance defines.
 *
 * Fields, allowed values and validation come from OpenProject's project
 * schema, so custom project attributes appear here without code changes.
 */

interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  projectId?: ID;
}

export function ProjectDialog({ open, onOpenChange, projectId }: ProjectDialogProps) {
  const isEdit = Boolean(projectId);
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(
    (payload: Record<string, unknown>) =>
      isEdit
        ? formService.projectEditForm(projectId!, payload)
        : formService.projectCreateForm(payload),
    [isEdit, projectId],
  );

  const form = useSchemaForm(load, { enabled: open });

  const save = async () => {
    setIsSaving(true);
    try {
      if (isEdit) {
        await projectWriteService.update(projectId!, form.draft);
        toast.success('Project updated');
      } else {
        await projectWriteService.create(form.draft);
        toast.success('Project created');
      }

      for (const key of invalidationGroups.projectWrite) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(isEdit ? 'Could not update project' : 'Could not create project', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>
            Every project field configured for this workspace.
          </DialogDescription>
        </DialogHeader>

        <SchemaForm
          form={form.form}
          values={form.draft}
          errors={form.errors}
          onChange={form.setValue}
          isLoading={form.isLoading}
        />

        {form.error ? (
          <p role="alert" className="text-2xs font-medium text-danger">
            {form.error.message}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={save} loading={isSaving} disabled={!form.canSubmit || isSaving}>
            {isEdit ? 'Save changes' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
