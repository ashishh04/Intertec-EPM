import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { ListToolbar, ResultCount } from '@/components/common/ListToolbar';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useCreateNonWorkingDay,
  useDeleteNonWorkingDay,
  useNonWorkingDays,
} from '@/hooks/useAdmin';
import { usePagination } from '@/hooks/usePagination';
import { formatWeekdayDate } from '@/lib/utils';
import type { AdminNonWorkingDay } from '@/services/api/admin';
import { ISO_DATE_PATTERN, describeError, isNotImplementedUpstream } from './shared-format';
import { ManagedUpstreamNotice } from './shared-notices';
import { AdminPagination, AdminTable } from './shared-tables';

/**
 * Non-working days: the public holidays and closures skipped when work is
 * scheduled, on top of the weekly working days.
 */
export default function NonWorkingDaysPage() {
  const nonWorkingDays = useNonWorkingDays();
  const create = useCreateNonWorkingDay();
  const remove = useDeleteNonWorkingDay();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AdminNonWorkingDay | undefined>();
  // Set once the instance has refused a write because its API does not offer
  // it. Kept for the rest of the visit so the notice does not flicker away.
  const [managedUpstream, setManagedUpstream] = useState(false);

  const rows = useMemo(
    () => [...(nonWorkingDays.data ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [nonWorkingDays.data],
  );
  const paging = usePagination(rows, { pageSize: 25 });

  const confirmRemove = () => {
    if (!removing) return;
    const target = removing;
    remove.mutate(target.id, {
      onSuccess: () => {
        setRemoving(undefined);
        toast.success('Non-working day removed', { description: target.name });
      },
      onError: (error) => {
        if (isNotImplementedUpstream(error)) setManagedUpstream(true);
        setRemoving(undefined);
        toast.error('Non-working day was not removed', { description: describeError(error) });
      },
    });
  };

  return (
    <div className="space-y-4">
      {managedUpstream ? <ManagedUpstreamNotice shown="list" /> : null}

      <ListToolbar
        trailing={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add non-working day
          </Button>
        }
      >
        <ResultCount count={rows.length} label="non-working day" />
      </ListToolbar>

      <QueryBoundary
        isLoading={nonWorkingDays.isLoading}
        isError={nonWorkingDays.isError}
        error={nonWorkingDays.error}
        onRetry={() => void nonWorkingDays.refetch()}
        errorTitle="Non-working days could not be loaded"
        skeleton={<TableSkeleton columns={3} />}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={CalendarOff}
            title="No non-working days"
            description="Every day of the week that is a working day is scheduled. Add a holiday or closure to skip it."
            action={{ label: 'Add non-working day', onClick: () => setAdding(true) }}
          />
        }
      >
        <AdminTable footer={<AdminPagination paging={paging} itemLabel="non-working day" />}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paging.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <time dateTime={row.date}>{formatWeekdayDate(row.date)}</time>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${row.name}`}
                    className="text-muted-foreground hover:text-danger"
                    onClick={() => setRemoving(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </AdminTable>
      </QueryBoundary>

      <AddNonWorkingDayDialog
        open={adding}
        onOpenChange={setAdding}
        pending={create.isPending}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (created) => {
              setAdding(false);
              toast.success('Non-working day added', {
                description: `${created.name}, ${formatWeekdayDate(created.date)}.`,
              });
            },
            onError: (error) => {
              if (isNotImplementedUpstream(error)) {
                setManagedUpstream(true);
                setAdding(false);
              }
              toast.error('Non-working day was not added', { description: describeError(error) });
            },
          })
        }
      />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              {removing ? `${formatWeekdayDate(removing.date)} becomes a working day again` : 'This day becomes a working day again'}
              , and work packages scheduled around it may move. This applies to every project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} loading={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Add dialog                                                                */
/* ------------------------------------------------------------------------ */

interface AddNonWorkingDayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (input: { name: string; date: string }) => void;
}

function AddNonWorkingDayDialog({ open, onOpenChange, pending, onSubmit }: AddNonWorkingDayDialogProps) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [errors, setErrors] = useState<{ name?: string; date?: string }>({});

  const reset = () => {
    setName('');
    setDate('');
    setErrors({});
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const next: { name?: string; date?: string } = {};
    if (!trimmed) next.name = 'Give the day a name.';
    if (!date) next.date = 'Choose a date.';
    else if (!ISO_DATE_PATTERN.test(date)) next.date = 'Enter the date as YYYY-MM-DD.';
    setErrors(next);
    if (next.name || next.date) return;
    onSubmit({ name: trimmed, date });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add non-working day</DialogTitle>
            <DialogDescription>
              A single date skipped when work is scheduled. Recurring holidays are added one
              year at a time.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="non-working-day-name" required>
                Name
              </Label>
              <Input
                id="non-working-day-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Christmas Day"
                invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'non-working-day-name-error' : undefined}
                autoFocus
                maxLength={255}
              />
              {errors.name ? <FieldError id="non-working-day-name-error">{errors.name}</FieldError> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="non-working-day-date" required>
                Date
              </Label>
              <Input
                id="non-working-day-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                invalid={Boolean(errors.date)}
                aria-describedby={errors.date ? 'non-working-day-date-error' : 'non-working-day-date-hint'}
              />
              {errors.date ? (
                <FieldError id="non-working-day-date-error">{errors.date}</FieldError>
              ) : (
                <FieldHint id="non-working-day-date-hint">
                  {date && ISO_DATE_PATTERN.test(date) ? formatWeekdayDate(date) : 'YYYY-MM-DD'}
                </FieldHint>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
