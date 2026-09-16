import { Input } from '@/components/ui/input';
import { FieldError, FieldHint, Label } from '@/components/ui/label';

/**
 * The short code a department, team or portfolio is known by.
 *
 * Shared by the three dialogs because the rules are identical for all of
 * them, and three copies of the same regex and hint had already started to
 * drift in wording. Each dialog keeps its own schema and mutation; this owns
 * only the field itself.
 *
 * Uppercased as it is typed, because that is how it is stored — showing one
 * thing and saving another invites a false "already taken" conflict.
 */

export const CODE_PATTERN = /^[A-Z0-9-]{2,16}$/;
export const CODE_PROBLEM = 'The code must be 2–16 letters, numbers or hyphens.';

interface CodeFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** A field-level message; replaces the hint rather than stacking under it. */
  error?: string;
}

export function CodeField({ id, value, onChange, placeholder, error }: CodeFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required>
        Code
      </Label>
      <Input
        id={id}
        value={value}
        maxLength={16}
        invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        placeholder={placeholder}
      />
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <FieldHint>2–16 letters, numbers or hyphens. Must be unique.</FieldHint>
      )}
    </div>
  );
}
