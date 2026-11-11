import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Trash2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/services/api/client';
import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { ReservedIdentifierEntry } from '@/types';
import { describeError } from './shared-format';

const KEY = ['admin', 'reserved-identifiers'] as const;

/**
 * Identifiers kept back for projects that do not exist yet. Anyone else who
 * types one into a project form is told it is reserved, and what for; an
 * administrator may still use it, which releases it.
 */
export function ReservedIdentifiersCard() {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => apiClient.get<ReservedIdentifierEntry[]>('/reserved-identifiers'),
  });
  const reserve = useMutation({
    mutationFn: (input: { identifier: string; note?: string }) => apiClient.post<ReservedIdentifierEntry>('/reserved-identifiers', input),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
  const release = useMutation({
    mutationFn: (identifier: string) => apiClient.delete<void>(`/reserved-identifiers/${encodeURIComponent(identifier)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });

  const [identifier, setIdentifier] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    const value = identifier.trim().toLowerCase();
    if (!value) return setProblem(t('An identifier is required.'));
    reserve.mutate(
      { identifier: value, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(t('“{identifier}” reserved', { identifier: value }));
          setIdentifier('');
          setNote('');
        },
        onError: (error) => setProblem(describeError(error)),
      },
    );
  };

  const rows = list.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Reserved identifiers')}
        </CardTitle>
        <CardDescription>
          {t('Keep an identifier back for a project that is coming. Nobody else can give it to a project; an administrator can, which releases it.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="reserve-identifier">{t('Identifier')}</Label>
            <Input
              id="reserve-identifier"
              value={identifier}
              dir="ltr"
              maxLength={100}
              placeholder="finance-2027"
              onChange={(event) => setIdentifier(event.target.value.toLowerCase())}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reserve-note">{t('Kept for')}</Label>
            <Input
              id="reserve-note"
              value={note}
              maxLength={300}
              placeholder={t('the Finance transformation programme')}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <Button type="submit" loading={reserve.isPending}>
            {t('Reserve')}
          </Button>
        </form>
        <FieldHint>{t('Lowercase letters, numbers, dashes and underscores, and not digits alone.')}</FieldHint>
        {problem ? <Alert tone="danger">{problem}</Alert> : null}

        {list.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('No identifiers are reserved.')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((row) => (
              <li key={row.identifier} className="flex items-center gap-3 px-3 py-2">
                <span className="font-mono text-xs" dir="ltr">
                  {row.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="auto">
                  {row.note ?? t('No note')}
                </span>
                <span className="hidden shrink-0 text-2xs text-muted-foreground sm:inline">
                  {t('{name}, {date}', { name: row.reservedByName ?? t('Unknown'), date: formatShortDate(row.createdAt) })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Release {identifier}', { identifier: row.identifier })}
                  className="hover:bg-danger-soft hover:text-danger"
                  onClick={() =>
                    release.mutate(row.identifier, {
                      onSuccess: () => toast.success(t('“{identifier}” released', { identifier: row.identifier })),
                      onError: (error) => toast.error(t('That could not be released'), { description: describeError(error) }),
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
