import { useState } from 'react';
import { CalendarPlus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { ComboSelect } from '@/components/common/ComboSelect';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { TableSkeleton } from '@/components/common/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePlaceholderPeople } from '@/hooks/usePlaceholderPeople';
import { useProjects } from '@/hooks/useProjects';
import { useAllocations, useDeleteAllocation, useResourceRoles, useSaveAllocation } from '@/hooks/useResources';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import type { ResourceAllocation } from '@/types';
import { hours } from './bands';

type Who = 'person' | 'placeholder' | 'role';

interface Draft {
  id?: string;
  projectId?: string;
  who: Who;
  personId?: string;
  placeholderId?: string;
  roleId?: string;
  startsOn: string;
  endsOn: string;
  hoursPerWeek: string;
  note: string;
}

const blank = (): Draft => ({ who: 'placeholder', startsOn: '', endsOn: '', hoursPerWeek: '', note: '' });

const fromAllocation = (row: ResourceAllocation): Draft => ({
  id: row.id,
  projectId: row.projectId,
  who: row.personId ? 'person' : row.placeholderId ? 'placeholder' : 'role',
  personId: row.personId ?? undefined,
  placeholderId: row.placeholderId ?? undefined,
  roleId: row.roleId ?? undefined,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  hoursPerWeek: String(row.hoursPerWeek),
  note: row.note ?? '',
});

/**
 * Planned work (BR-313): a person, a placeholder for someone not yet hired, or
 * a role with nobody named, booked to a project for some hours a week. It is
 * demand the heatmap and the forecast count alongside work already assigned.
 */
export function BookingsPanel() {
  const allocations = useAllocations();
  const remove = useDeleteAllocation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ResourceAllocation | null>(null);

  return (
    <Card>
      <CardHeader variant="compact">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t('Bookings')}</CardTitle>
            <CardDescription>
              {t(
                'Time planned for a project before the work is assigned: book a person, a placeholder for someone not yet hired, or just a role. Bookings count as demand in the heatmap and the forecast.',
              )}
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setDraft(blank())}>
            <CalendarPlus className="h-4 w-4" />
            {t('Book time')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <QueryBoundary
          isLoading={allocations.isLoading}
          isError={allocations.isError}
          error={allocations.error}
          onRetry={() => void allocations.refetch()}
          skeleton={<TableSkeleton rows={4} />}
          isEmpty={allocations.data?.length === 0}
          empty={<EmptyState icon={CalendarPlus} title={t('Nothing booked yet')} description={t('Book time to plan demand that is not yet work in a project.')} />}
        >
          <Table data-testid="bookings">
            <TableHeader>
              <TableRow>
                <TableHead>{t('Project')}</TableHead>
                <TableHead>{t('Booked to')}</TableHead>
                <TableHead>{t('From – to')}</TableHead>
                <TableHead numeric>{t('A week')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(allocations.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell dir="auto">
                    <span className="font-medium text-foreground">{row.projectName}</span>
                    {row.note ? <span className="block text-2xs text-muted-foreground">{row.note}</span> : null}
                  </TableCell>
                  <TableCell>
                    <span dir="auto">{row.carrierName}</span>{' '}
                    {row.placeholderId ? (
                      <Badge tone="neutral" size="sm">
                        {t('Placeholder')}
                      </Badge>
                    ) : !row.personId ? (
                      <Badge tone="warning" size="sm">
                        {t('Nobody named')}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatShortDate(row.startsOn)} – {formatShortDate(row.endsOn)}
                  </TableCell>
                  <TableCell numeric>{hours(row.hoursPerWeek)}</TableCell>
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon-sm" aria-label={t('Change this booking')} onClick={() => setDraft(fromAllocation(row))}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t('Remove this booking')} onClick={() => setDeleting(row)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryBoundary>
      </CardContent>

      {draft ? <BookingDialog draft={draft} onClose={() => setDraft(null)} /> : null}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Remove this booking?')}
        description={t('The planned demand it carried leaves the heatmap and the forecast.')}
        confirmLabel={t('Remove')}
        tone="danger"
        pending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.success(t('Booking removed'));
            },
            onError: (error) => toast.error(t('The booking was not removed'), { description: error instanceof Error ? error.message : undefined }),
          })
        }
      />
    </Card>
  );
}

function BookingDialog({ draft: initial, onClose }: { draft: Draft; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const projects = useProjects();
  const users = useUsers();
  const placeholders = usePlaceholderPeople();
  const roles = useResourceRoles();
  const save = useSaveAllocation();
  const hoursValue = Number(draft.hoursPerWeek);
  const problem =
    !draft.projectId
      ? t('Choose the project.')
      : draft.who === 'person' && !draft.personId
        ? t('Choose the person.')
        : draft.who === 'placeholder' && !draft.placeholderId
          ? t('Choose the placeholder.')
          : draft.who === 'role' && !draft.roleId
            ? t('Choose the role.')
            : !draft.startsOn || !draft.endsOn
              ? t('Give the first and last day.')
              : draft.endsOn < draft.startsOn
                ? t('The last day comes on or after the first.')
                : !(hoursValue > 0 && hoursValue <= 168)
                  ? t('Hours a week are more than 0 and at most 168.')
                  : null;

  const submit = () => {
    if (problem || !draft.projectId) return;
    save.mutate(
      {
        id: draft.id,
        projectId: draft.projectId,
        personId: draft.who === 'person' ? draft.personId : null,
        placeholderId: draft.who === 'placeholder' ? draft.placeholderId : null,
        roleId: draft.who === 'role' ? draft.roleId : (draft.roleId ?? null),
        startsOn: draft.startsOn,
        endsOn: draft.endsOn,
        hoursPerWeek: hoursValue,
        note: draft.note.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success(draft.id ? t('Booking changed') : t('Time booked'));
          onClose();
        },
        onError: (error) => toast.error(t('The booking was not saved'), { description: error instanceof Error ? error.message : undefined }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{draft.id ? t('Change booking') : t('Book time')}</DialogTitle>
          <DialogDescription>{t('Hours a week, from the first day to the last, spread over the working days.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('Project')}</Label>
            <ComboSelect
              label={t('Project')}
              value={draft.projectId}
              onChange={(projectId) => setDraft({ ...draft, projectId })}
              options={(projects.data ?? []).map((project) => ({ id: project.id, name: project.name }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="booking-who">{t('Booked to')}</Label>
              <Select value={draft.who} onValueChange={(value) => setDraft({ ...draft, who: value as Who })}>
                <SelectTrigger id="booking-who">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="placeholder">{t('A placeholder')}</SelectItem>
                  <SelectItem value="person">{t('A person')}</SelectItem>
                  <SelectItem value="role">{t('A role, nobody named')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{draft.who === 'person' ? t('Person') : draft.who === 'placeholder' ? t('Placeholder') : t('Role')}</Label>
              {draft.who === 'person' ? (
                <ComboSelect
                  label={t('Person')}
                  value={draft.personId}
                  onChange={(personId) => setDraft({ ...draft, personId })}
                  options={(users.data ?? []).map((user) => ({ id: user.id, name: user.name }))}
                />
              ) : draft.who === 'placeholder' ? (
                <ComboSelect
                  label={t('Placeholder')}
                  value={draft.placeholderId}
                  onChange={(placeholderId) => setDraft({ ...draft, placeholderId })}
                  options={(placeholders.data ?? []).map((placeholder) => ({ id: placeholder.id, name: placeholder.name }))}
                />
              ) : (
                <ComboSelect
                  label={t('Role')}
                  value={draft.roleId}
                  onChange={(roleId) => setDraft({ ...draft, roleId })}
                  options={(roles.data ?? []).map((role) => ({ id: role.id, name: role.name }))}
                />
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="booking-from">{t('First day')}</Label>
              <Input id="booking-from" type="date" value={draft.startsOn} onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-to">{t('Last day')}</Label>
              <Input id="booking-to" type="date" value={draft.endsOn} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-hours">{t('Hours a week')}</Label>
              <Input
                id="booking-hours"
                inputMode="decimal"
                value={draft.hoursPerWeek}
                onChange={(event) => setDraft({ ...draft, hoursPerWeek: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="booking-note">{t('Note')}</Label>
            <Textarea id="booking-note" rows={2} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} dir="auto" />
          </div>
          {problem ? <FieldError>{problem}</FieldError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={Boolean(problem)} loading={save.isPending} onClick={submit}>
            {draft.id ? t('Save') : t('Book')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
