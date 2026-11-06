import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Users } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { roleLabel } from '@/config/navigation';
import { useMfaAdmin, useResetMfa, useSaveMfaPolicy } from '@/hooks/useMfa';
import { usePagination } from '@/hooks/usePagination';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { AppRole, MfaPersonRow } from '@/types';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable } from './shared-tables';

const ROLES: AppRole[] = ['admin', 'manager', 'hr', 'employee', 'external'];

type Filter = 'all' | 'on' | 'off' | 'missing';

/**
 * Two-factor authentication, for administrators: which EPM roles must use it, who
 * has set it up, and the reset for someone who has lost their phone and their
 * recovery codes. Never a secret or a code: only whether they have one, and how
 * many recovery codes are left.
 */
export default function TwoFactorPage() {
  const { user } = useAuth();
  const admin = useMfaAdmin();
  const save = useSaveMfaPolicy();
  const reset = useResetMfa();

  const [draft, setDraft] = useState<AppRole[]>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [resetting, setResetting] = useState<MfaPersonRow>();

  const saved = admin.data?.policy.requiredRoles;
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const people = admin.data?.people ?? [];
  const dirty = Boolean(draft && saved && (draft.length !== saved.length || draft.some((role) => !saved.includes(role))));

  const counts = useMemo(() => {
    const byRole = new Map<AppRole, { on: number; total: number }>();
    for (const person of people) {
      const entry = byRole.get(person.role) ?? { on: 0, total: 0 };
      entry.total += 1;
      if (person.enabled) entry.on += 1;
      byRole.set(person.role, entry);
    }
    return byRole;
  }, [people]);

  const me = people.find((person) => person.userId === String(user?.id));
  const requiringMyself = Boolean(me && !me.enabled && draft?.includes(me.role) && !saved?.includes(me.role));

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((person) => {
      if (filter === 'on' && !person.enabled) return false;
      if (filter === 'off' && person.enabled) return false;
      if (filter === 'missing' && (person.enabled || !person.required)) return false;
      return !needle || person.userName.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle);
    });
  }, [people, query, filter]);
  const paging = usePagination(rows, { pageSize: 25 });

  const missing = people.filter((person) => person.required && !person.enabled).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Who must use it')}</CardTitle>
          <CardDescription>
            {t('Anyone can turn it on for themselves in Security settings. People in a role ticked here are held at a set-up screen, and can do nothing else in EPM until they have set it up.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {ROLES.map((role) => {
              const checked = draft?.includes(role) ?? false;
              const count = counts.get(role) ?? { on: 0, total: 0 };
              return (
                <li key={role}>
                  <label className="flex h-full cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-xs">
                    <Checkbox
                      checked={checked}
                      disabled={!draft}
                      onCheckedChange={(next) =>
                        setDraft((current) =>
                          next === true ? [...(current ?? []), role] : (current ?? []).filter((entry) => entry !== role),
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-foreground">{roleLabel(role)}</span>
                      <span className="block text-2xs text-muted-foreground">
                        {t('{on} of {total} set up', { on: count.on, total: count.total })}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {requiringMyself ? (
            <Alert tone="warning">
              {t('This includes you, and you have not set it up. You will be asked to as soon as you save.')}
            </Alert>
          ) : null}

          <Button
            size="sm"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() =>
              draft &&
              save.mutate(draft, {
                onSuccess: () => toast.success(t('Saved'), { description: t('It applies straight away, including to people already signed in.') }),
                onError: (error) => toast.error(t('That was not saved'), { description: describeError(error) }),
              })
            }
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('Save')}
          </Button>
        </CardContent>
      </Card>

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
            <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
              <SelectTrigger className="h-8 w-48" aria-label={t('Filter by status')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('Everyone')}</SelectItem>
                <SelectItem value="on">{t('Set up')}</SelectItem>
                <SelectItem value="off">{t('Not set up')}</SelectItem>
                <SelectItem value="missing">{t('Required but not set up ({count})', { count: missing })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <ResultCount count={rows.length} label={t('person')} plural={t('people')} />
      </ListToolbar>

      <QueryBoundary
        isLoading={admin.isLoading}
        isError={admin.isError}
        error={admin.error}
        onRetry={() => void admin.refetch()}
        errorTitle={t('Unable to load two-factor authentication')}
        skeleton={<TableSkeleton columns={5} />}
        isEmpty={rows.length === 0}
        empty={<EmptyState icon={Users} title={t('Nobody matches')} description={t('Try another name or status.')} />}
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel={t('person')} itemLabelPlural={t('people')} />}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Person')}</TableHead>
              <TableHead>{t('Role')}</TableHead>
              <TableHead>{t('Two-factor authentication')}</TableHead>
              <TableHead>{t('Last used')}</TableHead>
              <TableHead>{t('Recovery codes left')}</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((person) => (
              <TableRow key={person.userId}>
                <TableCell>
                  <p className="font-medium" dir="auto">
                    {person.userName}
                  </p>
                  <p className="font-mono text-2xs text-muted-foreground">{person.email}</p>
                </TableCell>
                <TableCell className="text-xs">{roleLabel(person.role)}</TableCell>
                <TableCell>
                  <StatusBadge person={person} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {person.lastUsedAt ? formatRelative(person.lastUsedAt) : '—'}
                </TableCell>
                <TableCell className="text-xs tabular-nums">{person.enabled ? person.recoveryCodesLeft : '—'}</TableCell>
                <TableCell className="text-end">
                  {/* Not for one's own: that would let a stolen session remove the factor protecting it. */}
                  {person.enabled && person.userId !== String(user?.id) ? (
                    <Button variant="ghost" size="sm" onClick={() => setResetting(person)}>
                      {t('Reset')}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <ConfirmDialog
        open={Boolean(resetting)}
        onOpenChange={(open) => !open && setResetting(undefined)}
        title={t('Reset two-factor authentication for {person}?', { person: resetting?.userName ?? '' })}
        description={t('For someone who has lost their phone and their recovery codes. Their authenticator and codes stop working, they are signed out everywhere, and they are told by email. Check it really is them asking: this is how an impostor would try to get in.')}
        confirmLabel={t('Reset')}
        tone="danger"
        pending={reset.isPending}
        onConfirm={() =>
          resetting &&
          reset.mutate(resetting.userId, {
            onSuccess: () => {
              toast.success(t('Two-factor authentication reset for {person}', { person: resetting.userName }));
              setResetting(undefined);
            },
            onError: (error) => {
              toast.error(t('That was not reset'), { description: describeError(error) });
              setResetting(undefined);
            },
          })
        }
      />
    </div>
  );
}

function StatusBadge({ person }: { person: MfaPersonRow }) {
  if (person.lockedUntil) {
    return (
      <Badge tone="danger" size="sm" dot title={formatDateTime(person.lockedUntil)}>
        {t('Locked until {time}', { time: formatDateTime(person.lockedUntil) })}
      </Badge>
    );
  }
  if (person.enabled) {
    return (
      <Badge tone="success" size="sm" dot title={person.enabledAt ? formatDateTime(person.enabledAt) : undefined}>
        {t('On')}
      </Badge>
    );
  }
  return person.required ? (
    <Badge tone="warning" size="sm" dot>
      {t('Required, not set up')}
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm" dot>
      {t('Off')}
    </Badge>
  );
}
