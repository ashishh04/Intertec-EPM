import { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

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
 * Searchable single-choice control — `MultiSelect` for one value.
 *
 * `Select` is the right control for a handful of fixed options and the wrong one
 * past that: picking a project out of two hundred, or a task out of a sprint's
 * worth, means reading a scroll list with no way to narrow it. This is the same
 * Command/Popover pairing `MultiSelect` already uses, so the two read as one
 * control family rather than as two different pickers.
 *
 * Clearing is offered only when the field is genuinely optional, so a required
 * choice cannot be emptied back into a state the form will refuse.
 */

export interface ComboOption {
  id: string;
  name: string;
  /** Second line, e.g. a project code or a parent's name. */
  hint?: string;
}

interface ComboSelectProps {
  options: ComboOption[];
  value?: string;
  onChange: (value?: string) => void;
  /** Accessible name. Pair it with a visible `<Label htmlFor>` when there is one. */
  label: string;
  id?: string;
  placeholder?: string;
  /** Shown when the option list is empty, e.g. "No open tasks in this project". */
  emptyLabel?: string;
  /** Offers a clear button and lets the popover set the value back to nothing. */
  clearable?: boolean;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}

export function ComboSelect({
  options,
  value,
  onChange,
  label,
  id,
  placeholder = 'Select',
  emptyLabel = 'Nothing matches',
  clearable = false,
  disabled,
  loading,
  className,
}: ComboSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);

  const showClear = clearable && Boolean(value) && !disabled && !loading;

  return (
    /*
     * The clear control is a sibling of the trigger, not a child of it.
     *
     * A button inside a button is invalid markup and behaves accordingly: the
     * inner one is unreachable by keyboard in several browsers, and screen
     * readers announce one control where there are two. Overlaying it instead
     * costs a wrapper and a little right padding on the trigger, and gives a real
     * button with a real accessible name.
     */
    <div className={cn('relative', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            disabled={disabled || loading}
            className={cn('w-full justify-between font-normal', showClear && 'pr-14')}
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {/* The stored value is shown even when it is not in the list: a task
                  that has since closed, or a project the filter no longer covers,
                  must still read as what was chosen rather than as nothing. */}
              {loading ? 'Loading…' : (selected?.name ?? (value ? value : placeholder))}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder={`Search ${label.toLowerCase()}`} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    // `value` is what cmdk filters on, so the hint has to be in it
                    // or searching for a project code would find nothing.
                    value={`${option.name} ${option.hint ?? ''}`}
                    onSelect={() => {
                      onChange(option.id);
                      setOpen(false);
                    }}
                    className="gap-2"
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        option.id === value ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.name}</span>
                      {option.hint ? (
                        <span className="block truncate text-2xs text-muted-foreground">
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {showClear ? (
        <button
          type="button"
          aria-label={`Clear ${label}`}
          onClick={() => onChange(undefined)}
          className={cn(
            'absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}