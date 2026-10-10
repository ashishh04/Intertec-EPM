import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Briefcase, Pencil } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePortfolios, useSetProjectPortfolio } from '@/hooks/usePortfolios';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmProject } from '@/types';

/**
 * Which portfolio a project belongs to.
 *
 * Projects are not created or edited here — OpenProject owns them. The only
 * thing this writes is the EPM association, and it is the project page rather
 * than the portfolio page because that is where someone looking at a project
 * would expect to change it.
 *
 * Only active portfolios are offered. A project already in an archived one
 * keeps that association — the backend leaves it alone — but moving into one
 * being retired is refused server-side, so it is not offered.
 */

const NONE = '__none__';

interface ProjectPortfolioCardProps {
  project: EpmProject;
}

export function ProjectPortfolioCard({ project }: ProjectPortfolioCardProps) {
  const { can } = useAuth();
  const mayManage = can('portfolios:manage');

  const portfolios = usePortfolios(true);
  const setPortfolio = useSetProjectPortfolio();

  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(NONE);
  const [problem, setProblem] = useState<string>();

  const openDialog = () => {
    setChoice(project.portfolioId ?? NONE);
    setProblem(undefined);
    setOpen(true);
  };

  const save = () => {
    setProblem(undefined);

    setPortfolio.mutate(
      { projectId: project.id, portfolioId: choice === NONE ? '' : choice },
      {
        onSuccess: () => {
          toast.success(choice === NONE ? t('Removed from its portfolio') : t('Portfolio updated'));
          setOpen(false);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : t('That could not be saved.')),
      },
    );
  };

  const options = (portfolios.data ?? []).filter(
    (portfolio) => portfolio.active || portfolio.id === project.portfolioId,
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Portfolio')}
        </CardTitle>
        {mayManage ? (
          <Button size="sm" variant="ghost" className="h-8" onClick={openDialog}>
            <Pencil className="h-3.5 w-3.5" />
            {t('Change')}
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="pt-4">
        {project.portfolioId ? (
          <Link
            to={`/portfolios/${project.portfolioId}`}
            dir="auto"
            className="text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {project.portfolio}
          </Link>
        ) : project.portfolio ? (
          // A legacy free-text value, from before portfolios were a real
          // reference. Shown rather than hidden, so nothing is silently lost.
          <p className="text-sm" dir="auto">{project.portfolio}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('This project is not in a portfolio.')}
          </p>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Change portfolio')}</DialogTitle>
            <DialogDescription>
              {t(
                'Which portfolio {name} belongs to. The portfolio is an EPM grouping; the project itself is unchanged.',
                { name: project.name },
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-portfolio">{t('Portfolio')}</Label>
              {/* An empty value while loading shows the placeholder instead of
                  the "No portfolio" option, which would read as a settled answer. */}
              <Select
                value={portfolios.isLoading ? '' : choice}
                onValueChange={setChoice}
                disabled={portfolios.isLoading}
              >
                <SelectTrigger id="project-portfolio" aria-label={t('Select a portfolio')}>
                  <SelectValue placeholder={portfolios.isLoading ? t('Loading…') : t('No portfolio')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('No portfolio')}</SelectItem>
                  {options.map((portfolio) => (
                    <SelectItem key={portfolio.id} value={portfolio.id}>
                      {portfolio.active ? portfolio.name : t('{name} (archived)', { name: portfolio.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!portfolios.isLoading && options.length === 0 ? (
                <FieldHint>{t('No portfolios yet. Create one from the Portfolios page.')}</FieldHint>
              ) : null}
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="button" loading={setPortfolio.isPending} onClick={save}>
              {t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
