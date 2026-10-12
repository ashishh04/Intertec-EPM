import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, FolderKanban, ListChecks, Pencil, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { FactList } from '@/components/common/FactList';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { TaskListSkeleton, TaskRow } from '@/components/tasks/TaskRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAccounts } from '@/hooks/useAccounts';
import { useAdminInvitations, useAdminUserLogins, useAdminUserProjects } from '@/hooks/useAdmin';
import { useEmployee } from '@/hooks/useEmployees';
import { useProjects } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useUserMap } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatDateTime, formatLongDate, formatNumber } from '@/lib/utils';
import { adminService } from '@/services';
import { writableFields, type FormResult, type SchemaField } from '@/services/api/forms';
import type { EpmProject, ID } from '@/types';
import {
  AccountActionsMenu,
  InvitationNote,
  STATUS_LABEL,
  STATUS_TONE,
  useAccountActions,
} from './shared-accounts';

/**
 * One person, as an administrator sees them: who they are, where they sit,
 * what they are known by, the projects they belong to and the work assigned to
 * them — with the same actions the Users list offers.
 *
 * Opened from a name or an email in the list. The address is shown as text with
 * a copy button rather than as a mail link, so reading someone's profile never
 * starts a mail program.
 */
export function UserProfile({ id }: { id: ID }) {
  const navigate = useNavigate();
  const accounts = useAccounts(true);
  const users = useUserMap();
  const actions = useAccountActions({ onRemoved: () => navigate('/admin/users/users') });

  const account = accounts.data?.find((candidate) => candidate.id === id);

  return (
    <div className="space-y-4">
      <Link
        to="/admin/users/users"
        className="inline-flex items-center gap-1.5 rounded-lg text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-3 w-3 rtl:rotate-180" aria-hidden />
        {t('All users')}
      </Link>

      <QueryBoundary
        isLoading={accounts.isLoading}
        isError={accounts.isError}
        error={accounts.error}
        onRetry={() => accounts.refetch()}
        errorTitle={t('Unable to load users')}
        skeleton={<ListSkeleton rows={4} height="h-24" />}
        isEmpty={!account}
        empty={
          <EmptyState
            icon={UserRound}
            title={t('This user could not be found')}
            description={t('They may have been deleted. Go back to the list to find someone else.')}
          />
        }
      >
        {account ? (
          <>
            <Card>
              <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
                <UserAvatar
                  user={users.get(account.id) ?? { name: account.name, initials: initialsOf(account.name), accent: 'slate', status: 'offline' }}
                  size="xl"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 dir="auto" className="truncate text-lg font-semibold tracking-tight">{account.name}</h2>
                    <Badge tone={STATUS_TONE[account.status]} size="sm">{STATUS_LABEL[account.status]}</Badge>
                    {account.admin ? <Badge tone="primary" size="sm">{t('Administrator')}</Badge> : null}
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-muted-foreground">{account.login}</p>
                  {account.email ? <CopyableEmail email={account.email} /> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {account.can.update ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => actions.openEdit(account)}>
                        <Pencil className="h-3.5 w-3.5" />
                        {t('Edit')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => actions.openAttributes(account)}>
                        <ListChecks className="h-3.5 w-3.5" />
                        {t('Attributes')}
                      </Button>
                    </>
                  ) : null}
                  <AccountActionsMenu account={account} actions={actions} include="more" />
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <AccountCard id={account.id} createdAt={account.createdAt} language={account.language} />
              <OrganisationCard id={account.id} />
              <AttributesCard id={account.id} />
              <ProjectsCard id={account.id} />
            </div>

            <AssignedWorkCard id={account.id} />
          </>
        ) : null}
      </QueryBoundary>

      {actions.dialogs}
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}

/** The address as text, with a copy button: reading a profile never opens a mail program. */
function CopyableEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () =>
    navigator.clipboard
      .writeText(email)
      .then(() => {
        setCopied(true);
        toast.success(t('Email address copied'));
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast.error(t('The address could not be copied. Select it and copy it manually.')));

  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate">{email}</span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="h-6 w-6"
        onClick={copy}
        aria-label={t('Copy email address')}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </p>
  );
}

function AccountCard({ id, createdAt, language }: { id: ID; createdAt: string; language?: string }) {
  const logins = useAdminUserLogins();
  const invitations = useAdminInvitations();

  const lastLogin = logins.data?.find((login) => login.id === id)?.lastLoginAt;
  const invitation = invitations.data?.find((candidate) => candidate.id === id);

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Account')}</CardTitle>
        <CardDescription>{t('Sign-in and history.')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <FactList
          facts={[
            { label: t('Created on'), value: formatLongDate(createdAt), mono: false },
            {
              label: t('Last login'),
              value: logins.isError ? t('Not available') : lastLogin ? formatDateTime(lastLogin) : logins.data ? t('Never') : '…',
              mono: false,
            },
            { label: t('Language'), value: language ? language.toUpperCase() : t('Not set'), mono: false },
            {
              label: t('Invitation'),
              value: invitation && invitation.status !== 'cancelled' ? (
                <span className="inline-flex flex-col items-end gap-0.5">
                  <InvitationNote invitation={invitation} history />
                  {invitation.status === 'failed' && invitation.error ? (
                    <span className="max-w-xs text-2xs text-muted-foreground" dir="auto">{invitation.error}</span>
                  ) : null}
                </span>
              ) : (
                t('None sent')
              ),
              mono: false,
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function OrganisationCard({ id }: { id: ID }) {
  const employee = useEmployee(id);
  const data = employee.data;

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Organisation')}</CardTitle>
        <CardDescription>{t('Where they sit, and the hours they work.')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary
          isLoading={employee.isLoading}
          isError={employee.isError}
          error={employee.error}
          onRetry={() => employee.refetch()}
          errorTitle={t('Unable to load this person’s placement')}
          skeleton={<ListSkeleton rows={3} height="h-8" />}
        >
          <FactList
            facts={[
              { label: t('Department'), value: data?.department?.name ?? t('No department'), mono: false },
              { label: t('Team'), value: data?.team?.name ?? t('No team'), mono: false },
              {
                label: t('Weekly capacity'),
                value: data ? t('{hours, number} hours', { hours: data.hoursCapacity }) : '…',
                mono: false,
              },
            ]}
          />
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

/** A value as the form holds it, in words: options by their names, flags as Yes or No. */
function describeValue(field: SchemaField, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    const names = value.map((item) => describeValue(field, item)).filter((name) => name !== '—');
    return names.length ? names.join(', ') : '—';
  }
  if (typeof value === 'boolean') return value ? t('Yes') : t('No');
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'object') {
    const record = value as { title?: unknown; raw?: unknown; href?: unknown };
    if (typeof record.title === 'string' && record.title) return record.title;
    if (typeof record.raw === 'string') return record.raw || '—';
    return '—';
  }
  if (field.type === 'Date' && typeof value === 'string') return formatLongDate(value);
  return String(value);
}

function AttributesCard({ id }: { id: ID }) {
  const form = useQuery({
    queryKey: ['admin', 'users', id, 'attributes'],
    queryFn: () => adminService.userAttributesForm(id, {}),
    staleTime: 30_000,
  });

  const values = useMemo(() => attributeValues(form.data), [form.data]);

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Attributes')}</CardTitle>
        <CardDescription>{t('The user attributes defined for everyone, with this person’s values.')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary
          isLoading={form.isLoading}
          isError={form.isError}
          error={form.error}
          onRetry={() => form.refetch()}
          errorTitle={t('Unable to load the attributes')}
          skeleton={<ListSkeleton rows={3} height="h-8" />}
          isEmpty={values.length === 0}
          empty={
            <p className="text-xs text-muted-foreground">
              {t('No user attributes are defined yet.')}{' '}
              <Link to="/admin/users/user-attributes" className="text-primary underline-offset-4 hover:underline">
                {t('Define user attributes')}
              </Link>
            </p>
          }
        >
          <FactList facts={values.map(({ name, value }) => ({ label: name, value, mono: false }))} />
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function attributeValues(form?: FormResult): { name: string; value: string }[] {
  if (!form) return [];
  const links = (form.payload._links ?? {}) as Record<string, unknown>;
  return writableFields(form.schema).map(([key, field]) => ({
    name: field.name,
    value: describeValue(field, form.payload[key] ?? links[key]),
  }));
}

function ProjectsCard({ id }: { id: ID }) {
  const projects = useAdminUserProjects(id);

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Projects')}</CardTitle>
        <CardDescription>{t('The projects they belong to, and their roles there.')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary
          isLoading={projects.isLoading}
          isError={projects.isError}
          error={projects.error}
          onRetry={() => projects.refetch()}
          errorTitle={t('Unable to load projects')}
          skeleton={<ListSkeleton rows={3} height="h-8" />}
          isEmpty={(projects.data ?? []).length === 0}
          empty={<p className="text-xs text-muted-foreground">{t('Not a member of any project.')}</p>}
        >
          <ul className="divide-y divide-border">
            {(projects.data ?? []).map((project) => (
              <li key={project.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <Link
                  to={`/projects/${project.id}`}
                  className="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-foreground hover:text-primary"
                >
                  <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate" dir="auto">{project.name}</span>
                </Link>
                <span className="shrink-0 text-2xs text-muted-foreground" dir="auto">
                  {project.roles.join(', ') || '—'}
                </span>
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function AssignedWorkCard({ id }: { id: ID }) {
  const tasks = useTasks({ assigneeId: id, pageSize: 10, sortBy: 'dueDate' });
  const projects = useProjects();
  const users = useUserMap();

  const projectsById = useMemo(
    () => new Map<ID, EpmProject>((projects.data ?? []).map((project) => [project.id, project])),
    [projects.data],
  );
  const total = tasks.data?.total ?? 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader variant="compact">
        <CardTitle>
          {t('Assigned work')}
          {total > 0 ? <span className="ms-1.5 font-mono text-2xs text-muted-foreground">{formatNumber(total)}</span> : null}
        </CardTitle>
        <CardDescription>{t('Open work assigned to them, soonest due first.')}</CardDescription>
      </CardHeader>
      <QueryBoundary
        isLoading={tasks.isLoading}
        isError={tasks.isError}
        error={tasks.error}
        onRetry={() => tasks.refetch()}
        errorTitle={t('Unable to load their work')}
        skeleton={<TaskListSkeleton rows={4} />}
        isEmpty={(tasks.data?.items.length ?? 0) === 0}
        empty={<EmptyState size="inline" title={t('No assigned work')} />}
      >
        <div className="divide-y divide-border">
          {(tasks.data?.items ?? []).map((task) => (
            <TaskRow key={task.id} task={task} project={projectsById.get(task.projectId)} assignee={users.get(id)} />
          ))}
        </div>
      </QueryBoundary>
    </Card>
  );
}

