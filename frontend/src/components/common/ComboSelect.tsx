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
import { t } from '@/lib/i18n';
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
  /** Nesting level in a tree, drawn as an indent: a subtask under its parent. */
  depth?: number;
  /** Short text at the end of the row, e.g. a task's dates. */
  aside?: string;
  /** Drawn quieter, e.g. a closed task that can still be chosen. */
  muted?: boolean;
  /**
   * The heading the option is listed under, e.g. a task's category. Groups
   * appear in the order their first option does; options without one are
   * listed after them, under `ungroupedLabel`.
   */
  group?: string;
  /** Shown but not choosable, e.g. a review task for someone who may not review. */
  disabled?: boolean;
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
  /** What is being typed, for a list too long to hold here that is searched on the server. */
  onSearch?: (term: string) => void;
  /** A wider list than the trigger, for options with more to say than a name. */
  wide?: boolean;
  /** The heading for options with no `group`, when others have one. */
  ungroupedLabel?: string;
  /** The search box's prompt, where "Search" and the accessible name do not read as one. */
  searchPlaceholder?: string;
}

/** Options under their headings, in the order each heading first appears; the ungrouped last. */
function groupsOf(options: ComboOption[], ungroupedLabel: string): { heading?: string; options: ComboOption[] }[] {
  if (!options.some((option) => option.group)) return [{ options }];
  const groups = new Map<string, ComboOption[]>();
  const ungrouped: ComboOption[] = [];
  for (const option of options) {
    if (!option.group) {
      ungrouped.push(option);
      continue;
    }
    groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  }
  const out: { heading?: string; options: ComboOption[] }[] = [...groups.entries()].map(([heading, list]) => ({ heading, options: list }));
  if (ungrouped.length > 0) out.push({ heading: ungroupedLabel, options: ungrouped });
  return out;
}

export function ComboSelect({
  options,
  value,
  onChange,
  label,
  id,
  placeholder = t('Select'),
  emptyLabel = t('Nothing matches'),
  clearable = false,
  disabled,
  loading,
  className,
  onSearch,
  wide = false,
  ungroupedLabel = t('Other'),
  searchPlaceholder,
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
      {/*
        Modal, so the list scrolls with the mouse wheel inside a dialog. The list
        is drawn outside the dialog's own markup, and an open dialog swallows
        wheel scrolling everywhere outside itself — a project or task list longer
        than the box could only be scrolled by dragging its scrollbar. A modal
        pop-over takes the scroll lock over while it is open, for its own list.
      */}
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            disabled={disabled || loading}
            className={cn('w-full justify-between font-normal', showClear && 'pe-14')}
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {/* The stored value is shown even when it is not in the list: a task
                  that has since closed, or a project the filter no longer covers,
                  must still read as what was chosen rather than as nothing. */}
              {loading ? t('Loading…') : (selected?.name ?? (value ? value : placeholder))}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>

        <PopoverContent
          className={cn(
            'p-0',
            wide ? 'w-[min(32rem,calc(100vw_-_2rem))] min-w-[--radix-popover-trigger-width]' : 'w-[--radix-popover-trigger-width]',
          )}
          align="start"
        >
          <Command>
            <CommandInput placeholder={searchPlaceholder ?? t('Search {label}', { label: label.toLowerCase() })} onValueChange={onSearch} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              {groupsOf(options, ungroupedLabel).map((group) => (
                <CommandGroup
                  key={group.heading ?? ''}
                  heading={group.heading}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {group.options.map((option) => (
                    <CommandItem
                      key={option.id}
                      // `value` is what cmdk filters on, so the hint has to be in it
                      // or searching for a project code would find nothing. The id
                      // keeps two tasks of the same name apart.
                      value={`${option.name} ${option.hint ?? ''} ${option.group ?? ''} #${option.id}`}
                      disabled={option.disabled}
                      onSelect={() => {
                        if (option.disabled) return;
                        onChange(option.id);
                        setOpen(false);
                      }}
                      className={cn('gap-2', option.muted && 'text-muted-foreground')}
                      // An indent per level, capped so a deep tree stays readable.
                      style={option.depth ? { paddingInlineStart: `${0.5 + Math.min(option.depth, 6) * 0.875}rem` } : undefined}
                    >
                      <Check
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          option.id === value ? 'opacity-100' : 'opacity-0',
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" dir="auto">{option.name}</span>
                        {option.hint ? (
                          <span className="block truncate text-2xs text-muted-foreground" dir="auto">
                            {option.hint}
                          </span>
                        ) : null}
                      </span>
                      {option.aside ? (
                        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">{option.aside}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {showClear ? (
        <button
          type="button"
          aria-label={t('Clear {label}', { label })}
          onClick={() => onChange(undefined)}
          className={cn(
            'absolute end-8 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground',
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
