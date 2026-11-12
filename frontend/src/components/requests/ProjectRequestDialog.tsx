import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePortfolios } from '@/hooks/usePortfolios';
import { usePrograms } from '@/hooks/useProjectSettings';
import { useProjects } from '@/hooks/useProjects';
import { useProjectRequestMutations } from '@/hooks/useRequests';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import type { ProjectRequest, ProjectRequestInput } from '@/types';

const NONE = '__none__';
const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/**
 * A request to start a project: what it is for, why, who sponsors it, where it
 * would sit and what it would cost. Saved as a draft, or sent for approval at
 * once.
 */
export function ProjectRequestDialog({
  open,
  onOpenChange,
  request,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing an existing draft or rejected request. */
  request?: ProjectRequest;
}) {
  const navigate = useNavigate();
  const mutations = useProjectRequestMutations();
  const users = useUsers();
  const portfolios = usePortfolios();
  const programs = usePrograms();
  const projects = useProjects();
  const [title, setTitle] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [description, setDescription] = useState('');
  const [businessCase, setBusinessCase] = useState('');
  const [sponsorId, setSponsorId] = useState(NONE);
  const [portfolioId, setPortfolioId] = useState(NONE);
  const [programId, setProgramId] = useState(NONE);
  const [templateId, setTemplateId] = useState(NONE);
  const [budget, setBudget] = useState('');
  const [startDate, setStartDate] = useState('');
  const [finishDate, setFinishDate] = useState('');
  const [problem, setProblem] = useState<string>();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setTitle(request?.title ?? '');
    setIdentifier(request?.identifier ?? '');
    setDescription(request?.description ?? '');
    setBusinessCase(request?.businessCase ?? '');
    setSponsorId(request?.sponsorId ?? NONE);
    setPortfolioId(request?.portfolioId ?? NONE);
    setProgramId(request?.programId ?? NONE);
    setTemplateId(request?.templateId ?? NONE);
    setBudget(request?.budget !== undefined ? String(request.budget) : '');
    setStartDate(request?.startDate ?? '');
    setFinishDate(request?.finishDate ?? '');
    setProblem(undefined);
  }, [open, request?.id]);

  const people = useMemo(() => (users.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [users.data]);
  const activePortfolios = (portfolios.data ?? []).filter((portfolio) => portfolio.active !== false);
  const activePrograms = (programs.data ?? []).filter((program) => program.active && (portfolioId === NONE || !program.portfolioId || program.portfolioId === portfolioId));
  const templates = (projects.data ?? []).filter((project) => project.templated);

  const input = (): ProjectRequestInput | undefined => {
    if (!title.trim()) {
      setProblem(t('A name is required.'));
      return undefined;
    }
    const amount = budget.trim() ? Number(budget) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setProblem(t('The budget has to be a number, zero or more.'));
      return undefined;
    }
    if (startDate && finishDate && finishDate < startDate) {
      setProblem(t('The finish cannot be before the start.'));
      return undefined;
    }
    setProblem(undefined);
    return {
      title: title.trim(),
      ...(identifier.trim() ? { identifier: identifier.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(businessCase.trim() ? { businessCase: businessCase.trim() } : {}),
      sponsorId: sponsorId === NONE ? null : sponsorId,
      portfolioId: portfolioId === NONE ? null : portfolioId,
      programId: programId === NONE ? null : programId,
      templateId: templateId === NONE ? null : templateId,
      budget: amount,
      startDate: startDate || null,
      finishDate: finishDate || null,
    };
  };

  const save = async (submit: boolean) => {
    const body = input();
    if (!body) return;
    let saved: ProjectRequest;
    try {
      saved = request ? await mutations.update.mutateAsync({ id: request.id, input: body }) : await mutations.create.mutateAsync(body);
    } catch (error) {
      setProblem(errorText(error) ?? t('That could not be saved.'));
      return;
    }
    if (submit) {
      try {
        await mutations.submit.mutateAsync(saved.id);
        toast.success(t('Request submitted for approval'));
      } catch (error) {
        // Saved, but not sent: say why, and leave it as a draft to send later.
        toast.error(t('Saved as a draft, but not submitted'), { description: errorText(error) });
      }
    } else {
      toast.success(t('Request saved as a draft'));
    }
    onOpenChange(false);
    navigate(`/project-requests/${saved.id}`);
  };

  const pending = mutations.create.isPending || mutations.update.isPending || mutations.submit.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{request ? t('Edit the request') : t('Request a project')}</DialogTitle>
          <DialogDescription>{t('Say what the project is for and why. It is decided through the approval chain for project requests.')}</DialogDescription>
        </DialogHeader>
        <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="request-title" required>
                {t('Project name')}
              </Label>
              <Input id="request-title" value={title} maxLength={255} autoFocus onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="request-identifier">{t('Identifier')}</Label>
              <Input id="request-identifier" value={identifier} dir="ltr" maxLength={100} onChange={(event) => setIdentifier(event.target.value.toLowerCase())} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-description">{t('What it is for')}</Label>
            <Textarea id="request-description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-case">{t('Business case')}</Label>
            <Textarea id="request-case" rows={3} value={businessCase} placeholder={t('The benefit, the cost of not doing it, and how success is measured.')} onChange={(event) => setBusinessCase(event.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="request-sponsor">{t('Sponsor')}</Label>
              <Select value={sponsorId} onValueChange={setSponsorId}>
                <SelectTrigger id="request-sponsor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('Not named yet')}</SelectItem>
                  {people.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="request-template">{t('Start from')}</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="request-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('A blank project')}</SelectItem>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {t('Template: {name}', { name: template.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="request-portfolio">{t('Portfolio')}</Label>
              <Select value={portfolioId} onValueChange={(value) => { setPortfolioId(value); setProgramId(NONE); }}>
                <SelectTrigger id="request-portfolio">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('None')}</SelectItem>
                  {activePortfolios.map((portfolio) => (
                    <SelectItem key={portfolio.id} value={portfolio.id}>
                      {portfolio.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="request-program">{t('Program')}</Label>
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger id="request-program">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('Not in a program')}</SelectItem>
                  {activePrograms.map((program) => (
                    <SelectItem key={program.id} value={program.id}>
                      {program.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="request-budget">{t('Budget')}</Label>
              <Input id="request-budget" inputMode="decimal" dir="ltr" value={budget} onChange={(event) => setBudget(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="request-start">{t('Planned start')}</Label>
              <Input id="request-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="request-finish">{t('Planned finish')}</Label>
              <Input id="request-finish" type="date" value={finishDate} onChange={(event) => setFinishDate(event.target.value)} />
            </div>
          </div>
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => void save(false)}>
            {t('Save as a draft')}
          </Button>
          <Button loading={pending} onClick={() => void save(true)}>
            {t('Submit for approval')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
