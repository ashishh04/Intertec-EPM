import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CODE_PATTERN, CODE_PROBLEM, CodeField } from '@/components/common/CodeField';
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
import { Label } from '@/components/ui/label';
import { useCreatePortfolio, useUpdatePortfolio } from '@/hooks/usePortfolios';
import type { EpmPortfolio } from '@/services/api/portfolios';

/**
 * Create or edit a portfolio.
 *
 * A hand-written form, as for departments and teams: portfolios are EPM-owned
 * and have no OpenProject schema to drive a `SchemaForm`.
 *
 * Projects are not chosen here. A project is put into a portfolio from the
 * project's own page, because OpenProject owns projects and EPM only records
 * which portfolio one belongs to.
 */

interface PortfolioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  portfolio?: EpmPortfolio;
}

export function PortfolioDialog({ open, onOpenChange, portfolio }: PortfolioDialogProps) {
  const isEdit = Boolean(portfolio);
  const create = useCreatePortfolio();
  const update = useUpdatePortfolio();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string>();

  // Reset each time it opens, so a cancelled edit does not leak into the next.
  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setName(portfolio?.name ?? '');
    setCode(portfolio?.code ?? '');
    setDescription(portfolio?.description ?? '');
    setProblem(undefined);
  }, [open, portfolio?.id]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    const input = {
      name: name.trim(),
      code: code.trim().toUpperCase(),
      description: description.trim() || undefined,
    };

    if (!input.name) return setProblem('A name is required.');
    if (!input.code) return setProblem('A code is required.');
    if (!CODE_PATTERN.test(input.code)) return setProblem(CODE_PROBLEM);

    const onSuccess = () => {
      toast.success(isEdit ? 'Portfolio updated' : 'Portfolio created');
      onOpenChange(false);
    };
    const onError = (error: unknown) =>
      setProblem(error instanceof Error ? error.message : 'That could not be saved.');

    if (isEdit) {
      update.mutate({ id: portfolio!.id, input }, { onSuccess, onError });
    } else {
      create.mutate(input, { onSuccess, onError });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit portfolio' : 'New portfolio'}</DialogTitle>
            <DialogDescription>
              Portfolios are defined in EPM. Projects are put into one from the project itself.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="portfolio-name" required>
                Name
              </Label>
              <Input
                id="portfolio-name"
                value={name}
                maxLength={120}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer Apps"
              />
            </div>

            <CodeField id="portfolio-code" value={code} onChange={setCode} placeholder="CUST" />

            <div className="space-y-1.5">
              <Label htmlFor="portfolio-description">Description</Label>
              <Textarea
                id="portfolio-description"
                rows={3}
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this portfolio covers."
              />
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {isEdit ? 'Save changes' : 'Create portfolio'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
