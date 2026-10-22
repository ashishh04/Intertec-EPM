import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { withAudit } from './audit.js';

/**
 * Inbound integration events (BR-506): safe to replay after any interruption.
 *
 * Every delivery is kept once, keyed on its identity — the sender's event id,
 * or a hash of the delivery's bytes where the sender has none, as OpenProject's
 * webhook has not — so a redelivery is counted, not processed again. Each is
 * processed by its source's processor, whose effects are idempotent (emails
 * and rule events are keyed, recalculations are idempotent), so processing
 * the same event twice changes nothing the second time. A failure is retried
 * with back-off; after MAX_ATTEMPTS it is dead-lettered, and an operator
 * replays it — or every dead one — from Administration → Integration.
 */

export type IntegrationEventStatus = 'pending' | 'done' | 'failed' | 'dead';

/** Processes an event; `receivedAt` keys anything time-based, so a replay gives the same keys. */
export type Processor = (action: string, payload: unknown, meta: { eventKey: string; receivedAt: Date }) => Promise<void>;

export const MAX_ATTEMPTS = 5;
/** Back-off before attempt n + 1: 1, 5, 15, 60 minutes. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Processed events are kept this long, then pruned. */
export const RETENTION_DAYS = 30;

const processors = new Map<string, Processor>();

/** Registers how a source's events are processed. */
export function registerProcessor(source: string, processor: Processor): void {
  processors.set(source, processor);
}

/** An event's identity from the bytes that arrived, when the sender gives it no id. */
export function eventKeyOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IntegrationEventView {
  id: string;
  source: string;
  action: string;
  status: IntegrationEventStatus;
  attempts: number;
  deliveries: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
  nextAttemptAt: string | null;
  replayedBy: string | null;
  replayedAt: string | null;
}

type Row = Awaited<ReturnType<typeof prisma.integrationEvent.findFirstOrThrow>>;

const toView = (row: Row): IntegrationEventView => ({
  id: row.id,
  source: row.source,
  action: row.action,
  status: row.status as IntegrationEventStatus,
  attempts: row.attempts,
  deliveries: row.deliveries,
  lastError: row.lastError,
  receivedAt: row.receivedAt.toISOString(),
  processedAt: row.processedAt?.toISOString() ?? null,
  nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
  replayedBy: row.replayedBy,
  replayedAt: row.replayedAt?.toISOString() ?? null,
});

/**
 * Keeps a delivery and processes it, unless the same event was already
 * processed — then it is only counted. Never throws for a processing failure:
 * the failure is recorded and retried. Returns what became of it.
 */
export async function receiveEvent(input: { source: string; eventKey: string; action: string; payload: unknown }): Promise<{ id: string; duplicate: boolean; status: IntegrationEventStatus }> {
  const existing = await prisma.integrationEvent.findUnique({ where: { source_eventKey: { source: input.source, eventKey: input.eventKey } } });
  if (existing) {
    await prisma.integrationEvent.update({ where: { id: existing.id }, data: { deliveries: { increment: 1 } } });
    // Done, or already waiting for its retry: nothing more to do now.
    if (existing.status === 'done' || existing.status === 'dead' || existing.status === 'failed') {
      return { id: existing.id, duplicate: true, status: existing.status as IntegrationEventStatus };
    }
    return { id: existing.id, duplicate: true, status: await processEvent(existing.id) };
  }
  let created: Row;
  try {
    created = await prisma.integrationEvent.create({
      data: { source: input.source, eventKey: input.eventKey, action: input.action, payload: (input.payload ?? {}) as Prisma.InputJsonValue },
    });
  } catch (error) {
    // Two deliveries of the same event at once: the other one keeps it.
    if ((error as { code?: string }).code === 'P2002') return { id: '', duplicate: true, status: 'pending' };
    throw error;
  }
  return { id: created.id, duplicate: false, status: await processEvent(created.id) };
}

/** Processes one event once: done, or failed with its next attempt, or dead after the last. */
export async function processEvent(id: string): Promise<IntegrationEventStatus> {
  // Claimed by moving its next attempt on, so a second server skips it meanwhile.
  const claimed = await prisma.integrationEvent.updateMany({
    where: { id, status: { in: ['pending', 'failed'] } },
    data: { nextAttemptAt: new Date(Date.now() + 10 * 60_000) },
  });
  if (claimed.count === 0) {
    const row = await prisma.integrationEvent.findUnique({ where: { id }, select: { status: true } });
    return (row?.status as IntegrationEventStatus | undefined) ?? 'done';
  }
  const row = await prisma.integrationEvent.findUniqueOrThrow({ where: { id } });
  const processor = processors.get(row.source);
  try {
    if (!processor) throw new Error(`Nothing processes events from ${row.source}.`);
    await processor(row.action, row.payload, { eventKey: row.eventKey, receivedAt: row.receivedAt });
    await prisma.integrationEvent.update({
      where: { id },
      data: { status: 'done', attempts: { increment: 1 }, processedAt: new Date(), nextAttemptAt: null, lastError: null },
    });
    return 'done';
  } catch (error) {
    const attempts = row.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await prisma.integrationEvent.update({
      where: { id },
      data: {
        status: dead ? 'dead' : 'failed',
        attempts,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        nextAttemptAt: dead ? null : new Date(Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!),
      },
    });
    return dead ? 'dead' : 'failed';
  }
}

/** Retries every failed event whose time has come; prunes old processed ones. For the worker. */
export async function retryDue(limit = 100): Promise<{ retried: number; done: number; dead: number; pruned: number }> {
  const due = await prisma.integrationEvent.findMany({
    where: { status: { in: ['failed', 'pending'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { receivedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  let done = 0;
  let dead = 0;
  for (const { id } of due) {
    const status = await processEvent(id);
    if (status === 'done') done += 1;
    if (status === 'dead') dead += 1;
  }
  const pruned = await prisma.integrationEvent.deleteMany({
    where: { status: 'done', processedAt: { lt: new Date(Date.now() - RETENTION_DAYS * 86_400_000) } },
  });
  return { retried: due.length, done, dead, pruned: pruned.count };
}

export async function listEvents(filter: { status?: IntegrationEventStatus; limit?: number }): Promise<{ counts: Record<IntegrationEventStatus, number>; events: IntegrationEventView[] }> {
  const [rows, grouped] = await Promise.all([
    prisma.integrationEvent.findMany({
      where: filter.status ? { status: filter.status } : {},
      orderBy: { receivedAt: 'desc' },
      take: Math.min(filter.limit ?? 50, 200),
    }),
    prisma.integrationEvent.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const counts: Record<IntegrationEventStatus, number> = { pending: 0, done: 0, failed: 0, dead: 0 };
  for (const group of grouped) counts[group.status as IntegrationEventStatus] = group._count._all;
  return { counts, events: rows.map(toView) };
}

/**
 * Replays events — one, or every dead one — as an operator: back to pending
 * with their attempts reset, then processed at once. Processing is
 * idempotent, so replaying an event that had in fact taken effect changes
 * nothing. Journalled.
 */
export async function replayEvents(selector: { id: string } | { status: 'dead' | 'failed' | 'done' }, actorId: string): Promise<{ replayed: number; done: number; failed: number }> {
  const rows = await prisma.integrationEvent.findMany({
    where: 'id' in selector ? { id: selector.id } : { status: selector.status },
    orderBy: { receivedAt: 'asc' },
    take: 500,
    select: { id: true },
  });
  if ('id' in selector && rows.length === 0) throw EpmError.notFound('That event');
  const ids = rows.map((row) => row.id);
  await prisma.integrationEvent.updateMany({
    where: { id: { in: ids } },
    data: { status: 'pending', attempts: 0, nextAttemptAt: null, replayedBy: actorId, replayedAt: new Date() },
  });
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    if ((await processEvent(id)) === 'done') done += 1;
    else failed += 1;
  }
  await withAudit(async () => null, {
    actorId,
    entityType: 'integration',
    entityId: 'id' in selector ? selector.id : `status:${selector.status}`,
    action: 'integration.events.replayed',
    summary: message('{count, plural, one {# integration event} other {# integration events}} replayed: {done} processed.', { count: ids.length, done }),
    after: { replayed: ids.length, done, failed },
  }).catch(() => undefined);
  return { replayed: ids.length, done, failed };
}
