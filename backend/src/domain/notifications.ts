import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../email/outbox.js';
import { resolveRecipient } from '../email/recipients.js';
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

interface NotificationInput {
  recipients: string[];
  category: string;
  title: string;
  body: string;
  link?: string;
  severity: Severity;
  dedupeKey: string;
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
    const result = await prisma.notification
      .createMany({
        data: {
          recipientId,
          category: input.category,
          title: input.title,
          body: input.body,
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
    if (result.count > 0) await offerByEmail(recipientId, input);
  }

  return created;
}

async function offerByEmail(recipientId: string, input: NotificationInput): Promise<void> {
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
      channel: 'digest',
      dedupeKey: `notification:${input.dedupeKey}`,
      gate: 'updates',
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
}): Promise<number> {
  // No transition, no news — whatever the evaluation count.
  if (input.previous === input.next) return 0;
  if (!input.ownerId) return 0;

  const improved =
    input.previous !== null &&
    ['critical', 'warning', 'healthy'].indexOf(input.next) >
      ['critical', 'warning', 'healthy'].indexOf(input.previous);

  const title = improved
    ? `${input.projectName} health improved to ${input.next}`
    : `${input.projectName} health is now ${input.next}`;

  const wasWhat = input.previous ? `It was ${input.previous}.` : 'This is the first assessment.';
  // Said plainly, so a pinned green is never read as a measured one.
  const because = input.overridden
    ? ' The value is currently overridden rather than calculated.'
    : '';

  return notify({
    recipients: [input.ownerId],
    category: 'system',
    title,
    body: `${wasWhat}${because}`,
    link: `/projects/${input.projectId}`,
    // An improvement is information, not an alarm, however far it moved.
    severity: improved ? 'info' : HEALTH_SEVERITY[input.next],
    dedupeKey: `health:${input.projectId}:${input.next}`,
  });
}

/**
 * Evaluates every project's health against what was last reported.
 *
 * Run from the daily capture, which already computes each project's effective
 * health — so this adds no OpenProject call. A project whose health has not
 * moved produces nothing, however many times it is evaluated: the comparison
 * happens before anything is written, and the dedupe key would stop it anyway.
 *
 * `lastNotifiedHealth` is updated whether or not anyone was told, so a project
 * with no owner still records where it got to and does not re-fire the moment
 * one is assigned.
 */
export async function evaluateHealthTransitions(
  projects: {
    id: string;
    name: string;
    ownerId: string;
    health: { overall: HealthLevel };
    healthOverride?: unknown;
    status: string;
  }[],
): Promise<number> {
  // Archived projects are not delivering, so their health is not news.
  const active = projects.filter((project) => project.status !== 'paused');
  if (active.length === 0) return 0;

  const profiles = await prisma.projectProfile
    .findMany({
      where: { openProjectId: { in: active.map((project) => project.id) } },
      select: { openProjectId: true, lastNotifiedHealth: true },
    })
    .catch(() => [] as { openProjectId: string; lastNotifiedHealth: string | null }[]);

  const previousById = new Map(profiles.map((row) => [row.openProjectId, row.lastNotifiedHealth]));

  let created = 0;

  for (const project of active) {
    const previous = (previousById.get(project.id) ?? null) as HealthLevel | null;
    const next = project.health.overall;
    if (previous === next) continue;

    created += await notifyHealthChange({
      projectId: project.id,
      projectName: project.name,
      ownerId: project.ownerId || undefined,
      previous,
      next,
      overridden: Boolean(project.healthOverride),
    });

    await prisma.projectProfile
      .upsert({
        where: { openProjectId: project.id },
        create: { openProjectId: project.id, lastNotifiedHealth: next },
        update: { lastNotifiedHealth: next },
      })
      .catch(() => undefined);
  }

  return created;
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
    title: `${input.employeeName} capacity ${direction} to ${input.to} h/week`,
    body: `It was ${input.from} h/week.${profile?.team ? ` They are on ${profile.team.name}.` : ''}`,
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
    title: 'Analytics snapshot failed',
    body: `No metrics were recorded for ${input.day}.${reason ? ` ${reason}.` : ''} The period will show as a gap until a capture succeeds.`,
    link: '/analytics',
    severity: 'warning',
    dedupeKey: `snapshot-failed:${input.day}`,
  });
}
