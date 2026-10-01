import type { FastifyRequest } from 'fastify';

import * as guard from '../auth/guard.js';
import { permissionsFor } from '../auth/guard.js';
import { allows } from '../auth/capabilities.js';
import { EpmError } from '../lib/errors.js';
import { getUsers } from '../mapping/users.js';
import { listProjects } from '../mapping/projects.js';
import { requestSignal } from '../lib/request-signal.js';
import type { RecordAbilities } from '../types/epm.js';

/**
 * Authorisation and naming shared by meetings, news and the wiki.
 *
 * All three are EPM's own records scoped to an OpenProject project, or to no
 * project at all, and all three need the same three answers: may this person see
 * this scope, may they add to it, and may they change this particular record.
 * Written once here because three copies of an authorisation rule is three
 * chances for one of them to be wrong.
 *
 * The rules, and why:
 *
 *   Reading a project's records requires `project:view` **in that project**, so
 *   visibility follows project membership exactly. EPM invents no separate
 *   sharing model, and a person removed from a project loses its meetings with
 *   the rest of it.
 *
 *   Adding to a project requires the same `project:view`. Scheduling a meeting,
 *   posting news or writing a wiki page is what a member does; requiring
 *   `project:edit` would have made these read-only for most of a project team,
 *   which is not what the modules are for.
 *
 *   Changing a record requires being its author, or holding `project:edit` in
 *   its project. Authorship covers the ordinary case — people fix their own
 *   minutes — and `project:edit` is what lets a lead clean up after somebody who
 *   has left.
 *
 *   Organisation-wide records (no project) are readable by anyone signed in and
 *   writable only by an administrator: an announcement addressed to everybody is
 *   not everybody's to publish.
 */

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

/** The administrator marker used throughout EPM for organisation-wide authority. */
const ADMIN_PERMISSION = 'users:manage' as const;

/** A project id from a request body or query, validated before it reaches upstream. */
export function optionalProjectId(value: unknown, field = 'project'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw EpmError.badRequest(`That ${field} is not valid.`);
  }
  return value;
}

/** May this person read records in this scope? Throws if not. */
export async function requireScopeRead(
  request: FastifyRequest,
  projectId: string | null | undefined,
): Promise<void> {
  // Organisation-wide: any signed-in caller. The auth hook has already refused
  // anybody without a session, so there is nothing further to check.
  if (!projectId) return;

  await guard.require(request, 'project:view', projectId);
}

/** May this person add a record to this scope? Throws if not. */
export async function requireScopeWrite(
  request: FastifyRequest,
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) {
    await guard.require(request, ADMIN_PERMISSION);
    return;
  }

  await guard.require(request, 'project:view', projectId);
}

/**
 * May this person change or delete this record?
 *
 * Returns the abilities rather than throwing, because every read needs them for
 * the `can` field on the response — the UI has to know whether to offer an edit
 * button before anybody presses it. `requireRecordWrite` below is the throwing
 * version, for the write paths.
 */
export async function abilitiesFor(
  request: FastifyRequest,
  record: { authorId: string; projectId: string | null },
): Promise<RecordAbilities> {
  const userId = request.auth?.userId;
  if (!userId) return { update: false, delete: false };

  if (record.authorId === userId) return { update: true, delete: true };

  const permissions = await permissionsFor(request);
  const privileged = record.projectId
    ? allows(permissions, 'project:edit', record.projectId)
    : allows(permissions, ADMIN_PERMISSION);

  return { update: privileged, delete: privileged };
}

/** The throwing form, for a write path. */
export async function requireRecordWrite(
  request: FastifyRequest,
  record: { authorId: string; projectId: string | null },
  what: string,
): Promise<void> {
  const can = await abilitiesFor(request, record);
  if (!can.update) {
    throw EpmError.forbidden(`You do not have permission to change this ${what}.`);
  }
}

/**
 * The projects this caller may see, by id.
 *
 * Used two ways: to name a record's project for display, and — more
 * importantly — to scope an unfiltered list. "Every meeting" has to mean "every
 * meeting in a project I can see, plus the organisation-wide ones", and the only
 * authority on the first part is OpenProject. Asking it once per list is far
 * cheaper than a permission check per row.
 *
 * Cached on the reference cache, which is keyed per user — so one person's
 * visible set is never served to another.
 */
export async function visibleProjects(
  request: FastifyRequest,
): Promise<Map<string, string>> {
  // The shared cached list, rather than a walk of its own. Every meetings, news
  // and wiki request needs this to name a record's project and to scope an
  // unfiltered list, and each was paying for its own copy.
  const projects = await listProjects(requestSignal(request));
  return new Map(projects.map((project) => [String(project.id), project.name]));
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Display names for a set of OpenProject user ids.
 *
 * Nothing in these tables stores a name — they store ids, because OpenProject
 * owns identity and a copied name is a name that goes stale. Resolved at read
 * time from the cached directory, and absent rather than invented for somebody
 * the caller cannot read.
 */
export async function namesFor(ids: Iterable<string>): Promise<Map<string, string>> {
  const wanted = new Set([...ids].filter(Boolean));
  if (wanted.size === 0) return new Map();

  const users = await getUsers().catch(() => []);
  return new Map(
    users.filter((user) => wanted.has(user.id)).map((user) => [user.id, user.name]),
  );
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A URL-safe slug from a title.
 *
 * Deliberately lossy and ASCII-only: a slug is an address, and an address has to
 * survive being typed, pasted into a chat window and printed. A title with no
 * ASCII in it at all yields an empty string, which the caller turns into a
 * fallback rather than storing.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    // Strip combining marks, so "Café" becomes "Cafe" rather than "Caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Trimmed, or undefined when there is nothing left. Empty means "clear it". */
export function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw EpmError.badRequest(`${field} must be text.`);

  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw EpmError.badRequest(`${field} cannot be longer than ${max} characters.`);
  }
  return trimmed;
}

/** The same, but required and non-empty. */
export function requiredText(value: unknown, field: string, max: number): string {
  const trimmed = text(value, field, max);
  if (!trimmed) throw EpmError.badRequest(`${field} is required.`);
  return trimmed;
}
