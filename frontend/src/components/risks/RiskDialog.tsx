import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProjectAssignees, useProjectTypes } from '@/hooks/useCatalog';
import { useProjects } from '@/hooks/useProjects';
import { useSaveRiskAssessment } from '@/hooks/useRisks';
import { useCreateTask } from '@/hooks/useTasks';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { ID, RiskAssessmentInput, RiskCategory, RiskEntry, RiskResponse } from '@/types';
import {
  CATEGORIES,
  PRIORITY_OF_RATING,
  RATING_TONE,
  RESPONSES,
  SCALE,
  categoryLabel,
  impactLabel,
  probabilityLabel,
  ratingLabel,
  ratingOf,
  responseHint,
  responseLabel,
} from './riskMeta';

/**
 * Raise a risk, or assess one.
 *
 * Raising one creates a work package of the project's risk type (title, owner,
 * target date) and then saves its assessment. Assessing changes only the
 * assessment: the title, owner and status are the work package's, edited
 * where it opens. Either way the priority follows the rating, which the
 * backend sets.
 */

const NONE = '__none__';

interface RiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The risk types; the first one a project has is what a new risk is made as. */
  typeIds: ID[];
  /** Omit to raise a new risk. */
  risk?: RiskEntry;
  /** Preselected project, when the register is filtered to one. */
  defaultProjectId?: ID;
}

export function RiskDialog({ open, onOpenChange, typeIds, risk, defaultProjectId }: RiskDialogProps) {
  const isNew = !risk;
  const { canInProject } = useAuth();
  const projects = useProjects();
  const createTask = useCreateTask();
  const saveAssessment = useSaveRiskAssessment();

  const creatable = useMemo(
    () => (projects.data ?? []).filter((project) => canInProject(project.id, 'task:create')),
    [projects.data, canInProject],
  );

  const [projectId, setProjectId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState(NONE);
  const [dueDate, setDueDate] = useState('');
  const [probability, setProbability] = useState(NONE);
  const [impact, setImpact] = useState(NONE);
  const [category, setCategory] = useState(NONE);
  const [response, setResponse] = useState(NONE);
  const [mitigation, setMitigation] = useState('');
  const [contingency, setContingency] = useState('');
  const [reviewOn, setReviewOn] = useState('');
  const [problem, setProblem] = useState<string>();

  // Reset each time it opens, keyed on the risk's id so a refetch mid-edit
  // does not clear the form.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const assessment = risk?.assessment;
    setProjectId(risk?.task.projectId ?? defaultProjectId ?? '');
    setSubject(risk?.task.subject ?? '');
    setDescription('');
    setOwnerId(NONE);
    setDueDate('');
    setProbability(assessment?.probability ? String(assessment.probability) : NONE);
    setImpact(assessment?.impact ? String(assessment.impact) : NONE);
    setCategory(assessment?.category ?? NONE);
    setResponse(assessment?.response ?? NONE);
    setMitigation(assessment?.mitigation ?? '');
    setContingency(assessment?.contingency ?? '');
    setReviewOn(assessment?.reviewOn ?? '');
    setProblem(undefined);
  }, [open, risk?.task.id, defaultProjectId]);

  // Asked of the project: a type or an owner it does not allow is refused.
  const projectTypes = useProjectTypes(isNew && projectId ? projectId : undefined);
  const assignees = useProjectAssignees(isNew && projectId ? projectId : undefined);
  const riskTypeId = projectTypes.data?.find((type) => typeIds.includes(type.id))?.id;
  const noRiskType = isNew && Boolean(projectId) && projectTypes.isSuccess && !riskTypeId;

  const score = probability !== NONE && impact !== NONE ? Number(probability) * Number(impact) : null;
  const rating = ratingOf(score);
  const busy = createTask.isPending || saveAssessment.isPending;

  const assessmentInput = (): RiskAssessmentInput => ({
    probability: probability === NONE ? null : Number(probability),
    impact: impact === NONE ? null : Number(impact),
    category: category === NONE ? null : (category as RiskCategory),
    response: response === NONE ? null : (response as RiskResponse),
    mitigation: mitigation.trim() || null,
    contingency: contingency.trim() || null,
    reviewOn: reviewOn || null,
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    try {
      if (isNew) {
        if (!projectId) return setProblem(t('Choose the project the risk belongs to.'));
        if (!subject.trim()) return setProblem(t('A title is required.'));
        if (!riskTypeId) return setProblem(t('This project does not have the Risk work type switched on.'));

        const created = await createTask.mutateAsync({
          projectId,
          subject: subject.trim(),
          description: description.trim() || undefined,
          typeId: riskTypeId,
          assigneeId: ownerId === NONE ? undefined : ownerId,
          dueDate: dueDate || undefined,
          ...(rating ? { priority: PRIORITY_OF_RATING[rating] } : {}),
        });
        const input = assessmentInput();
        const anything = Object.values(input).some((value) => value !== null);
        if (anything) {
          await saveAssessment.mutateAsync({ workPackageId: created.id, input }).catch((error: unknown) => {
            // The risk exists; only its assessment did not save. Said so, and the
            // assessment can be made again from the register.
            toast.error(t('The risk was added, but its assessment was not saved'), {
              description: error instanceof Error ? error.message : undefined,
            });
          });
        }
        toast.success(t('Risk added'));
      } else {
        await saveAssessment.mutateAsync({ workPackageId: risk.task.id, input: assessmentInput() });
        toast.success(t('Assessment saved'));
      }
      onOpenChange(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t('That could not be saved.'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? t('New risk') : t('Assess risk')}</DialogTitle>
            <DialogDescription>
              {isNew
                ? t('A risk is a work item of the Risk type in its project, with an owner, a status and comments like any other.')
                : t('How likely it is, how bad it would be, and the plan for it. Title, owner and status are changed on the risk itself.')}
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
            {isNew ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="risk-project" required>
                      {t('Project')}
                    </Label>
                    <Select value={projectId} onValueChange={setProjectId} disabled={projects.isLoading}>
                      <SelectTrigger id="risk-project">
                        <SelectValue placeholder={projects.isLoading ? t('Loading…') : t('Select a project')} />
                      </SelectTrigger>
                      <SelectContent>
                        {creatable.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {noRiskType ? (
                      <FieldHint className="text-danger">
                        {t('This project does not have the Risk work type switched on.')}
                      </FieldHint>
                    ) : !projects.isLoading && creatable.length === 0 ? (
                      <FieldHint>{t('There is no project you may add work to.')}</FieldHint>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="risk-owner">{t('Owner')}</Label>
                    <Select value={ownerId} onValueChange={setOwnerId} disabled={!projectId}>
                      <SelectTrigger id="risk-owner">
                        <SelectValue placeholder={t('Unassigned')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t('Unassigned')}</SelectItem>
                        {(assignees.data ?? []).map((person) => (
                          <SelectItem key={person.id} value={person.id}>
                            {person.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldHint>{t('Who watches the risk and carries out its response.')}</FieldHint>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="risk-subject" required>
                    {t('Title')}
                  </Label>
                  <Input
                    id="risk-subject"
                    value={subject}
                    maxLength={255}
                    autoFocus
                    onChange={(event) => setSubject(event.target.value)}
                    placeholder={t('What might happen, and what it would cause')}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="risk-description">{t('Description')}</Label>
                    <Textarea
                      id="risk-description"
                      rows={2}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={t('The cause, and what would show it is happening.')}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="risk-due">{t('Resolve by')}</Label>
                    <Input id="risk-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                <div className="min-w-0">
                  <p className="font-mono text-2xs text-muted-foreground">{risk.task.key}</p>
                  <p className="truncate text-sm font-medium" dir="auto">
                    {risk.task.subject}
                  </p>
                </div>
                <Button asChild size="sm" variant="ghost">
                  <Link to={`/tasks/${risk.task.id}`} onClick={() => onOpenChange(false)}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('Open risk')}
                  </Link>
                </Button>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="risk-probability">{t('Probability')}</Label>
                <Select value={probability} onValueChange={setProbability}>
                  <SelectTrigger id="risk-probability">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('Not assessed')}</SelectItem>
                    {SCALE.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {t('{value, number} · {label}', { value, label: probabilityLabel(value) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="risk-impact">{t('Impact')}</Label>
                <Select value={impact} onValueChange={setImpact}>
                  <SelectTrigger id="risk-impact">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('Not assessed')}</SelectItem>
                    {SCALE.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {t('{value, number} · {label}', { value, label: impactLabel(value) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs">
              <span className="text-muted-foreground">{t('Score')}</span>
              {score === null || rating === null ? (
                <span className="text-muted-foreground">{t('Set the probability and impact to score it.')}</span>
              ) : (
                <>
                  <Badge tone={RATING_TONE[rating]} size="sm" className="tabular-nums">
                    {t('{score, number} · {rating}', { score, rating: ratingLabel(rating) })}
                  </Badge>
                  <span className="text-muted-foreground">
                    {t('The risk’s priority follows its rating, so dashboards and health count it the same way.')}
                  </span>
                </>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="risk-category">{t('Category')}</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="risk-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('None')}</SelectItem>
                    {CATEGORIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {categoryLabel(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="risk-response">{t('Response')}</Label>
                <Select value={response} onValueChange={setResponse}>
                  <SelectTrigger id="risk-response">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('Not decided')}</SelectItem>
                    {RESPONSES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {responseLabel(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {response !== NONE ? <FieldHint>{responseHint(response as RiskResponse)}</FieldHint> : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="risk-mitigation">{t('Mitigation plan')}</Label>
                <Textarea
                  id="risk-mitigation"
                  rows={3}
                  maxLength={4000}
                  value={mitigation}
                  onChange={(event) => setMitigation(event.target.value)}
                  placeholder={t('What is being done to make it less likely or less harmful.')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="risk-contingency">{t('Contingency plan')}</Label>
                <Textarea
                  id="risk-contingency"
                  rows={3}
                  maxLength={4000}
                  value={contingency}
                  onChange={(event) => setContingency(event.target.value)}
                  placeholder={t('What happens if it happens anyway.')}
                />
              </div>
            </div>

            <div className="space-y-1.5 sm:w-1/2 sm:pe-2">
              <Label htmlFor="risk-review">{t('Review on')}</Label>
              <Input id="risk-review" type="date" value={reviewOn} onChange={(event) => setReviewOn(event.target.value)} />
              <FieldHint>{t('Once this date passes, the register marks the risk as due for review.')}</FieldHint>
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={noRiskType}>
              {isNew ? t('Add risk') : t('Save assessment')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
