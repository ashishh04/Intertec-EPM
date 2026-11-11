import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CODE_PATTERN, CODE_PROBLEM, CodeField } from '@/components/common/CodeField';
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
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateTeam, useUpdateTeam } from '@/hooks/useTeams';
import { useDepartments } from '@/hooks/useDepartments';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import type { EpmTeam, TeamKind } from '@/services/api/teams';

/**
 * Create or edit a team or a client.
 *
 * A hand-written form, as for departments: teams are EPM-owned and have no
 * OpenProject schema to drive a `SchemaForm`. A client is the same record of
 * the other kind, with a contact's email and phone, and its lead read as the
 * account manager who looks after it.
 *
 * Only active departments are offered. A team already in an archived one keeps
 * that association, and it stays on the list, marked, for that team alone: the
 * backend leaves it alone, but forming a new one into a department being retired
 * is refused server-side, so it is not offered to any other.
 */

const NONE = '__none__';

interface TeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  team?: EpmTeam;
  /** The kind a new one starts as: the tab it was created from. */
  defaultKind?: TeamKind;
  /** Preselected department, when creating from a filtered list. */
  defaultDepartmentId?: string;
}

export function TeamDialog({ open, onOpenChange, team, defaultKind = 'internal', defaultDepartmentId }: TeamDialogProps) {
  const isEdit = Boolean(team);
  const create = useCreateTeam();
  const update = useUpdateTeam();
  // Archived ones too, or the team's own could not be found among the options.
  const departments = useDepartments(true);
  const users = useUsers();

  const [kind, setKind] = useState<TeamKind>(defaultKind);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState(NONE);
  const [leadId, setLeadId] = useState(NONE);
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [problem, setProblem] = useState<string>();
  const isClient = kind === 'client';

  // Reset each time it opens, so a cancelled edit does not leak into the next.
  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setKind(team?.kind ?? defaultKind);
    setName(team?.name ?? '');
    setCode(team?.code ?? '');
    setDescription(team?.description ?? '');
    setDepartmentId(team?.department?.id ?? defaultDepartmentId ?? NONE);
    setLeadId(team?.lead?.id ?? NONE);
    setContactEmail(team?.contactEmail ?? '');
    setContactPhone(team?.contactPhone ?? '');
    setProblem(undefined);
  }, [open, team?.id, defaultDepartmentId, defaultKind]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    // NONE is somebody choosing nothing. Empty is a select in a form with no option
    // for its value, which clears itself (the list did not load): nobody chose
    // that, so the field is left as it is.
    const sent = (value: string) => (value === '' ? undefined : value === NONE ? '' : value);

    const input = {
      name: name.trim(),
      code: code.trim().toUpperCase(),
      kind,
      description: description.trim() || undefined,
      departmentId: sent(departmentId),
      leadId: sent(leadId),
      // Empty clears it on an edit; a team keeps whatever it had.
      ...(isClient ? { contactEmail: contactEmail.trim(), contactPhone: contactPhone.trim() } : {}),
    };

    if (!input.name) return setProblem(t('A name is required.'));
    if (!input.code) return setProblem(t('A code is required.'));
    if (!CODE_PATTERN.test(input.code)) return setProblem(t(CODE_PROBLEM));

    const onSuccess = () => {
      toast.success(
        isClient
          ? isEdit
            ? t('Client updated')
            : t('Client added')
          : isEdit
            ? t('Team updated')
            : t('Team created'),
      );
      onOpenChange(false);
    };
    const onError = (error: unknown) =>
      setProblem(error instanceof Error ? error.message : t('That could not be saved.'));

    if (isEdit) {
      update.mutate({ id: team!.id, input }, { onSuccess, onError });
    } else {
      create.mutate(input, { onSuccess, onError });
    }
  };

  // A team can sit in an archived department; that option stays selectable so
  // an edit does not silently move it out. Inside a form, a select whose value
  // is not among its options clears itself, and the next save detached the team.
  const options = (departments.data ?? []).filter(
    (department) => department.active || department.id === team?.department?.id,
  );
  // Whoever leads it now stays on offer even when the reader's directory does not
  // list them, or the first save would silently take them off it.
  const lead = team?.lead;
  const people: { id: string; name: string }[] = [
    ...(users.data ?? []),
    ...(lead && !users.data?.some((user) => user.id === lead.id) ? [lead] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The form is the dialog's only flex child, so it has to carry the
            column layout for the body to scroll under a pinned footer. */}
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {isClient ? (isEdit ? t('Edit client') : t('New client')) : isEdit ? t('Edit team') : t('New team')}
            </DialogTitle>
            <DialogDescription>
              {isClient
                ? t('Clients exist only in EPM. Nothing about them leaves it.')
                : t('Teams exist only in EPM. Nothing about them leaves it.')}
            </DialogDescription>
          </DialogHeader>

          <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-kind">{t('Type')}</Label>
              <Select value={kind} onValueChange={(value) => setKind(value === 'client' ? 'client' : 'internal')}>
                <SelectTrigger id="team-kind" aria-label={t('Type')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">{t('Internal team')}</SelectItem>
                  <SelectItem value="client">{t('External client')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-name" required>
                {t('Name')}
              </Label>
              <Input
                id="team-name"
                value={name}
                maxLength={120}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder={isClient ? t('The client’s company name') : t('Platform Delivery')}
              />
            </div>

            <CodeField id="team-code" value={code} onChange={setCode} placeholder={isClient ? 'CLIENT' : 'PLAT'} />

            {isClient ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="team-email">{t('Contact email')}</Label>
                  <Input
                    id="team-email"
                    type="email"
                    dir="ltr"
                    value={contactEmail}
                    maxLength={254}
                    onChange={(event) => setContactEmail(event.target.value)}
                    placeholder="name@client.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="team-phone">{t('Contact phone')}</Label>
                  <Input
                    id="team-phone"
                    type="tel"
                    dir="ltr"
                    value={contactPhone}
                    maxLength={40}
                    onChange={(event) => setContactPhone(event.target.value)}
                    placeholder="+971 4 000 0000"
                  />
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="team-department">{t('Department')}</Label>
              {/* An empty value while loading shows the placeholder instead of
                  the "No department" option, which would read as a settled answer. */}
              <Select
                value={departments.isLoading ? '' : departmentId}
                onValueChange={setDepartmentId}
                disabled={departments.isLoading}
              >
                <SelectTrigger id="team-department" aria-label={t('Select a department')}>
                  <SelectValue
                    placeholder={departments.isLoading ? t('Loading…') : t('No department')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('No department')}</SelectItem>
                  {options.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.active ? department.name : t('{name} (archived)', { name: department.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>
                {isClient
                  ? t('The department that serves this client, if one does.')
                  : !departments.isLoading && options.length === 0
                    ? t('No departments yet. A team may exist without one.')
                    : t('A team may exist without one.')}
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-lead">{isClient ? t('Account manager') : t('Lead')}</Label>
              <Select
                value={users.isLoading ? '' : leadId}
                onValueChange={setLeadId}
                disabled={users.isLoading}
              >
                <SelectTrigger id="team-lead" aria-label={isClient ? t('Select an account manager') : t('Select a lead')}>
                  <SelectValue
                    placeholder={users.isLoading ? t('Loading…') : isClient ? t('No account manager') : t('No lead')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{isClient ? t('No account manager') : t('No lead')}</SelectItem>
                  {people.map((user) => (
                    <SelectItem key={user.id} value={String(user.id)}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!users.isLoading && people.length === 0 ? (
                <FieldHint>{t('Nobody in the directory to choose from.')}</FieldHint>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-description">{t('Description')}</Label>
              <Textarea
                id="team-description"
                rows={3}
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={isClient ? t('What the organisation delivers for this client.') : t('What this team delivers.')}
              />
            </div>

            {problem ? <Alert tone="danger">{problem}</Alert> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {isEdit ? t('Save changes') : isClient ? t('Add client') : t('Create team')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
