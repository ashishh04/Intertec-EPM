import { useMemo } from 'react';
import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  useProjectAssignees,
  usePriorities,
  useProjectVersions,
  useStatuses,
  useTypes,
} from '@/hooks/useCatalog';
import { useProjects } from '@/hooks/useProjects';
import type {
  QueryFilterInstance,
  QueryFilterSchema,
  QueryOperatorSchema,
} from '@/services/api/queries';
import type { ID } from '@/types';

/**
 * Builds a work package filter from OpenProject's own metadata.
 *
 * Every filter, operator and value shape here is discovered upstream — this
 * instance offers 47 in a project, against the six the previous bar could
 * express. Nothing is enumerated in this file, which is what makes a custom
 * field added in OpenProject appear with no code change.
 *
 * Controls are chosen from the value type the schema reports, not from the
 * filter's name. An operator that carries no value type renders no value
 * control at all, because operators like "open" and "is empty" are complete on
 * their own and sending values with them is rejected.
 */

interface QueryBuilderProps {
  schema: QueryFilterSchema[];
  filters: QueryFilterInstance[];
  onChange: (filters: QueryFilterInstance[]) => void;
  /** Scopes value candidates — assignees and versions are per project. */
  projectId?: ID;
  isLoading?: boolean;
  className?: string;
}

/** Candidate values for a resource-typed filter, keyed by the schema's type. */
function useResourceValues(valueType: string | undefined, projectId?: ID) {
  const statuses = useStatuses();
  const types = useTypes();
  const priorities = usePriorities();
  const assignees = useProjectAssignees(valueType === 'User' ? projectId : undefined);
  const versions = useProjectVersions(valueType === 'Version' ? projectId : undefined);
  const projects = useProjects();

  return useMemo(() => {
    switch (valueType) {
      case 'Status':
        return statuses.data?.map((s) => ({ id: s.id, name: s.name }));
      case 'Type':
        return types.data?.map((t) => ({ id: t.id, name: t.name }));
      case 'Priority':
        return priorities.data?.map((p) => ({ id: p.id, name: p.name }));
      case 'User':
        return assignees.data?.map((u) => ({ id: u.id, name: u.name }));
      case 'Version':
        return versions.data?.map((v) => ({ id: v.id, name: v.name }));
      case 'Project':
        return projects.data?.map((p) => ({ id: p.id, name: p.name }));
      default:
        // CustomOption, Role, WorkPackage and anything added upstream later.
        // Rendering a free-text id beats hiding the filter entirely.
        return undefined;
    }
  }, [valueType, statuses.data, types.data, priorities.data, assignees.data, versions.data, projects.data]);
}

function ValueControl({
  operator,
  filter,
  projectId,
  onChange,
}: {
  operator: QueryOperatorSchema;
  filter: QueryFilterInstance;
  projectId?: ID;
  onChange: (values: QueryFilterInstance['values']) => void;
}) {
  const candidates = useResourceValues(operator.valueType, projectId);

  // Operators such as `o`, `*` and `!*` carry no value schema at all.
  if (!operator.valueType) return null;

  if (operator.arity === 'range') {
    const [from, to] = [filter.values[0]?.id ?? '', filter.values[1]?.id ?? ''];
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          value={from}
          aria-label={`${filter.name} from`}
          onChange={(event) => onChange([{ id: event.target.value }, { id: to }])}
          className="h-8 w-36"
        />
        <span className="text-2xs text-muted-foreground">to</span>
        <Input
          type="date"
          value={to}
          aria-label={`${filter.name} to`}
          onChange={(event) => onChange([{ id: from }, { id: event.target.value }])}
          className="h-8 w-36"
        />
      </div>
    );
  }

  if (candidates) {
    const selected = filter.values[0]?.id ?? '';
    return (
      <Select
        value={selected}
        onValueChange={(value) => {
          const match = candidates.find((candidate) => candidate.id === value);
          onChange([{ id: value, name: match?.name }]);
        }}
      >
        <SelectTrigger className="h-8 w-52" aria-label={`${filter.name} value`}>
          <SelectValue placeholder="Select a value" />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (operator.valueType === 'Boolean') {
    return (
      <Select
        value={filter.values[0]?.id ?? ''}
        onValueChange={(value) => onChange([{ id: value }])}
      >
        <SelectTrigger className="h-8 w-32" aria-label={`${filter.name} value`}>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="t">Yes</SelectItem>
          <SelectItem value="f">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  const isNumeric = operator.valueType === 'Integer' || operator.valueType === 'Float';
  const isDate = operator.valueType === 'Date' || operator.valueType === 'DateTime';

  return (
    <Input
      type={isDate ? 'date' : isNumeric ? 'number' : 'text'}
      value={filter.values[0]?.id ?? ''}
      aria-label={`${filter.name} value`}
      placeholder={operator.isResource ? 'Value id' : 'Value'}
      onChange={(event) => onChange([{ id: event.target.value }])}
      className="h-8 w-52"
    />
  );
}

export function QueryBuilder({
  schema,
  filters,
  onChange,
  projectId,
  isLoading,
  className,
}: QueryBuilderProps) {
  const byId = useMemo(() => new Map(schema.map((entry) => [entry.id, entry])), [schema]);

  // Offer only filters not already applied; OpenProject allows one instance
  // of each.
  const available = useMemo(
    () => schema.filter((entry) => !filters.some((filter) => filter.id === entry.id)),
    [schema, filters],
  );

  const addFilter = (id: string) => {
    const definition = byId.get(id);
    // Operators arrive sorted by symbol, which puts `!` (is not) first — a
    // surprising default. Prefer equality, then anything, before giving up.
    const operator =
      definition?.operators.find((entry) => entry.id === '=') ??
      definition?.operators.find((entry) => entry.id === '~') ??
      definition?.operators[0];
    if (!definition || !operator) return;

    onChange([
      ...filters,
      { id: definition.id, name: definition.name, operator: operator.id, values: [] },
    ]);
  };

  const update = (index: number, next: QueryFilterInstance) => {
    onChange(filters.map((filter, position) => (position === index ? next : filter)));
  };

  const remove = (index: number) => {
    onChange(filters.filter((_, position) => position !== index));
  };

  return (
    <div className={cn('space-y-2', className)}>
      {filters.map((filter, index) => {
        const definition = byId.get(filter.id);
        const operator = definition?.operators.find((entry) => entry.id === filter.operator);

        return (
          <div
            key={filter.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2"
          >
            <Badge tone="neutral" size="sm" className="shrink-0">
              {definition?.name ?? filter.name}
            </Badge>

            <Select
              value={filter.operator}
              onValueChange={(value) =>
                // Values rarely survive an operator change — a date range and a
                // "today" operator want different shapes — so they are dropped.
                update(index, { ...filter, operator: value, values: [] })
              }
            >
              <SelectTrigger className="h-8 w-44" aria-label={`${filter.name} operator`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(definition?.operators ?? []).map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {operator ? (
              <ValueControl
                operator={operator}
                filter={filter}
                projectId={projectId}
                onChange={(values) => update(index, { ...filter, values })}
              />
            ) : null}

            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-8 w-8 p-0"
              aria-label={`Remove ${filter.name} filter`}
              onClick={() => remove(index)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Select value="" onValueChange={addFilter} disabled={isLoading || available.length === 0}>
          <SelectTrigger className="h-8 w-56" aria-label="Add filter">
            <SelectValue placeholder={isLoading ? 'Loading filters…' : 'Add filter'} />
          </SelectTrigger>
          <SelectContent>
            {available.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filters.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChange([])}>
            Clear all
          </Button>
        ) : null}

        {!isLoading ? (
          <span className="text-2xs text-muted-foreground">
            {schema.length} filters available
          </span>
        ) : null}
      </div>
    </div>
  );
}

export { Plus };
