import { useState } from 'react';
import { toast } from 'sonner';
import { ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Markdown } from '@/components/common/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useStatusReportMutations, useStatusReports } from '@/hooks/useStatusReports';
import { formatShortDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { ID, StatusReport } from '@/types';
import { RATING_TONE, STATUS_DIMENSIONS, dimensionWord, ratingWord } from './statusMeta';
import { StatusReportDialog } from './StatusReportDialog';

/**
 * A project's or portfolio's status reports: the latest in full, the ones
 * before it as a list to open. Whoever may write one sees New and Edit.
 */
export function StatusReportsCard({
  scopeKind,
  scopeId,
  mayWrite,
}: {
  scopeKind: 'project' | 'portfolio';
  scopeId: ID;
  /** Whether to offer a new report; the server decides in the end. */
  mayWrite: boolean;
}) {
  const reports = useStatusReports(scopeKind, scopeId);
  const { remove } = useStatusReportMutations();
  const [dialog, setDialog] = useState<{ open: boolean; report?: StatusReport }>({ open: false });
  const [shown, setShown] = useState<string>();
  const [deleting, setDeleting] = useState<StatusReport>();

  const items = reports.data?.items ?? [];
  const current = items.find((item) => item.id === shown) ?? items[0];

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          mayWrite ? (
            <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              {t('New report')}
            </Button>
          ) : null
        }
      >
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Status reports')}
        </CardTitle>
        <CardDescription className="text-2xs">
          {current
            ? t('As of {date}, by {name}', { date: formatShortDate(current.reportDate), name: current.createdByName ?? t('Unknown') })
            : t('Where it stands, in its manager’s words, report by report.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {reports.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !current ? (
          <p className="text-2xs text-muted-foreground">
            {mayWrite ? t('No status report yet. Write the first one.') : t('No status report has been written yet.')}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={RATING_TONE[current.overall]} dot>
                {ratingWord(current.overall)}
              </Badge>
              {STATUS_DIMENSIONS.map((dimension) =>
                current[dimension] ? (
                  <Badge key={dimension} tone={RATING_TONE[current[dimension]!]} size="sm">
                    {t('{dimension}: {rating}', { dimension: dimensionWord(dimension), rating: ratingWord(current[dimension]!) })}
                  </Badge>
                ) : null,
              )}
              {current.canEdit ? (
                <span className="ms-auto flex items-center">
                  <Button variant="ghost" size="icon-sm" aria-label={t('Edit this report')} onClick={() => setDialog({ open: true, report: current })}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Delete this report')}
                    className="hover:bg-danger-soft hover:text-danger"
                    onClick={() => setDeleting(current)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              ) : null}
            </div>
            <div className="text-sm" dir="auto">
              <Markdown>{current.summary}</Markdown>
            </div>
            <dl className="grid gap-3 text-xs sm:grid-cols-3">
              {(
                [
                  [t('Achieved'), current.achievements],
                  [t('Next'), current.nextSteps],
                  [t('In the way'), current.issues],
                ] as const
              ).map(([label, value]) =>
                value ? (
                  <div key={label} className="rounded-md bg-muted/40 p-2.5">
                    <dt className="mb-1 font-medium text-muted-foreground">{label}</dt>
                    <dd dir="auto">
                      <Markdown>{value}</Markdown>
                    </dd>
                  </div>
                ) : null,
              )}
            </dl>
            {items.length > 1 ? (
              <div className="border-t border-border pt-2">
                <p className="mb-1 text-2xs font-medium text-muted-foreground">{t('Earlier reports')}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setShown(item.id)}
                        aria-pressed={item.id === current.id}
                        className="rounded-md border border-border px-2 py-1 text-2xs hover:bg-muted aria-pressed:border-primary/50 aria-pressed:bg-primary-soft"
                      >
                        {formatShortDate(item.reportDate)} · {ratingWord(item.overall)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      <StatusReportDialog
        open={dialog.open}
        onOpenChange={(next) => setDialog((state) => ({ ...state, open: next }))}
        scopeKind={scopeKind}
        scopeId={scopeId}
        report={dialog.report}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => !next && setDeleting(undefined)}
        title={t('Delete this status report?')}
        description={t('It is removed for everybody. This cannot be undone.')}
        confirmLabel={t('Delete')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(undefined);
              setShown(undefined);
              toast.success(t('Status report deleted'));
            },
            onError: (error) => toast.error(t('That could not be deleted'), { description: error instanceof Error ? error.message : undefined }),
          })
        }
      />
    </Card>
  );
}
