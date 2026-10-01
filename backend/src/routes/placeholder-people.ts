import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import type { EpmPlaceholderPerson } from '../types/epm.js';

/**
 * Placeholder people: named stand-ins for roles that are planned but not filled.
 *
 * EPM's own, not OpenProject's. Upstream has the same idea and gates creating
 * one behind an Enterprise licence, so on a Community instance it is simply
 * absent — and a planner still has to be able to say "a second backend
 * engineer, starting in March" before that person is hired.
 *
 * The boundary is real and worth stating plainly rather than papering over: a
 * placeholder belongs to a team and a department and carries weekly capacity,
 * so planned headcount counts toward team workload and portfolio capacity. It
 * cannot be a work package assignee, because OpenProject will only accept a
 * principal it knows about, and that is precisely the part the licence gates.
 *
 * `POST /:id/convert` is the way out: it records which real account the
 * placeholder became, and the caller carries the team, department and capacity
 * onto that person's profile.
 */

const writeBody = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(120, 'Keep the name under 120 characters.'),
  note: z.string().trim().max(500, 'Keep the note under 500 characters.').optional(),
  departmentId: z.string().trim().min(1).nullish(),
  teamId: z.string().trim().min(1).nullish(),
  hoursCapacity: z
    .number()
    .min(0, 'Capacity cannot be negative.')
    .max(168, 'A week has 168 hours.')
    .optional(),
});

const patchBody = writeBody.partial();

const listQuery = z.object({
  /** Placeholders already turned into real people. Excluded by default. */
  includeConverted: z.enum(['true', 'false']).optional(),
  teamId: z.string().optional(),
  departmentId: z.string().optional(),
});

type Row = Prisma.PlaceholderPersonGetPayload<{
  include: { departmentRef: true; team: true };
}>;

function toEpm(row: Row): EpmPlaceholderPerson {
  return {
    id: row.id,
    name: row.name,
    note: row.note ?? undefined,
    department: row.departmentRef
      ? { id: row.departmentRef.id, name: row.departmentRef.name, active: row.departmentRef.active }
      : undefined,
    team: row.team ? { id: row.team.id, name: row.team.name, active: row.team.active } : undefined,
    hoursCapacity: row.hoursCapacity,
    convertedToUserId: row.convertedTo ?? undefined,
    convertedAt: row.convertedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const include = { departmentRef: true, team: true } as const;

/**
 * Resolves the team and department as one unit.
 *
 * A team carries its own department, so naming a team settles both — the same
 * rule employee mapping follows, and for the same reason: the pair must never
 * disagree about which department someone sits in.
 */
async function resolveMapping(input: {
  teamId?: string | null;
  departmentId?: string | null;
}): Promise<{ teamId: string | null; departmentId: string | null }> {
  const teamId = input.teamId ?? null;
  let departmentId = input.departmentId ?? null;

  if (teamId) {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw EpmError.badRequest('That team does not exist.');
    departmentId = team.departmentId ?? departmentId;
  }

  if (departmentId) {
    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department) throw EpmError.badRequest('That department does not exist.');
  }

  return { teamId, departmentId };
}

/** A duplicate name is the one write failure worth naming precisely. */
function rethrowWrite(name: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw EpmError.conflict(`${name} is already a placeholder.`);
    }
    throw error;
  };
}

async function byId(id: string): Promise<Row> {
  const row = await prisma.placeholderPerson.findUnique({ where: { id }, include });
  if (!row) throw EpmError.notFound('That placeholder');
  return row;
}

export const placeholderPeopleRoutes: FastifyPluginAsync = async (app) => {
  /** Reading is open to anyone who may see the directory; they are org data. */
  app.get('/placeholder-people', async (request): Promise<EpmPlaceholderPerson[]> => {
    const query = listQuery.parse(request.query);

    const rows = await prisma.placeholderPerson.findMany({
      where: {
        ...(query.includeConverted === 'true' ? {} : { convertedTo: null }),
        ...(query.teamId ? { teamId: query.teamId } : {}),
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      },
      include,
      orderBy: { name: 'asc' },
    });

    return rows.map(toEpm);
  });

  app.get<{ Params: { id: string } }>('/placeholder-people/:id', async (request) => {
    return toEpm(await byId(request.params.id));
  });

  app.post<{ Body: unknown }>('/placeholder-people', async (request, reply) => {
    await guard.require(request, 'employees:manage');
    const input = writeBody.parse(request.body ?? {});
    const mapping = await resolveMapping(input);

    const created = await prisma.placeholderPerson
      .create({
        data: {
          name: input.name,
          note: input.note || null,
          ...mapping,
          ...(input.hoursCapacity === undefined ? {} : { hoursCapacity: input.hoursCapacity }),
        },
        include,
      })
      .catch(rethrowWrite(input.name));

    reply.code(201);
    return toEpm(created);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/placeholder-people/:id',
    async (request) => {
      await guard.require(request, 'employees:manage');
      const input = patchBody.parse(request.body ?? {});
      if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');

      const existing = await byId(request.params.id);
      if (existing.convertedTo) {
        throw EpmError.conflict('That placeholder has already become a real person.');
      }

      // Mapping is written as a pair whenever either half is mentioned, so the
      // two can never drift apart.
      const touchesMapping = 'teamId' in input || 'departmentId' in input;
      const mapping = touchesMapping
        ? await resolveMapping({
            teamId: 'teamId' in input ? input.teamId : existing.teamId,
            departmentId: 'departmentId' in input ? input.departmentId : existing.departmentId,
          })
        : {};

      const updated = await prisma.placeholderPerson
        .update({
          where: { id: request.params.id },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.note === undefined ? {} : { note: input.note || null }),
            ...(input.hoursCapacity === undefined ? {} : { hoursCapacity: input.hoursCapacity }),
            ...mapping,
          },
          include,
        })
        .catch(rethrowWrite(input.name ?? existing.name));

      return toEpm(updated);
    },
  );

  /**
   * Records that this placeholder has become a real person.
   *
   * The account itself is created through the accounts surface, which is where
   * account creation belongs and where its own rules live. This marks the
   * placeholder as filled and carries the planned team, department and capacity
   * onto that person's profile, so the capacity that was planned against the
   * placeholder does not vanish and reappear as a gap.
   *
   * The row is kept rather than deleted: a converted placeholder is the record
   * of a plan that was fulfilled, and deleting it would make last quarter's
   * capacity history unreadable.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/placeholder-people/:id/convert',
    async (request) => {
      await guard.require(request, 'employees:manage');

      const { userId } = z
        .object({ userId: z.string().regex(/^\d+$/, 'That person is not valid.') })
        .parse(request.body ?? {});

      const existing = await byId(request.params.id);
      if (existing.convertedTo) {
        throw EpmError.conflict('That placeholder has already become a real person.');
      }

      const [, converted] = await prisma.$transaction([
        prisma.userProfile.upsert({
          where: { openProjectId: userId },
          create: {
            openProjectId: userId,
            teamId: existing.teamId,
            departmentId: existing.departmentId,
            hoursCapacity: existing.hoursCapacity,
          },
          update: {
            teamId: existing.teamId,
            departmentId: existing.departmentId,
            hoursCapacity: existing.hoursCapacity,
          },
        }),
        prisma.placeholderPerson.update({
          where: { id: request.params.id },
          data: { convertedTo: userId, convertedAt: new Date() },
          include,
        }),
      ]);

      return toEpm(converted);
    },
  );

  app.delete<{ Params: { id: string } }>('/placeholder-people/:id', async (request, reply) => {
    await guard.require(request, 'employees:manage');
    await byId(request.params.id);

    await prisma.placeholderPerson.delete({ where: { id: request.params.id } });
    reply.code(204);
  });
};
