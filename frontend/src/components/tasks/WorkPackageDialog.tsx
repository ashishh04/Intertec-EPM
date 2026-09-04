import { useCallback, useEffect, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjectTypes } from '@/hooks/useCatalog';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { useProjects } from '@/hooks/useProjects';
import { invalidationGroups } from '@/lib/queryKeys';
import { formService, workPackageService } from '@/services';
import type { ID } from '@/types';

/**
 * Create or edit a work package with every field the instance defines.
 *
 * The curated task drawer covers the common path deliberately. This is the
 * complete one: fields, allowed values and validation all come from
 * OpenProject's schema, so custom fields and instance-specific configuration
 * appear without any change here.
 */

interface WorkPackageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  workPackageId?: ID;
  /** Pre-selects the project when creating. */
  projectId?: ID;
}

export function WorkPackageDialog({
  open,
  onOpenChange,
  workPackageId,
  projectId: initialProjectId,
}: WorkPackageDialogProps) {
  const isEdit = Boolean(workPackageId);
  const queryClient = useQueryClient();

  const projectsQuery = useProjects();
  const [projectId, setProjectId] = useState<ID | undefined>(initialProjectId);
  const [typeId, setTypeId] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) setProjectId(initialProjectId);
  }, [open, initialProjectId]);

  const typesQuery = useProjectTypes(isEdit ? undefined : projectId);

  // Type drives which fields exist, so it is chosen before the schema loads
  // rather than rendered as one field among many. It travels as an id: the
  // backend builds the link, so the shape of the upstream API stays out of the
  // browser.
  const load = useCallback(
    (payload: Record<string, unknown>) =>
      isEdit
        ? formService.workPackageEditForm(workPackageId!, payload)
        : formService.workPackageCreateForm(projectId!, payload, typeId || undefined),
    [isEdit, workPackageId, projectId, typeId],
  );

  const form = useSchemaForm(load, {
    enabled: open && (isEdit || Boolean(projectId)),
  });

  const save = async () => {
    setIsSaving(true);
    try {
      // The draft holds only what the user changed plus OpenProject's own
      // defaulting, which is exactly what should be written.
      const payload = form.draft;

      if (isEdit) {
        await workPackageService.update(workPackageId!, payload);
        toast.success('Work package updated');
      } else {
        await workPackageService.create(projectId!, payload, typeId || undefined);
        toast.success('Work package created');
      }

      for (const key of invalidationGroups.taskWrite) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(isEdit ? 'Could not update work package' : 'Could not create work package', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const projects = projectsQuery.data ?? [];
  const types = typesQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit work package' : 'New work package'}</DialogTitle>
          <DialogDescription>
            Every field configured for this workspace, including custom fields.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEdit ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="wp-project" required>
                  Project
                </Label>
                <Select value={projectId ?? ''} onValueChange={(value) => setProjectId(value)}>
                  <SelectTrigger id="wp-project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {projectId ? (
                <div className="space-y-1.5">
                  <Label htmlFor="wp-type" required>
                    Type
                  </Label>
                  <Select value={typeId ?? ''} onValueChange={setTypeId}>
                    <SelectTrigger id="wp-type">
                      <SelectValue placeholder="Select a type" />
                    </SelectTrigger>
                    <SelectContent>
                      {types.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          {type.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </>
          ) : null}

          {isEdit || projectId ? (
            <SchemaForm
              form={form.form}
              values={form.draft}
              errors={form.errors}
              onChange={form.setValue}
              isLoading={form.isLoading}
              // Chosen above; rendering them again would let the two disagree.
              exclude={['project', 'type']}
            />
          ) : null}

          {form.error ? (
            <p role="alert" className="text-2xs font-medium text-danger">
              {form.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={save}
            loading={isSaving}
            // OpenProject withholds the commit link while the payload is
            // invalid, which is a better gate than anything computed here.
            disabled={!form.canSubmit || isSaving}
          >
            {isEdit ? 'Save changes' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
