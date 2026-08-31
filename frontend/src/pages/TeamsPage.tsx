import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FolderKanban, Gauge, Users } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Pagination } from '@/components/common/Pagination';
import { EmptyState } from '@/components/common/EmptyState';
import { AvatarGroup, UserAvatar } from '@/components/common/UserAvatar';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useTeams } from '@/hooks/useTeams';
import { useProjects } from '@/hooks/useProjects';
import { useUserMap } from '@/hooks/useUsers';
import { usePagination } from '@/hooks/usePagination';
import { pluralize } from '@/lib/utils';
import type { ID, NexusProject } from '@/types';

/** Directory of delivery teams and their current load. */
export default function TeamsPage() {
  const teamsQuery = useTeams();
  const projectsQuery = useProjects();
  const users = useUserMap();

  const paged = usePagination(teamsQuery.data ?? [], { pageSize: 9 });

  const projectsById = useMemo(
    () => new Map<ID, NexusProject>((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Teams"
        description="Delivery teams, their people and the projects they own."
      />

      <QueryBoundary
        isLoading={teamsQuery.isLoading}
        isError={teamsQuery.isError}
        error={teamsQuery.error}
        onRetry={() => teamsQuery.refetch()}
        errorTitle="Unable to load teams"
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} className="h-52 rounded-xl" />
            ))}
          </div>
        }
        isEmpty={(teamsQuery.data?.length ?? 0) === 0}
        empty={
          <Card>
            <EmptyState icon={Users} title="No teams yet" description="Teams sync from the workspace directory." />
          </Card>
        }
      >
        <div className="space-y-4">
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {paged.items.map((team) => {
            const lead = users.get(team.leadId);
            const members = team.memberIds.map((id) => users.get(id));
            const teamProjects = team.projectIds
              .map((id) => projectsById.get(id))
              .filter(Boolean) as NexusProject[];

            return (
              <motion.div
                key={team.id}
                variants={{
                  hidden: { opacity: 0, y: 8 },
                  show: { opacity: 1, y: 0, transition: { duration: 0.26 } },
                }}
                whileHover={{ y: -2 }}
              >
                <Link
                  to={`/teams/${team.id}`}
                  className="flex h-full flex-col gap-3.5 rounded-xl border border-border bg-surface p-4 shadow-sm transition-all hover:border-primary/30 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <div>
                    <h2 className="text-sm font-semibold tracking-tight">{team.name}</h2>
                    <p className="mt-1 line-clamp-2 text-2xs text-muted-foreground">
                      {team.description}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 rounded-lg bg-muted/70 px-2.5 py-2">
                    <UserAvatar user={lead} size="sm" />
                    <div className="min-w-0">
                      <p className="nexus-eyebrow">Team lead</p>
                      <p className="truncate text-2xs font-medium">{lead?.name ?? 'Unassigned'}</p>
                    </div>
                    <AvatarGroup users={members} max={3} size="xs" className="ml-auto" />
                  </div>

                  <dl className="grid grid-cols-3 gap-2 text-2xs">
                    <div>
                      <dt className="flex items-center gap-1 text-muted-foreground">
                        <Users className="h-3 w-3" aria-hidden />
                        Members
                      </dt>
                      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
                        {team.memberIds.length}
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1 text-muted-foreground">
                        <FolderKanban className="h-3 w-3" aria-hidden />
                        Projects
                      </dt>
                      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
                        {teamProjects.length}
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1 text-muted-foreground">
                        <Gauge className="h-3 w-3" aria-hidden />
                        Capacity
                      </dt>
                      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
                        {team.capacity}%
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-auto space-y-1.5 border-t border-border pt-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-2xs text-muted-foreground">Sprint progress</span>
                      <span className="font-mono text-2xs font-medium tabular-nums">
                        {team.sprintProgress}%
                      </span>
                    </div>
                    <ProgressBar
                      value={team.sprintProgress}
                      size="sm"
                      tone={team.sprintProgress >= 70 ? 'success' : 'warning'}
                      label={`${team.name} sprint progress`}
                    />
                    <p className="text-2xs text-muted-foreground">
                      {teamProjects.length} active {pluralize(teamProjects.length, 'project')}
                    </p>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </motion.div>
        <Pagination
          page={paged.page}
          pageSize={paged.pageSize}
          total={paged.total}
          onPageChange={paged.setPage}
          onPageSizeChange={paged.setPageSize}
          pageSizeOptions={[9, 18, 36]}
          itemLabel="team"
          className="rounded-xl border border-border bg-surface"
        />
        </div>
      </QueryBoundary>
    </div>
  );
}
