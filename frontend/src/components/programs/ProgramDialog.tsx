import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CODE_PATTERN, CODE_PROBLEM, CodeField } from '@/components/common/CodeField';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useProgramMutations } from '@/hooks/useProjectSettings';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import type { EpmProgram } from '@/types';

const NONE = '__none__';

/** Create or edit a program: its name, code, portfolio, manager and what it is for. */
export function ProgramDialog({ open, onOpenChange, program }: { open: boolean; onOpenChange: (open: boolean) => void; program?: EpmProgram }) {
  const { create, update } = useProgramMutations();
  const portfolios = usePortfolios();
  const users = useUsers();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [portfolioId, setPortfolioId] = useState(NONE);
  const [managerId, setManagerId] = useState(NONE);
  const [problem, setProblem] = useState<string>();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setName(program?.name ?? '');
    setCode(program?.code ?? '');
    setDescription(program?.description ?? '');
    setPortfolioId(program?.portfolioId ?? NONE);
    setManagerId(program?.managerId ?? NONE);
    setProblem(undefined);
  }, [open, program?.id]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    const input = {
      name: name.trim(),
      code: code.trim().toUpperCase(),
      description: description.trim() || undefined,
      portfolioId: portfolioId === NONE ? null : portfolioId,
      managerId: managerId === NONE ? null : managerId,
    };
    if (!input.name) return setProblem(t('A name is required.'));
    if (!CODE_PATTERN.test(input.code)) return setProblem(t(CODE_PROBLEM));
    const done = () => {
      toast.success(program ? t('Program updated') : t('Program created'));
      onOpenChange(false);
    };
    const failed = (error: unknown) => setProblem(error instanceof Error ? error.message : t('That could not be saved.'));
    if (program) update.mutate({ id: program.id, input }, { onSuccess: done, onError: failed });
    else create.mutate(input, { onSuccess: done, onError: failed });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{program ? t('Edit program') : t('New program')}</DialogTitle>
            <DialogDescription>{t('A program groups related projects run together, inside a portfolio or on its own.')}</DialogDescription>
          </DialogHeader>
          <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
            <div className="space-y-1.5">
              <Label htmlFor="program-name" required>
                {t('Name')}
              </Label>
              <Input id="program-name" value={name} maxLength={120} autoFocus onChange={(event) => setName(event.target.value)} placeholder={t('Digital channels')} />
            </div>
            <CodeField id="program-code" value={code} onChange={setCode} placeholder="DIGI" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="program-portfolio">{t('Portfolio')}</Label>
                <Select value={portfolioId} onValueChange={setPortfolioId}>
                  <SelectTrigger id="program-portfolio">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('No portfolio')}</SelectItem>
                    {(portfolios.data ?? []).map((portfolio) => (
                      <SelectItem key={portfolio.id} value={portfolio.id}>
                        {portfolio.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="program-manager">{t('Program manager')}</Label>
                <Select value={managerId} onValueChange={setManagerId}>
                  <SelectTrigger id="program-manager">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('Nobody yet')}</SelectItem>
                    {(users.data ?? []).map((user) => (
                      <SelectItem key={user.id} value={String(user.id)}>
                        {user.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="program-description">{t('Description')}</Label>
              <Textarea id="program-description" rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('What the program is for, and how its projects add up.')} />
            </div>
            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {program ? t('Save changes') : t('Create program')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
