import { Prisma } from '@prisma/client';

import { currentAuth } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { appLog } from '../lib/log.js';
import type { AuditEvent } from '../types/epm.js';

/**
 * The activity journal for EPM-owned data (BRL-02, NFR07).
 *
 * OpenProject journals what it owns, under the token of whoever changed it.
 * What EPM owns — health and its overrides, planned dates, budgets, the rules
 * themselves — had no record at all of who changed it or why. Every such write
 * now records one here.
 *
 * Insert-only. There is no update or delete in this module, and the table's
 * trigger refuses both at the database, so a bug elsewhere cannot rewrite
 * history either.
 */

export interface AuditInput {
  /**
   * Who made the change. Defaults to the signed-in user of the current request;
   * pass `null` for a change EPM made itself, such as a scheduled recalculation.
   */
  actorId?: string | null;
  projectId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** JSON-safe, or the database null — never `undefined`, which Prisma rejects. */
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function rowData(input: AuditInput): Prisma.AuditEventCreateManyInput {
  const actorId = input.actorId === undefined ? currentAuth()?.userId ?? null : input.actorId;

  return {
    actorId,
    actorKind: actorId ? 'user' : 'system',
    projectId: input.projectId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    summary: input.summary,
    reason: input.reason ?? null,
    before: json(input.before),
    after: json(input.after),
    metadata: json(input.metadata),
  };
}

/**
 * Writes one journal entry.
 *
 * Throws on failure. For a change the journal is the evidence of, losing the
 * entry is worse than failing the change, so callers that write state and the
 * entry together use `withAudit` and get both or neither.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  await prisma.auditEvent.create({ data: rowData(input) });
}

/**
 * Writes a change and its journal entry in one transaction.
 *
 * `write` receives the transaction client; the entry is inserted inside the
 * same transaction, so a change can never land without its record or the
 * other way round.
 */
export async function withAudit<T>(
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  entry: AuditInput | ((result: T) => AuditInput | AuditInput[]),
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await write(tx);
    const entries = typeof entry === 'function' ? entry(result) : entry;
    for (const one of Array.isArray(entries) ? entries : [entries]) {
      await tx.auditEvent.create({ data: rowData(one) });
    }
    return result;
  });
}

/**
 * Writes journal entries for something that has already happened elsewhere.
 *
 * For changes EPM observes rather than makes — a recalculated health level —
 * where there is no state of its own to roll back if this fails. A failure is
 * logged rather than thrown: the recalculation stands, and the next one that
 * changes anything will be journalled.
 */
export async function recordAuditQuietly(inputs: AuditInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await prisma.auditEvent.createMany({ data: inputs.map(rowData) });
  } catch (error) {
    appLog.warn({ err: error, count: inputs.length }, 'Could not write journal entries');
  }
}

type AuditRow = Awaited<ReturnType<typeof prisma.auditEvent.findFirstOrThrow>>;

export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    seq: row.seq,
    occurredAt: row.occurredAt.toISOString(),
    actorId: row.actorId ?? undefined,
    actorKind: row.actorKind === 'user' ? 'user' : 'system',
    projectId: row.projectId ?? undefined,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    summary: row.summary,
    reason: row.reason ?? undefined,
    before: row.before ?? undefined,
    after: row.after ?? undefined,
  };
}

export interface JournalQuery {
  projectId?: string;
  entityType?: string;
  entityId?: string;
  /** Only actions starting with this, e.g. `health.`. */
  actionPrefix?: string;
  /** Entries before this sequence number, for paging backwards. */
  before?: number;
  limit?: number;
}

/** Newest first, paged by sequence number. */
export async function listAudit(query: JournalQuery): Promise<AuditEvent[]> {
  const rows = await prisma.auditEvent.findMany({
    where: {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actionPrefix ? { action: { startsWith: query.actionPrefix } } : {}),
      ...(query.before ? { seq: { lt: query.before } } : {}),
    },
    orderBy: { seq: 'desc' },
    take: Math.min(Math.max(query.limit ?? 50, 1), 200),
  });
  return rows.map(toAuditEvent);
}
