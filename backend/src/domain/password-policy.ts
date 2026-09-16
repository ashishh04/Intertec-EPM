import { openProject } from '../openproject/client.js';
import { referenceCache, userScopedKey } from '../lib/cache.js';

/**
 * The password rules this instance enforces.
 *
 * Read from the instance rather than declared here. OpenProject owns the
 * policy — an administrator can change it at any time — so a copy in EPM would
 * be wrong the moment they did, either rejecting a password the instance would
 * take or promising one it will refuse.
 *
 * `minAdheredRules` is the number of `activeRules` a password must satisfy, not
 * a flag. Zero means **none** of the character rules are required and only the
 * length applies, which is the instance's default and is easy to misread as
 * "all of them".
 */

export interface PasswordPolicy {
  minLength: number;
  /** The character classes the instance can require, in its own vocabulary. */
  activeRules: PasswordRule[];
  /** How many of `activeRules` a password must satisfy. */
  minAdheredRules: number;
}

export type PasswordRule = 'lowercase' | 'uppercase' | 'numeric' | 'special';

/** What each rule means, and the sentence a failure is reported with. */
const RULE_TESTS: Record<PasswordRule, { label: string; met: (value: string) => boolean }> = {
  lowercase: { label: 'a lowercase letter', met: (v) => /[a-z]/.test(v) },
  uppercase: { label: 'an uppercase letter', met: (v) => /[A-Z]/.test(v) },
  numeric: { label: 'a number', met: (v) => /\d/.test(v) },
  // Anything that is not a letter, a digit or whitespace — broader than a fixed
  // list, which would refuse symbols people legitimately use.
  special: { label: 'a symbol', met: (v) => /[^A-Za-z0-9\s]/.test(v) },
};

/** A policy that asks for nothing, used when the instance cannot be read. */
const PERMISSIVE: PasswordPolicy = { minLength: 0, activeRules: [], minAdheredRules: 0 };

function isRule(value: unknown): value is PasswordRule {
  return typeof value === 'string' && value in RULE_TESTS;
}

/**
 * Cached on the reference TTL: the policy changes about as often as the
 * statuses do, and this is read on every password change and every render of
 * the form.
 */
export async function getPasswordPolicy(signal?: AbortSignal): Promise<PasswordPolicy> {
  return referenceCache.get(userScopedKey('password-policy'), async () => {
    const body = await openProject.request<{
      minLength?: unknown;
      activeRules?: unknown;
      minAdheredRules?: unknown;
    }>('/epm_admin/password_policy', { root: true, signal });

    return {
      minLength: typeof body.minLength === 'number' ? body.minLength : 0,
      activeRules: Array.isArray(body.activeRules) ? body.activeRules.filter(isRule) : [],
      minAdheredRules: typeof body.minAdheredRules === 'number' ? body.minAdheredRules : 0,
    };
  });
}

/**
 * What a password is missing, as phrases that complete "That password needs:".
 * An empty array means it satisfies the policy.
 *
 * Fails open if the instance cannot be reached: the instance checks the
 * password itself on the write that follows, so refusing here as well would
 * turn an upstream blip into "your password is wrong", which is both untrue and
 * the least useful thing to tell someone at that moment.
 */
export async function checkPassword(password: string, signal?: AbortSignal): Promise<string[]> {
  const policy = await getPasswordPolicy(signal).catch(() => PERMISSIVE);

  const failures: string[] = [];

  if (password.length < policy.minLength) {
    failures.push(`at least ${policy.minLength} characters`);
  }

  // `minAdheredRules` of the active rules, not all of them — so a policy that
  // asks for "any 3 of 4" is honoured as written rather than tightened.
  const unmet = policy.activeRules.filter((rule) => !RULE_TESTS[rule].met(password));
  const met = policy.activeRules.length - unmet.length;

  if (met < policy.minAdheredRules) {
    const wanted = policy.minAdheredRules - met;
    const options = unmet.map((rule) => RULE_TESTS[rule].label);
    failures.push(
      wanted >= unmet.length
        ? options.join(', ')
        : `${wanted} more of: ${options.join(', ')}`,
    );
  }

  return failures;
}
