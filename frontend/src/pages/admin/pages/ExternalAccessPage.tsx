import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useProjects } from '@/hooks/useProjects';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import { apiClient } from '@/services/api/client';
import type { ExternalAccessView, ExternalPermission, ExternalRoleView } from '@/types';
import { describeError } from './shared-format';

const PERMISSIONS: { key: ExternalPermission; label: () => string }[] = [
  { key: 'status', label: () => t('See project status and health') },
  { key: 'milestones', label: () => t('See milestones and timeline') },
  { key: 'tasks.all', label: () => t('See all tasks') },
  { key: 'tasks.assigned', label: () => t('See only tasks assigned to them') },
  { key: 'comment', label: () => t('Comment on tasks') },
  { key: 'status.own', label: () => t('Update the status of their own tasks') },
  { key: 'time.own', label: () => t('Log time on their own tasks') },
  { key: 'documents.view', label: () => t('See documents') },
  { key: 'documents.upload', label: () => t('Upload documents') },
  { key: 'approvals', label: () => t('Answer approval requests sent to them') },
  { key: 'reports', label: () => t('See the project status summary') },
];

/**
 * External users (Module 17): the roles and their permission matrix, and who
 * holds which role on which project. An external user sees only the portal,
 * and in it only what their role allows; administration, finance, resources
 * and other projects are never reachable.
 */
export default function ExternalAccessPage() {
  return (
    <div className="space-y-4">
      <MatrixCard />
      <GrantsCard />
    </div>
  );
}

function MatrixCard() {
  const client = useQueryClient();
  const roles = useQuery({ queryKey: ['external', 'roles'], queryFn: () => apiClient.get<ExternalRoleView[]>('/admin/external-roles') });
  const [draft, setDraft] = useState<Record<string, ExternalPermission[]>>({});
  const [newName, setNewName] = useState('');
  useEffect(() => {
    if (roles.data) setDraft(Object.fromEntries(roles.data.map((role) => [role.id, role.permissions])));
  }, [roles.data]);
  const save = useMutation({
    mutationFn: (role: ExternalRoleView) => apiClient.put<ExternalRoleView>(`/admin/external-roles/${role.id}`, { name: role.name, description: role.description, permissions: draft[role.id] ?? [] }),
    onSuccess: () => {
      toast.success(t('Role saved'));
      void client.invalidateQueries({ queryKey: ['external'] });
    },
    onError: (error) => toast.error(t('The role was not saved'), { description: describeError(error) }),
  });
  const create = useMutation({
    mutationFn: () => apiClient.post<ExternalRoleView>('/admin/external-roles', { name: newName.trim(), permissions: ['status', 'milestones'] }),
    onSuccess: () => {
      setNewName('');
      void client.invalidateQueries({ queryKey: ['external'] });
    },
    onError: (error) => toast.error(t('The role was not added'), { description: describeError(error) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/admin/external-roles/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['external'] }),
    onError: (error) => toast.error(t('The role was not removed'), { description: describeError(error) }),
  });
  const toggle = (roleId: string, key: ExternalPermission) =>
    setDraft((current) => {
      const has = (current[roleId] ?? []).includes(key);
      return { ...current, [roleId]: has ? (current[roleId] ?? []).filter((entry) => entry !== key) : [...(current[roleId] ?? []), key] };
    });
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('External roles')}</CardTitle>
        <CardDescription>{t('What each kind of external user may do on a project they are given. Administration, finance, resources and other projects are never available to them.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 overflow-x-auto pt-4">
        <QueryBoundary isLoading={roles.isLoading} isError={roles.isError} error={roles.error} onRetry={() => void roles.refetch()} errorTitle={t('The roles could not be loaded')} skeleton={<ListSkeleton rows={6} />}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-2xs text-muted-foreground">
                <th className="py-1.5 text-start font-medium">{t('Permission')}</th>
                {(roles.data ?? []).map((role) => (
                  <th key={role.id} className="px-2 py-1.5 text-center font-medium" dir="auto">
                    {role.name}
                    <div className="font-normal">{t('{count, plural, one {# person} other {# people}}', { count: role.grants })}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((permission) => (
                <tr key={permission.key} className="border-b border-border/60">
                  <td className="py-1.5">{permission.label()}</td>
                  {(roles.data ?? []).map((role) => (
                    <td key={role.id} className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${role.name}: ${permission.label()}`}
                        checked={(draft[role.id] ?? []).includes(permission.key)}
                        onChange={() => toggle(role.id, permission.key)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td />
                {(roles.data ?? []).map((role) => (
                  <td key={role.id} className="px-2 py-2 text-center">
                    <div className="flex justify-center gap-1">
                      <Button size="sm" variant="outline" loading={save.isPending} onClick={() => save.mutate(role)}>
                        {t('Save')}
                      </Button>
                      {role.grants === 0 ? (
                        <Button size="sm" variant="ghost" aria-label={t('Remove')} onClick={() => remove.mutate(role.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </QueryBoundary>
        <div className="flex items-end gap-2 border-t border-border pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="external-role-name">{t('A new role')}</Label>
            <Input id="external-role-name" className="w-64" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={t('e.g. Auditor')} />
          </div>
          <Button size="sm" disabled={!newName.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            <Plus className="h-3.5 w-3.5" />
            {t('Add role')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GrantsCard() {
  const client = useQueryClient();
  const access = useQuery({ queryKey: ['external', 'access'], queryFn: () => apiClient.get<ExternalAccessView[]>('/admin/external-access') });
  const roles = useQuery({ queryKey: ['external', 'roles'], queryFn: () => apiClient.get<ExternalRoleView[]>('/admin/external-roles') });
  const users = useUsers();
  const projects = useProjects();
  const [userId, setUserId] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [roleId, setRoleId] = useState<string>();
  const userOptions = useMemo(() => (users.data ?? []).map((user) => ({ id: user.id, name: user.name, hint: user.email })), [users.data]);
  const projectOptions = useMemo(() => (projects.data ?? []).map((project) => ({ id: project.id, name: project.name, hint: project.identifier })), [projects.data]);
  const roleOptions = useMemo(() => (roles.data ?? []).map((role) => ({ id: role.id, name: role.name })), [roles.data]);
  const grant = useMutation({
    mutationFn: () => apiClient.post<ExternalAccessView>('/admin/external-access', { userId, projectId, roleId }),
    onSuccess: () => {
      toast.success(t('Access given'));
      void client.invalidateQueries({ queryKey: ['external'] });
    },
    onError: (error) => toast.error(t('Access was not given'), { description: describeError(error) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/admin/external-access/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['external'] }),
    onError: (error) => toast.error(t('Access was not removed'), { description: describeError(error) }),
  });
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('External users')}</CardTitle>
        <CardDescription>{t('Giving someone a role on a project makes them an external user and a member of that project. From then on they see only the portal.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-64 space-y-1.5">
            <Label htmlFor="grant-user">{t('Person')}</Label>
            <ComboSelect id="grant-user" label={t('Person')} options={userOptions} value={userId} onChange={setUserId} />
          </div>
          <div className="w-64 space-y-1.5">
            <Label htmlFor="grant-project">{t('Project')}</Label>
            <ComboSelect id="grant-project" label={t('Project')} options={projectOptions} value={projectId} onChange={setProjectId} />
          </div>
          <div className="w-56 space-y-1.5">
            <Label htmlFor="grant-role">{t('Role')}</Label>
            <ComboSelect id="grant-role" label={t('Role')} options={roleOptions} value={roleId} onChange={setRoleId} />
          </div>
          <Button size="sm" disabled={!userId || !projectId || !roleId} loading={grant.isPending} onClick={() => grant.mutate()}>
            <Plus className="h-3.5 w-3.5" />
            {t('Give access')}
          </Button>
        </div>
        <QueryBoundary isLoading={access.isLoading} isError={access.isError} error={access.error} onRetry={() => void access.refetch()} errorTitle={t('External access could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-2xs text-muted-foreground">
                <th className="py-1.5 text-start font-medium">{t('Person')}</th>
                <th className="py-1.5 text-start font-medium">{t('Project')}</th>
                <th className="py-1.5 text-start font-medium">{t('Role')}</th>
                <th className="py-1.5 text-start font-medium">{t('Since')}</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {(access.data ?? []).map((entry) => (
                <tr key={entry.id} className="border-b border-border/60">
                  <td className="py-1.5" dir="auto">
                    {entry.userName}
                  </td>
                  <td className="py-1.5" dir="auto">
                    {entry.projectName}
                  </td>
                  <td className="py-1.5">{entry.roleName}</td>
                  <td className="py-1.5">{formatShortDate(entry.grantedAt)}</td>
                  <td className="py-1.5 text-end">
                    <Button size="sm" variant="ghost" aria-label={t('Remove')} onClick={() => revoke.mutate(entry.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
              {(access.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-2xs text-muted-foreground">
                    {t('No external users yet.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
