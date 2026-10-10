import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FolderKanban, LayoutGrid, List, Plus } from 'lucide-react';
import { TableCard } from '@/components/common/DataTable';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { PageHeader } from '@/components/common/PageHeader';
import { ProjectDialog } from '@/components/common/ProjectDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { ProjectCardSkeleton, ProjectHealthCard } from '@/components/common/ProjectCard';
import { ProjectStatusBadge, HealthIndicator } from '@/components/common/StatusBadge';
import { AvatarGroup } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { useDebounce } from '@/hooks/useDebounce';
import { usePagination } from '@/hooks/usePagination';
import { ALL_PROJECT_STATUSES, PROJECT_STATUS_META } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { cn, formatNumber, formatPercent, formatShortDate } from '@/lib/utils';
import type { ProjectStatus } from '@/types';
import { useAuth } from '@/providers/AuthProvider';

const ALL = '__all__';

/** Portfolio index: every project the user can see, as cards or a dense table. */
export default function ProjectsPage() {
  const { can } = useAuth();
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [portfolio, setPortfolio] = useState<string>(ALL);
  const debouncedSearch = useDebounce(search, 250);

  const projectsQuery = useProjects({
    search: debouncedSearch || undefined,
    status: status === ALL ? undefined : [status],
  });
  const users = useUserMap();

  const portfolios = useMemo(
    () => [...new Set((projectsQuery.data ?? []).map((project) => project.portfolio))].sort(),
    [projectsQuery.data],
  );

  const projects = useMemo(
    () =>
      (projectsQuery.data ?? []).filter(
        (project) => portfolio === ALL || project.portfolio === portfolio,
      ),
    [projectsQuery.data, portfolio],
  );

  // Paging resets whenever the query behind the list changes.
  const paged = usePagination(projects, {
    pageSize: view === 'grid' ? 12 : 15,
    resetKey: `${debouncedSearch}|${status}|${portfolio}|${view}`,
  });

  const summary = useMemo(() => {
    const counts = { on_track: 0, at_risk: 0, delayed: 0, completed: 0, paused: 0 } as Record<
      ProjectStatus,
      number
    >;
    for (const project of projects) counts[project.status] += 1;
    return counts;
  }, [projects]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Projects')}
        description={t('Delivery portfolio across every active engagement.')}
        actions={
          <Button onClick={() => setCreateOpen(true)} disabled={!can('project:create')}>
            <Plus className="h-4 w-4" />
            {t('New Project')}
          </Button>
        }
      />

      {/* Portfolio status strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ALL_PROJECT_STATUSES.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatus(status === key ? ALL : key)}
            aria-pressed={status === key}
            className={cn(
              'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              status === key
                ? 'border-primary/40 bg-primary-soft'
                : 'border-border bg-surface hover:border-primary/25',
            )}
          >
            <span className="min-w-0">
              <span className="block truncate text-2xs text-muted-foreground">
                {PROJECT_STATUS_META[key].label}
              </span>
              <span className="block font-mono text-base font-semibold tabular-nums">
                {formatNumber(summary[key])}
              </span>
            </span>
            <ProjectStatusBadge status={key} size="sm" />
          </button>
        ))}
      </div>

      <ListToolbar
        trailing={
          <>
            <ResultCount
              count={projects.length}
              total={projectsQuery.data?.length}
              label={t('project')}
              plural={t('projects')}
            />
            <Tabs value={view} onValueChange={(value) => setView(value as 'grid' | 'table')}>
              <TabsList aria-label={t('View mode')}>
                <TabsTrigger value="grid" aria-label={t('Card view')}>
                  <LayoutGrid className="h-3.5 w-3.5" />
                </TabsTrigger>
                <TabsTrigger value="table" aria-label={t('Table view')}>
                  <List className="h-3.5 w-3.5" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </>
        }
      >
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('Search projects...')}
          aria-label={t('Search projects')}
        />

        <Select value={portfolio} onValueChange={setPortfolio}>
          <SelectTrigger className="h-8 w-auto min-w-36 text-xs" aria-label={t('Filter by portfolio')}>
            <SelectValue placeholder={t('All portfolios')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('All portfolios')}</SelectItem>
            {portfolios.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-auto min-w-32 text-xs" aria-label={t('Filter by status')}>
            <SelectValue placeholder={t('All statuses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('All statuses')}</SelectItem>
            {ALL_PROJECT_STATUSES.map((key) => (
              <SelectItem key={key} value={key}>
                {PROJECT_STATUS_META[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ListToolbar>

      <QueryBoundary
        isLoading={projectsQuery.isLoading}
        isError={projectsQuery.isError}
        error={projectsQuery.error}
        onRetry={() => projectsQuery.refetch()}
        errorTitle={t('Unable to load projects')}
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <ProjectCardSkeleton key={index} />
            ))}
          </div>
        }
        isEmpty={projects.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={FolderKanban}
              title={t('No projects match those filters')}
              description={t('Try a different status or portfolio, or clear the search.')}
              action={{
                label: t('Clear filters'),
                onClick: () => {
                  setSearch('');
                  setStatus(ALL);
                  setPortfolio(ALL);
                },
              }}
            />
          </Card>
        }
      >
        {view === 'grid' ? (
          <div className="space-y-4">
            <motion.div
              initial="hidden"
              animate="show"
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
              className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
              {paged.items.map((project) => (
                <motion.div
                  key={project.id}
                  variants={{
                    hidden: { opacity: 0, y: 8 },
                    show: { opacity: 1, y: 0, transition: { duration: 0.26 } },
                  }}
                >
                  <ProjectHealthCard project={project} users={users} />
                </motion.div>
              ))}
            </motion.div>
            <Card className="px-1">
              <Pagination
                page={paged.page}
                pageSize={paged.pageSize}
                total={paged.total}
                onPageChange={paged.setPage}
                onPageSizeChange={paged.setPageSize}
                pageSizeOptions={[12, 24, 48]}
                itemLabel={t('project')}
                itemLabelPlural={t('projects')}
              />
            </Card>
          </div>
        ) : (
          <TableCard
            footer={
              <Pagination
                page={paged.page}
                pageSize={paged.pageSize}
                total={paged.total}
                onPageChange={paged.setPage}
                onPageSizeChange={paged.setPageSize}
                pageSizeOptions={[15, 25, 50]}
                itemLabel={t('project')}
                itemLabelPlural={t('projects')}
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Project')}</TableHead>
                  <TableHead>{t('Portfolio')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead>{t('Health')}</TableHead>
                  <TableHead numeric className="min-w-36">
                    {t('Progress')}
                  </TableHead>
                  <TableHead numeric>{t('Tasks')}</TableHead>
                  <TableHead>{t('Due')}</TableHead>
                  <TableHead>{t('Team')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.items.map((project) => (
                  <TableRow key={project.id} interactive>
                    <TableCell>
                      <Link
                        to={`/projects/${project.id}`}
                        className="flex items-center gap-2 font-medium text-foreground hover:text-primary"
                      >
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                          {project.identifier}
                        </span>
                        {project.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{project.portfolio}</TableCell>
                    <TableCell>
                      <ProjectStatusBadge status={project.status} size="sm" />
                    </TableCell>
                    <TableCell>
                      <HealthIndicator level={project.health.overall} />
                    </TableCell>
                    <TableCell numeric>
                      <div className="flex items-center justify-end gap-2">
                        <ProgressBar
                          value={project.progress}
                          size="xs"
                          tone={PROJECT_STATUS_META[project.status].tone}
                          label={t('{name} progress', { name: project.name })}
                          className="w-20"
                        />
                        <span className="text-muted-foreground">
                          {formatPercent(project.progress)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell numeric className="text-muted-foreground">
                      {formatNumber(project.completedTaskCount)}/{formatNumber(project.taskCount)}
                    </TableCell>
                    <TableCell className="font-mono text-2xs text-muted-foreground">
                      {formatShortDate(project.dueDate)}
                    </TableCell>
                    <TableCell>
                      <AvatarGroup
                        users={project.memberIds.map((id) => users.get(id))}
                        max={3}
                        size="xs"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        )}
      </QueryBoundary>

      <ProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
