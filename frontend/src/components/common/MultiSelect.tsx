import { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Searchable multiple-choice control.
 *
 * Built for query filters, where OpenProject reports that a filter accepts many
 * values and the option list can run to dozens — a plain list of checkboxes
 * stops being usable somewhere around the fourteen statuses this instance
 * defines, so the options are searchable.
 *
 * Selection is shown on the trigger rather than only inside the popover, so a
 * filter's state is readable without opening it.
 */

export interface MultiSelectOption {
  id: string;
  name: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  selected: MultiSelectOption[];
  onChange: (selected: MultiSelectOption[]) => void;
  placeholder?: string;
  /** Accessible name; the trigger has no visible label of its own. */
  label: string;
  className?: string;
  disabled?: boolean;
  /** Beyond this, the trigger summarises rather than listing every chip. */
  maxVisible?: number;
}

export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Select values',
  label,
  className,
  disabled,
  maxVisible = 2,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);

  const selectedIds = new Set(selected.map((option) => option.id));

  const toggle = (option: MultiSelectOption) => {
    onChange(
      selectedIds.has(option.id)
        ? selected.filter((entry) => entry.id !== option.id)
        : [...selected, option],
    );
  };

  const visible = selected.slice(0, maxVisible);
  const overflow = selected.length - visible.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          /*
           * Full width and the Button's own height, so a label above it sits
           * above it. The trigger is a Button, which is `inline-flex`: left to
           * shrink-wrap, it flows inline beside the `<label>` that precedes it
           * and the field reads as "Invite [control]" on one line while every
           * other field in the form is stacked. `w-full` is what ComboSelect
           * does for the same reason.
           *
           * The height is deliberately not pinned here. Toolbar call sites pass
           * `h-8` alongside their width, as every other control in a filter row
           * already does; a form gets the default h-9 and matches the inputs
           * either side of it.
           */
          className={cn('w-full justify-between gap-1.5 font-normal', className)}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              <>
                {visible.map((option) => (
                  <Badge key={option.id} tone="neutral" size="sm" className="shrink-0">
                    {option.name}
                  </Badge>
                ))}
                {overflow > 0 ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">+{overflow}</span>
                ) : null}
              </>
            )}
          </span>

          {selected.length > 0 ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Clear ${label}`}
              className="shrink-0 rounded p-0.5 hover:bg-muted"
              onClick={(event) => {
                // Clearing must not also open the popover.
                event.preventDefault();
                event.stopPropagation();
                onChange([]);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                onChange([]);
              }}
            >
              <X className="h-3 w-3" aria-hidden />
            </span>
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selectedIds.has(option.id);
                return (
                  <CommandItem
                    key={option.id}
                    value={option.name}
                    onSelect={() => toggle(option)}
                  >
                    <span
                      className={cn(
                        'mr-2 flex h-3.5 w-3.5 items-center justify-center rounded border',
                        isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                      )}
                      aria-hidden
                    >
                      {isSelected ? <Check className="h-2.5 w-2.5" /> : null}
                    </span>
                    {option.name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
