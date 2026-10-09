import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ScrollText, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableCard, TableSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useJournal } from '@/hooks/useGovernance';
import { downloadCsv } from '@/lib/csv';
import { formatDateTime } from '@/lib/utils';
import type { JournalEntry } from '@/types';

const ALL = '__all__';

/** How the journal names a kind of record, for people rather than for code. */
const KIND_LABEL: Record<string, string> = {
  account: 'Account',
  approval_chain: 'Approval chain',
  approval_delegation: 'Approval delegation',
  approval_request: 'Approval',
  automation_rule: 'Rule',
  department: 'Department',
  employee: 'Person',
  escalation: 'Escalation',
  escalation_policy: 'Escalation policy',
  health_rules: 'Health rules',
  invitation: 'Invitation',
  operations: 'Operations alert',
  permission_grant: 'EPM permission',
  placeholder: 'Placeholder',
  portfolio: 'Portfolio',
  portfolio_view: 'Portfolio view',
  project: 'Project',
  report_schedule: 'Scheduled report',
  team: 'Team',
  work_package: 'Work package',
};

// Earlier modules wrote kinds with hyphens (`approval-chain`), later ones with
// underscores; the label is the same either way.
const kindLabel = (kind: string) => KIND_LABEL[kind.replace(/-/g, '_')] ?? kind.replace(/[-_]/g, ' ');

/**
 * The audit journal (BRL-02): every change EPM has recorded — to plans and
 * health, approvals, rules, organisation data, accounts and permissions — in
 * one place, newest first. Read-only by construction: the database refuses
 * to change or remove an entry, so nothing here offers to.
 *
 * For people granted "Read the audit journal", and for administrators.
 */
export default function JournalPage() {
  const [kind, setKind] = useState(ALL);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [open, setOpen] = useState<JournalEntry | undefined>();

  const query = useMemo(
    () => ({
      entityType: kind === ALL ? undefined : kind,
      q: q || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize,
    }),
    [kind, q, from, to, page, pageSize],
  );
  const journal = useJournal(query);
  const data = journal.data;
  const filtered = kind !== ALL || Boolean(q) || Boolean(from) || Boolean(to);

  const reset = () => {
    setKind(ALL);
    setText('');
    setQ('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const exportPage = () => {
    if (!data || data.items.length === 0) return;
    downloadCsv(
      `epm-journal-page-${data.page}.csv`,
      ['When (UTC)', 'Who', 'Kind', 'Action', 'Record', 'Project', 'What', 'Reason'],
      data.items.map((entry) => [
        entry.occurredAt,
        actorOf(entry),
        kindLabel(entry.entityType),
        entry.action,
        entry.entityId,
        entry.projectName ?? entry.projectId ?? '',
        entry.summary,
        entry.reason ?? '',
      ]),
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administration"
        title="Audit journal"
        description="Every change EPM has recorded, across projects and organisation data. Entries cannot be edited or removed."
        actions={
          <Button variant="secondary" size="sm" onClick={exportPage} disabled={!data || data.items.length === 0}>
            <Download className="h-3.5 w-3.5" />
            Export this page
          </Button>
        }
      />

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(text.trim());
          setPage(1);
        }}
      >
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="journal-search">Search what changed</Label>
          <div className="flex gap-2">
            <Input
              id="journal-search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="A name, a project, a word in the summary"
            />
            <Button type="submit" variant="secondary" size="sm" aria-label="Search">
              <Search className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="w-48 space-y-1.5">
          <Label htmlFor="journal-kind">Kind of record</Label>
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              setPage(1);
            }}
          >
            <SelectTrigger id="journal-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every kind</SelectItem>
              {(data?.entityTypes ?? []).map((type) => (
                <SelectItem key={type} value={type}>
                  {kindLabel(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40 space-y-1.5">
          <Label htmlFor="journal-from">From</Label>
          <Input
            id="journal-from"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-40 space-y-1.5">
          <Label htmlFor="journal-to">To</Label>
          <Input
            id="journal-to"
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </div>
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        ) : null}
      </form>

      <QueryBoundary
        isLoading={journal.isLoading}
        isError={journal.isError}
        error={journal.error}
        onRetry={() => void journal.refetch()}
        errorTitle="The journal could not be loaded"
        skeleton={<TableSkeleton columns={5} rows={8} />}
        isEmpty={(data?.items.length ?? 0) === 0}
        empty={
          <TableCard>
            <EmptyState
              icon={ScrollText}
              title={filtered ? 'Nothing matches' : 'Nothing recorded yet'}
              description={
                filtered ? 'Widen the dates or clear the filters.' : 'Changes appear here as people make them.'
              }
            />
          </TableCard>
        }
      >
        {data ? (
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead className="w-44">Who</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead className="w-40">Kind</TableHead>
                  <TableHead className="w-48">Project</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((entry) => (
                  <TableRow
                    key={entry.id}
                    className="cursor-pointer"
                    onClick={() => setOpen(entry)}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setOpen(entry);
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap font-mono text-2xs text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                    </TableCell>
                    <TableCell className="text-xs">{actorOf(entry)}</TableCell>
                    <TableCell className="text-xs">
                      {entry.summary}
                      {entry.reason ? <span className="text-muted-foreground"> — {entry.reason}</span> : null}
                    </TableCell>
                    <TableCell>
                      <Badge tone="neutral" size="sm">
                        {kindLabel(entry.entityType)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {entry.projectId ? (
                        <Link
                          to={`/projects/${entry.projectId}`}
                          className="hover:text-primary hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {entry.projectName ?? `Project ${entry.projectId}`}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-t border-border p-3">
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                itemLabel="entry"
                itemLabelPlural="entries"
              />
            </div>
          </TableCard>
        ) : null}
      </QueryBoundary>

      <Dialog open={Boolean(open)} onOpenChange={(next) => !next && setOpen(undefined)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{open?.summary}</DialogTitle>
            <DialogDescription>
              {open ? `${formatDateTime(open.occurredAt)} · ${actorOf(open)} · ${open.action} · entry ${open.seq}` : ''}
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <div className="space-y-3 text-xs">
              <p>
                <span className="text-muted-foreground">Record:</span> {kindLabel(open.entityType)} {open.entityId}
                {open.projectId ? ` · ${open.projectName ?? `project ${open.projectId}`}` : ''}
              </p>
              {open.reason ? (
                <p>
                  <span className="text-muted-foreground">Reason:</span> {open.reason}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <ValueBlock title="Before" value={open.before} />
                <ValueBlock title="After" value={open.after} />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function actorOf(entry: JournalEntry): string {
  if (entry.actorKind === 'system') return 'EPM (automatic)';
  if (entry.actorKind === 'service') return entry.actorName ? `${entry.actorName} (automation)` : 'EPM Automation';
  return entry.actorName ?? (entry.actorId ? `User ${entry.actorId}` : 'Unknown');
}

function ValueBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <p className="epm-eyebrow">{title}</p>
      {value === undefined || value === null ? (
        <p className="text-muted-foreground">—</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-2xs leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
