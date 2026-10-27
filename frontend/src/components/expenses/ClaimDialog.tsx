import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
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
import { useCurrencies } from '@/hooks/useFinance';
import {
  useCreateClaim,
  useCreateExpenseCategory,
  useExpenseCategories,
  useTimeSettings,
  useUpdateClaim,
} from '@/hooks/useTimesheets';
import { t } from '@/lib/i18n';
import { toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
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
  // Whoever may add a category can do it here. A new instance has none, and
  // the field is required: an administrator drafting the first claim met a
  // dead end, told to go to another page to make the claim possible at all.
  const { can } = useAuth();
  const mayAddCategory = can('time:configure') || can('expenses:manage');
  const createCategory = useCreateExpenseCategory();
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const projects = useProjects();

  const [projectId, setProjectId] = useState<string>();
  const [workPackageId, setWorkPackageId] = useState<string>();
  const [categoryId, setCategoryId] = useState<string>();
  const [amount, setAmount] = useState('');
  const [claimCurrency, setClaimCurrency] = useState<string>();
  const currencies = useCurrencies();
  const [spentOn, setSpentOn] = useState(() => toISODateOnly(new Date()));
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProjectId(claim?.projectId);
    setWorkPackageId(claim?.workPackageId);
    setCategoryId(claim?.categoryId);
    setAmount(claim ? String(claim.amount) : '');
    setClaimCurrency(claim?.currency);
    setSpentOn(claim?.spentOn ?? toISODateOnly(new Date()));
    setDescription(claim?.description ?? '');
    setError(undefined);
    setAddingCategory(false);
    setNewCategory('');
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
  const usual = settings.data?.settings.expenses.currency ?? '';
  const currency = claimCurrency ?? usual;
  const threshold = settings.data?.settings.expenses.receiptThreshold;
  const noCategories = categories.data?.length === 0;

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    setError(undefined);
    createCategory.mutate(name, {
      onSuccess: (created) => {
        toast.success(t('Category added'));
        setCategoryId(created.id);
        setNewCategory('');
        setAddingCategory(false);
      },
      onError: (failure) => setError(failure instanceof Error ? failure.message : t('The cost type was not added')),
    });
  };

  const save = () => {
    setError(undefined);
    const value = Number(amount);
    if (!projectId || !workPackageId) return setError(t('Choose the project and the work package the cost was for.'));
    if (!categoryId) return setError(t('Choose a category.'));
    if (!Number.isFinite(value) || value <= 0) return setError(t('Enter the amount, e.g. 125.50.'));
    if (!description.trim()) return setError(t('Say what the cost was for.'));
    const input = { projectId, workPackageId, categoryId, amount: value, currency: currency || undefined, spentOn, description: description.trim() };
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
            {noCategories && !mayAddCategory ? (
              <FieldHint>{t('There are no categories yet: an administrator adds them under Administration, Time and costs, Cost types.')}</FieldHint>
            ) : null}
            {noCategories && mayAddCategory ? (
              <FieldHint>{t('There are no categories yet: add the first one here.')}</FieldHint>
            ) : null}
            {mayAddCategory && (noCategories || addingCategory) ? (
              <div className="flex gap-2">
                <Input
                  aria-label={t('New category')}
                  placeholder={t('e.g. Travel')}
                  value={newCategory}
                  onChange={(event) => setNewCategory(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter adds the category rather than submitting anything.
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addCategory();
                    }
                  }}
                  dir="auto"
                />
                <Button
                  variant="secondary"
                  onClick={addCategory}
                  disabled={!newCategory.trim()}
                  loading={createCategory.isPending}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('Add')}
                </Button>
              </div>
            ) : null}
            {mayAddCategory && !noCategories && !addingCategory && categories.data ? (
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setAddingCategory(true)}>
                {t('Add a category')}
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="claim-amount" required>
                {currency ? t('Amount ({currency})', { currency }) : t('Amount')}
              </Label>
              <div className="flex gap-2">
                <Input id="claim-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
                {(currencies.data?.currencies.length ?? 0) > 1 ? (
                  <Select value={currency} onValueChange={setClaimCurrency}>
                    <SelectTrigger className="w-24" aria-label={t('Currency')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(currencies.data?.currencies ?? []).map((code) => (
                        <SelectItem key={code} value={code}>
                          {code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
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
