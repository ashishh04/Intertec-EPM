import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { SchemaForm } from '@/components/common/SchemaForm';
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
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { t } from '@/lib/i18n';
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
        toast.success(t('Project updated'));
      } else {
        await projectWriteService.create(form.draft);
        toast.success(t('Project created'));
      }

      for (const key of invalidationGroups.projectWrite) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(isEdit ? t('Could not update project') : t('Could not create project'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('Edit project') : t('New project')}</DialogTitle>
          <DialogDescription>
            {t('Every project field configured for this workspace.')}
          </DialogDescription>
        </DialogHeader>

        {/* Scrolls, so the actions stay pinned however many fields the
            instance has configured. */}
        <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
          <SchemaForm
            form={form.form}
            values={form.draft}
            errors={form.errors}
            onChange={form.setValue}
            isLoading={form.isLoading}
          />

          {/* The schema itself failed to load, so there is no field to hang
              this on; it stands in for the form. */}
          {form.error ? <Alert tone="danger">{form.error.message}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} loading={isSaving} disabled={!form.canSubmit || isSaving}>
            {isEdit ? t('Save changes') : t('Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
