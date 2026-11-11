import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useProjects } from '@/hooks/useProjects';
import { useStatusReportMutations } from '@/hooks/useStatusReports';
import { cn, toISODateOnly } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { TONE_SOFT } from '@/lib/domain';
import { useAuth } from '@/providers/AuthProvider';
import type { ID, StatusRating, StatusReport } from '@/types';
import { RATING_TONE, STATUS_DIMENSIONS, STATUS_RATINGS, dimensionWord, ratingWord, type StatusDimension } from './statusMeta';

const NONE = '__none__';

interface StatusReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopeKind: 'project' | 'portfolio';
  /** Preselected; omit to let the writer choose. */
  scopeId?: ID;
  /** Omit to write a new report. */
  report?: StatusReport;
}

/**
 * Write or change a status report: the day it speaks for, how it stands
 * overall and on each dimension, and what was achieved, what is next and what
 * is in the way.
 */
export function StatusReportDialog({ open, onOpenChange, scopeKind, scopeId, report }: StatusReportDialogProps) {
  const { canInProject } = useAuth();
  const projects = useProjects();
  const portfolios = usePortfolios();
  const { create, update } = useStatusReportMutations();
  const pending = create.isPending || update.isPending;

  const choices = useMemo(
    () =>
      scopeKind === 'project'
        ? (projects.data ?? [])
            .filter((project) => canInProject(project.id, 'project:edit'))
            .map((project) => ({ id: project.id, name: project.name }))
        : (portfolios.data ?? []).map((portfolio) => ({ id: portfolio.id, name: portfolio.name })),
    [scopeKind, projects.data, portfolios.data, canInProject],
  );

  const [target, setTarget] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [overall, setOverall] = useState<StatusRating>('on_track');
  const [dimensions, setDimensions] = useState<Record<StatusDimension, string>>({
    schedule: NONE,
    budget: NONE,
    scope: NONE,
    resources: NONE,
  });
  const [summary, setSummary] = useState('');
  const [achievements, setAchievements] = useState('');
  const [nextSteps, setNextSteps] = useState('');
  const [issues, setIssues] = useState('');
  const [problem, setProblem] = useState<string>();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setTarget(report?.scopeId ?? scopeId ?? '');
    setReportDate(report?.reportDate ?? toISODateOnly(new Date()));
    setOverall(report?.overall ?? 'on_track');
    setDimensions({
      schedule: report?.schedule ?? NONE,
      budget: report?.budget ?? NONE,
      scope: report?.scope ?? NONE,
      resources: report?.resources ?? NONE,
    });
    setSummary(report?.summary ?? '');
    setAchievements(report?.achievements ?? '');
    setNextSteps(report?.nextSteps ?? '');
    setIssues(report?.issues ?? '');
    setProblem(undefined);
  }, [open, report?.id, scopeId]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    if (!target) return setProblem(scopeKind === 'project' ? t('Choose a project.') : t('Choose a portfolio.'));
    if (!summary.trim()) return setProblem(t('A summary is required.'));
    const rated = (value: string) => (value === NONE ? null : (value as StatusRating));
    const fields = {
      reportDate,
      overall,
      schedule: rated(dimensions.schedule),
      budget: rated(dimensions.budget),
      scope: rated(dimensions.scope),
      resources: rated(dimensions.resources),
      summary: summary.trim(),
      achievements: achievements.trim() || null,
      nextSteps: nextSteps.trim() || null,
      issues: issues.trim() || null,
    };
    const failed = (error: unknown) => setProblem(error instanceof Error ? error.message : t('That could not be saved.'));
    if (report) {
      update.mutate(
        { id: report.id, input: fields },
        { onSuccess: () => { toast.success(t('Status report saved')); onOpenChange(false); }, onError: failed },
      );
    } else {
      create.mutate(
        { scopeKind, scopeId: target, ...fields },
        { onSuccess: () => { toast.success(t('Status report published')); onOpenChange(false); }, onError: failed },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {report
                ? t('Edit status report')
                : scopeKind === 'project'
                  ? t('New project status report')
                  : t('New portfolio status report')}
            </DialogTitle>
            <DialogDescription>
              {t('Where it stands, in your words. Health is worked out by the rules; this is the view of the person running it.')}
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <div className="space-y-1.5">
                <Label htmlFor="status-scope" required>
                  {scopeKind === 'project' ? t('Project') : t('Portfolio')}
                </Label>
                <Select value={target} onValueChange={setTarget} disabled={Boolean(report || scopeId)}>
                  <SelectTrigger id="status-scope">
                    <SelectValue placeholder={scopeKind === 'project' ? t('Select a project') : t('Select a portfolio')} />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id}>
                        {choice.name}
                      </SelectItem>
                    ))}
                    {/* The one it is about stays on the list even when it would not be offered. */}
                    {target && !choices.some((choice) => choice.id === target) ? (
                      <SelectItem value={target}>{report?.scopeName ?? target}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="status-date" required>
                  {t('As of')}
                </Label>
                <Input id="status-date" type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
              </div>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">{t('Overall')}</legend>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('Overall')}>
                {STATUS_RATINGS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={overall === value}
                    onClick={() => setOverall(value)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      overall === value ? TONE_SOFT[RATING_TONE[value]] : 'border-border hover:bg-muted',
                    )}
                  >
                    {ratingWord(value)}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-4">
              {STATUS_DIMENSIONS.map((dimension) => (
                <div key={dimension} className="space-y-1.5">
                  <Label htmlFor={`status-${dimension}`}>{dimensionWord(dimension)}</Label>
                  <Select
                    value={dimensions[dimension]}
                    onValueChange={(value) => setDimensions((current) => ({ ...current, [dimension]: value }))}
                  >
                    <SelectTrigger id={`status-${dimension}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('Not rated')}</SelectItem>
                      {STATUS_RATINGS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {ratingWord(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="status-summary" required>
                {t('Summary')}
              </Label>
              <Textarea
                id="status-summary"
                rows={3}
                value={summary}
                placeholder={t('Where things stand, in two or three sentences.')}
                onChange={(event) => setSummary(event.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="status-achievements">{t('Achieved')}</Label>
                <Textarea id="status-achievements" rows={4} value={achievements} onChange={(event) => setAchievements(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="status-next">{t('Next')}</Label>
                <Textarea id="status-next" rows={4} value={nextSteps} onChange={(event) => setNextSteps(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="status-issues">{t('In the way')}</Label>
                <Textarea id="status-issues" rows={4} value={issues} onChange={(event) => setIssues(event.target.value)} />
              </div>
            </div>
            <FieldHint>{t('Markdown. Lists and links work.')}</FieldHint>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {report ? t('Save changes') : t('Publish')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
