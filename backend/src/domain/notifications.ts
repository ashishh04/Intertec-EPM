import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../email/outbox.js';
import { getPreferences } from '../email/preferences.js';
import { resolveRecipient } from '../email/recipients.js';
import { message, render, toLanguage, type Conventions, type Language, type Message } from '../lib/i18n.js';
import type { HealthLevel } from '../types/epm.js';

/**
 * EPM notifications.
 *
 * A notification is something a specific person should know and would not
 * otherwise see. That is narrower than "things that happened": a successful
 * snapshot, a metric value and an audit trail are all events, and none of them
 * is news. Each candidate here has to survive the question *would someone act
 * on this, and would they miss it otherwise?*
 *
 * OpenProject notifications are still read through from upstream and merged
 * with these; this exists because a health transition, a capacity change and a
 * failed capture are EPM concepts that upstream has nowhere to put.
 *
 * Deduplication is the database's job. Every write is an upsert on
 * `(recipientId, dedupeKey)` that updates nothing on conflict, so a repeat is a
 * silent no-op rather than a resurrected notification jumping back to the top
 * of someone's list — and two concurrent producers cannot both decide the same
 * notification is new.
 *
 * Each new notification is also offered to the email outbox, on the digest
 * channel: none of these is urgent enough to interrupt someone, and one
 * summary a day is what the `email.updates` switch promises. The outbox
 * applies that switch and its own dedupe; this only asks.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface NotificationInput {
  recipients: string[];
  category: string;
  /**
   * A message rather than finished text (BR-605): each recipient's copy is
   * written in their own language when it is created, so one event can reach
   * an English reader and an Arabic one. Plain text is still accepted, for
   * words that are data — a rule's own title — and is kept exactly as written.
   */
  title: string | Message;
  body: string | Message;
  link?: string;
  severity: Severity;
  dedupeKey: string;
  /**
   * How the email copy goes: on the daily digest (the default), or at once —
   * for an escalation, which is the point of escalating. Immediate email is
   * gated on the person's "assigned" switch: work that has become theirs.
   */
  email?: 'digest' | 'immediate';
}

/**
 * Creates one notification per recipient, skipping any that already exist.
 *
 * Returns how many were actually new, which is what the callers log — a run
 * that created nothing is the normal case once a state has settled.
 */
async function notify(input: NotificationInput): Promise<number> {
  // Distinct, so someone who is both a team lead and a department manager is
  // told once rather than twice.
  const recipients = [...new Set(input.recipients.filter(Boolean))];
  if (recipients.length === 0) return 0;

  let created = 0;

  for (const recipientId of recipients) {
    // Written for this reader: the inbox stores text, so it is stored in the
    // language they read EPM in, and the email copy below is the same words.
    const write = await writerFor(recipientId);
    const title = write(input.title);
    const body = write(input.body);

    const result = await prisma.notification
      .createMany({
        data: {
          recipientId,
          category: input.category,
          title,
          body,
          link: input.link,
          severity: input.severity,
          dedupeKey: input.dedupeKey,
        },
        // The unique key does the deduplicating; this makes a repeat a no-op
        // rather than an error to catch and swallow.
        skipDuplicates: true,
      })
      .catch(() => ({ count: 0 }));

    created += result.count;

    // Only what was actually new: a repeat that wrote no row is not news in
    // the inbox either. Email is a side effect of the notification and must
    // never make it fail, so nothing here is allowed to throw.
    if (result.count > 0) await offerByEmail(recipientId, { ...input, title, body });
  }

  return created;
}

/** A recipient's language and conventions, from their preferences; English when unknown. */
async function readerOf(recipientId: string): Promise<{ language: Language; conventions: Conventions }> {
  const preferences = await getPreferences(recipientId).catch(() => undefined);
  return {
    language: toLanguage(preferences?.locale.language),
    conventions: { calendar: preferences?.locale.calendar, numerals: preferences?.locale.numerals },
  };
}

/**
 * Writes text for one person, in the language they read EPM in (BR-605) — for
 * the inbox here, and for anything else that mails people directly.
 *
 * A message is written out with its arguments. Plain text is data — a rule's
 * own words, a post's title — and comes back exactly as given: read as a
 * message, anything in it that looked like {an argument} would be dropped.
 */
export async function writerFor(recipientId: string): Promise<(value: string | Message) => string> {
  const reader = await readerOf(recipientId);
  return (value) => (typeof value === 'string' ? value : render(reader.language, value, reader.conventions));
}

/**
 * Whole sentences one after another, as one message. Each is translated
 * complete, so a translation never has to split one; all that is joined is
 * the space between them. An absent sentence is left out.
 */
export function sentences(first: Message, ...rest: (string | Message | undefined)[]): Message {
  return rest.reduce<Message>((text, next) => (next ? message('{first} {next}', { first: text, next }) : text), first);
}

/**
 * Clauses in a series — "schedule variance green → amber; …" — joined the way
 * the language joins them. Takes at least one.
 */
export function clauses(items: Message[]): Message {
  return items.reduce((text, next) => message('{first}; {next}', { first: text, next }));
}

/**
 * The same path, for a domain with events of its own — approvals tell
 * approvers, requesters and escalation contacts through it. Deduplicated and
 * offered to the digest exactly like every notification above.
 */
export function notifyPeople(input: NotificationInput): Promise<number> {
  return notify(input);
}

async function offerByEmail(
  recipientId: string,
  input: NotificationInput & { title: string; body: string },
): Promise<void> {
  try {
    const recipient = await resolveRecipient(recipientId);
    if (!recipient) return;

    await enqueueEmail({
      recipientId,
      template: 'notification',
      payload: {
        firstName: recipient.firstName,
        title: input.title,
        body: input.body,
        // `link` is an EPM route; the email needs somewhere absolute to point.
        url: input.link ? `${env.APP_BASE_URL}${input.link}` : undefined,
      },
      channel: input.email ?? 'digest',
      dedupeKey: `notification:${input.dedupeKey}`,
      gate: input.email === 'immediate' ? 'assigned' : 'updates',
    });
  } catch {
    // Already logged by the outbox where it could be; the notification stands.
  }
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

const HEALTH_SEVERITY: Record<HealthLevel, Severity> = {
  healthy: 'info',
  warning: 'warning',
  critical: 'critical',
};

/**
 * Tells a project's owner that its health moved.
 *
 * The owner is the only recipient relationship that exists for a project —
 * `EpmProject.ownerId`, from OpenProject's `responsible` link. A project with
 * nobody responsible notifies nobody, which is reported rather than worked
 * around: guessing at a recipient would be inventing the hierarchy this is not
 * supposed to build.
 */
export async function notifyHealthChange(input: {
  projectId: string;
  projectName: string;
  ownerId?: string;
  previous: HealthLevel | null;
  next: HealthLevel;
  overridden: boolean;
  /**
   * What makes this transition distinct from an earlier one to the same level,
   * e.g. the day it happened. Without it the dedupe key was the level alone,
   * so a project that went red, recovered and went red again told nobody the
   * second time.
   */
  occurrence?: string;
  /**
   * Which criteria moved, said in the body so the owner knows where to look.
   * A message, so it reads in the owner's language like the rest.
   */
  detail?: string | Message;
}): Promise<number> {
  // No transition, no news — whatever the evaluation count.
  if (input.previous === input.next) return 0;
  if (!input.ownerId) return 0;

  const improved =
    input.previous !== null &&
    ['critical', 'warning', 'healthy'].indexOf(input.next) >
      ['critical', 'warning', 'healthy'].indexOf(input.previous);

  const title = improved
    ? message('{project} health improved to {level, select, healthy {healthy} warning {warning} other {critical}}', {
        project: input.projectName,
        level: input.next,
      })
    : message('{project} health is now {level, select, healthy {healthy} warning {warning} other {critical}}', {
        project: input.projectName,
        level: input.next,
      });

  const wasWhat = input.previous
    ? message('It was {level, select, healthy {healthy} warning {warning} other {critical}}.', { level: input.previous })
    : message('This is the first assessment.');
  // Said plainly, so a pinned green is never read as a measured one.
  const because = input.overridden
    ? message('The value is currently overridden rather than calculated.')
    : undefined;

  return notify({
    recipients: [input.ownerId],
    category: 'system',
    title,
    body: sentences(wasWhat, input.detail, because),
    link: `/projects/${input.projectId}`,
    // An improvement is information, not an alarm, however far it moved.
    severity: improved ? 'info' : HEALTH_SEVERITY[input.next],
    dedupeKey: input.occurrence
      ? `health:${input.projectId}:${input.next}:${input.occurrence}`
      : `health:${input.projectId}:${input.next}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Capacity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tells the people responsible for someone that their capacity changed.
 *
 * Triggered at the mutation point, so a background read notifies nobody.
 * Capacity is already rounded to the quarter hour, so any difference is a real
 * change and a no-op write produces nothing.
 */
export async function notifyCapacityChange(input: {
  employeeId: string;
  employeeName: string;
  from: number;
  to: number;
}): Promise<number> {
  if (input.from === input.to) return 0;

  const profile = await prisma.userProfile
    .findUnique({
      where: { openProjectId: input.employeeId },
      select: {
        team: { select: { id: true, name: true, leadId: true } },
        departmentRef: { select: { managerId: true } },
      },
    })
    .catch(() => null);

  // Only relationships that exist: the person themselves, whoever leads their
  // team, and whoever manages their department.
  const recipients = [
    input.employeeId,
    profile?.team?.leadId ?? '',
    profile?.departmentRef?.managerId ?? '',
  ];

  const direction = input.to > input.from ? 'increased' : 'reduced';
  const day = new Date().toISOString().slice(0, 10);

  return notify({
    recipients,
    category: 'system',
    title: message('{name} capacity {direction, select, increased {increased} other {reduced}} to {hours, number} h/week', {
      name: input.employeeName,
      direction,
      hours: input.to,
    }),
    body: profile?.team
      ? message('It was {hours, number} h/week. They are on {team}.', { hours: input.from, team: profile.team.name })
      : message('It was {hours, number} h/week.', { hours: input.from }),
    link: '/employees',
    severity: 'info',
    // The mutation, not the state: setting 40 → 30 → 40 is three events, and
    // keying on the value alone would swallow the third.
    dedupeKey: `capacity:${input.employeeId}:${input.from}-${input.to}:${day}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot failure                                                            */
/* -------------------------------------------------------------------------- */

/** Whoever holds `analytics:manage` — configured, never hardcoded. */
async function analyticsAdministrators(): Promise<string[]> {
  const granted = await prisma.epmPermissionGrant
    .findMany({ where: { permission: 'analytics:manage' }, select: { openProjectId: true } })
    .catch(() => [] as { openProjectId: string }[]);

  return [...env.EPM_ADMIN_USER_IDS, ...granted.map((row) => row.openProjectId)];
}

/**
 * Tells the analytics administrators that a capture failed.
 *
 * Once per failed day: the scheduler retries, and a notification per tick is
 * the spam this is meant to avoid. A successful capture notifies nobody — a
 * daily "it worked" is noise.
 *
 * The body carries the day and the error's message, and nothing else. An
 * upstream error can contain a request URL, and a stack trace can contain
 * paths; neither belongs in something a person reads.
 */
export async function notifyAnalyticsProblem(input: {
  /** Messages, so each administrator reads them in their own language. */
  title: string | Message;
  body: string | Message;
  /** Once per problem per period: the scheduler retries, and so would the notice. */
  dedupeKey: string;
  link?: string;
}): Promise<number> {
  const recipients = await analyticsAdministrators();
  if (recipients.length === 0) return 0;

  return notify({
    recipients,
    category: 'system',
    title: input.title,
    body: input.body,
    link: input.link ?? '/admin/analytics',
    severity: 'warning',
    dedupeKey: input.dedupeKey,
  });
}

export async function notifySnapshotFailure(input: {
  day: string;
  reason: string;
}): Promise<number> {
  const recipients = await analyticsAdministrators();

  // Nobody holds the permission. Logged already by the caller; a fake recipient
  // would be worse than none.
  if (recipients.length === 0) return 0;

  // The reason comes from whatever threw, and an error message is as likely to
  // end without punctuation as with it. Sentences either side of it make the
  // difference visible, so it is closed here rather than hoped for.
  const reason = input.reason.trim().replace(/[.!?]*$/, '');

  return notify({
    recipients,
    category: 'system',
    title: message('Analytics snapshot failed'),
    body: reason
      ? message('No metrics were recorded for {day}. {reason}. The period will show as a gap until a capture succeeds.', {
          day: input.day,
          reason,
        })
      : message('No metrics were recorded for {day}. The period will show as a gap until a capture succeeds.', {
          day: input.day,
        }),
    link: '/analytics',
    severity: 'warning',
    dedupeKey: `snapshot-failed:${input.day}`,
  });
}
