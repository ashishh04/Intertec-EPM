import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { GitBranch, Plus, Search, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useCreateRelation,
  useDeleteRelation,
  useRelatable,
  useRelationTypes,
  useRelations,
} from '@/hooks/useCollaboration';
import { useDebounce } from '@/hooks/useDebounce';
import type { ID } from '@/types';

/**
 * How this work package relates to others.
 *
 * Direction is settled by the backend: each relation arrives already stated
 * from this task's point of view, so a row is rendered as-is. Nothing here
 * inspects which end of the relation this task sits on, because getting that
 * wrong would silently invert the meaning of half the list.
 *
 * Targets are searched rather than listed — the project's work packages are
 * never all loaded into the browser to be filtered here.
 */

interface TaskRelationsProps {
  workPackageId: ID;
}

export function TaskRelations({ workPackageId }: TaskRelationsProps) {
  const relations = useRelations(workPackageId);
  const create = useCreateRelation(workPackageId);
  const remove = useDeleteRelation(workPackageId);

  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<string>();
  const [term, setTerm] = useState('');

  const types = useRelationTypes(adding);
  // Typing should not fire a request per keystroke.
  const search = useDebounce(term, 250);
  const candidates = useRelatable(workPackageId, search, adding && Boolean(type));

  const chosenType = type ?? types.data?.[0]?.value;

  const close = () => {
    setAdding(false);
    setType(undefined);
    setTerm('');
  };

  const items = relations.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
          Relations
          {items.length > 0 ? (
            <span className="text-2xs font-normal text-muted-foreground">{items.length}</span>
          ) : null}
        </CardTitle>

        <Popover
          open={adding}
          onOpenChange={(open) => (open ? setAdding(true) : close())}
        >
          <PopoverTrigger asChild>
            <Button size="sm" variant="secondary" className="h-8">
              <Plus className="h-3.5 w-3.5" />
              Add relation
            </Button>
          </PopoverTrigger>

          <PopoverContent align="end" className="w-80 space-y-2 p-2">
            <div className="space-y-1">
              <label
                htmlFor="relation-type"
                className="text-2xs font-medium text-muted-foreground"
              >
                This task…
              </label>
              {/* The vocabulary is served by the backend, so a direction added
                  upstream appears here without a change to this file. */}
              <select
                id="relation-type"
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={chosenType ?? ''}
                disabled={types.isLoading}
                onChange={(event) => setType(event.target.value)}
              >
                {types.data?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="relation-search" className="text-2xs font-medium text-muted-foreground">
                …this one
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="relation-search"
                  value={term}
                  placeholder="Search by subject or id"
                  className="h-8 pl-7 text-xs"
                  onChange={(event) => setTerm(event.target.value)}
                />
              </div>
            </div>

            {candidates.isLoading ? (
              <div className="space-y-1">
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
              </div>
            ) : (candidates.data?.length ?? 0) === 0 ? (
              <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                {search ? 'Nothing matched that search.' : 'No other tasks are available.'}
              </p>
            ) : (
              <ul className="max-h-56 overflow-y-auto">
                {candidates.data?.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      disabled={create.isPending || !chosenType}
                      className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        if (!chosenType) return;
                        create.mutate(
                          { type: chosenType, relatedId: candidate.id },
                          {
                            onSuccess: () => {
                              close();
                              toast.success('Relation added');
                            },
                            onError: (error) =>
                              toast.error('Could not add that relation', {
                                description:
                                  error instanceof Error ? error.message : undefined,
                              }),
                          },
                        );
                      }}
                    >
                      <span className="shrink-0 text-muted-foreground">#{candidate.id}</span>
                      <span className="truncate">{candidate.subject}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      </CardHeader>

      <CardContent className="pt-4">
        {relations.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No relations"
            description="Link this task to another to record that it blocks, follows or relates to it."
          />
        ) : (
          <ul className="space-y-1.5">
            {items.map((relation) => (
              <li
                key={relation.id}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="w-24 shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  {relation.label}
                </span>

                {/* Always an EPM route. The related task is opened here, never
                    in OpenProject. */}
                <Link
                  to={`/tasks/${relation.related.id}`}
                  className="min-w-0 flex-1 truncate text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-muted-foreground">#{relation.related.id}</span>{' '}
                  {relation.related.subject}
                </Link>

                {relation.lag !== undefined ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {relation.lag}d lag
                  </span>
                ) : null}

                {relation.can.delete ? (
                  <button
                    type="button"
                    aria-label={`Remove relation to ${relation.related.subject}`}
                    className="rounded p-1.5 text-muted-foreground hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() =>
                      remove.mutate(relation, {
                        onSuccess: () => toast.success('Relation removed'),
                        onError: (error) =>
                          toast.error('Could not remove that relation', {
                            description: error instanceof Error ? error.message : undefined,
                          }),
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
