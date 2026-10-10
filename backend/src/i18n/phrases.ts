import { msg } from '../lib/i18n.js';

/**
 * Phrases that reach a message as an argument rather than as its text, listed
 * here so the translation check requires an entry for each (BR-605).
 *
 * "{field} must be text." is translated as a whole, but "The name" arrives as
 * its argument from whichever validator raised it; `t()` translates such an
 * argument when it is a catalogue entry. A phrase passed this way and not
 * listed here would appear in English inside an Arabic sentence — so when a
 * validator gains a field, or a permission is added, its words go here too.
 */
export const PHRASES: readonly string[] = [
  // auth/guard.ts describe(): "You do not have permission to {action}." with
  // {action} = "{action} {subject}", from the permission's two halves.
  msg('view'),
  msg('create'),
  msg('edit'),
  msg('archive'),
  msg('delete'),
  msg('assign'),
  msg('status change'),
  msg('manage'),
  msg('log'),
  msg('upload'),
  msg('configure'),
  msg('schedule'),
  msg('approve'),
  msg('plan'),
  msg('projects'),
  msg('work packages'),
  msg('members'),
  msg('sprints'),
  msg('times'),
  msg('documents'),
  msg('users'),
  msg('groups'),
  msg('departments'),
  msg('teams'),
  msg('employees'),
  msg('project health'),
  msg('approvals'),
  msg('rules'),
  msg('portfolios'),
  msg('analytics'),
  msg('reports'),
  msg('rates'),
  msg('audits'),
  msg('roles'),
  msg('resources'),
  msg('systems'),

  // guard.requireLink(…, description): what the caller may not do.
  msg('edit this comment'),
  msg('delete this attachment'),
  msg('delete this document'),
  msg('delete this view'),
  msg('change this view'),
  msg('star this view'),
  msg('unstar this view'),
  msg('delete this relation'),

  // domain/collaboration.ts: "You do not have permission to change this {what}."
  msg('meeting'),
  msg('page'),
  msg('post'),

  // Field names given to the validators: "{field} must be text.",
  // "{field} is required.", "That {field} is not valid."
  msg('The name'),
  msg('The code'),
  msg('The description'),
  msg('The department'),
  msg('The team'),
  msg('The portfolio'),
  msg('The manager'),
  msg('The lead'),
  msg('project'),
  msg('person'),
  msg('activity'),
  msg('work package'),
  msg('status'),
  msg('priority'),
  msg('type'),
  msg('grouping'),
  msg('column'),
  msg('sort'),
  msg('filter'),
  msg('firstName'),
  msg('lastName'),
  msg('email'),
  msg('login'),
  msg('language'),

  // routes/accounts.ts: "Creating a person needs {missing}."
  msg('a username'),
  msg('a first name'),
  msg('a last name'),
  msg('an email address'),
  msg('a starting password'),

  // routes/accounts.ts requireAffordance(…, message): why an account action is refused.
  msg('This person cannot be deactivated.'),
  msg('This person is not deactivated.'),
  msg('You may not edit this person.'),
  msg('That membership'),

  // domain/password-policy.ts: what a password still needs.
  msg('a lowercase letter'),
  msg('an uppercase letter'),
  msg('a number'),
  msg('a symbol'),
];
