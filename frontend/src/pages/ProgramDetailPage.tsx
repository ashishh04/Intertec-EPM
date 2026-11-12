import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArrowLeft, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TableCard } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { HealthIndicator, ProjectStatusBadge } from '@/components/common/StatusBadge';
import { ProgramDialog } from '@/components/programs/ProgramDialog';
import { ProgramHealthBar } from '@/components/programs/ProgramHealth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useProgram, useProgramMutations } from '@/hooks/useProjectSettings';
import { useProjects } from '@/hooks/useProjects';
import { formatCurrency, formatPercent, formatShortDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';

/**
 * One program: what it adds up to (health, progress, budget) and its
 * projects, each opening the project. Whoever manages portfolios adds and
 * removes projects, edits the program, archives or deletes it.
 */
export default function ProgramDetailPage() {
  const { programId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const mayManage = can('programs:manage') || can('portfolios:manage');
  const program = useProgram(programId);
  const allProjects = useProjects();
  const mutations = useProgramMutations();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState('');

  const data = program.data;
  const candidates = useMemo(
    () => (allProjects.data ?? []).filter((project) => !project.programId && project.status !== 'paused'),
    [allProjects.data],
  );

  if (program.isLoading) return <PageSkeleton />;

  const move = (projectId: string, to: string | null) =>
    mutations.setProjectProgram.mutate(
      { projectId, programId: to },
      {
        onSuccess: () => toast.success(to ? t('Project added to the program') : t('Project taken out of the program')),
        onError: (error) => toast.error(t('That could not be changed'), { description: error instanceof Error ? error.message : undefined }),
      },
    );

  return (
    <QueryBoundary isLoading={program.isLoading} isError={program.isError} error={program.error} onRetry={() => program.refetch()} errorTitle={t('Unable to load this program')} skeleton={<PageSkeleton />}>
      {data ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow={
              <Link to="/programs" className="inline-flex items-center gap-1 hover:underline">
                <ArrowLeft className="h-3 w-3" aria-hidden />
                {t('Programs')}
              </Link>
            }
            title={data.name}
            description={data.description}
            meta={
              <>
                <Badge size="sm" className="font-mono">{data.code}</Badge>
                {data.portfolioName ? <Badge tone="neutral" size="sm">{data.portfolioName}</Badge> : null}
                {data.managerName ? <Badge tone="accent" size="sm">{t('Run by {name}', { name: data.managerName })}</Badge> : null}
                {!data.active ? <Badge tone="warning" size="sm">{t('Archived')}</Badge> : null}
              </>
            }
            actions={
              mayManage ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('Edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={mutations.setActive.isPending}
                    onClick={() =>
                      mutations.setActive.mutate(
                        { id: data.id, active: !data.active },
                        { onSuccess: () => toast.success(data.active ? t('Program archived') : t('Program restored')) },
                      )
                    }
                  >
                    {data.active ? <Archive className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    {data.active ? t('Archive') : t('Restore')}
                  </Button>
                  <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setDeleting(true)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('Delete')}
                  </Button>
                </div>
              ) : null
            }
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="epm-eyebrow">{t('Projects')}</p>
              <p className="mt-1 font-mono text-lg tabular-nums">{data.projectCount}</p>
              <div className="mt-2">
                <ProgramHealthBar health={data.health} />
              </div>
            </Card>
            <Card className="p-4">
              <p className="epm-eyebrow">{t('Progress')}</p>
              <p className="mt-1 font-mono text-lg tabular-nums">{formatPercent(data.progress)}</p>
              <ProgressBar value={data.progress} size="sm" className="mt-2" label={t('{name} progress', { name: data.name })} />
            </Card>
            <Card className="p-4">
              <p className="epm-eyebrow">{t('Spent of budget')}</p>
              <p className="mt-1 font-mono text-lg tabular-nums">{formatCurrency(data.budgetUsed)}</p>
              <p className="text-2xs text-muted-foreground">{t('of {budget}', { budget: formatCurrency(data.budgetTotal) })}</p>
            </Card>
          </div>

          <TableCard
            toolbar={
              mayManage && data.active ? (
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <Select value={adding} onValueChange={setAdding}>
                    <SelectTrigger className="h-8 w-72 text-xs" aria-label={t('Project to add')}>
                      <SelectValue placeholder={t('Choose a project to add')} />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={!adding || mutations.setProjectProgram.isPending} onClick={() => { move(adding, data.id); setAdding(''); }}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('Add to the program')}
                  </Button>
                  {candidates.length === 0 ? <span className="text-2xs text-muted-foreground">{t('Every active project you can see is in a program already.')}</span> : null}
                </div>
              ) : undefined
            }
          >
            {data.projects.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('No projects in this program yet.')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Project')}</TableHead>
                    <TableHead>{t('Status')}</TableHead>
                    <TableHead>{t('Health')}</TableHead>
                    <TableHead numeric>{t('Progress')}</TableHead>
                    <TableHead numeric>{t('Spent of budget')}</TableHead>
                    <TableHead>{t('Due')}</TableHead>
                    {mayManage ? <TableHead className="w-0"><span className="sr-only">{t('Actions')}</span></TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.projects.map((project) => (
                    <TableRow key={project.id} interactive onClick={() => navigate(`/projects/${project.id}`)}>
                      <TableCell>
                        <Link to={`/projects/${project.id}`} className="font-medium hover:text-primary" dir="auto" onClick={(event) => event.stopPropagation()}>
                          {project.name}
                        </Link>
                      </TableCell>
                      <TableCell><ProjectStatusBadge status={project.status} size="sm" /></TableCell>
                      <TableCell><HealthIndicator level={project.health.overall} /></TableCell>
                      <TableCell numeric>{formatPercent(project.progress)}</TableCell>
                      <TableCell numeric>{formatCurrency(project.budgetUsed)} / {formatCurrency(project.budgetTotal ?? 0)}</TableCell>
                      <TableCell className="text-xs">{formatShortDate(project.dueDate)}</TableCell>
                      {mayManage ? (
                        <TableCell>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t('Take {name} out of the program', { name: project.name })}
                            onClick={(event) => { event.stopPropagation(); move(project.id, null); }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCard>

          <ProgramDialog open={editing} onOpenChange={setEditing} program={data} />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={t('Delete {name}?', { name: data.name })}
            description={t('This removes the program for good. It is refused while any project is still in it; archiving keeps it and can be undone.')}
            confirmLabel={t('Delete permanently')}
            tone="danger"
            pending={mutations.remove.isPending}
            onConfirm={() =>
              mutations.remove.mutate(data.id, {
                onSuccess: () => { toast.success(t('{name} deleted', { name: data.name })); navigate('/programs', { replace: true }); },
                onError: (error) => toast.error(t('That could not be deleted'), { description: error instanceof Error ? error.message : undefined }),
              })
            }
          />
        </div>
      ) : null}
    </QueryBoundary>
  );
}
