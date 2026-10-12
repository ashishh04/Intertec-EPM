import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Fingerprint, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { FactList } from '@/components/common/FactList';
import { ListToolbar, ResultCount, SearchInput } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminKeys, useAdminProjects } from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { t } from '@/lib/i18n';
import { invalidationGroups } from '@/lib/queryKeys';
import { projectWriteService } from '@/services';
import type { AdminProject } from '@/services/api/admin';
import { describeError } from './shared-format';
import { AdminPagination, AdminTable } from './shared-tables';

/**
 * Identifiers: how work packages are named across EPM.
 *
 * EPM names every work package by its project and its number — `PORTAL-1234`.
 * The number is the instance-wide one, so it never changes and links never
 * break; the prefix is taken from the project's identifier, which is why this
 * page is mostly about those identifiers: which projects end up sharing a
 * prefix, which prefixes read badly, and changing an identifier to fix it.
 */

/**
 * Must match how the backend composes the key (`mapping/tasks.ts` and the
 * places that repeat it): the first six characters of the identifier, upper
 * case, then a dash and the work package number.
 */
const PREFIX_LENGTH = 6;
const SAMPLE_NUMBER = 1234;

/** The instance's own rule: a-z, 0-9, dashes and underscores, not digits alone. */
const IDENTIFIER_PATTERN = /^(?!\d+$)[a-z0-9_-]+$/;
const IDENTIFIER_MAX_LENGTH = 100;
const RESERVED = new Set(['new', 'menu', 'queries', 'export_list_modal']);

const PAGE_SIZE = 25;

const prefixOf = (identifier: string) => identifier.slice(0, PREFIX_LENGTH).toUpperCase();
const sampleKey = (identifier: string) => (identifier ? `${prefixOf(identifier)}-${SAMPLE_NUMBER}` : `WP-${SAMPLE_NUMBER}`);

interface Row {
  project: AdminProject;
  prefix: string;
  /** Other projects whose work packages carry the same prefix. */
  sharedWith: AdminProject[];
  /** A dash or underscore inside the prefix, so the key has two of them. */
  awkward: boolean;
}

function analyse(projects: AdminProject[]): Row[] {
  const byPrefix = new Map<string, AdminProject[]>();
  for (const project of projects) {
    const prefix = prefixOf(project.identifier);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), project]);
  }

  return projects
    .map((project) => {
      const prefix = prefixOf(project.identifier);
      return {
        project,
        prefix,
        sharedWith: (byPrefix.get(prefix) ?? []).filter((other) => other.id !== project.id),
        awkward: /[-_]/.test(prefix),
      };
    })
    .sort((a, b) => {
      const weight = (row: Row) => (row.sharedWith.length > 0 ? 0 : row.awkward ? 1 : 2);
      return weight(a) - weight(b) || a.project.name.localeCompare(b.project.name, undefined, { sensitivity: 'base' });
    });
}

const namesOf = (projects: AdminProject[]) =>
  projects.length <= 2
    ? projects.map((project) => project.name).join(', ')
    : t('{names} and {count, plural, one {# more} other {# more}}', {
        names: projects.slice(0, 2).map((project) => project.name).join(', '),
        count: projects.length - 2,
      });

export default function IdentifiersPage() {
  const projects = useAdminProjects();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminProject>();

  const all = useMemo(() => projects.data ?? [], [projects.data]);
  const rows = useMemo(() => analyse(all), [all]);
  const shared = rows.filter((row) => row.sharedWith.length > 0).length;

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(({ project, prefix }) =>
      [project.name, project.identifier, prefix].some((field) => field.toLowerCase().includes(needle)),
    );
  }, [rows, search]);
  const paging = usePagination(matches, { pageSize: PAGE_SIZE, resetKey: search });

  const example = rows[0]?.project.identifier ?? 'portal';

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('Project-based identifiers')}</CardTitle>
          <CardDescription>
            {t('Every work package is named by its project and its number, for example {key}.', { key: sampleKey(example) })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FactList
            facts={[
              {
                label: t('Prefix'),
                value: t('The first {count, number} characters of the project’s identifier, in capitals.', { count: PREFIX_LENGTH }),
                mono: false,
              },
              {
                label: t('Number'),
                value: t('Unique across every project and never reused, so it is the part links rely on.'),
                mono: false,
              },
              {
                label: t('When work moves'),
                value: t('It keeps its number and takes the prefix of the project it moves to. Links keep working.'),
                mono: false,
              },
              {
                label: t('Changing an identifier'),
                value: t('Changes the prefix of every work package in that project from then on. Text already sent, such as emails, keeps the old one.'),
                mono: false,
              },
            ]}
          />
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="project-identifiers">
        <div>
          <h2 id="project-identifiers" className="text-sm font-semibold tracking-tight">
            {t('Project identifiers')}
          </h2>
          <p className="text-2xs text-muted-foreground">
            {shared > 0
              ? t('{count, plural, one {# project shares} other {# projects share}} a prefix with another, so their work packages read as if from the same project. Give one of them a different identifier.', { count: shared })
              : t('Every project has a prefix of its own.')}
          </p>
        </div>

        <ListToolbar
          trailing={<ResultCount count={matches.length} total={all.length} label={t('project')} plural={t('projects')} />}
        >
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('Filter by name or identifier')}
            aria-label={t('Filter projects by name or identifier')}
          />
        </ListToolbar>

        <QueryBoundary
          isLoading={projects.isLoading}
          isError={projects.isError}
          error={projects.error}
          onRetry={() => void projects.refetch()}
          errorTitle={t('Unable to load projects')}
          skeleton={<TableSkeleton columns={5} />}
          isEmpty={all.length === 0}
          empty={<EmptyState icon={Fingerprint} title={t('No projects yet')} />}
        >
          <AdminTable footer={<AdminPagination paging={paging} itemLabel={t('project')} itemLabelPlural={t('projects')} />}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Project')}</TableHead>
                <TableHead>{t('Identifier')}</TableHead>
                <TableHead>{t('Work packages read')}</TableHead>
                <TableHead>{t('Check')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('Actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paging.items.map((row) => (
                <TableRow key={row.project.id}>
                  <TableCell>
                    <span className="font-medium" dir="auto">{row.project.name}</span>
                    {!row.project.active ? (
                      <Badge tone="neutral" size="sm" className="ms-2">{t('Archived')}</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-2xs">{row.project.identifier}</TableCell>
                  <TableCell className="font-mono text-2xs" dir="ltr">{sampleKey(row.project.identifier)}</TableCell>
                  <TableCell>
                    {row.sharedWith.length > 0 ? (
                      <Badge tone="warning" size="sm" title={row.sharedWith.map((project) => project.name).join(', ')}>
                        {t('Same prefix as {names}', { names: namesOf(row.sharedWith) })}
                      </Badge>
                    ) : row.awkward ? (
                      <Badge tone="neutral" size="sm">{t('Prefix contains a dash or underscore')}</Badge>
                    ) : (
                      <Badge tone="success" size="sm">{t('Unique')}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('Change the identifier of {name}', { name: row.project.name })}
                      onClick={() => setEditing(row.project)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {matches.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                    {t('No projects match “{search}”.', { search: search.trim() })}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </AdminTable>
        </QueryBoundary>
      </section>

      <IdentifierDialog project={editing} projects={all} onClose={() => setEditing(undefined)} />
    </div>
  );
}

function IdentifierDialog({
  project,
  projects,
  onClose,
}: {
  project?: AdminProject;
  projects: AdminProject[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Keyed on the id: a refetch hands over a fresh object, and resetting on it
  // would wipe what is being typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setValue(project?.identifier ?? ''), [project?.id]);

  const next = value.trim();
  const others = projects.filter((other) => other.id !== project?.id);
  const problem = !next
    ? t('An identifier is required.')
    : next.length > IDENTIFIER_MAX_LENGTH
      ? t('At most {count, number} characters.', { count: IDENTIFIER_MAX_LENGTH })
      : !IDENTIFIER_PATTERN.test(next)
        ? t('Use lower-case letters, digits, dashes and underscores, and not digits alone.')
        : RESERVED.has(next)
          ? t('That identifier is reserved.')
          : others.some((other) => other.identifier === next)
            ? t('Another project already has that identifier.')
            : undefined;
  const sharing = next ? others.filter((other) => prefixOf(other.identifier) === prefixOf(next)) : [];
  const unchanged = next === project?.identifier;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || problem || unchanged) return;
    setSaving(true);
    try {
      await projectWriteService.update(project.id, { identifier: next });
      await client.invalidateQueries({ queryKey: adminKeys.projects });
      for (const key of invalidationGroups.projectWrite) await client.invalidateQueries({ queryKey: key });
      toast.success(t('Identifier changed'), { description: `${project.name} · ${sampleKey(next)}` });
      onClose();
    } catch (error) {
      toast.error(t('The identifier was not changed'), { description: describeError(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('Change the identifier of {name}', { name: project?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('The prefix of every work package in this project changes with it. Their numbers do not.')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="project-identifier">{t('Identifier')}</Label>
              <Input
                id="project-identifier"
                value={value}
                onChange={(event) => setValue(event.target.value.toLowerCase())}
                className="font-mono"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(problem) && !unchanged}
              />
              <FieldHint>
                {problem && !unchanged
                  ? problem
                  : t('Work packages will read {key}.', { key: sampleKey(next) })}
              </FieldHint>
            </div>
            {!problem && !unchanged && sharing.length > 0 ? (
              <Alert tone="warning">
                {t('{prefix} is also the prefix of {names}.', { prefix: prefixOf(next), names: namesOf(sharing) })}
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={saving} disabled={Boolean(problem) || unchanged || saving}>
              {t('Change identifier')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
