import { ArrowDown, ArrowUp, Columns3, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { QueryColumn } from '@/services/api/queries';

/**
 * Chooses which columns a view shows, and in what order.
 *
 * The list comes from OpenProject — 26 columns on this instance, including any
 * custom field — so nothing here is enumerated and a field added upstream
 * appears without a change.
 *
 * Not every upstream column can be shown. The table renders the normalized task
 * model, which does not carry attributes like category, duration or custom field
 * values, and inventing a renderer for data EPM does not hold would produce
 * blank columns that look like missing data. Those are listed as unavailable
 * with the reason rather than hidden, so the gap is visible instead of puzzling.
 */

interface ColumnPickerProps {
  /** Every column the instance offers, in OpenProject's order. */
  available: QueryColumn[];
  /** Column ids the table can actually render. */
  renderable: string[];
  /** Current selection, in display order. */
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Columns that must stay: the table needs them to navigate. */
  required?: string[];
  disabled?: boolean;
  className?: string;
}

export function ColumnPicker({
  available,
  renderable,
  selected,
  onChange,
  required = [],
  disabled,
  className,
}: ColumnPickerProps) {
  const renderableSet = new Set(renderable);
  const byId = new Map(available.map((column) => [column.id, column]));

  const toggle = (id: string) => {
    if (required.includes(id)) return;
    onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  };

  const move = (id: string, direction: -1 | 1) => {
    const index = selected.indexOf(id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= selected.length) return;

    const next = [...selected];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved as string);
    onChange(next);
  };

  const unsupported = available.filter((column) => !renderableSet.has(column.id));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className={cn('h-8', className)} disabled={disabled}>
          <Columns3 className="h-3.5 w-3.5" />
          Columns
          <Badge tone="neutral" size="sm" className="ml-1">
            {selected.length}
          </Badge>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" align="end">
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium">Columns</p>
          <p className="text-2xs text-muted-foreground">
            Shown in this order. Saved with the view.
          </p>
        </div>

        <ScrollArea className="max-h-80">
          <div className="p-1.5">
            {/* Selected first, in display order, so reordering is direct. */}
            {selected.map((id, index) => {
              const column = byId.get(id);
              if (!column) return null;
              const isRequired = required.includes(id);

              return (
                <div
                  key={id}
                  className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/60"
                >
                  <Checkbox
                    checked
                    disabled={isRequired}
                    onCheckedChange={() => toggle(id)}
                    aria-label={`Hide ${column.name}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">{column.name}</span>

                  {isRequired ? (
                    <span className="text-2xs text-muted-foreground">required</span>
                  ) : null}

                  <button
                    type="button"
                    aria-label={`Move ${column.name} up`}
                    disabled={index === 0}
                    onClick={() => move(id, -1)}
                    className="rounded p-0.5 text-muted-foreground disabled:opacity-30 hover:bg-muted"
                  >
                    <ArrowUp className="h-3 w-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${column.name} down`}
                    disabled={index === selected.length - 1}
                    onClick={() => move(id, 1)}
                    className="rounded p-0.5 text-muted-foreground disabled:opacity-30 hover:bg-muted"
                  >
                    <ArrowDown className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              );
            })}

            {selected.length > 0 ? <div className="my-1.5 h-px bg-border" /> : null}

            {available
              .filter((column) => renderableSet.has(column.id) && !selected.includes(column.id))
              .map((column) => (
                <div
                  key={column.id}
                  className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/60"
                >
                  <Checkbox
                    checked={false}
                    onCheckedChange={() => toggle(column.id)}
                    aria-label={`Show ${column.name}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">{column.name}</span>
                </div>
              ))}

            {unsupported.length > 0 ? (
              <>
                <div className="my-1.5 h-px bg-border" />
                <p className="px-1.5 py-1 text-2xs text-muted-foreground">
                  Not available in this table
                </p>
                {unsupported.map((column) => (
                  <div
                    key={column.id}
                    className="flex items-center gap-2 rounded px-1.5 py-1 opacity-55"
                    title="This attribute is not carried by the task model EPM renders."
                  >
                    <X className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-xs">{column.name}</span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
