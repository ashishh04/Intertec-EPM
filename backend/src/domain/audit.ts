import { Prisma } from '@prisma/client';

import { currentAuth } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { render, renderStored, type Message } from '../lib/i18n.js';
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
  /**
   * Set to `service` for EPM's automation account acting for a rule (BR-217),
   * with `actorId` its OpenProject user id. Otherwise derived from `actorId`.
   */
  actorKind?: 'user' | 'system' | 'service';
  projectId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  /**
   * One line saying what happened. A message is kept as well as its English,
   * so the journal reads in each reader's language (BR-605); the English is the
   * record and what a search matches.
   */
  summary: string | Message;
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

/**
 * The row for one entry, for code that writes inside a transaction of its own
 * — an approval decision and its journal entry are one write, not two.
 */
export function auditRow(input: AuditInput): Prisma.AuditEventCreateManyInput {
  const actorId = input.actorId === undefined ? currentAuth()?.userId ?? null : input.actorId;

  return {
    actorId,
    actorKind: input.actorKind ?? (actorId ? 'user' : 'system'),
    projectId: input.projectId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    summary: typeof input.summary === 'string' ? input.summary : render('en', input.summary),
    summaryMessage: typeof input.summary === 'string' ? Prisma.DbNull : json(input.summary),
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
  await prisma.auditEvent.create({ data: auditRow(input) });
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
      await tx.auditEvent.create({ data: auditRow(one) });
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
    await prisma.auditEvent.createMany({ data: inputs.map(auditRow) });
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
    actorKind: row.actorKind === 'user' || row.actorKind === 'service' ? row.actorKind : 'system',
    projectId: row.projectId ?? undefined,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    summary: renderStored(row.summary, row.summaryMessage),
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

/**
 * One numbered page of a journal, newest first, with the total it is a page
 * of — for a list a person pages through, where every entry has to stay
 * reachable however long the journal grows.
 */
export async function listAuditPage(
  query: Omit<JournalQuery, 'before' | 'limit'> & { page: number; pageSize: number },
): Promise<{ items: AuditEvent[]; total: number; page: number; pageSize: number }> {
  const where = {
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.actionPrefix ? { action: { startsWith: query.actionPrefix } } : {}),
  };
  const pageSize = Math.min(Math.max(query.pageSize, 1), 100);
  const total = await prisma.auditEvent.count({ where });
  // Past the end — the journal is append-only, so only a stale page number
  // can be — answers the last page rather than an empty one.
  const page = Math.min(Math.max(query.page, 1), Math.max(1, Math.ceil(total / pageSize)));
  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { seq: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { items: rows.map(toAuditEvent), total, page, pageSize };
}

export interface InstanceJournalQuery {
  entityType?: string;
  /** Only actions starting with this, e.g. `grant.` or `department.`. */
  actionPrefix?: string;
  actorId?: string;
  projectId?: string;
  /** Inclusive days, YYYY-MM-DD, in UTC. */
  from?: string;
  to?: string;
  /** Words in the summary, case-insensitive. */
  q?: string;
  page: number;
  pageSize: number;
}

/**
 * The whole journal, filtered, one numbered page at a time, newest first —
 * for the administrators' journal page (BRL-02). Every kind of entry, project
 * or not, with the kinds the journal holds so the page can offer them.
 */
export async function listInstanceJournal(query: InstanceJournalQuery): Promise<{
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  entityTypes: string[];
}> {
  const occurredAt: Prisma.DateTimeFilter = {};
  if (query.from) occurredAt.gte = new Date(`${query.from}T00:00:00.000Z`);
  if (query.to) occurredAt.lt = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000);
  const where: Prisma.AuditEventWhereInput = {
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.actionPrefix ? { action: { startsWith: query.actionPrefix } } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.from || query.to ? { occurredAt } : {}),
    ...(query.q ? { summary: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const pageSize = Math.min(Math.max(query.pageSize, 1), 200);
  const [total, kinds] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({ distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
  ]);
  const page = Math.min(Math.max(query.page, 1), Math.max(1, Math.ceil(total / pageSize)));
  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { seq: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return {
    items: rows.map(toAuditEvent),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
    entityTypes: kinds.map((row) => row.entityType),
  };
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
