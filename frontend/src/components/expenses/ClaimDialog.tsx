import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProjects } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useCreateClaim, useExpenseCategories, useTimeSettings, useUpdateClaim } from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { toISODateOnly } from '@/lib/utils';
import type { ExpenseClaimView } from '@/types';

/**
 * A new expense claim, or a draft's details changed (BR-307): the project and
 * work package the cost was for, its category, the amount, the day it was paid
 * and what it was. Receipts are added on the claim's own page.
 */
export function ClaimDialog({
  open,
  onOpenChange,
  claim,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claim?: ExpenseClaimView;
}) {
  const navigate = useNavigate();
  const create = useCreateClaim();
  const update = useUpdateClaim();
  const pending = create.isPending || update.isPending;
  const settings = useTimeSettings(open);
  const categories = useExpenseCategories();
  const projects = useProjects();

  const [projectId, setProjectId] = useState<string>();
  const [workPackageId, setWorkPackageId] = useState<string>();
  const [categoryId, setCategoryId] = useState<string>();
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(() => toISODateOnly(new Date()));
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProjectId(claim?.projectId);
    setWorkPackageId(claim?.workPackageId);
    setCategoryId(claim?.categoryId);
    setAmount(claim ? String(claim.amount) : '');
    setSpentOn(claim?.spentOn ?? toISODateOnly(new Date()));
    setDescription(claim?.description ?? '');
    setError(undefined);
  }, [open, claim]);

  const tasks = useTasks({ projectId, pageSize: 100 }, { enabled: open && Boolean(projectId) });
  const projectOptions = useMemo(
    () => (projects.data ?? []).map((project) => ({ id: project.id, name: project.name, hint: project.identifier })),
    [projects.data],
  );
  const taskOptions = useMemo(
    () => (tasks.data?.items ?? []).map((task) => ({ id: task.id, name: task.subject, hint: task.key })),
    [tasks.data],
  );
  const currency = settings.data?.settings.expenses.currency ?? '';
  const threshold = settings.data?.settings.expenses.receiptThreshold;

  const save = () => {
    setError(undefined);
    const value = Number(amount);
    if (!projectId || !workPackageId) return setError(t('Choose the project and the work package the cost was for.'));
    if (!categoryId) return setError(t('Choose a category.'));
    if (!Number.isFinite(value) || value <= 0) return setError(t('Enter the amount, e.g. 125.50.'));
    if (!description.trim()) return setError(t('Say what the cost was for.'));
    const input = { projectId, workPackageId, categoryId, amount: value, spentOn, description: description.trim() };
    const failed = (failure: unknown) => setError(failure instanceof Error ? failure.message : t('The claim was refused.'));
    if (claim) {
      update.mutate(
        { id: claim.id, input },
        {
          onSuccess: () => {
            toast.success(t('Claim updated'));
            onOpenChange(false);
          },
          onError: failed,
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: (created) => {
          toast.success(t('Claim drafted: add its receipts, then submit it'));
          onOpenChange(false);
          navigate(`/expenses/${created.id}`);
        },
        onError: failed,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{claim ? t('Change the claim') : t('New expense claim')}</DialogTitle>
          <DialogDescription>
            {threshold !== undefined
              ? t('A claim over {threshold} {currency} needs a receipt before it can be submitted.', { threshold, currency })
              : t('A cost you paid for a project, to be approved and then recorded against it.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="claim-project" required>
              {t('Project')}
            </Label>
            <ComboSelect
              id="claim-project"
              label={t('Project')}
              options={projectOptions}
              value={projectId}
              loading={projects.isLoading}
              emptyLabel={t('No projects match')}
              placeholder={t('Choose a project')}
              onChange={(next) => {
                setProjectId(next);
                setWorkPackageId(undefined);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-task" required>
              {t('Work package')}
            </Label>
            <ComboSelect
              id="claim-task"
              label={t('Work package')}
              options={taskOptions}
              value={workPackageId}
              loading={tasks.isLoading}
              disabled={!projectId}
              emptyLabel={t('No work packages match')}
              placeholder={projectId ? t('Choose a work package') : t('Choose a project first')}
              onChange={setWorkPackageId}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-category" required>
              {t('Category')}
            </Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="claim-category">
                <SelectValue placeholder={t('Choose a category')} />
              </SelectTrigger>
              <SelectContent>
                {(categories.data ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {categories.data && categories.data.length === 0 ? (
              <FieldHint>{t('There are no categories yet: an administrator adds them under Administration, Time and costs, Cost types.')}</FieldHint>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="claim-amount" required>
                {currency ? t('Amount ({currency})', { currency }) : t('Amount')}
              </Label>
              <Input id="claim-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claim-date" required>
                {t('Paid on')}
              </Label>
              <Input id="claim-date" type="date" value={spentOn} max={toISODateOnly(new Date())} onChange={(event) => setSpentOn(event.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-description" required>
              {t('What it was for')}
            </Label>
            <Textarea id="claim-description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} dir="auto" />
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('Cancel')}
          </Button>
          <Button loading={pending} onClick={save}>
            {claim ? t('Save') : t('Draft the claim')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
