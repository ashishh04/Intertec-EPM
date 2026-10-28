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
import { formService, workPackageService } from '@/services';
import { t } from '@/lib/i18n';
import type { ID } from '@/types';

/**
 * Edit a work package with every field the instance defines ("Edit all
 * fields" on a task).
 *
 * Fields, allowed values and validation all come from OpenProject's schema,
 * so custom fields and instance-specific configuration appear without any
 * change here.
 *
 * Edit only. Creating a work package has one form wherever it starts — the
 * task drawer (`openTaskDrawer`) — so people learn one way to add work; the
 * fields the drawer does not carry are set here afterwards.
 */

interface WorkPackageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workPackageId: ID;
}

export function WorkPackageDialog({ open, onOpenChange, workPackageId }: WorkPackageDialogProps) {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(
    (payload: Record<string, unknown>) => formService.workPackageEditForm(workPackageId, payload),
    [workPackageId],
  );

  const form = useSchemaForm(load, { enabled: open });

  const save = async () => {
    setIsSaving(true);
    try {
      // The draft holds only what the user changed plus OpenProject's own
      // defaulting, which is exactly what should be written.
      await workPackageService.update(workPackageId, form.draft);
      toast.success(t('Work package updated'));

      for (const key of invalidationGroups.taskWrite) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(t('Could not update work package'), {
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
          <DialogTitle>{t('Edit work package')}</DialogTitle>
          <DialogDescription>
            {t('Every field configured for this workspace, including custom fields.')}
          </DialogDescription>
        </DialogHeader>

        {/* Scrolls, so the actions stay pinned however many fields the
            instance has configured on this type. */}
        <div className="epm-dialog-body epm-scroll -me-1 space-y-4 pe-2">
          <SchemaForm
            form={form.form}
            values={form.draft}
            errors={form.errors}
            onChange={form.setValue}
            isLoading={form.isLoading}
            // The project and type are the record's identity, not edited here.
            exclude={['project', 'type']}
            // OpenProject's own sections — People, Estimates and progress,
            // Details — because this is the whole record and forty fields in
            // one column is a wall rather than a form.
            grouped
          />

          {form.error ? (
            <p role="alert" className="text-2xs font-medium text-danger">
              {form.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('Cancel')}
          </Button>
          <Button
            onClick={save}
            loading={isSaving}
            // OpenProject withholds the commit link while the payload is
            // invalid, which is a better gate than anything computed here.
            disabled={!form.canSubmit || isSaving}
          >
            {t('Save changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
