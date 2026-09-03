import type { Portfolio } from '@prisma/client';

import { EpmError } from '../lib/errors.js';
import { prisma } from '../db/prisma.js';
import type { HealthLevel } from '../types/epm.js';

/**
 * Portfolios — a named grouping of projects that EPM owns.
 *
 * Nothing here copies a project. The association is one nullable reference on
 * the project's EPM profile, and every project fact in a rollup is read live
 * from the projects the caller can already see.
 *
 * The teams working on a portfolio are **derived**, not declared: a project's
 * people come from OpenProject memberships and each is mapped to an EPM team,
 * so the teams follow from who is actually on the work and cannot drift from
 * it. See `docs/portfolio-design.md` for the trade that comes with that.
 */

export interface EpmPortfolio {
  id: string;
  name: string;
  code: string;
  description?: string;
  /** Projects associated with it, whether or not they are active upstream. */
  projectCount: number;
  activeProjectCount: number;
  /**
   * How its projects' effective health is distributed. The distribution rather
   * than a single verdict: rolling three states into one needs a rule nobody
   * has specified, and health itself is not recalculated here.
   */
  health: { healthy: number; warning: number; critical: number };
  /**
   * People across its projects, each counted once. Someone on two projects in
   * the same portfolio would otherwise be counted twice and overstate it.
   */
  memberCount: number;
  capacityHours: number;
  /** Distinct teams those people belong to. Derived, never declared. */
  teams: { id: string; name: string }[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioInput {
  name?: unknown;
  code?: unknown;
  description?: unknown;
}

/** What a rollup needs from each project, read live rather than stored. */
export interface PortfolioProjectFacts {
  portfolioId: string;
  active: boolean;
  overallHealth: HealthLevel;
  memberIds: string[];
}

const NAME_MAX = 120;
const CODE_MIN = 2;
const CODE_MAX = 16;
const DESCRIPTION_MAX = 2000;
const CODE_PATTERN = /^[A-Z0-9-]+$/;

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

/** Normalized before storing, so `PLAT` and `plat` collide in Postgres too. */
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

/** Turns a unique-constraint violation into a message that names the field. */
function asConflict(error: unknown): never {
  const violation = error as { code?: string; meta?: { target?: string[] | string } };

  if (violation?.code === 'P2002') {
    const target = Array.isArray(violation.meta?.target)
      ? violation.meta.target.join(', ')
      : String(violation.meta?.target ?? '');

    throw EpmError.badRequest(
      target.includes('code')
        ? 'A portfolio with that code already exists.'
        : 'A portfolio with that name already exists.',
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
  const clash = await prisma.portfolio.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) throw EpmError.badRequest('A portfolio with that name already exists.');
}

/**
 * Builds the rollups for every portfolio from live project facts.
 *
 * `facts` is supplied by the caller, which already has the projects loaded, so
 * this never reads OpenProject itself and never sees a project the caller
 * cannot. Capacity comes from the EPM employee mapping, unchanged.
 */
async function rollupsFor(
  facts: PortfolioProjectFacts[],
): Promise<Map<string, Omit<EpmPortfolio, keyof Portfolio | 'description'>>> {
  const profiles = await prisma.userProfile.findMany({
    where: { teamId: { not: null } },
    select: { openProjectId: true, hoursCapacity: true, team: { select: { id: true, name: true } } },
  });
  const byPerson = new Map(profiles.map((row) => [row.openProjectId, row]));

  const rollups = new Map<
    string,
    {
      projectCount: number;
      activeProjectCount: number;
      health: { healthy: number; warning: number; critical: number };
      people: Set<string>;
      teams: Map<string, string>;
    }
  >();

  for (const fact of facts) {
    let rollup = rollups.get(fact.portfolioId);
    if (!rollup) {
      rollup = {
        projectCount: 0,
        activeProjectCount: 0,
        health: { healthy: 0, warning: 0, critical: 0 },
        people: new Set(),
        teams: new Map(),
      };
      rollups.set(fact.portfolioId, rollup);
    }

    rollup.projectCount += 1;
    if (fact.active) rollup.activeProjectCount += 1;
    rollup.health[fact.overallHealth] += 1;

    // A set, so someone on two projects in the same portfolio is counted once.
    for (const memberId of fact.memberIds) rollup.people.add(memberId);
  }

  const result = new Map<string, Omit<EpmPortfolio, keyof Portfolio | 'description'>>();

  for (const [portfolioId, rollup] of rollups) {
    let capacityHours = 0;
    for (const personId of rollup.people) {
      const profile = byPerson.get(personId);
      if (!profile) continue;
      capacityHours += profile.hoursCapacity;
      if (profile.team) rollup.teams.set(profile.team.id, profile.team.name);
    }

    result.set(portfolioId, {
      projectCount: rollup.projectCount,
      activeProjectCount: rollup.activeProjectCount,
      health: rollup.health,
      memberCount: rollup.people.size,
      // Float addition leaves 37.5 + 37.5 + 0.1 looking like 75.10000000000001.
      capacityHours: Math.round(capacityHours * 100) / 100,
      teams: [...rollup.teams].map(([id, name]) => ({ id, name })),
    });
  }

  return result;
}

function toEpmPortfolio(
  row: Portfolio,
  rollup: Omit<EpmPortfolio, keyof Portfolio | 'description'> | undefined,
): EpmPortfolio {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description ?? undefined,
    // Zero rather than absent: an empty portfolio has no projects, which is an
    // answer rather than a missing value.
    projectCount: rollup?.projectCount ?? 0,
    activeProjectCount: rollup?.activeProjectCount ?? 0,
    health: rollup?.health ?? { healthy: 0, warning: 0, critical: 0 },
    memberCount: rollup?.memberCount ?? 0,
    capacityHours: rollup?.capacityHours ?? 0,
    teams: rollup?.teams ?? [],
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPortfolios(
  options: { includeInactive?: boolean },
  facts: PortfolioProjectFacts[],
): Promise<EpmPortfolio[]> {
  const [rows, rollups] = await Promise.all([
    prisma.portfolio.findMany({
      where: options.includeInactive ? {} : { active: true },
      orderBy: { name: 'asc' },
    }),
    rollupsFor(facts),
  ]);

  return rows.map((row) => toEpmPortfolio(row, rollups.get(row.id)));
}

export async function getPortfolio(
  id: string,
  facts: PortfolioProjectFacts[],
): Promise<EpmPortfolio> {
  const row = await prisma.portfolio.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That portfolio');

  return toEpmPortfolio(row, (await rollupsFor(facts)).get(id));
}

export async function createPortfolio(
  input: PortfolioInput,
  facts: PortfolioProjectFacts[],
): Promise<EpmPortfolio> {
  const name = validateName(input.name);
  const code = validateCode(input.code);
  const description = validateDescription(input.description);

  await assertNameAvailable(name);

  // `active` is not accepted from the caller: the lifecycle routes own it.
  const row = await prisma.portfolio.create({ data: { name, code, description } }).catch(asConflict);

  return toEpmPortfolio(row, (await rollupsFor(facts)).get(row.id));
}

export async function updatePortfolio(
  id: string,
  input: PortfolioInput,
  facts: PortfolioProjectFacts[],
): Promise<EpmPortfolio> {
  const existing = await prisma.portfolio.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw EpmError.notFound('That portfolio');

  // Only what was sent is changed, so a partial update cannot blank a field by
  // omitting it.
  const data: { name?: string; code?: string; description?: string | null } = {};

  if (input.name !== undefined) {
    data.name = validateName(input.name);
    await assertNameAvailable(data.name, id);
  }
  if (input.code !== undefined) data.code = validateCode(input.code);
  if (input.description !== undefined) data.description = validateDescription(input.description);

  if (Object.keys(data).length === 0) {
    throw EpmError.badRequest('There is nothing to update.');
  }

  const row = await prisma.portfolio.update({ where: { id }, data }).catch(asConflict);

  return toEpmPortfolio(row, (await rollupsFor(facts)).get(id));
}

/**
 * Deactivates or restores a portfolio.
 *
 * No delete. Projects reference portfolios, and archiving is a visibility
 * decision that leaves those associations exactly as they were — the same rule
 * departments and teams follow.
 */
export async function setPortfolioActive(
  id: string,
  active: boolean,
  facts: PortfolioProjectFacts[],
): Promise<EpmPortfolio> {
  const existing = await prisma.portfolio.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw EpmError.notFound('That portfolio');

  const row = await prisma.portfolio.update({ where: { id }, data: { active } });

  return toEpmPortfolio(row, (await rollupsFor(facts)).get(id));
}

/**
 * Associates a project with a portfolio, or clears it.
 *
 * Assignment into an archived portfolio is refused, consistent with every other
 * assignment in EPM; an existing association into one that has since been
 * archived is left alone, and can always be cleared.
 */
export async function setProjectPortfolio(
  projectId: string,
  portfolioId: unknown,
): Promise<string | null> {
  const requested =
    portfolioId === undefined || portfolioId === null || portfolioId === ''
      ? null
      : asString(portfolioId, 'The portfolio');

  if (requested) {
    const portfolio = await prisma.portfolio.findUnique({
      where: { id: requested },
      select: { id: true, active: true },
    });

    if (!portfolio) throw EpmError.badRequest('That portfolio does not exist.');
    if (!portfolio.active) {
      throw EpmError.badRequest('That portfolio is archived, so a project cannot be moved into it.');
    }
  }

  await prisma.projectProfile.upsert({
    where: { openProjectId: projectId },
    create: { openProjectId: projectId, portfolioId: requested },
    update: { portfolioId: requested },
  });

  return requested;
}
