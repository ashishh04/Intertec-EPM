import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useDepartments } from '@/hooks/useDepartments';
import { useSetMapping } from '@/hooks/useEmployees';
import { useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import type { EpmEmployee } from '@/services/api/employees';

/**
 * Assign a person to a department and a team.
 *
 * Only teams valid for the chosen department are offered, and changing the
 * department clears the team so a compatible one has to be picked deliberately
 * rather than silently carried over. That is convenience: the backend rejects a
 * contradictory pair regardless of what is sent.
 *
 * A team that belongs to a department also *sets* it — selecting one fills the
 * department in, because that is what will be stored either way.
 */

const NONE = '__none__';

interface MappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: EpmEmployee;
}

export function MappingDialog({ open, onOpenChange, employee }: MappingDialogProps) {
  const setMapping = useSetMapping();
  const departments = useDepartments();
  const teams = useTeams();
  const users = useUserMap();

  const [departmentId, setDepartmentId] = useState(NONE);
  const [teamId, setTeamId] = useState(NONE);
  const [problem, setProblem] = useState<string>();

  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setDepartmentId(employee?.department?.id ?? NONE);
    setTeamId(employee?.team?.id ?? NONE);
    setProblem(undefined);
  }, [open, employee?.id]);

  const allDepartments = departments.data ?? [];
  const allTeams = teams.data ?? [];

  // A team with no department fits anywhere, so it stays on offer whichever
  // department is chosen.
  const selectableTeams =
    departmentId === NONE
      ? allTeams
      : allTeams.filter((team) => !team.department || team.department.id === departmentId);

  const chooseDepartment = (value: string) => {
    setDepartmentId(value);
    // The current team may no longer belong here.
    const team = allTeams.find((candidate) => candidate.id === teamId);
    if (team?.department && team.department.id !== value) setTeamId(NONE);
  };

  const chooseTeam = (value: string) => {
    setTeamId(value);
    // Selecting a team that belongs somewhere settles the department too.
    const team = allTeams.find((candidate) => candidate.id === value);
    if (team?.department) setDepartmentId(team.department.id);
  };

  const save = () => {
    if (!employee) return;
    setProblem(undefined);

    setMapping.mutate(
      {
        id: employee.id,
        input: {
          departmentId: departmentId === NONE ? '' : departmentId,
          teamId: teamId === NONE ? '' : teamId,
        },
      },
      {
        onSuccess: () => {
          toast.success(`${employee.name} updated`);
          onOpenChange(false);
        },
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  // What to say under the team picker: which teams are on offer, or why none.
  const teamHint = teams.isLoading
    ? null
    : allTeams.length === 0
      ? 'No teams yet.'
      : departmentId !== NONE
        ? selectableTeams.length === 0
          ? 'No teams in this department.'
          : 'Only teams in this department are listed.'
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign {employee?.name}</DialogTitle>
          <DialogDescription>
            Where this person sits in EPM. Their name and account are managed centrally.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {employee ? (
            <Card className="flex items-center gap-3 p-3">
              <UserAvatar user={users.get(employee.id)} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{employee.name}</p>
                {employee.email ? (
                  <p className="truncate text-2xs text-muted-foreground">{employee.email}</p>
                ) : null}
              </div>
            </Card>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="mapping-department">Department</Label>
            {/* An empty value while loading shows the placeholder instead of
                the "No department" option, which would read as a settled answer. */}
            <Select
              value={departments.isLoading ? '' : departmentId}
              onValueChange={chooseDepartment}
              disabled={departments.isLoading}
            >
              <SelectTrigger id="mapping-department" aria-label="Select a department">
                <SelectValue placeholder={departments.isLoading ? 'Loading…' : 'No department'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No department</SelectItem>
                {allDepartments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!departments.isLoading && allDepartments.length === 0 ? (
              <FieldHint>No departments yet.</FieldHint>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mapping-team">Team</Label>
            <Select
              value={teams.isLoading ? '' : teamId}
              onValueChange={chooseTeam}
              disabled={teams.isLoading}
            >
              <SelectTrigger id="mapping-team" aria-label="Select a team">
                <SelectValue placeholder={teams.isLoading ? 'Loading…' : 'No team'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No team</SelectItem>
                {selectableTeams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                    {team.department ? '' : ' (no department)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {teamHint ? <FieldHint>{teamHint}</FieldHint> : null}
          </div>

          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={setMapping.isPending} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
