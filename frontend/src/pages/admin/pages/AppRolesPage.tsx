import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, UserCog, Users } from 'lucide-react';
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
import type { AppRole, AppRoleAssignment } from '@/types';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable } from './shared-tables';

type AssignableRole = Exclude<AppRole, 'admin'>;

/** Where an external person's projects, and their client or vendor role on each, are given. */
const EXTERNAL_USERS_PATH = '/admin/users/external-access';

/**
 * Access roles: whether each person works in EPM as a Manager, HR, an
 * Employee or an External user (a client or vendor). The role picks their
 * sidebar and screens, and brings a bundle of EPM permissions. An external
 * person sees only the portal; which projects, and as a client or a vendor on
 * each, is set on the External users page. Administrators are the instance's
 * administrator accounts, listed but not changed here.
 */
export default function AppRolesPage() {
  const roles = useAppRoles();
  const setRole = useSetAppRole();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AppRole | 'all'>('all');

  const catalogue = roles.data?.catalogue ?? [];
  const labelOf = useMemo(() => new Map(catalogue.map((entry) => [entry.role, entry.label])), [catalogue]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (roles.data?.people ?? []).filter(
      (person) =>
        (filter === 'all' || person.role === filter) &&
        (!needle || person.userName.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle)),
    );
  }, [roles.data?.people, query, filter]);
  const paging = usePagination(rows, { pageSize: 25 });

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
    <div className="space-y-4">
      <Alert tone="neutral" icon={UserCog}>
        {t('A role decides which screens and sidebar someone works in, and brings the EPM permissions listed below. Individual grants under EPM permissions still apply on top. External users — clients and vendors — see only the portal. Administrators are the instance\'s administrator accounts and are set on the Users page. Every change is journalled.')}
      </Alert>

      {catalogue.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {catalogue.map((entry) => (
            <div key={entry.role} className="flex flex-col rounded-lg border border-border p-3">
              <p className="text-xs font-semibold text-foreground">{entry.label}</p>
              <p className="mt-0.5 text-2xs text-muted-foreground">{entry.description}</p>
              {entry.permissions.length > 0 && entry.role !== 'admin' ? (
                <ul className="mt-2 flex flex-wrap gap-1">
                  {entry.permissions.map((permission) => (
                    <li key={permission}>
                      <Badge size="sm">{permission}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              {entry.role === 'external' ? (
                <>
                  {entry.kinds && entry.kinds.length > 0 ? (
                    <>
                      <p className="mt-2 text-2xs font-medium text-foreground">{t('Their role on each project')}</p>
                      <ul className="mt-1 flex flex-wrap gap-1">
                        {entry.kinds.map((kind) => (
                          <li key={kind}>
                            <Badge size="sm" tone="accent">
                              {kind}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <Link
                    to={EXTERNAL_USERS_PATH}
                    className="mt-auto inline-flex items-center gap-1 pt-2 text-2xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t('Manage on External users')}
                    <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden />
                  </Link>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

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
              <SelectTrigger className="h-8 w-40" aria-label={t('Filter by role')}>
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
              <TableHead className="w-48">{t('Role')}</TableHead>
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
