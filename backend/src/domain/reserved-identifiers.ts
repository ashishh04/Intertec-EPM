import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message, type Message } from '../lib/i18n.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { runAsSystem } from '../auth/context.js';
import { withAudit } from './audit.js';

/**
 * Reserved project identifiers.
 *
 * An administrator can keep an identifier back for a project that does not
 * exist yet: anyone else creating or renaming a project is told it is
 * reserved, and what for. An administrator may still use it, which releases
 * it. The words the delivery system itself refuses are refused here too, so
 * the form says so while it is being filled in rather than on save.
 */

/** Identifiers the delivery system refuses for a project, whoever asks. */
export const BUILT_IN_RESERVED: readonly string[] = [
  'new',
  'menu',
  'queries',
  'filters',
  'identifier_update_dialog',
  'identifier_suggestion',
  'export_list_modal',
];

/** The delivery system's own rule: a-z, 0-9, dashes and underscores, not digits alone. */
const PATTERN = /^(?!\d+$)[a-z0-9_-]+$/;
const MAX_LENGTH = 100;
const NOTE_MAX = 300;

export interface ReservedIdentifierEntry {
  identifier: string;
  note?: string;
  reservedBy: string;
  createdAt: string;
}

const normalise = (value: string) => value.trim().toLowerCase();

/**
 * Why an identifier may not be used, or null when it may. Format and
 * uniqueness are left to the delivery system's own validation, which already
 * reports them on the form.
 */
export async function identifierProblem(value: unknown, mayUseReserved: boolean): Promise<Message | null> {
  if (typeof value !== 'string' || !value.trim()) return null;
  const identifier = normalise(value);
  if (BUILT_IN_RESERVED.includes(identifier)) {
    return message('“{identifier}” is reserved and cannot be used for a project.', { identifier });
  }
  if (mayUseReserved) return null;
  const reserved = await prisma.reservedIdentifier.findUnique({ where: { identifier } });
  if (!reserved) return null;
  return reserved.note
    ? message('“{identifier}” is reserved for {note}. Choose another, or ask an administrator.', { identifier, note: reserved.note })
    : message('“{identifier}” is reserved. Choose another, or ask an administrator.', { identifier });
}

/** Refuses an identifier that may not be used, with the reason. */
export async function assertIdentifierAllowed(value: unknown, mayUseReserved: boolean): Promise<void> {
  const problem = await identifierProblem(value, mayUseReserved);
  if (problem) throw EpmError.badRequest(problem);
}

/** Releases a reservation once a project has taken the identifier. Quietly: nothing to say if there was none. */
export async function releaseTaken(value: unknown): Promise<void> {
  if (typeof value !== 'string' || !value.trim()) return;
  const identifier = normalise(value);
  const reserved = await prisma.reservedIdentifier.findUnique({ where: { identifier } });
  if (!reserved) return;
  await withAudit((tx) => tx.reservedIdentifier.delete({ where: { identifier } }), {
    entityType: 'reserved_identifier',
    entityId: identifier,
    action: 'reserved_identifier.used',
    summary: message('Reserved identifier {identifier} was given to a new project', { identifier }),
    before: { note: reserved.note },
  });
}

export async function listReservations(): Promise<ReservedIdentifierEntry[]> {
  const rows = await prisma.reservedIdentifier.findMany({ orderBy: { identifier: 'asc' } });
  return rows.map((row) => ({
    identifier: row.identifier,
    ...(row.note ? { note: row.note } : {}),
    reservedBy: row.reservedBy,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function reserve(input: { identifier?: unknown; note?: unknown }, actorId: string): Promise<ReservedIdentifierEntry> {
  if (typeof input.identifier !== 'string' || !input.identifier.trim()) throw EpmError.badRequest('An identifier is required.');
  const identifier = normalise(input.identifier);
  if (identifier.length > MAX_LENGTH || !PATTERN.test(identifier)) {
    throw EpmError.badRequest('An identifier uses lowercase letters, numbers, dashes and underscores, and is not digits alone.');
  }
  if (BUILT_IN_RESERVED.includes(identifier)) {
    throw EpmError.badRequest(message('“{identifier}” is reserved and cannot be used for a project.', { identifier }));
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > NOTE_MAX) throw EpmError.badRequest(message('The note cannot be longer than {max} characters.', { max: NOTE_MAX }));

  // Every project, not just those the administrator belongs to.
  const taken = [...(await runAsSystem(() => projectIdentifiers())).values()].some((existing) => existing === identifier);
  if (taken) throw EpmError.badRequest(message('A project already has the identifier “{identifier}”.', { identifier }));
  if (await prisma.reservedIdentifier.findUnique({ where: { identifier } })) {
    throw EpmError.badRequest(message('“{identifier}” is already reserved.', { identifier }));
  }

  const row = await withAudit(
    (tx) => tx.reservedIdentifier.create({ data: { identifier, note: note || null, reservedBy: actorId } }),
    {
      entityType: 'reserved_identifier',
      entityId: identifier,
      action: 'reserved_identifier.reserved',
      summary: message('Reserved the project identifier {identifier}', { identifier }),
      after: { note: note || null },
    },
  );
  return { identifier: row.identifier, ...(row.note ? { note: row.note } : {}), reservedBy: row.reservedBy, createdAt: row.createdAt.toISOString() };
}

export async function release(value: string): Promise<void> {
  const identifier = normalise(value);
  const reserved = await prisma.reservedIdentifier.findUnique({ where: { identifier } });
  if (!reserved) throw EpmError.notFound('That reservation');
  await withAudit((tx) => tx.reservedIdentifier.delete({ where: { identifier } }), {
    entityType: 'reserved_identifier',
    entityId: identifier,
    action: 'reserved_identifier.released',
    summary: message('Released the project identifier {identifier}', { identifier }),
    before: { note: reserved.note },
  });
}
