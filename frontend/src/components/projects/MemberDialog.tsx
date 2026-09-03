import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/common/EmptyState';
import { UserAvatar } from '@/components/common/UserAvatar';
import {
  useAddProjectMember,
  useMemberCandidates,
  useProjectRoles,
  useSetMemberRoles,
} from '@/hooks/useMembers';
import { useUserMap } from '@/hooks/useUsers';
import type { EpmProjectMember, ID } from '@/types';
import { Users } from 'lucide-react';

/**
 * Add someone to a project, or change the role they already hold.
 *
 * One dialog for both, because they differ only in whether the person is
 * already chosen. Adding grants real access in OpenProject and sends the
 * invitation mail OpenProject would have sent anyway — this is not an EPM-only
 * record, and the wording says so.
 *
 * The candidate list comes from the backend already filtered to people who are
 * neither locked nor members, so this never has to subtract one list from
 * another and get it wrong.
 */

interface MemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: ID;
  /** Present when editing an existing member's role. */
  member?: EpmProjectMember;
}

export function MemberDialog({ open, onOpenChange, projectId, member }: MemberDialogProps) {
  const isEdit = Boolean(member);

  const candidates = useMemberCandidates(projectId, open && !isEdit);
  const roles = useProjectRoles(open);
  const addMember = useAddProjectMember(projectId);
  const setRoles = useSetMemberRoles(projectId);
  const users = useUserMap();

  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [problem, setProblem] = useState<string>();

  // Keyed on the id, not the object: the record is a fresh object on every
  // refetch, and depending on it reset the form under the user mid-edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setUserId(member?.userId ?? '');
    // A membership can carry several roles upstream. This edits the first,
    // which is what the list shows; multi-role memberships are left to
    // OpenProject rather than half-represented here.
    setRoleId(member?.roles[0]?.id ?? '');
    setProblem(undefined);
  }, [open, member?.membershipId]);

  const pending = addMember.isPending || setRoles.isPending;
  const available = candidates.data ?? [];
  const person = users.get(userId);

  const fail = (error: unknown) =>
    setProblem(error instanceof Error ? error.message : 'That could not be saved.');

  const submit = () => {
    setProblem(undefined);

    if (!roleId) {
      setProblem('Choose a role.');
      return;
    }

    if (isEdit && member) {
      setRoles.mutate(
        { membershipId: member.membershipId, roleIds: [roleId] },
        {
          onSuccess: () => {
            toast.success('Role updated');
            onOpenChange(false);
          },
          onError: fail,
        },
      );
      return;
    }

    if (!userId) {
      setProblem('Choose someone to add.');
      return;
    }

    addMember.mutate(
      { userId, roleIds: [roleId] },
      {
        onSuccess: () => {
          toast.success('Member added');
          onOpenChange(false);
        },
        onError: fail,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Change role' : 'Add a member'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Their role on this project. This changes their access in OpenProject.'
              : 'Grants access to this project in OpenProject, and OpenProject emails them.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {isEdit ? (
            <div className="flex items-center gap-2 rounded-lg border border-border p-3">
              <UserAvatar user={person} size="sm" />
              <p className="truncate text-xs font-medium">{person?.name ?? 'Unknown person'}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="member-person">Person</Label>
              {candidates.isLoading ? (
                <p className="text-2xs text-muted-foreground">Loading…</p>
              ) : available.length === 0 ? (
                <EmptyState
                  size="inline"
                  icon={Users}
                  title="Nobody left to add"
                  description="Everyone in the directory is already a member of this project."
                />
              ) : (
                <Select value={userId} onValueChange={setUserId}>
                  <SelectTrigger id="member-person" aria-label="Select a person">
                    <SelectValue placeholder="Choose someone" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((candidate) => (
                      <SelectItem key={candidate.userId} value={candidate.userId}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="member-role">Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id="member-role" aria-label="Select a role">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {(roles.data ?? []).map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              Roles are OpenProject's, and decide what this person can do here.
            </p>
          </div>

          {problem ? <p className="text-2xs text-danger">{problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || (!isEdit && available.length === 0)}
          >
            {isEdit ? 'Save' : 'Add member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
