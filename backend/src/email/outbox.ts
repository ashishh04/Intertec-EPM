import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import type { UserPreferences } from '../types/epm.js';
import { emailLog } from './log.js';
import { getPreferences } from './preferences.js';
import { resolveEmail } from './recipients.js';
import { renderTemplate, type TemplateName, type TemplatePayloads } from './templates/index.js';

/**
 * The outbox.
 *
 * Nothing in EPM sends email; everything that wants to writes a row here and
 * the worker sends it later. That keeps the mail provider out of every request
 * path — an invitation is created in the time it takes to insert a row, and a
 * provider outage delays mail rather than failing whatever triggered it.
 *
 * The decision not to send is made here, once, when the row would be written:
 * no address, or the person has turned that kind of email off. A row that
 * exists is therefore a row that should go out, and the worker never has to
 * consult a preference.
 */

export type Channel = 'immediate' | 'digest';

export interface EnqueueInput<Name extends TemplateName = TemplateName> {
  recipientId: string;
  template: Name;
  payload: TemplatePayloads[Name];
  channel: Channel;
  /**
   * Unique per recipient. A second enqueue with the same key is a no-op, which
   * is how a webhook redelivery or an unchanged assignee sends nothing.
   */
  dedupeKey?: string;
  /**
   * The switch in the person's email settings that governs this. Left off for
   * an invitation, which has no switch — only the master `enabled` applies.
   */
  gate?: keyof UserPreferences['email'];
}

export type EnqueueOutcome = 'queued' | 'duplicate' | 'no-address' | 'opted-out' | 'error';

/**
 * Writes one row, or explains why not. Never throws: mail is a side effect of
 * whatever called this, and that thing has already happened.
 */
export async function enqueueEmail<Name extends TemplateName>(
  input: EnqueueInput<Name>,
): Promise<EnqueueOutcome> {
  const context = { recipientId: input.recipientId, template: input.template, dedupeKey: input.dedupeKey };

  try {
    const toEmail = await resolveEmail(input.recipientId);
    if (!toEmail) {
      emailLog.info(context, 'Email skipped: the recipient has no address');
      return 'no-address';
    }

    const preferences = await getPreferences(input.recipientId);
    if (!preferences.email.enabled || (input.gate && !preferences.email[input.gate])) {
      emailLog.debug({ ...context, gate: input.gate ?? 'enabled' }, 'Email skipped: turned off in preferences');
      return 'opted-out';
    }

    // Rendered now only for the subject, which the row carries so the outbox
    // is readable without re-rendering. The body is rendered at send time.
    const { subject } = renderTemplate(input.template, input.payload);

    await prisma.emailOutbox.create({
      data: {
        recipientId: input.recipientId,
        toEmail,
        template: input.template,
        subject,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        channel: input.channel,
        dedupeKey: input.dedupeKey,
      },
    });

    emailLog.debug({ ...context, channel: input.channel }, 'Email queued');
    return 'queued';
  } catch (error) {
    // The unique index on (recipientId, dedupeKey) is the deduplication; a
    // violation is the expected way to learn this email already exists.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return 'duplicate';
    }

    emailLog.warn({ ...context, err: error }, 'Email could not be queued');
    return 'error';
  }
}

export async function markSent(id: string, providerId: string): Promise<void> {
  await prisma.emailOutbox.update({
    where: { id },
    data: { status: 'sent', providerId, sentAt: new Date(), lastError: null },
  });
}

/** Waits between attempts: a minute, five, half an hour, two hours. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/** After this many attempts the row stays failed and a person has to look. */
export const MAX_ATTEMPTS = 5;

/**
 * Records a failed attempt. A retryable failure goes back to `queued` with a
 * later `scheduledFor`, until the attempts run out; anything else is final.
 */
export async function markFailed(
  row: { id: string; attempts: number },
  error: string,
  retryable: boolean,
): Promise<'requeued' | 'failed'> {
  const attempts = row.attempts + 1;
  const again = retryable && attempts < MAX_ATTEMPTS;

  await prisma.emailOutbox.update({
    where: { id: row.id },
    data: again
      ? {
          status: 'queued',
          attempts,
          lastError: error,
          scheduledFor: new Date(Date.now() + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!)),
        }
      : { status: 'failed', attempts, lastError: error },
  });

  return again ? 'requeued' : 'failed';
}
