import { useState } from 'react';
import { X } from 'lucide-react';

import { ComboSelect } from '@/components/common/ComboSelect';
import { Badge } from '@/components/ui/badge';
import { useUsers } from '@/hooks/useUsers';
import { t } from '@/lib/i18n';
import type { AutomationOptions, PersonSpec } from '@/types';
import { PERSON_WORDS } from './vocabulary';

/**
 * Picks people the way rules and escalation paths name them: a person by
 * name, or someone relative to the item — the assignee, the owner, a manager,
 * everyone in a role. `kinds` limits the choice to what makes sense where it
 * is used; `single` keeps one.
 */
export function PersonPicker({
  value,
  onChange,
  options,
  kinds,
  single = false,
  emptyText = t('Nobody yet'),
  label = t('Add person'),
}: {
  value: PersonSpec[];
  onChange: (value: PersonSpec[]) => void;
  options?: AutomationOptions;
  kinds: PersonSpec['kind'][];
  single?: boolean;
  emptyText?: string;
  label?: string;
}) {
  const users = useUsers();
  const [adding, setAdding] = useState<string>();

  const key = (spec: PersonSpec) =>
    spec.kind === 'user' ? `user:${spec.userId}` : spec.kind === 'project_role' ? `role:${spec.roleId}` : spec.kind;
  const name = (spec: PersonSpec) => {
    if (spec.kind === 'user') return users.data?.find((user) => user.id === spec.userId)?.name ?? t('Person {id}', { id: spec.userId });
    if (spec.kind === 'project_role') {
      return t('Role: {role}', { role: options?.roles.find((role) => role.id === spec.roleId)?.name ?? spec.roleId });
    }
    return PERSON_WORDS[spec.kind];
  };

  const choices = [
    ...kinds
      .filter((kind) => kind !== 'user' && kind !== 'project_role')
      .map((kind) => ({ id: kind, name: PERSON_WORDS[kind] })),
    ...(kinds.includes('project_role')
      ? (options?.roles ?? []).map((role) => ({ id: `role:${role.id}`, name: t('Everyone in role: {role}', { role: role.name }) }))
      : []),
    ...(kinds.includes('user') ? (users.data ?? []).map((user) => ({ id: `user:${user.id}`, name: user.name })) : []),
  ].filter((choice) => !value.some((spec) => key(spec) === choice.id));

  const add = (id?: string) => {
    if (!id) return;
    const spec: PersonSpec = id.startsWith('user:')
      ? { kind: 'user', userId: id.slice(5) }
      : id.startsWith('role:')
        ? { kind: 'project_role', roleId: id.slice(5) }
        : ({ kind: id } as PersonSpec);
    onChange(single ? [spec] : [...value, spec]);
    setAdding(undefined);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? <span className="text-2xs text-muted-foreground">{emptyText}</span> : null}
        {value.map((spec) => (
          <Badge key={key(spec)} tone="neutral" size="sm" className="gap-1">
            {name(spec)}
            <button
              type="button"
              aria-label={t('Remove {name}', { name: name(spec) })}
              onClick={() => onChange(value.filter((one) => key(one) !== key(spec)))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      {!single || value.length === 0 ? (
        <ComboSelect label={label} options={choices} value={adding} onChange={add} placeholder={single ? t('Choose…') : t('Add…')} />
      ) : null}
    </div>
  );
}
