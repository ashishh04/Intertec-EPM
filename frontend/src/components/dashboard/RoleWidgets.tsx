import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDays } from 'date-fns';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  ClipboardCheck,
  FolderKanban,
  Plug,
  Receipt,
  ScrollText,
  UserPlus,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { MetricCard, MetricCardSkeleton } from '@/components/common/MetricCard';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TaskListSkeleton } from '@/components/tasks/TaskRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAccounts } from '@/hooks/useAccounts';
import { useApprovalInbox, useApprovalInboxCount } from '@/hooks/useApprovals';
import { useDashboardMetrics } from '@/hooks/useDashboard';
import { useEmployees } from '@/hooks/useEmployees';
import { useJournal } from '@/hooks/useGovernance';
import { useIntegrationStatus } from '@/hooks/useIntegration';
import { useOverAllocations } from '@/hooks/useResources';
import { useClaims, useTimesheetOverview } from '@/hooks/useTimesheets';
import { CONNECTION_STATE_META } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { formatCurrency, formatHours, formatRelative, formatShortDate, toISODateOnly } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { ExpenseClaimStatus } from '@/types';

/**
 * The Overview widgets that belong to a role rather than to anyone's own work:
 * what a manager, HR or an administrator starts the day from. Each reads an
 * endpoint its page already uses, so it shows what that page would, and the
 * catalogue offers it only to people allowed to read it (widgets.tsx).
 */

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

/** A day in last week: the week people should have submitted by now. */
const lastWeekDay = () => toISODateOnly(addDays(new Date(), -7));

function WidgetCard({
  title,
  description,
  link,
  linkLabel,
  children,
}: {
  title: string;
  description: string;
  link: string;
  linkLabel: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader
        variant="compact"
        actions={
          <Button asChild variant="ghost" size="sm" className="text-2xs">
            <Link to={link}>
              {linkLabel}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-2xs">{description}</CardDescription>
      </CardHeader>
      <div className="flex-1">{children}</div>
    </Card>
  );
}

function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

function KpiSkeleton() {
  return (
    <KpiGrid>
      {[0, 1, 2, 3].map((index) => (
        <MetricCardSkeleton key={index} />
      ))}
    </KpiGrid>
  );
}

/** As the Expenses page names a claim's state. */
const CLAIM_STATE: Record<ExpenseClaimStatus, { label: () => string; tone: 'neutral' | 'primary' | 'success' | 'highlight' }> = {
  draft: { label: () => t('Draft'), tone: 'neutral' },
  submitted: { label: () => t('Submitted'), tone: 'primary' },
  approved: { label: () => t('Approved, not yet posted'), tone: 'highlight' },
  posted: { label: () => t('Posted to the project'), tone: 'success' },
};

/* -------------------------------------------------------------------------- */
/* Key figures, by role                                                       */
/* -------------------------------------------------------------------------- */

/** The four figures a role starts from; an employee's are their own work (widgets.tsx). */
export function RoleKpis({ role }: { role: 'manager' | 'hr' | 'admin' }) {
  if (role === 'manager') return <ManagerKpis />;
  if (role === 'hr') return <HrKpis />;
  return <AdminKpis />;
}

/** Projects and the people on them: what is at risk, waiting, over capacity and late. */
function ManagerKpis() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const metrics = useDashboardMetrics();
  const waiting = useApprovalInboxCount();
  const planner = can('resources:plan');
  const over = useOverAllocations({ weeks: 4 }, planner);
  const overPeople = useMemo(() => new Set((over.data ?? []).map((row) => row.key)).size, [over.data]);

  if (metrics.isLoading || !metrics.data) return <KpiSkeleton />;
  const m = metrics.data;

  return (
    <KpiGrid>
      <MetricCard
        label={t('Active Projects')}
        value={m.activeProjects}
        support={t('{count, plural, one {# project at risk} other {# projects at risk}}', { count: m.projectsAtRisk })}
        icon={FolderKanban}
        tone="highlight"
        trend={m.trends.activeProjects}
        onClick={() => navigate('/projects')}
      />
      <MetricCard
        label={t('Waiting for your approval')}
        value={waiting}
        support={t('Timesheets, expense claims and changes')}
        icon={ClipboardCheck}
        tone="primary"
        onClick={() => navigate('/approvals')}
      />
      {planner ? (
        <MetricCard
          label={t('Over-allocated')}
          value={overPeople}
          support={t('People over capacity in the next four weeks')}
          icon={UsersRound}
          tone="warning"
          onClick={() => navigate('/resources')}
        />
      ) : (
        <MetricCard
          label={t('In Progress')}
          value={m.inProgress}
          support={m.inProgressBlocked > 0 ? t('{count, number} blocked', { count: m.inProgressBlocked }) : t('Nothing blocked')}
          icon={ClipboardCheck}
          tone="accent"
          onClick={() => navigate('/tasks?status=in_progress')}
        />
      )}
      <MetricCard
        label={t('Overdue')}
        value={m.overdue}
        support={m.overdueCritical > 0 ? t('{count, number} critical', { count: m.overdueCritical }) : t('No critical items')}
        icon={AlertTriangle}
        tone="danger"
        trend={m.trends.overdue}
        onClick={() => navigate('/my-work?bucket=overdue')}
      />
    </KpiGrid>
  );
}

/** The organisation and its people: who is here, and last week's timesheets. */
function HrKpis() {
  const navigate = useNavigate();
  const people = useEmployees();
  const waiting = useApprovalInboxCount();
  const week = useTimesheetOverview({ day: lastWeekDay() });

  if (people.isLoading || week.isLoading) return <KpiSkeleton />;
  const counts = week.data?.counts;

  return (
    <KpiGrid>
      <MetricCard
        label={t('People')}
        value={people.data?.length ?? '—'}
        support={t('In the directory')}
        icon={Users}
        tone="highlight"
        onClick={() => navigate('/employees')}
      />
      <MetricCard
        label={t('Outstanding')}
        value={counts?.outstanding ?? '—'}
        support={t("Last week's timesheets not yet submitted")}
        icon={AlertTriangle}
        tone="danger"
        onClick={() => navigate('/timesheets')}
      />
      <MetricCard
        label={t('Submitted')}
        value={counts?.submitted ?? '—'}
        support={t("Last week's timesheets waiting for approval")}
        icon={CalendarCheck}
        tone="accent"
        onClick={() => navigate('/timesheets')}
      />
      <MetricCard
        label={t('Waiting for your approval')}
        value={waiting}
        support={t('Timesheets, expense claims and changes')}
        icon={ClipboardCheck}
        tone="primary"
        onClick={() => navigate('/approvals')}
      />
    </KpiGrid>
  );
}

/** The workspace itself: who has access, what is waiting, and the connection behind it. */
function AdminKpis() {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const metrics = useDashboardMetrics();
  const integration = useIntegrationStatus();
  const waiting = useApprovalInboxCount();

  if (accounts.isLoading || metrics.isLoading) return <KpiSkeleton />;
  const list = accounts.data ?? [];
  const active = list.filter((account) => account.status === 'active').length;
  const invited = list.filter((account) => account.status === 'invited').length;
  const state = integration.data?.state;

  return (
    <KpiGrid>
      <MetricCard
        label={t('Active people')}
        value={accounts.data ? active : '—'}
        support={t('{count, plural, one {# invitation waiting} other {# invitations waiting}}', { count: invited })}
        icon={Users}
        tone="highlight"
        onClick={() => navigate('/admin/users/users')}
      />
      <MetricCard
        label={t('Active Projects')}
        value={metrics.data?.activeProjects ?? '—'}
        support={t('{count, plural, one {# project at risk} other {# projects at risk}}', { count: metrics.data?.projectsAtRisk ?? 0 })}
        icon={FolderKanban}
        tone="accent"
        onClick={() => navigate('/projects')}
      />
      <MetricCard
        label={t('Waiting for your approval')}
        value={waiting}
        support={t('Timesheets, expense claims and changes')}
        icon={ClipboardCheck}
        tone="primary"
        onClick={() => navigate('/approvals')}
      />
      <MetricCard
        label={t('Connection')}
        value={state ? CONNECTION_STATE_META[state].label : '—'}
        support={integration.data ? t('Last synchronised {when}', { when: formatRelative(integration.data.lastSyncAt) }) : t('Checking…')}
        icon={Plug}
        tone={state ? CONNECTION_STATE_META[state].tone : 'neutral'}
        onClick={() => navigate('/settings/integration')}
      />
    </KpiGrid>
  );
}

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

/** What waits on the person: anyone can be an approver, whatever their role. */
export function ApprovalsWidget() {
  const query = useApprovalInbox();
  const items = (query.data ?? []).slice(0, 6);

  return (
    <WidgetCard
      title={t('Waiting for your approval')}
      description={t('Timesheets, expense claims and changes that need your decision')}
      link="/approvals"
      linkLabel={t('Approvals')}
    >
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load approvals')}
        skeleton={<TaskListSkeleton rows={4} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            size="inline"
            icon={ClipboardCheck}
            title={t('Nothing is waiting for you')}
            description={t('Requests that need your decision appear here.')}
          />
        }
      >
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <Link to={item.link} className="block truncate text-xs font-medium hover:underline" dir="auto">
                  {item.title}
                </Link>
                <p className="truncate text-2xs text-muted-foreground" dir="auto">
                  {item.chainName}
                  {item.projectName ? ` · ${item.projectName}` : ''} · {formatRelative(item.requestedAt)}
                </p>
              </div>
              {item.valueLabel ? (
                <Badge tone="neutral" size="sm">
                  {item.valueLabel}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </QueryBoundary>
    </WidgetCard>
  );
}

/**
 * Last week's timesheets for the people the reader looks after: everyone for
 * whoever manages timesheets, a lead's team, a department manager's department.
 */
export function TeamTimesheetsWidget() {
  const query = useTimesheetOverview({ day: lastWeekDay() });
  const data = query.data;
  const chase = (data?.rows ?? []).filter((row) => row.outstanding || row.rejected).slice(0, 6);
  const counts = data?.counts;

  return (
    <WidgetCard
      title={t("Last week's timesheets")}
      description={data ? t('Week of {date}', { date: formatShortDate(data.periodStart) }) : t('Who has submitted, and who has not')}
      link="/timesheets"
      linkLabel={t('Timesheets')}
    >
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load timesheets')}
        skeleton={<TaskListSkeleton rows={4} />}
      >
        {counts ? (
          <dl className="grid grid-cols-4 gap-2 border-b border-border px-4 py-3 text-center">
            {[
              { label: t('Submitted'), value: counts.submitted },
              { label: t('Approved'), value: counts.approved },
              { label: t('Outstanding'), value: counts.outstanding },
              { label: t('Rejected'), value: counts.rejected },
            ].map((stat) => (
              <div key={stat.label} className="min-w-0">
                <dt className="truncate text-2xs text-muted-foreground">{stat.label}</dt>
                <dd className="font-mono text-sm font-semibold tabular-nums">{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {chase.length === 0 ? (
          <EmptyState
            size="inline"
            icon={CalendarCheck}
            title={t('Everyone has submitted')}
            description={t('Nothing is outstanding for last week.')}
          />
        ) : (
          <ul className="divide-y divide-border">
            {chase.map((row) => (
              <li key={row.personId} className="flex items-center gap-3 px-4 py-2.5">
                <Link
                  to={row.timesheetId ? `/timesheets/${row.timesheetId}` : `/timesheets/people/${row.personId}?day=${data!.periodStart}`}
                  className="min-w-0 flex-1 truncate text-xs hover:underline"
                  dir="auto"
                >
                  {row.personName}
                </Link>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {formatHours(row.hours)} / {formatHours(row.available)}
                </span>
                <Badge tone="danger" size="sm">
                  {row.rejected ? t('Rejected') : t('Outstanding')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </WidgetCard>
  );
}

/** People planned beyond their capacity soon: the levelling a manager has to do. */
export function OverAllocatedWidget() {
  const query = useOverAllocations({ weeks: 4 });
  const people = useMemo(() => {
    const byPerson = new Map<string, { key: string; name: string; weeks: number; worst: number }>();
    for (const row of query.data ?? []) {
      const seen = byPerson.get(row.key) ?? { key: row.key, name: row.name, weeks: 0, worst: 0 };
      seen.weeks += 1;
      seen.worst = Math.max(seen.worst, row.excess);
      byPerson.set(row.key, seen);
    }
    return [...byPerson.values()].sort((a, b) => b.worst - a.worst).slice(0, 6);
  }, [query.data]);

  return (
    <WidgetCard
      title={t('Over-allocated')}
      description={t('People planned beyond their capacity in the next four weeks')}
      link="/resources"
      linkLabel={t('Resources')}
    >
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load capacity')}
        skeleton={<TaskListSkeleton rows={4} />}
        isEmpty={people.length === 0}
        empty={
          <EmptyState
            size="inline"
            icon={UsersRound}
            title={t('Nobody is over-allocated')}
            description={t('Everyone fits their capacity for the next four weeks.')}
          />
        }
      >
        <ul className="divide-y divide-border">
          {people.map((person) => (
            <li key={person.key} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-xs" dir="auto">
                {person.name}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {t('{count, plural, one {# week over} other {# weeks over}}', { count: person.weeks })}
              </span>
              <Badge tone="danger" size="sm">
                +{formatHours(person.worst)}
              </Badge>
            </li>
          ))}
        </ul>
      </QueryBoundary>
    </WidgetCard>
  );
}

/** The person's own claims and where each one stands. */
export function MyClaimsWidget() {
  const query = useClaims({ scope: 'mine' });
  const claims = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => (a.spentOn < b.spentOn ? 1 : a.spentOn > b.spentOn ? -1 : 0)).slice(0, 5),
    [query.data],
  );

  return (
    <WidgetCard
      title={t('My expense claims')}
      description={t('Your recent claims and where each one stands')}
      link="/expenses"
      linkLabel={t('Expenses')}
    >
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load expense claims')}
        skeleton={<TaskListSkeleton rows={4} />}
        isEmpty={claims.length === 0}
        empty={
          <EmptyState
            size="inline"
            icon={Receipt}
            title={t('No expense claims')}
            description={t('Claims you make appear here with where each one stands.')}
          />
        }
      >
        <ul className="divide-y divide-border">
          {claims.map((claim) => (
            <li key={claim.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <Link to={`/expenses/${claim.id}`} className="block truncate text-xs font-medium hover:underline" dir="auto">
                  {claim.description || claim.categoryName}
                </Link>
                <p className="truncate text-2xs text-muted-foreground" dir="auto">
                  {claim.categoryName} · {formatShortDate(claim.spentOn)}
                </p>
              </div>
              <span className="shrink-0 font-mono text-2xs">{formatCurrency(claim.amount, claim.currency, 2)}</span>
              <Badge tone={CLAIM_STATE[claim.status].tone} size="sm">
                {CLAIM_STATE[claim.status].label()}
              </Badge>
            </li>
          ))}
        </ul>
      </QueryBoundary>
    </WidgetCard>
  );
}

/** Who has access and what needs an administrator's hand, with the connection behind EPM. */
export function WorkspaceWidget() {
  const accounts = useAccounts();
  const integration = useIntegrationStatus();
  const list = accounts.data ?? [];
  const state = integration.data?.state;

  const rows: { label: string; value: ReactNode; to: string; icon: LucideIcon }[] = [
    { label: t('Active people'), value: list.filter((a) => a.status === 'active').length, to: '/admin/users/users', icon: Users },
    { label: t('Invitations not yet accepted'), value: list.filter((a) => a.status === 'invited').length, to: '/admin/users/users', icon: UserPlus },
    { label: t('Locked accounts'), value: list.filter((a) => a.status === 'locked').length, to: '/admin/users/users', icon: AlertTriangle },
    {
      label: t('Connection'),
      value: state ? (
        <Badge tone={CONNECTION_STATE_META[state].tone} size="sm">
          {CONNECTION_STATE_META[state].label}
        </Badge>
      ) : (
        '—'
      ),
      to: '/settings/integration',
      icon: Plug,
    },
  ];

  return (
    <WidgetCard
      title={t('Workspace')}
      description={t('People with access, invitations waiting and the connection behind EPM')}
      link="/admin"
      linkLabel={t('Administration')}
    >
      <QueryBoundary
        isLoading={accounts.isLoading}
        isError={accounts.isError}
        error={accounts.error}
        onRetry={() => accounts.refetch()}
        errorTitle={t('Unable to load accounts')}
        skeleton={<TaskListSkeleton rows={4} />}
      >
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.label}>
              <Link to={row.to} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted">
                <row.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs">{row.label}</span>
                <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">{row.value}</span>
              </Link>
            </li>
          ))}
        </ul>
        {integration.data ? (
          <p className="border-t border-border px-4 py-2 text-2xs text-muted-foreground">
            {t('Last synchronised {when}', { when: formatRelative(integration.data.lastSyncAt) })}
          </p>
        ) : null}
      </QueryBoundary>
    </WidgetCard>
  );
}

/** The latest entries in the audit journal, as the Audit journal page words them. */
export function RecentChangesWidget() {
  const query = useJournal({ pageSize: 6 });
  const items = query.data?.items ?? [];

  return (
    <WidgetCard
      title={t('Recent changes')}
      description={t('The latest entries in the audit journal')}
      link="/journal"
      linkLabel={t('Audit journal')}
    >
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
        errorTitle={t('Unable to load the audit journal')}
        skeleton={<TaskListSkeleton rows={4} />}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            size="inline"
            icon={ScrollText}
            title={t('Nothing journalled yet')}
            description={t('Changes to people, access and settings are recorded here.')}
          />
        }
      >
        <ul className="divide-y divide-border">
          {items.map((entry) => (
            <li key={entry.id} className="px-4 py-2.5">
              <p className="line-clamp-2 text-xs" dir="auto">
                {entry.summary}
              </p>
              <p className="mt-0.5 truncate text-2xs text-muted-foreground" dir="auto">
                {entry.actorName ?? t('EPM')} · {formatRelative(entry.occurredAt)}
              </p>
            </li>
          ))}
        </ul>
      </QueryBoundary>
    </WidgetCard>
  );
}
