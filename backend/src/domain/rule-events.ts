import { randomBytes } from 'node:crypto';

import { Prisma, type RuleEvent } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { appLog } from '../lib/log.js';
import type { RuleEventKind, RuleSubjectType } from '../types/epm.js';
import { INSTANCE_ID } from './job-lease.js';

/**
 * The events rules consider (BR-216): what changed, queued in the database.
 *
 * Two sources feed it. EPM's own writes — a work package created or edited
 * through EPM — are noted as they happen. Changes made in OpenProject directly
 * arrive by its webhook. The same change usually comes both ways; keyed on the
 * work package and its lockVersion, it is queued once.
 *
 * In the database rather than in memory: a second server claims different
 * events (`FOR UPDATE SKIP LOCKED`), a restart loses nothing, and an event that
 * keeps failing is retried a few times and then kept with its error.
 */

export const MAX_ATTEMPTS = 3;

export interface RuleEventInput {
  source: 'epm' | 'webhook';
  kind: RuleEventKind;
  subjectType: RuleSubjectType;
  subjectId: string;
  projectId?: string;
  /** The work package's lockVersion after the change: with the id, one change. */
  version?: number;
  /** Who made the change, when known. */
  actorId?: string;
  /** For events with no version: what makes a repeat a repeat. */
  dedupeKey?: string;
}

let listener: (() => void) | undefined;

/** The worker asks to hear of new events, so it need not wait for its next poll. */
export function onRuleEvent(callback: () => void): void {
  listener = callback;
}

const isDuplicate = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

function keyFor(input: RuleEventInput): string {
  if (input.dedupeKey) return input.dedupeKey;
  if (input.version !== undefined) return `${input.subjectType}:${input.subjectId}:v${input.version}`;
  // No version (projects): the same change reported by EPM and by the webhook
  // within a few seconds is one change.
  return `${input.subjectType}:${input.subjectId}:${input.kind}:${Math.floor(Date.now() / 10_000)}`;
}

/**
 * Queues an event. Never throws: a change is not undone because a rule could
 * not hear of it, and the caller is usually a request that already succeeded.
 */
export async function noteRuleEvent(input: RuleEventInput): Promise<void> {
  try {
    await prisma.ruleEvent.create({
      data: {
        source: input.source,
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        projectId: input.projectId ?? null,
        version: input.version ?? null,
        actorId: input.actorId ?? null,
        dedupeKey: keyFor(input),
      },
    });
    listener?.();
  } catch (error) {
    if (isDuplicate(error)) return;
    appLog.warn({ err: error, kind: input.kind, subjectId: input.subjectId }, 'Could not queue a rule event');
  }
}

/**
 * Records a change a rule is about to make, as already considered, so its echo
 * — the same lockVersion reported by the webhook — is never taken for a new
 * change. Rules do not trigger rules. Written before the change, because the
 * webhook can arrive before the write's own response does.
 */
export async function markSelfCaused(workPackageId: string, version: number, actorId?: string): Promise<string> {
  const dedupeKey = `work_package:${workPackageId}:v${version}`;
  try {
    await prisma.ruleEvent.create({
      data: {
        source: 'automation',
        kind: 'work_package.updated',
        subjectType: 'work_package',
        subjectId: workPackageId,
        version,
        actorId: actorId ?? null,
        dedupeKey,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
  }
  return dedupeKey;
}

/** Withdraws a marker when the change it announced did not happen. */
export async function unmarkSelfCaused(dedupeKey: string): Promise<void> {
  await prisma.ruleEvent.deleteMany({ where: { dedupeKey, source: 'automation' } }).catch(() => undefined);
}

/**
 * Claims up to `limit` events for this server, oldest first. An event claimed
 * by a server that went quiet for two minutes is claimable again.
 */
export async function claimRuleEvents(limit = 20): Promise<RuleEvent[]> {
  const rows = await prisma.$queryRaw<RuleEvent[]>`
    UPDATE rule_events
       SET "claimedAt" = now(), "claimedBy" = ${INSTANCE_ID}, attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM rule_events
        WHERE "processedAt" IS NULL
          AND attempts < ${MAX_ATTEMPTS}
          AND ("claimedAt" IS NULL OR "claimedAt" < now() - interval '2 minutes')
        ORDER BY "receivedAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING *`;
  return rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

/** Done with an event: processed, or failed — retried, or given up on after the last attempt. */
export async function finishRuleEvent(event: RuleEvent, error?: string): Promise<void> {
  const giveUp = error !== undefined && event.attempts >= MAX_ATTEMPTS;
  await prisma.ruleEvent
    .update({
      where: { id: event.id },
      data:
        error === undefined
          ? { processedAt: new Date(), error: null }
          : { error: error.slice(0, 1000), claimedAt: null, ...(giveUp ? { processedAt: new Date() } : {}) },
    })
    .catch((failure: unknown) => appLog.warn({ err: failure, eventId: event.id }, 'Could not finish a rule event'));
}

/** For the status card. */
export async function ruleEventStats(): Promise<{ queued: number; failed: number; lastProcessedAt?: string }> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [queued, failed, last] = await Promise.all([
    prisma.ruleEvent.count({ where: { processedAt: null } }),
    prisma.ruleEvent.count({ where: { processedAt: { gte: since }, error: { not: null } } }),
    prisma.ruleEvent.findFirst({
      where: { processedAt: { not: null }, source: { not: 'automation' } },
      orderBy: { processedAt: 'desc' },
      select: { processedAt: true },
    }),
  ]);
  return { queued, failed, lastProcessedAt: last?.processedAt?.toISOString() };
}

/** Keeps the queue bounded: processed events older than a month go. */
export async function pruneRuleEvents(): Promise<number> {
  const before = new Date(Date.now() - 30 * 86_400_000);
  const removed = await prisma.ruleEvent
    .deleteMany({ where: { processedAt: { lt: before } } })
    .catch(() => ({ count: 0 }));
  return removed.count;
}

let webhookReceivedAt: Date | undefined;

/** The webhook is the only way changes made outside EPM reach the rules; the status card shows it is arriving. */
export function noteWebhookReceived(): void {
  webhookReceivedAt = new Date();
}

export function lastWebhookReceived(): string | undefined {
  return webhookReceivedAt?.toISOString();
}

/** A unique suffix for events that are each their own occurrence. */
export const occurrence = () => `${Date.now()}:${randomBytes(3).toString('hex')}`;
