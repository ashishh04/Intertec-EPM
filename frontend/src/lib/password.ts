import type { PasswordPolicy, PasswordRule } from '@/types';

/**
 * The instance's password policy, evaluated against a candidate.
 *
 * Shared by the two places a password is chosen — the gate a new account is held
 * at, and the Security section of Settings — because two copies of this drift,
 * and the one that drifts is the one that tells somebody their password is fine
 * before the backend refuses it.
 *
 * Nothing here is the check. The backend reads the same policy from the instance
 * and applies it before forwarding the change, so this is a preview of that
 * check rather than a second, independent one.
 */

export const RULE_LABELS: Record<PasswordRule, string> = {
  lowercase: 'A lowercase letter',
  uppercase: 'An uppercase letter',
  numeric: 'A number',
  special: 'A symbol',
};

export const RULE_TESTS: Record<PasswordRule, (value: string) => boolean> = {
  lowercase: (value) => /[a-z]/.test(value),
  uppercase: (value) => /[A-Z]/.test(value),
  numeric: (value) => /\d/.test(value),
  // Anything that is not a letter, a digit or whitespace — broader than a fixed
  // list, which would reject symbols people legitimately use.
  special: (value) => /[^A-Za-z0-9\s]/.test(value),
};

export interface PasswordRuleRow {
  id: string;
  label: string;
  ok: boolean;
}

/** Every requirement the instance publishes, with whether this value meets it. */
export function passwordRuleRows(
  policy: PasswordPolicy | undefined,
  value: string,
): PasswordRuleRow[] {
  if (!policy) return [];

  const rows: PasswordRuleRow[] = [];
  if (policy.minLength > 0) {
    rows.push({
      id: 'length',
      label: `At least ${policy.minLength} characters`,
      ok: value.length >= policy.minLength,
    });
  }
  for (const rule of policy.activeRules) {
    rows.push({ id: rule, label: RULE_LABELS[rule], ok: RULE_TESTS[rule](value) });
  }
  return rows;
}

/**
 * Whether the policy is satisfied.
 *
 * `minAdheredRules` is a count, not a flag: OpenProject lets an administrator
 * require "any 3 of 4", so this counts how many rules are met rather than
 * insisting on all of them. Zero means only the length applies.
 */
export function passwordSatisfies(policy: PasswordPolicy | undefined, value: string): boolean {
  if (!policy) return false;
  if (value.length < policy.minLength) return false;

  const met = policy.activeRules.filter((rule) => RULE_TESTS[rule](value)).length;
  return met >= policy.minAdheredRules;
}
