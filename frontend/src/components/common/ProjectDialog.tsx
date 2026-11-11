import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { SchemaForm } from '@/components/common/SchemaForm';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCopyJob, useCopyProject } from '@/hooks/useProjectSettings';
import { useProjects } from '@/hooks/useProjects';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { t } from '@/lib/i18n';
import { invalidationGroups } from '@/lib/queryKeys';
import { formService, projectWriteService } from '@/services';
import type { ID, ProjectCopyOptions } from '@/types';

/**
 * Create or edit a project with every field the instance defines.
 *
 * Fields, allowed values and validation come from OpenProject's project
 * schema, so custom project attributes appear here without code changes.
 * A new project can instead start from a template: a copy of it, made in the
 * background, with a choice of what comes across.
 */

interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  projectId?: ID;
  /** `attributes` edits only the project attributes. */
  fields?: 'all' | 'attributes';
}

const BLANK = '__blank__';

/** What a copy brings across, with what each means. On unless said otherwise. */
const COPY_CHOICES: { key: keyof ProjectCopyOptions; label: () => string; on: boolean }[] = [
  { key: 'workPackages', label: () => t('Work packages'), on: true },
  { key: 'versions', label: () => t('Versions and sprints'), on: true },
  { key: 'members', label: () => t('Members'), on: true },
  { key: 'wiki', label: () => t('Wiki'), on: true },
  { key: 'boards', label: () => t('Boards'), on: true },
  { key: 'queries', label: () => t('Saved views'), on: true },
  { key: 'categories', label: () => t('Categories'), on: true },
  { key: 'overview', label: () => t('Overview'), on: true },
  { key: 'phases', label: () => t('Life cycle'), on: true },
  { key: 'workPackageAttachments', label: () => t('Attachments'), on: false },
];

export function ProjectDialog({ open, onOpenChange, projectId, fields = 'all' }: ProjectDialogProps) {
  const isEdit = Boolean(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const projects = useProjects();
  const templates = useMemo(() => (projects.data ?? []).filter((project) => project.templated), [projects.data]);

  const [templateId, setTemplateId] = useState(BLANK);
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [copy, setCopy] = useState<ProjectCopyOptions>({});
  const [jobId, setJobId] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const startCopy = useCopyProject();
  const job = useCopyJob(jobId);

  useEffect(() => {
    if (!open) return;
    setTemplateId(BLANK);
    setName('');
    setIdentifier('');
    setCopy(Object.fromEntries(COPY_CHOICES.map((choice) => [choice.key, choice.on])));
    setJobId(undefined);
    setProblem(undefined);
  }, [open]);

  // When the copy finishes: open the new project, or say why it failed.
  useEffect(() => {
    const status = job.data?.status;
    if (!status || status === 'in_queue' || status === 'in_process') return;
    if (status === 'success') {
      toast.success(t('Project created from the template'));
      onOpenChange(false);
      if (job.data?.projectId) navigate(`/projects/${job.data.projectId}`);
    } else {
      setProblem(job.data?.message ?? t('The copy did not finish.'));
      setJobId(undefined);
    }
  }, [job.data?.status, job.data?.projectId, job.data?.message, navigate, onOpenChange]);

  const fromTemplate = !isEdit && templateId !== BLANK;

  const load = useCallback(
    (payload: Record<string, unknown>) =>
      isEdit ? formService.projectEditForm(projectId!, payload) : formService.projectCreateForm(payload),
    [isEdit, projectId],
  );

  const form = useSchemaForm(load, { enabled: open && !fromTemplate });
  const only = useMemo(
    () => (fields === 'attributes' ? Object.keys(form.form?.schema ?? {}).filter((key) => key.startsWith('customField')) : undefined),
    [fields, form.form?.schema],
  );

  const save = async () => {
    if (fromTemplate) {
      setProblem(undefined);
      if (!name.trim()) return setProblem(t('A name is required.'));
      startCopy.mutate(
        { templateId, input: { name: name.trim(), identifier: identifier.trim() || undefined, copy } },
        {
          onSuccess: (started) => setJobId(started.jobId),
          onError: (error) => setProblem(error instanceof Error ? error.message : t('The copy could not start.')),
        },
      );
      return;
    }

    setIsSaving(true);
    try {
      if (isEdit) {
        await projectWriteService.update(projectId!, form.draft);
        toast.success(fields === 'attributes' ? t('Project attributes saved') : t('Project updated'));
      } else {
        await projectWriteService.create(form.draft);
        toast.success(t('Project created'));
      }

      for (const key of invalidationGroups.projectWrite) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      void queryClient.invalidateQueries({ queryKey: ['project-settings'] });
      onOpenChange(false);
    } catch (error) {
      toast.error(isEdit ? t('Could not update project') : t('Could not create project'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const copying = Boolean(jobId) || startCopy.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !copying && onOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {fields === 'attributes' ? t('Edit project attributes') : isEdit ? t('Edit project') : t('New project')}
          </DialogTitle>
          <DialogDescription>
            {fromTemplate
              ? t('The new project starts as a copy of the template, with what you choose below.')
              : t('Every project field configured for this workspace.')}
          </DialogDescription>
        </DialogHeader>

        {/* Scrolls, so the actions stay pinned however many fields the
            instance has configured. */}
        <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
          {!isEdit && templates.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-template">{t('Start from')}</Label>
              <Select value={templateId} onValueChange={setTemplateId} disabled={copying}>
                <SelectTrigger id="project-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BLANK}>{t('A blank project')}</SelectItem>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {t('Template: {name}', { name: template.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {fromTemplate ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="copy-name" required>
                    {t('Name')}
                  </Label>
                  <Input id="copy-name" value={name} maxLength={255} autoFocus disabled={copying} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="copy-identifier">{t('Identifier')}</Label>
                  <Input
                    id="copy-identifier"
                    value={identifier}
                    dir="ltr"
                    maxLength={100}
                    disabled={copying}
                    onChange={(event) => setIdentifier(event.target.value.toLowerCase())}
                  />
                  <FieldHint>{t('Left empty, one is made from the name.')}</FieldHint>
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium">{t('Copy across')}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {COPY_CHOICES.map((choice) => (
                    <label key={choice.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={Boolean(copy[choice.key])}
                        disabled={copying}
                        onCheckedChange={(checked) => setCopy((current) => ({ ...current, [choice.key]: checked === true }))}
                      />
                      {choice.label()}
                    </label>
                  ))}
                </div>
                <FieldHint>{t('Modules and project attributes always come across. Meetings, budgets, news, documents and logged time do not.')}</FieldHint>
              </fieldset>
              {copying ? <Alert tone="primary">{t('Copying the template. This can take a minute for a large one.')}</Alert> : null}
            </>
          ) : (
            <>
              <SchemaForm
                form={form.form}
                values={form.draft}
                errors={form.errors}
                onChange={form.setValue}
                isLoading={form.isLoading}
                only={only}
              />
              {fields === 'attributes' && form.form && only?.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('This project shows no attributes you can change.')}</p>
              ) : null}
            </>
          )}

          {/* The schema itself failed to load, so there is no field to hang
              this on; it stands in for the form. */}
          {!fromTemplate && form.error ? <Alert tone="danger">{form.error.message}</Alert> : null}
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving || copying}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} loading={isSaving || copying} disabled={fromTemplate ? copying : !form.canSubmit || isSaving}>
            {isEdit ? t('Save changes') : t('Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
