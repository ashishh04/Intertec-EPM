import { Fragment, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, Check, UserCog, Users } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAppRoles, useSetAppRole } from '@/hooks/useGovernance';
import { usePagination } from '@/hooks/usePagination';
import { t } from '@/lib/i18n';
import type { AppRole, AppRoleAssignment, AppRoleDefinition, AppRoles } from '@/types';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable } from './shared-tables';

type AssignableRole = Exclude<AppRole, 'admin'>;

/** Where an external person's projects, and their client or vendor role on each, are given. */
const EXTERNAL_USERS_PATH = '/admin/users/external-access';

/**
 * The comparison's rows, by what they are about. A permission the list does not
 * name yet still shows, under Other, so a new one is never silently left out.
 */
const PERMISSION_GROUPS: { title: () => string; keys: readonly string[] }[] = [
  { title: () => t('People and organisation'), keys: ['departments:manage', 'teams:manage', 'employees:manage', 'rates:view'] },
  { title: () => t('Portfolios, programs and requests'), keys: ['portfolios:manage', 'programs:manage', 'requests:review', 'scenarios:manage'] },
  { title: () => t('Delivery'), keys: ['health:manage', 'resources:plan'] },
  { title: () => t('Time and expenses'), keys: ['timesheets:view', 'timesheets:manage', 'expenses:manage'] },
  { title: () => t('Money'), keys: ['finance:view', 'finance:manage'] },
  { title: () => t('Reports and audit'), keys: ['reports:schedule', 'reports:approve', 'analytics:manage', 'audit:view'] },
  {
    title: () => t('Rules and set-up'),
    keys: ['health:configure', 'approvals:configure', 'rules:configure', 'evm:configure', 'fields:configure', 'resources:configure', 'time:configure', 'finance:configure'],
  },
];

interface PermissionRow {
  key: string;
  label: string;
  description?: string;
}

/**
 * The permissions grouped for the comparison. From the server's catalogue, by
 * key; from the roles' own labels when an older server sends no catalogue.
 */
function permissionGroups(data: AppRoles | undefined): { title: string; rows: PermissionRow[] }[] {
  const catalogue: PermissionRow[] = data?.permissionCatalogue
    ? data.permissionCatalogue.map((entry) => ({ key: entry.permission, label: entry.label, description: entry.description }))
    : [...new Set((data?.catalogue ?? []).flatMap((entry) => entry.permissions))].map((label) => ({ key: label, label }));
  const byKey = new Map(catalogue.map((row) => [row.key, row]));
  const placed = new Set<string>();
  const groups = PERMISSION_GROUPS.map((group) => ({
    title: group.title(),
    rows: group.keys.flatMap((key) => {
      const row = byKey.get(key);
      if (!row) return [];
      placed.add(key);
      return [row];
    }),
  })).filter((group) => group.rows.length > 0);
  const rest = catalogue.filter((row) => !placed.has(row.key));
  return rest.length > 0 ? [...groups, { title: t('Other'), rows: rest }] : groups;
}

/** Whether a role brings a permission. Administrators hold every one. */
function holds(entry: AppRoleDefinition, row: PermissionRow): boolean {
  if (entry.role === 'admin') return true;
  return entry.permissionKeys ? entry.permissionKeys.includes(row.key) : entry.permissions.includes(row.label);
}

/**
 * Access roles: the role each person works in — BU Head, Portfolio, Program,
 * Project or Delivery Manager, Manager, Employee, or External (a client or
 * vendor). The role picks their sidebar and Overview, and brings a bundle of
 * EPM permissions, compared side by side here. An external person sees only the
 * portal; which projects, and as a client or a vendor on each, is set on the
 * External users page. Administrators are the instance's administrator
 * accounts, listed but not changed here.
 */
export default function AppRolesPage() {
  const roles = useAppRoles();
  const setRole = useSetAppRole();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AppRole | 'all'>('all');
  const peopleSection = useRef<HTMLDivElement>(null);

  const catalogue = useMemo(() => roles.data?.catalogue ?? [], [roles.data?.catalogue]);
  const labelOf = useMemo(() => new Map(catalogue.map((entry) => [entry.role, entry.label])), [catalogue]);
  const peopleIn = useMemo(() => {
    const counts = new Map<AppRole, number>();
    for (const person of roles.data?.people ?? []) counts.set(person.role, (counts.get(person.role) ?? 0) + 1);
    return counts;
  }, [roles.data?.people]);
  const groups = useMemo(() => permissionGroups(roles.data), [roles.data]);
  // External people work in the portal, under project roles of their own, so they are not compared here.
  const columns = catalogue.filter((entry) => entry.role !== 'external');
  const external = catalogue.find((entry) => entry.role === 'external');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (roles.data?.people ?? []).filter(
      (person) =>
        (filter === 'all' || person.role === filter) &&
        (!needle || person.userName.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle)),
    );
  }, [roles.data?.people, query, filter]);
  const paging = usePagination(rows, { pageSize: 25, resetKey: `${filter}:${query}` });

  const showPeople = (role: AppRole) => {
    setFilter(role);
    setQuery('');
    peopleSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const change = (person: AppRoleAssignment, role: AssignableRole) => {
    if (role === person.role) return;
    setRole.mutate(
      { userId: person.userId, role },
      {
        onSuccess: () =>
          toast.success(t('Role changed'), {
            description:
              role === 'external'
                ? t('{person} now sees only the portal. Choose their projects on the External users page.', {
                    person: person.userName,
                  })
                : t('{person} is now {role}. Their sidebar changes on their next page load.', {
                    person: person.userName,
                    role: labelOf.get(role) ?? role,
                  }),
          }),
        onError: (error) => toast.error(t('The role was not changed'), { description: describeError(error) }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <Alert tone="neutral" icon={UserCog}>
        {t('A role decides which screens and sidebar someone works in, and brings the EPM permissions compared below. Individual grants under EPM permissions still apply on top. External users — clients and vendors — see only the portal. Administrators are the instance\'s administrator accounts and are set on the Users page. Every change is journalled.')}
      </Alert>

      {catalogue.length > 0 ? (
        <section className="space-y-3" aria-labelledby="roles-heading">
          <h2 id="roles-heading" className="text-sm font-semibold text-foreground">
            {t('Roles')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {catalogue.map((entry) => {
              const count = peopleIn.get(entry.role) ?? 0;
              return (
                <div key={entry.role} className="flex flex-col rounded-lg border border-border bg-surface p-4" data-testid={`role-card-${entry.role}`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">{entry.label}</p>
                    <Badge size="sm" tone={count > 0 ? 'primary' : 'neutral'}>
                      {t('{count, plural, one {# person} other {# people}}', { count })}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
                  {entry.role === 'external' && entry.kinds && entry.kinds.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-2xs font-medium text-foreground">{t('Their role on each project')}</p>
                      <ul className="mt-1 flex flex-wrap gap-1">
                        {entry.kinds.map((kind) => (
                          <li key={kind}>
                            <Badge size="sm" tone="accent">
                              {kind}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-2xs font-medium">
                    {count > 0 ? (
                      <button type="button" onClick={() => showPeople(entry.role)} className="text-primary underline-offset-2 hover:underline">
                        {t('Show people')}
                      </button>
                    ) : null}
                    {entry.role === 'external' ? (
                      <Link to={EXTERNAL_USERS_PATH} className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                        {t('Manage on External users')}
                        <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {columns.length > 0 && groups.length > 0 ? (
        <section className="space-y-2" aria-labelledby="matrix-heading">
          <div>
            <h2 id="matrix-heading" className="text-sm font-semibold text-foreground">
              {t('What each role can do')}
            </h2>
            <p className="text-2xs text-muted-foreground">
              {t('Point at a permission to read what it allows.')}
              {external ? ` ${t('External users are not compared: what they may do is their client or vendor role on each project.')}` : ''}
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[60rem] border-collapse text-xs" data-testid="role-matrix">
              <thead>
                <tr className="bg-muted/50">
                  <th scope="col" className="sticky start-0 z-10 bg-muted px-4 py-2.5 text-start text-2xs font-semibold text-muted-foreground">
                    {t('Permission')}
                  </th>
                  {columns.map((entry) => (
                    <th key={entry.role} scope="col" className="w-28 px-2 py-2.5 text-center text-2xs font-semibold leading-tight text-foreground">
                      {entry.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.title}>
                    <tr className="border-t border-border">
                      <th
                        scope="colgroup"
                        colSpan={columns.length + 1}
                        className="bg-muted/30 px-4 py-1.5 text-start text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {group.title}
                      </th>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.key} className="border-t border-border/60 hover:bg-muted/20">
                        <th scope="row" className="sticky start-0 bg-surface px-4 py-2 text-start font-normal text-foreground" title={row.description}>
                          {row.label}
                        </th>
                        {columns.map((entry) => (
                          <td key={entry.role} className="px-2 py-2 text-center">
                            {holds(entry, row) ? (
                              <Check className="mx-auto h-4 w-4 text-primary" aria-label={t('Yes')} />
                            ) : (
                              <span className="text-muted-foreground/40" aria-label={t('No')}>
                                —
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div ref={peopleSection} className="scroll-mt-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t('People and their roles')}</h2>
        <ListToolbar
          trailing={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('Search people')}
                aria-label={t('Search people')}
                className="h-8 w-56"
              />
              <Select value={filter} onValueChange={(value) => setFilter(value as AppRole | 'all')}>
                <SelectTrigger className="h-8 w-44" aria-label={t('Filter by role')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('All roles')}</SelectItem>
                  {catalogue.map((entry) => (
                    <SelectItem key={entry.role} value={entry.role}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        >
          <ResultCount count={rows.length} label={t('person')} plural={t('people')} />
        </ListToolbar>

        <QueryBoundary
          isLoading={roles.isLoading}
          isError={roles.isError}
          error={roles.error}
          onRetry={() => void roles.refetch()}
          errorTitle={t('Roles could not be loaded')}
          skeleton={<TableSkeleton columns={3} />}
          isEmpty={rows.length === 0}
          empty={<EmptyState icon={Users} title={t('Nobody matches')} description={t('Try another name or role.')} />}
        >
          <AdminTable footer={<AdminPagination paging={paging} itemLabel={t('person')} itemLabelPlural={t('people')} />}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Person')}</TableHead>
                <TableHead>{t('Email')}</TableHead>
                <TableHead className="w-52">{t('Role')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paging.items.map((person) => (
                <TableRow key={person.userId}>
                  <TableCell>
                    <p className="font-medium">{person.userName}</p>
                    {person.role === 'external' ? <ExternalAccessLine access={person.externalAccess ?? []} /> : null}
                  </TableCell>
                  <TableCell className="font-mono text-2xs text-muted-foreground">{person.email}</TableCell>
                  <TableCell>
                    {person.administrator ? (
                      <Badge tone="primary">{labelOf.get('admin') ?? t('Administrator')}</Badge>
                    ) : (
                      <Select
                        value={person.role}
                        onValueChange={(value) => change(person, value as AssignableRole)}
                        disabled={setRole.isPending && setRole.variables?.userId === person.userId}
                      >
                        <SelectTrigger className="h-8" aria-label={t('Role of {person}', { person: person.userName })}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {catalogue
                            .filter((entry) => entry.assignable)
                            .map((entry) => (
                              <SelectItem key={entry.role} value={entry.role}>
                                {entry.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminTable>
        </QueryBoundary>
      </div>
    </div>
  );
}

/** Under an external person's name: the projects they see in the portal, and as what. */
function ExternalAccessLine({ access }: { access: { projectName: string; roleName: string }[] }) {
  if (access.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground">
        {t('No projects yet.')}{' '}
        <Link to={EXTERNAL_USERS_PATH} className="font-medium text-primary underline-offset-2 hover:underline">
          {t('Give them a project')}
        </Link>
      </p>
    );
  }
  return (
    <p className="text-2xs text-muted-foreground">
      {access
        .map((grant) => t('{role} on {project}', { role: grant.roleName, project: grant.projectName }))
        .join(' · ')}
    </p>
  );
}
