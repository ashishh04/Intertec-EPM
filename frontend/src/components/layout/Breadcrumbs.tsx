import { Fragment } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useProject } from '@/hooks/useProjects';
import { useTask } from '@/hooks/useTasks';
import { useTeam } from '@/hooks/useTeams';
import { cn } from '@/lib/utils';

/** Human labels for static route segments. */
const SEGMENT_LABEL: Record<string, string> = {
  dashboard: 'Overview',
  'my-work': 'My Work',
  projects: 'Projects',
  tasks: 'Tasks',
  teams: 'Teams',
  calendar: 'Calendar',
  agile: 'Agile',
  sprints: 'Sprints',
  boards: 'Boards',
  gantt: 'Gantt',
  reports: 'Reports',
  analytics: 'Analytics',
  documents: 'Documents',
  notifications: 'Notifications',
  profile: 'Profile',
  settings: 'Settings',
  integration: 'Integration',
  board: 'Board',
  sprint: 'Sprint',
  team: 'Team',
  activity: 'Activity',
};

interface Crumb {
  label: string;
  to?: string;
}

/**
 * Route-derived breadcrumb trail, e.g. "Projects / AutoOps Platform / Board".
 * Entity names are resolved from the query cache, so no extra request is made
 * when the page has already loaded the record.
 */
export function Breadcrumbs({ className }: { className?: string }) {
  const location = useLocation();
  const params = useParams();

  const { data: project } = useProject(params.projectId);
  const { data: task } = useTask(params.taskId);
  const { data: team } = useTeam(params.teamId);

  const segments = location.pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [];
  let path = '';

  for (const segment of segments) {
    path += `/${segment}`;

    if (segment === params.projectId) {
      crumbs.push({ label: project?.name ?? 'Project', to: path });
      continue;
    }
    if (segment === params.taskId) {
      crumbs.push({ label: task?.key ?? 'Task', to: path });
      continue;
    }
    if (segment === params.teamId) {
      crumbs.push({ label: team?.name ?? 'Team', to: path });
      continue;
    }

    crumbs.push({ label: SEGMENT_LABEL[segment] ?? segment, to: path });
  }

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex items-center gap-1 text-xs">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.to}-${index}`}>
              <li className="min-w-0">
                {isLast || !crumb.to ? (
                  <span
                    aria-current="page"
                    className="block truncate font-medium text-foreground"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    to={crumb.to}
                    className="block truncate text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
              {!isLast ? (
                <li aria-hidden className="shrink-0">
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
