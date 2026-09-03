import type { Department } from '@prisma/client';

import { EpmError } from '../lib/errors.js';
import { getUsers } from '../mapping/users.js';
import { prisma } from '../db/prisma.js';

/**
 * Departments — validation and storage.
 *
 * EPM owns this outright: no OpenProject record corresponds to a department, so
 * nothing here calls upstream except to resolve a manager's display name.
 *
 * Kept apart from the route file the way `mapping/*` is kept apart from the
 * routes that use it. This is where the rules live; the route decides who may
 * ask.
 */

export interface EpmDepartment {
  id: string;
  name: string;
  code: string;
  description?: string;
  /**
   * The manager, resolved for display. An id alone would make every client
   * join against the directory itself; the name is never stored, only looked up.
   */
  manager?: { id: string; name: string };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentInput {
  name?: unknown;
  code?: unknown;
  description?: unknown;
  managerId?: unknown;
}

const NAME_MAX = 120;
const CODE_MIN = 2;
const CODE_MAX = 16;
const DESCRIPTION_MAX = 2000;
/** Uppercase letters, digits and hyphens — a key people type, not free text. */
const CODE_PATTERN = /^[A-Z0-9-]+$/;

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw EpmError.badRequest(`${field} must be text.`);
  return value.trim();
}

function validateName(value: unknown): string {
  // Missing and malformed are different mistakes, and a caller who sent no name
  // is not helped by being told what type it should have been.
  if (value === undefined || value === null) throw EpmError.badRequest('A name is required.');

  const name = asString(value, 'The name');
  if (!name) throw EpmError.badRequest('A name is required.');
  if (name.length > NAME_MAX) {
    throw EpmError.badRequest(`The name cannot be longer than ${NAME_MAX} characters.`);
  }
  return name;
}

/** Codes are normalized before storing, so `eng` and `ENG` cannot both exist. */
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
  // Empty means "no description", not an empty string.
  return description || null;
}

/**
 * Checks a manager id against the directory.
 *
 * The id is not stored as a foreign key, so nothing at the database level would
 * catch a value that names no one. It is checked against the users the caller
 * can actually see, which also stops a department being used to probe for the
 * existence of accounts.
 */
async function validateManagerId(value: unknown, signal: AbortSignal): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;

  const managerId = asString(value, 'The manager');
  const users = await getUsers(signal);

  if (!users.some((user) => user.id === managerId)) {
    throw EpmError.badRequest('That manager is not a user you can assign.');
  }

  return managerId;
}

/** Manager display names, from the same cached directory the comments use. */
async function managerNames(signal: AbortSignal): Promise<Map<string, string>> {
  const users = await getUsers(signal).catch(() => []);
  return new Map(users.map((user) => [user.id, user.name]));
}

function toEpmDepartment(row: Department, names: Map<string, string>): EpmDepartment {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description ?? undefined,
    manager: row.managerId
      ? // A manager deleted upstream leaves an id behind that resolves to
        // nothing. Reported as unresolved rather than failing the whole read.
        { id: row.managerId, name: names.get(row.managerId) ?? 'Unknown user' }
      : undefined,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Turns a unique-constraint violation into a usable message.
 *
 * Prisma reports P2002 with the field that collided. Left alone it would
 * surface as a 500, which tells a user retyping a code nothing at all.
 */
function asConflict(error: unknown): never {
  const violation = error as { code?: string; meta?: { target?: string[] | string } };

  if (violation?.code === 'P2002') {
    const target = Array.isArray(violation.meta?.target)
      ? violation.meta.target.join(', ')
      : String(violation.meta?.target ?? '');

    throw EpmError.badRequest(
      target.includes('code')
        ? 'A department with that code already exists.'
        : 'A department with that name already exists.',
    );
  }

  throw error;
}

/**
 * Rejects a name that differs from an existing one only by case.
 *
 * The database enforces exact uniqueness; this covers "Engineering" against
 * "engineering", which Postgres treats as distinct. Application-level, so two
 * simultaneous creates could still slip past — recorded as a known limitation.
 */
async function assertNameAvailable(name: string, exceptId?: string): Promise<void> {
  const clash = await prisma.department.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) throw EpmError.badRequest('A department with that name already exists.');
}

export async function listDepartments(
  options: { includeInactive?: boolean },
  signal: AbortSignal,
): Promise<EpmDepartment[]> {
  const [rows, names] = await Promise.all([
    prisma.department.findMany({
      where: options.includeInactive ? {} : { active: true },
      orderBy: { name: 'asc' },
    }),
    managerNames(signal),
  ]);

  return rows.map((row) => toEpmDepartment(row, names));
}

export async function getDepartment(id: string, signal: AbortSignal): Promise<EpmDepartment> {
  const row = await prisma.department.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That department');

  return toEpmDepartment(row, await managerNames(signal));
}

export async function createDepartment(
  input: DepartmentInput,
  signal: AbortSignal,
): Promise<EpmDepartment> {
  const name = validateName(input.name);
  const code = validateCode(input.code);
  const description = validateDescription(input.description);
  const managerId = await validateManagerId(input.managerId, signal);

  await assertNameAvailable(name);

  // `active` is not accepted from the caller: the lifecycle routes own it, so a
  // department cannot be created already archived.
  const row = await prisma.department
    .create({ data: { name, code, description, managerId } })
    .catch(asConflict);

  return toEpmDepartment(row, await managerNames(signal));
}

export async function updateDepartment(
  id: string,
  input: DepartmentInput,
  signal: AbortSignal,
): Promise<EpmDepartment> {
  const existing = await prisma.department.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw EpmError.notFound('That department');

  // Only what was sent is changed, so a partial update cannot blank a field by
  // omitting it.
  const data: { name?: string; code?: string; description?: string | null; managerId?: string | null } = {};

  if (input.name !== undefined) {
    data.name = validateName(input.name);
    await assertNameAvailable(data.name, id);
  }
  if (input.code !== undefined) data.code = validateCode(input.code);
  if (input.description !== undefined) data.description = validateDescription(input.description);
  if (input.managerId !== undefined) {
    data.managerId = await validateManagerId(input.managerId, signal);
  }

  if (Object.keys(data).length === 0) {
    throw EpmError.badRequest('There is nothing to update.');
  }

  const row = await prisma.department.update({ where: { id }, data }).catch(asConflict);

  return toEpmDepartment(row, await managerNames(signal));
}

/**
 * Deactivates or restores a department.
 *
 * There is no delete. Teams, employee mappings and portfolio will all reference
 * departments, and removing one would orphan those references — the same reason
 * projects are archived rather than deleted.
 */
export async function setDepartmentActive(
  id: string,
  active: boolean,
  signal: AbortSignal,
): Promise<EpmDepartment> {
  const existing = await prisma.department.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw EpmError.notFound('That department');

  const row = await prisma.department.update({ where: { id }, data: { active } });

  return toEpmDepartment(row, await managerNames(signal));
}
