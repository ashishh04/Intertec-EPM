import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { recordAudit, withAudit } from '../domain/audit.js';
import { namesFor } from '../domain/collaboration.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { requestSignal } from '../lib/request-signal.js';
import { getUsers } from '../mapping/users.js';
import { openProject } from '../openproject/client.js';
import type { EpmProgram, EpmProject } from '../types/epm.js';
import { invalidateProjects, loadProjectsFor } from './projects.js';

/**
 * Programs: related projects run together, between a portfolio and its
 * projects. EPM-owned (the delivery system keeps its own programs for paid
 * plans only): a project belongs to at most one, through its EPM profile.
 *
 * Reading follows the projects, as for portfolios: a program shows to
 * whoever can see a project in it, and every figure is counted from the
 * projects that reader can see. Whoever manages portfolios sees and changes
 * them all.
 */

const CODE = /^[A-Z0-9-]{2,16}$/;

const writeBody = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(120),
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => CODE.test(value), 'The code can contain only letters, numbers and hyphens, 2 to 16 of them.'),
  description: z.string().trim().max(2000).optional(),
  portfolioId: z.string().nullable().optional(),
  managerId: z.string().regex(/^\d+$/).nullable().optional(),
});

type ProgramRow = Awaited<ReturnType<typeof prisma.program.findUniqueOrThrow>> & { portfolio: { name: string } | null };

function rollup(row: ProgramRow, projects: EpmProject[], names: Map<string, string>): EpmProgram {
  const mine = projects.filter((project) => project.programId === row.id);
  const health = { healthy: 0, warning: 0, critical: 0, unassessed: 0 };
  for (const project of mine) {
    // Nothing measured yet reads as not assessed rather than as healthy.
    const assessed = project.healthDetail?.criteria?.some((criterion) => criterion.level !== null) ?? false;
    const level = assessed ? project.health.overall : 'unassessed';
    health[level as keyof typeof health] += 1;
  }
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    ...(row.description ? { description: row.description } : {}),
    ...(row.portfolioId ? { portfolioId: row.portfolioId, ...(row.portfolio ? { portfolioName: row.portfolio.name } : {}) } : {}),
    ...(row.managerId ? { managerId: row.managerId, ...(names.has(row.managerId) ? { managerName: names.get(row.managerId)! } : {}) } : {}),
    active: row.active,
    projectCount: mine.length,
    health,
    progress: mine.length ? Math.round(mine.reduce((sum, project) => sum + project.progress, 0) / mine.length) : 0,
    budgetTotal: mine.reduce((sum, project) => sum + (project.budgetTotal ?? 0), 0),
    budgetUsed: mine.reduce((sum, project) => sum + (project.budgetUsed ?? 0), 0),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What the journal keeps of a program. */
const record = (row: { name: string; code: string; description: string | null; portfolioId: string | null; managerId: string | null; active: boolean }) => ({
  name: row.name,
  code: row.code,
  description: row.description,
  portfolioId: row.portfolioId,
  managerId: row.managerId,
  active: row.active,
});

async function validatePortfolio(portfolioId: string | null | undefined): Promise<string | null | undefined> {
  if (portfolioId === undefined) return undefined;
  if (!portfolioId) return null;
  const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId }, select: { id: true, active: true } });
  if (!portfolio) throw EpmError.badRequest('That portfolio does not exist.');
  if (!portfolio.active) throw EpmError.badRequest('That portfolio is archived, so a program cannot be put in it.');
  return portfolio.id;
}

async function validateManager(managerId: string | null | undefined, signal: AbortSignal): Promise<string | null | undefined> {
  if (managerId === undefined) return undefined;
  if (!managerId) return null;
  const users = await getUsers(signal);
  if (!users.some((user) => user.id === managerId)) throw EpmError.badRequest('That person is not someone you can name.');
  return managerId;
}

async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const clash = await prisma.program.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw EpmError.badRequest('A program with that name already exists.');
}

/** Reads a program the caller may see, answered as not found when not. */
async function readable(request: FastifyRequest, id: string): Promise<{ row: ProgramRow; projects: EpmProject[] }> {
  const [row, projects, manager] = await Promise.all([
    prisma.program.findUnique({ where: { id }, include: { portfolio: { select: { name: true } } } }),
    loadProjectsFor(request),
    guard.holds(request, 'portfolios:manage'),
  ]);
  if (!row || (!manager && !projects.some((project) => project.programId === row.id))) throw EpmError.notFound('That program');
  return { row, projects };
}

export const programRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { includeInactive?: string } }>('/programs', async (request) => {
    const [rows, projects, manager] = await Promise.all([
      prisma.program.findMany({
        where: request.query.includeInactive === 'true' ? {} : { active: true },
        include: { portfolio: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
      loadProjectsFor(request),
      guard.holds(request, 'portfolios:manage'),
    ]);
    const names = await namesFor(rows.flatMap((row) => (row.managerId ? [row.managerId] : [])));
    const programs = rows.map((row) => rollup(row, projects, names));
    return manager ? programs : programs.filter((program) => program.projectCount > 0);
  });

  app.get<{ Params: { id: string } }>('/programs/:id', async (request) => {
    const { row, projects } = await readable(request, request.params.id);
    const names = await namesFor(row.managerId ? [row.managerId] : []);
    return { ...rollup(row, projects, names), projects: projects.filter((project) => project.programId === row.id) };
  });

  app.post<{ Body: unknown }>('/programs', async (request, reply) => {
    await guard.require(request, 'portfolios:manage');
    const input = writeBody.parse(request.body ?? {});
    await assertNameFree(input.name);
    if (await prisma.program.findUnique({ where: { code: input.code } })) throw EpmError.badRequest('A program with that code already exists.');
    const portfolioId = await validatePortfolio(input.portfolioId);
    const managerId = await validateManager(input.managerId, requestSignal(request));
    const row = await withAudit(
      (tx) =>
        tx.program.create({
          data: {
            name: input.name,
            code: input.code,
            description: input.description || null,
            portfolioId: portfolioId ?? null,
            managerId: managerId ?? null,
          },
          include: { portfolio: { select: { name: true } } },
        }),
      (created) => ({
        entityType: 'program',
        entityId: created.id,
        action: 'program.created',
        summary: message('Created program {name}', { name: created.name }),
        after: record(created),
      }),
    );
    const names = await namesFor(row.managerId ? [row.managerId] : []);
    reply.code(201);
    return rollup(row, await loadProjectsFor(request), names);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/programs/:id', async (request) => {
    await guard.require(request, 'portfolios:manage');
    const input = writeBody.partial().parse(request.body ?? {});
    if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');
    const existing = await prisma.program.findUnique({ where: { id: request.params.id } });
    if (!existing) throw EpmError.notFound('That program');
    if (input.name !== undefined) await assertNameFree(input.name, existing.id);
    if (input.code !== undefined && input.code !== existing.code && (await prisma.program.findUnique({ where: { code: input.code } }))) {
      throw EpmError.badRequest('A program with that code already exists.');
    }
    // Staying where it is is not joining: an archived portfolio it is in already is kept.
    const portfolioId = input.portfolioId === existing.portfolioId ? undefined : await validatePortfolio(input.portfolioId);
    const managerId = input.managerId === existing.managerId ? undefined : await validateManager(input.managerId, requestSignal(request));
    const row = await withAudit(
      (tx) =>
        tx.program.update({
          where: { id: existing.id },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.description === undefined ? {} : { description: input.description || null }),
            ...(portfolioId === undefined ? {} : { portfolioId }),
            ...(managerId === undefined ? {} : { managerId }),
          },
          include: { portfolio: { select: { name: true } } },
        }),
      (updated) => ({
        entityType: 'program',
        entityId: updated.id,
        action: 'program.updated',
        summary: message('Changed program {name}', { name: updated.name }),
        before: record(existing),
        after: record(updated),
      }),
    );
    invalidateProjects();
    const names = await namesFor(row.managerId ? [row.managerId] : []);
    return rollup(row, await loadProjectsFor(request), names);
  });

  for (const [path, active] of [['archive', false], ['restore', true]] as const) {
    app.patch<{ Params: { id: string } }>(`/programs/:id/${path}`, async (request) => {
      await guard.require(request, 'portfolios:manage');
      const existing = await prisma.program.findUnique({ where: { id: request.params.id } });
      if (!existing) throw EpmError.notFound('That program');
      const row = await withAudit(
        (tx) => tx.program.update({ where: { id: existing.id }, data: { active }, include: { portfolio: { select: { name: true } } } }),
        {
          entityType: 'program',
          entityId: existing.id,
          action: active ? 'program.restored' : 'program.archived',
          summary: active ? message('Restored program {name}', { name: existing.name }) : message('Archived program {name}', { name: existing.name }),
          before: { active: existing.active },
          after: { active },
        },
      );
      const names = await namesFor(row.managerId ? [row.managerId] : []);
      return rollup(row, await loadProjectsFor(request), names);
    });
  }

  /** Deletes a program created by mistake; refused while any project is in it. */
  app.delete<{ Params: { id: string } }>('/programs/:id', async (request, reply) => {
    await guard.require(request, 'portfolios:manage');
    const existing = await prisma.program.findUnique({ where: { id: request.params.id } });
    if (!existing) throw EpmError.notFound('That program');
    const inIt = await prisma.projectProfile.count({ where: { programId: existing.id } });
    if (inIt > 0) {
      throw EpmError.badRequest(
        message('{count, plural, one {# project is} other {# projects are}} still in that program. Move them out first, or archive it instead.', { count: inIt }),
      );
    }
    await withAudit((tx) => tx.program.delete({ where: { id: existing.id } }), {
      entityType: 'program',
      entityId: existing.id,
      action: 'program.deleted',
      summary: message('Deleted program {name}', { name: existing.name }),
      before: record(existing),
    });
    reply.code(204);
  });

  /** Puts a project in a program, or takes it out (null). */
  app.patch<{ Params: { id: string }; Body: { programId?: unknown } }>('/projects/:id/program', async (request) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.params);
    await guard.require(request, 'portfolios:manage');
    // Confirms the project exists and the caller can see it.
    await openProject.request<{ id: number }>(`/projects/${id}`, { signal: requestSignal(request) });
    const requested = request.body?.programId;
    const programId = typeof requested === 'string' && requested ? requested : null;
    if (programId) {
      const program = await prisma.program.findUnique({ where: { id: programId }, select: { active: true } });
      if (!program) throw EpmError.badRequest('That program does not exist.');
      if (!program.active) throw EpmError.badRequest('That program is archived, so a project cannot be moved into it.');
    }
    const before = await prisma.projectProfile.findUnique({ where: { openProjectId: id }, select: { programRef: { select: { id: true, name: true } } } });
    await prisma.projectProfile.upsert({
      where: { openProjectId: id },
      create: { openProjectId: id, programId },
      update: { programId },
    });
    if ((before?.programRef?.id ?? null) !== programId) {
      const now = programId ? await prisma.program.findUnique({ where: { id: programId }, select: { name: true } }) : null;
      await recordAudit({
        projectId: id,
        entityType: 'project',
        entityId: id,
        action: 'project.program.changed',
        summary: message('Program {from} → {to}.', { from: before?.programRef?.name ?? message('none'), to: now?.name ?? message('none') }),
      });
    }
    invalidateProjects();
    return { programId };
  });
};
