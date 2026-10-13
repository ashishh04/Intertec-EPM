import { Fragment } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAccounts } from '@/hooks/useAccounts';
import { useProject } from '@/hooks/useProjects';
import { useTask } from '@/hooks/useTasks';
import { useTeam } from '@/hooks/useTeams';
import { usePortfolio } from '@/hooks/usePortfolios';
import { useDepartment } from '@/hooks/useDepartments';
import { usePortfolioView } from '@/hooks/usePortfolioViews';
import { cn } from '@/lib/utils';
import { findAdminArea, findAdminPage } from '@/config/administration';
import { t } from '@/lib/i18n';

/** Human labels for static route segments. */
const SEGMENT_LABEL: Record<string, string> = {
  get admin() { return t('Administration'); },
  get dashboard() { return t('Overview'); },
  get employees() { return t('Employees'); },
  get departments() { return t('Departments'); },
  get portfolios() { return t('Portfolios'); },
  get 'portfolio-views'() { return t('Portfolio views'); },
  get 'my-work'() { return t('My Work'); },
  get 'my-time'() { return t('My Time'); },
  get projects() { return t('Projects'); },
  get tasks() { return t('Tasks'); },
  get teams() { return t('Teams'); },
  get calendar() { return t('Calendar'); },
  get agile() { return t('Agile'); },
  get sprints() { return t('Sprints'); },
  get boards() { return t('Boards'); },
  get gantt() { return t('Gantt'); },
  get resources() { return t('Resources'); },
  get timesheets() { return t('Timesheets'); },
  get expenses() { return t('Expense claims'); },
  get finance() { return t('Finance'); },
  get reports() { return t('Reports'); },
  get scheduled() { return t('Scheduled reports'); },
  get analytics() { return t('Analytics'); },
  get insights() { return t('Dashboards'); },
  get 'portfolio-health'() { return t('Portfolio health'); },
  get delivery() { return t('Delivery'); },
  get utilisation() { return t('Utilisation'); },
  get budget() { return t('Budget'); },
  get 'earned-value'() { return t('Earned value'); },
  get risk() { return t('Risk exposure'); },
  get documents() { return t('Documents'); },
  get notifications() { return t('Notifications'); },
  get approvals() { return t('Approvals'); },
  get journal() { return t('Audit journal'); },
  get 'time-and-costs'() { return t('Time & Costs'); },
  get decide() { return t('Decision'); },
  get profile() { return t('Profile'); },
  get settings() { return t('Settings'); },
  get integration() { return t('Integration'); },
  get board() { return t('Board'); },
  get sprint() { return t('Sprint'); },
  get team() { return t('Team'); },
  get activity() { return t('Activity'); },
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
  const { data: portfolio } = usePortfolio(params.portfolioId);
  const { data: department } = useDepartment(params.departmentId);
  const { data: view } = usePortfolioView(params.viewId);
  // A person's profile in Administration → Users is addressed by id; the
  // account list the page has already loaded names them.
  const onUserProfile = params.areaId === 'users' && params.pageId === 'users' && Boolean(params.itemId);
  const { data: accounts } = useAccounts(onUserProfile);

  const segments = location.pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [];
  let path = '';

  for (const [index, segment] of segments.entries()) {
    path += `/${segment}`;

    if (segment === params.projectId) {
      crumbs.push({ label: project?.name ?? t('Project'), to: path });
      continue;
    }
    if (segment === params.taskId) {
      crumbs.push({ label: task?.key ?? t('Task'), to: path });
      continue;
    }
    if (segment === params.teamId) {
      crumbs.push({ label: team?.name ?? t('Team'), to: path });
      continue;
    }
    if (segment === params.portfolioId) {
      crumbs.push({ label: portfolio?.name ?? t('Portfolio'), to: path });
      continue;
    }
    if (segment === params.departmentId) {
      crumbs.push({ label: department?.name ?? t('Department'), to: path });
      continue;
    }
    if (segment === params.viewId) {
      crumbs.push({ label: view?.name ?? t('View'), to: path });
      continue;
    }

    if (onUserProfile && index === 3 && segment === params.itemId) {
      crumbs.push({ label: accounts?.find((account) => account.id === segment)?.name ?? t('User'), to: path });
      continue;
    }

    // An approval link's token is a credential, not a place: never shown.
    if (segments[0] === 'approvals' && segments[1] === 'decide' && index === 2) continue;

    // Administration routes carry area and page ids; their labels live in the
    // administration config rather than in the static table above.
    if (segments[0] === 'admin' && crumbs.length > 0) {
      const area = findAdminArea(segments[1]);
      if (area && index === 1) {
        crumbs.push({ label: area.label, to: path });
        continue;
      }
      const page = area && index === 2 ? findAdminPage(area, segment) : undefined;
      if (page) {
        crumbs.push({ label: page.label, to: path });
        continue;
      }
    }

    crumbs.push({ label: SEGMENT_LABEL[segment] ?? segment, to: path });
  }

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label={t('Breadcrumb')} className={cn('min-w-0', className)}>
      <ol className="flex items-center gap-1 text-xs">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.to}-${index}`}>
              <li className="min-w-0">
                {isLast || !crumb.to ? (
                  <span
                    aria-current="page"
                    dir="auto"
                    className="block truncate font-medium text-foreground"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    to={crumb.to}
                    dir="auto"
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
