import { Label, FieldHint } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { Weekday } from '@/types';

/**
 * The controls the Settings sections are built from.
 *
 * Shared so every section has the same row height, the same label/hint pairing
 * and the same disabled treatment. A settings page where one card's switches sit
 * a few pixels off the next one's reads as unfinished, and that is exactly the
 * kind of drift that happens when each section builds its own rows.
 */

export function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  /** Inert, and reads as such, because a switch above it is off. */
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className={cn('min-w-0 space-y-0.5', disabled && 'opacity-60')}>
        <Label htmlFor={id}>{label}</Label>
        <FieldHint>{hint}</FieldHint>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** A row whose control is not a switch — a select, a date pair, a number. */
export function FieldRow({
  label,
  hint,
  htmlFor,
  disabled,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className={cn('min-w-0 space-y-0.5', disabled && 'opacity-60')}>
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint ? <FieldHint>{hint}</FieldHint> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * A weekday picker.
 *
 * Toggle buttons rather than seven switches or a multi-select: a week is a shape
 * people recognise at a glance, and the point of this control is to see that
 * shape — five on and two off — without reading anything.
 *
 * The stored value keeps whatever order it has; this always renders Monday
 * first, so the row cannot re-arrange itself as days are clicked.
 */
export function WeekdayPicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value: Weekday[];
  onChange: (days: Weekday[]) => void;
  /** Accessible group name, e.g. "Reminder days". */
  label: string;
  disabled?: boolean;
}) {
  const selected = new Set(value);

  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {ORDER.map((day) => {
        const on = selected.has(day);
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() =>
              // Rebuilt from the canonical order rather than appended to, so the
              // stored list stays readable and two people who picked the same
              // days store the same thing.
              onChange(ORDER.filter((candidate) => (candidate === day ? !on : selected.has(candidate))))
            }
            className={cn(
              'h-7 w-11 rounded-md border text-2xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              disabled && 'cursor-not-allowed opacity-60',
              on
                ? 'border-primary/40 bg-primary-soft text-primary'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {WEEKDAY_LABELS[day]}
          </button>
        );
      })}
    </div>
  );
}

/** Every hour of the day, labelled in the person's own clock convention. */
export function hourOptions(timeFormat: '24h' | '12h'): { value: string; label: string }[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label:
      timeFormat === '24h'
        ? `${String(hour).padStart(2, '0')}:00`
        : `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? 'am' : 'pm'}`,
  }));
}
