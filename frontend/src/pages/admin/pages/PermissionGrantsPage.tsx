import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ComboSelect } from '@/components/common/ComboSelect';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useGrantPermission, usePermissionGrants, useRevokePermission } from '@/hooks/useGovernance';
import { usePagination } from '@/hooks/usePagination';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import type { GrantablePermission, Permission, PermissionGrant } from '@/types';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable } from './shared-tables';

/**
 * EPM permissions: what EPM itself grants, because OpenProject has no
 * equivalent — departments, teams, staffing, health, approvals, rules,
 * portfolios, analytics, scheduled reports, hourly rates and the audit
 * journal. Roles inside projects stay under Roles and permissions.
 *
 * Every grant and removal is journalled, and takes effect for the person
 * within a minute.
 */
export default function PermissionGrantsPage() {
  const grants = usePermissionGrants();
  const grant = useGrantPermission();
  const revoke = useRevokePermission();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PermissionGrant | undefined>();

  const catalogue = grants.data?.catalogue ?? [];
  const labelOf = useMemo(
    () => new Map(catalogue.map((entry) => [entry.permission, entry])),
    [catalogue],
  );
  const rows = useMemo(
    () =>
      [...(grants.data?.grants ?? [])].sort(
        (a, b) =>
          (labelOf.get(a.permission)?.label ?? a.permission).localeCompare(
            labelOf.get(b.permission)?.label ?? b.permission,
          ) || a.userName.localeCompare(b.userName),
      ),
    [grants.data?.grants, labelOf],
  );
  const paging = usePagination(rows, { pageSize: 25 });
  const configured = grants.data?.configured ?? [];

  const confirmRemove = () => {
    if (!removing) return;
    const target = removing;
    revoke.mutate(
      { userId: target.userId, permission: target.permission },
      {
        onSuccess: () => {
          setRemoving(undefined);
          toast.success(t('Permission removed'), {
            description: t('{permission} — {person}', {
              permission: labelOf.get(target.permission)?.label ?? target.permission,
              person: target.userName,
            }),
          });
        },
        onError: (error) => {
          setRemoving(undefined);
          toast.error(t('The permission was not removed'), { description: describeError(error) });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <Alert tone="neutral" icon={ShieldCheck}>
        {t('These are EPM\'s own permissions, for things OpenProject has no notion of. What someone may do inside a project comes from their role there (Roles and permissions). Every change here is journalled and takes effect within a minute.')}
      </Alert>

      {configured.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            '{count, plural, one {{names} holds every EPM permission from the server\'s configuration (EPM_ADMIN_USER_IDS). That is changed in configuration, not here.} other {{names} hold every EPM permission from the server\'s configuration (EPM_ADMIN_USER_IDS). That is changed in configuration, not here.}}',
            { count: configured.length, names: configured.map((holder) => holder.userName).join(', ') },
          )}
        </p>
      ) : null}

      <ListToolbar
        trailing={
          <Button size="sm" onClick={() => setAdding(true)} disabled={catalogue.length === 0}>
            <Plus className="h-3.5 w-3.5" />
            {t('Grant a permission')}
          </Button>
        }
      >
        <ResultCount count={rows.length} label={t('grant')} plural={t('grants')} />
      </ListToolbar>

      <QueryBoundary
        isLoading={grants.isLoading}
        isError={grants.isError}
        error={grants.error}
        onRetry={() => void grants.refetch()}
        errorTitle={t('EPM permissions could not be loaded')}
        skeleton={<TableSkeleton columns={4} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={KeyRound}
            title={t('No permissions granted')}
            description={t('Nobody holds an EPM permission except through the server\'s configuration.')}
            action={{ label: t('Grant a permission'), onClick: () => setAdding(true) }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel={t('grant')} itemLabelPlural={t('grants')} />}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Permission')}</TableHead>
              <TableHead>{t('Person')}</TableHead>
              <TableHead>{t('Granted')}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => {
              const entry = labelOf.get(row.permission);
              return (
                <TableRow key={`${row.userId}:${row.permission}`}>
                  <TableCell>
                    <p className="font-medium">{entry?.label ?? row.permission}</p>
                    {entry ? <p className="text-2xs text-muted-foreground">{entry.description}</p> : null}
                  </TableCell>
                  <TableCell className="font-medium">{row.userName}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {row.grantedByName
                      ? t('{date} · by {name}', { date: formatDateTime(row.grantedAt), name: row.grantedByName })
                      : formatDateTime(row.grantedAt)}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Remove {permission} from {person}', {
                        permission: entry?.label ?? row.permission,
                        person: row.userName,
                      })}
                      className="text-muted-foreground hover:text-danger"
                      onClick={() => setRemoving(row)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <GrantDialog
        open={adding}
        onOpenChange={setAdding}
        catalogue={catalogue}
        pending={grant.isPending}
        onSubmit={(input) =>
          grant.mutate(input, {
            onSuccess: (created) => {
              setAdding(false);
              toast.success(t('Permission granted'), {
                description: t('{permission} — {person}', {
                  permission: labelOf.get(created.permission)?.label ?? created.permission,
                  person: created.userName,
                }),
              });
            },
            onError: (error) => toast.error(t('The permission was not granted'), { description: describeError(error) }),
          })
        }
      />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('Remove {permission}?', {
                permission: removing ? labelOf.get(removing.permission)?.label ?? removing.permission : '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('{person} loses it within a minute. The change is journalled.', { person: removing?.userName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={revoke.isPending}>
              {t('Cancel')}
            </Button>
            <Button variant="danger" onClick={confirmRemove} loading={revoke.isPending}>
              {t('Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Grant dialog                                                              */
/* ------------------------------------------------------------------------ */

interface GrantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogue: GrantablePermission[];
  pending: boolean;
  onSubmit: (input: { userId: string; permission: Permission }) => void;
}

function GrantDialog({ open, onOpenChange, catalogue, pending, onSubmit }: GrantDialogProps) {
  const users = useUsers();
  const [userId, setUserId] = useState<string | undefined>();
  const [permission, setPermission] = useState<Permission | undefined>();
  const [errors, setErrors] = useState<{ userId?: string; permission?: string }>({});

  const people = useMemo(
    () =>
      (users.data ?? [])
        .map((user) => ({ id: user.id, name: user.name, hint: user.email || undefined }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [users.data],
  );
  const chosen = catalogue.find((entry) => entry.permission === permission);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setUserId(undefined);
      setPermission(undefined);
      setErrors({});
    }
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: { userId?: string; permission?: string } = {};
    if (!userId) next.userId = t('Choose a person.');
    if (!permission) next.permission = t('Choose a permission.');
    setErrors(next);
    if (next.userId || next.permission) return;
    onSubmit({ userId: userId!, permission: permission! });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t('Grant a permission')}</DialogTitle>
            <DialogDescription>{t('One EPM permission to one person. It is journalled.')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="grant-person" required>
                {t('Person')}
              </Label>
              <ComboSelect
                id="grant-person"
                label={t('Person')}
                options={people}
                value={userId}
                onChange={setUserId}
                loading={users.isLoading}
                placeholder={t('Choose a person')}
              />
              {errors.userId ? <FieldError>{errors.userId}</FieldError> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="grant-permission" required>
                {t('Permission')}
              </Label>
              <Select value={permission} onValueChange={(value) => setPermission(value as Permission)}>
                <SelectTrigger id="grant-permission">
                  <SelectValue placeholder={t('Choose a permission')} />
                </SelectTrigger>
                <SelectContent>
                  {catalogue.map((entry) => (
                    <SelectItem key={entry.permission} value={entry.permission}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.permission ? (
                <FieldError>{errors.permission}</FieldError>
              ) : chosen ? (
                <FieldHint>{chosen.description}</FieldHint>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {t('Grant')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
