import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers3, Plus } from 'lucide-react';

import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ProgramDialog } from '@/components/programs/ProgramDialog';
import { ProgramHealthBar } from '@/components/programs/ProgramHealth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { usePrograms } from '@/hooks/useProjectSettings';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Programs: related projects run together, between a portfolio and its
 * projects. Each card adds up its projects (as many as the reader can see):
 * their health, how far they have got, and their budget.
 */
export default function ProgramsPage() {
  const { can } = useAuth();
  const mayManage = can('portfolios:manage');
  const [showArchived, setShowArchived] = useState(false);
  const programs = usePrograms(showArchived);
  const [creating, setCreating] = useState(false);
  const items = programs.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Programs')}
        description={t('Related projects run together, each program between its portfolio and its projects.')}
        actions={
          mayManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('New program')}
            </Button>
          ) : null
        }
      />
      <ListToolbar trailing={<ResultCount count={items.length} label={t('program')} plural={t('programs')} />}>
        {mayManage ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label={t('Show archived programs')} />
            {t('Show archived')}
          </label>
        ) : null}
      </ListToolbar>
      <QueryBoundary
        isLoading={programs.isLoading}
        isError={programs.isError}
        error={programs.error}
        onRetry={() => programs.refetch()}
        errorTitle={t('Unable to load programs')}
        skeleton={<ListSkeleton rows={3} height="h-28" />}
        isEmpty={items.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={Layers3}
              title={t('No programs')}
              description={mayManage ? t('Create a program to run related projects together.') : t('None of your projects is in a program.')}
            />
          </Card>
        }
      >
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((program) => (
            <li key={program.id}>
              <Link to={`/programs/${program.id}`} className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
                <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-primary/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold" dir="auto">
                        {program.name}
                      </h3>
                      <p className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                        {program.code}
                        {program.portfolioName ? ` · ${program.portfolioName}` : ''}
                      </p>
                    </div>
                    {!program.active ? <Badge tone="warning" size="sm">{t('Archived')}</Badge> : null}
                  </div>
                  {program.description ? <p className="line-clamp-2 text-xs text-muted-foreground" dir="auto">{program.description}</p> : null}
                  <ProgramHealthBar health={program.health} />
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between text-2xs">
                      <span className="text-muted-foreground">{t('Progress')}</span>
                      <span className="font-mono tabular-nums">{formatPercent(program.progress)}</span>
                    </div>
                    <ProgressBar value={program.progress} size="sm" label={t('{name} progress', { name: program.name })} />
                  </div>
                  <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-border pt-3 text-2xs">
                    <div>
                      <dt className="text-muted-foreground">{t('Projects')}</dt>
                      <dd className="font-mono font-medium tabular-nums">{program.projectCount}</dd>
                    </div>
                    <div className="col-span-2 text-end">
                      <dt className="text-muted-foreground">{t('Spent of budget')}</dt>
                      <dd className="font-mono font-medium tabular-nums">
                        {formatCurrency(program.budgetUsed)} / {formatCurrency(program.budgetTotal)}
                      </dd>
                    </div>
                  </dl>
                  {program.managerName ? <p className="text-2xs text-muted-foreground">{t('Run by {name}', { name: program.managerName })}</p> : null}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </QueryBoundary>
      <ProgramDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
