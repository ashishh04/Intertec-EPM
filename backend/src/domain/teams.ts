import type { Department, Team } from '@prisma/client';

import { EpmError } from '../lib/errors.js';
import { getUsers } from '../mapping/users.js';
import { memberCounts } from './employees.js';
import { prisma } from '../db/prisma.js';

/**
 * Teams — validation and storage.
 *
 * EPM owns these outright. They were previously a reading of OpenProject
 * groups, which could carry neither a department nor a lifecycle of their own;
 * upstream is now consulted only to resolve a lead's display name.
 *
 * Membership, projects and capacity are deliberately absent. Each belongs to a
 * feature that has not been built, and a column added now would be a guess at
 * its shape.
 */

export interface EpmTeam {
  id: string;
  name: string;
  code: string;
  description?: string;
  /**
   * The owning department, resolved for display. `active` is included because a
   * team outlives its department's archival, and the UI has to be able to say
   * so rather than showing a name that looks current.
   */
  department?: { id: string; name: string; active: boolean };
  /** The lead, resolved for display. Only the id is stored. */
  lead?: { id: string; name: string };
  /**
   * How many people are mapped to this team. Counted from EPM's employee
   * mapping — never from OpenProject group membership, which is what teams
   * were read from before.
   */
  memberCount: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamInput {
  name?: unknown;
  code?: unknown;
  description?: unknown;
  departmentId?: unknown;
  leadId?: unknown;
}

const NAME_MAX = 120;
const CODE_MIN = 2;
const CODE_MAX = 16;
const DESCRIPTION_MAX = 2000;
const CODE_PATTERN = /^[A-Z0-9-]+$/;

type TeamWithDepartment = Team & { department: Department | null };

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw EpmError.badRequest(`${field} must be text.`);
  return value.trim();
}

function validateName(value: unknown): string {
  if (value === undefined || value === null) throw EpmError.badRequest('A name is required.');

  const name = asString(value, 'The name');
  if (!name) throw EpmError.badRequest('A name is required.');
  if (name.length > NAME_MAX) {
    throw EpmError.badRequest(`The name cannot be longer than ${NAME_MAX} characters.`);
  }
  return name;
}

/** Normalized before storing, so `ENG` and `eng` collide in Postgres too. */
function validateCode(value: unknown): string {
  if (value === undefined || value === null) throw EpmError.badRequest('A code is required.');

  const code = asString(value, 'The code').toUpperCase();
  if (!code) throw EpmError.badRequest('A code is required.');
  if (code.length < CODE_MIN || code.length > CODE_MAX) {
    throw EpmError.badRequest(`The code must be between ${CODE_MIN} and ${CODE_MAX} characters.`);
  }
  if (!CODE_PATTERN.test(code)) {
    throw EpmError.badRequest('The code can contain only letters, numbers and hyphens.');
  }
  return code;
}

function validateDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  const description = asString(value, 'The description');
  if (description.length > DESCRIPTION_MAX) {
    throw EpmError.badRequest(`The description cannot be longer than ${DESCRIPTION_MAX} characters.`);
  }
  return description || null;
}

/**
 * Checks a department can be joined.
 *
 * The foreign key already guarantees the department exists, but it would report
 * that as a constraint violation rather than a usable message, and it says
 * nothing about lifecycle. Forming a *new* association into a department being
 * retired is refused — which is not the same as retaining an existing one, and
 * is why the archive rule leaves current members alone.
 */
async function validateDepartmentId(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;

  const departmentId = asString(value, 'The department');
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, active: true },
  });

  if (!department) throw EpmError.badRequest('That department does not exist.');
  if (!department.active) {
    throw EpmError.badRequest('That department is archived, so a team cannot be moved into it.');
  }

  return department.id;
}

/**
 * Checks a lead against the directory.
 *
 * Not a foreign key — OpenProject owns users — so nothing at the database level
 * would catch an id naming nobody. Checked against the users the caller can
 * see, which also stops a team being used to probe for accounts.
 */
async function validateLeadId(value: unknown, signal: AbortSignal): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;

  const leadId = asString(value, 'The lead');
  const users = await getUsers(signal);

  if (!users.some((user) => user.id === leadId)) {
    throw EpmError.badRequest('That lead is not a user you can assign.');
  }

  return leadId;
}

async function leadNames(signal: AbortSignal): Promise<Map<string, string>> {
  const users = await getUsers(signal).catch(() => []);
  return new Map(users.map((user) => [user.id, user.name]));
}

function toEpmTeam(
  row: TeamWithDepartment,
  names: Map<string, string>,
  counts: Map<string, number>,
): EpmTeam {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description ?? undefined,
    department: row.department
      ? { id: row.department.id, name: row.department.name, active: row.department.active }
      : undefined,
    lead: row.leadId
      ? // A lead removed upstream leaves an id that resolves to nothing. Reported
        // as unresolved rather than failing the read.
        { id: row.leadId, name: names.get(row.leadId) ?? 'Unknown user' }
      : undefined,
    memberCount: counts.get(row.id) ?? 0,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Turns a unique-constraint violation into a message that names the field. */
function asConflict(error: unknown): never {
  const violation = error as { code?: string; meta?: { target?: string[] | string } };

  if (violation?.code === 'P2002') {
    const target = Array.isArray(violation.meta?.target)
      ? violation.meta.target.join(', ')
      : String(violation.meta?.target ?? '');

    throw EpmError.badRequest(
      target.includes('code')
        ? 'A team with that code already exists.'
        : 'A team with that name already exists.',
    );
  }

  throw error;
}

/**
 * Rejects a name differing from an existing one only by case.
 *
 * The database enforces this too, through a functional index on `LOWER(name)`,
 * so this exists to produce the message rather than to be the guarantee.
 */
async function assertNameAvailable(name: string, exceptId?: string): Promise<void> {
  const clash = await prisma.team.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) throw EpmError.badRequest('A team with that name already exists.');
}

export async function listTeams(
  options: { includeInactive?: boolean; departmentId?: string },
  signal: AbortSignal,
): Promise<EpmTeam[]> {
  const [rows, names, counts] = await Promise.all([
    prisma.team.findMany({
      where: {
        ...(options.includeInactive ? {} : { active: true }),
        ...(options.departmentId ? { departmentId: options.departmentId } : {}),
      },
      include: { department: true },
      orderBy: { name: 'asc' },
    }),
    leadNames(signal),
    memberCounts(),
  ]);

  return rows.map((row) => toEpmTeam(row, names, counts));
}

export async function getTeam(id: string, signal: AbortSignal): Promise<EpmTeam> {
  const row = await prisma.team.findUnique({ where: { id }, include: { department: true } });
  if (!row) throw EpmError.notFound('That team');

  return toEpmTeam(row, await leadNames(signal), await memberCounts());
}

export async function createTeam(input: TeamInput, signal: AbortSignal): Promise<EpmTeam> {
  const name = validateName(input.name);
  const code = validateCode(input.code);
  const description = validateDescription(input.description);
  const departmentId = await validateDepartmentId(input.departmentId);
  const leadId = await validateLeadId(input.leadId, signal);

  await assertNameAvailable(name);

  // `active` is not accepted from the caller: the lifecycle routes own it.
  const row = await prisma.team
    .create({
      data: { name, code, description, departmentId, leadId },
      include: { department: true },
    })
    .catch(asConflict);

  return toEpmTeam(row, await leadNames(signal), await memberCounts());
}

export async function updateTeam(
  id: string,
  input: TeamInput,
  signal: AbortSignal,
): Promise<EpmTeam> {
  const existing = await prisma.team.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw EpmError.notFound('That team');

  // Only what was sent is changed, so a partial update cannot blank a field by
  // omitting it.
  const data: {
    name?: string;
    code?: string;
    description?: string | null;
    departmentId?: string | null;
    leadId?: string | null;
  } = {};

  if (input.name !== undefined) {
    data.name = validateName(input.name);
    await assertNameAvailable(data.name, id);
  }
  if (input.code !== undefined) data.code = validateCode(input.code);
  if (input.description !== undefined) data.description = validateDescription(input.description);
  if (input.departmentId !== undefined) {
    data.departmentId = await validateDepartmentId(input.departmentId);
  }
  if (input.leadId !== undefined) data.leadId = await validateLeadId(input.leadId, signal);

  if (Object.keys(data).length === 0) {
    throw EpmError.badRequest('There is nothing to update.');
  }

  const row = await prisma.team
    .update({ where: { id }, data, include: { department: true } })
    .catch(asConflict);

  return toEpmTeam(row, await leadNames(signal), await memberCounts());
}

/**
 * Deactivates or restores a team.
 *
 * No delete, matching departments and projects. A team's lifecycle is its own:
 * archiving the department it belongs to leaves it untouched, and a team in an
 * archived department can still be archived, restored, or moved somewhere
 * active.
 */
export async function setTeamActive(
  id: string,
  active: boolean,
  signal: AbortSignal,
): Promise<EpmTeam> {
  const existing = await prisma.team.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw EpmError.notFound('That team');

  const row = await prisma.team.update({
    where: { id },
    data: { active },
    include: { department: true },
  });

  return toEpmTeam(row, await leadNames(signal), await memberCounts());
}
