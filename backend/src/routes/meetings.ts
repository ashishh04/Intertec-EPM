import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  abilitiesFor,
  namesFor,
  optionalProjectId,
  requireRecordWrite,
  requireScopeRead,
  requireScopeWrite,
  visibleProjects,
} from '../domain/collaboration.js';
import { notifyMeetingInvited } from '../domain/collaboration-notifications.js';
import { MEETING_FREQUENCIES, type MeetingFrequency } from '../domain/meeting-series.js';
import { createSeries, endSeriesAfter, topUpSeriesSoon } from '../domain/meeting-occurrences.js';
import { isTimeZone } from '../domain/report-schedule.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { calendarDay } from '../lib/dates.js';
import { paginated, resolvePage } from '../lib/pagination.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCatalog } from '../mapping/catalog.js';
import { projectIdentifiers } from '../mapping/projects.js';
import { toEpmTask, type WorkPackageWithPoints } from '../mapping/tasks.js';
import { openProject } from '../openproject/client.js';
import type { EpmMeeting, MeetingAgendaItem, MeetingAgendaTask, MeetingState } from '../types/epm.js';

/**
 * Meetings.
 *
 * EPM's own records. OpenProject has a meetings module and publishes no API v3
 * resource for it, so there is nothing upstream to read, write or overlay — a
 * meeting here is a row, and its project is an OpenProject project id that this
 * service never owns.
 *
 * Authorisation is entirely `domain/collaboration.ts`: reading a project's
 * meetings needs `project:view` in that project, adding one needs the same, and
 * changing one needs authorship or `project:edit`. An unfiltered list is scoped
 * to the projects the caller can actually see plus the organisation-wide
 * meetings, rather than returning everything and filtering in the browser.
 */

const STATES = ['planned', 'held', 'cancelled'] as const;

const listQuery = z.object({
  projectId: z.string().optional(),
  /** Only meetings with this work package on their agenda. */
  workPackageId: z.string().regex(/^\d+$/).optional(),
  window: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  state: z.enum(STATES).optional(),
  participantId: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const writeBody = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(200),
  projectId: z.string().optional(),
  location: z.string().trim().max(200).optional(),
  startsAt: z.string().datetime({ offset: true, message: 'startsAt must be an ISO-8601 instant.' }),
  // A working day is the ceiling. Anything longer is a typo, and an eight-hour
  // meeting is already a cry for help.
  durationMinutes: z.coerce.number().int().min(5).max(24 * 60),
  agenda: z.string().max(20_000).optional(),
  minutes: z.string().max(50_000).optional(),
  state: z.enum(STATES).optional(),
  participantIds: z.array(z.string()).max(200).optional(),
  /** Makes it repeat from this first occurrence. On create only. */
  repeat: z
    .object({
      frequency: z.enum(MEETING_FREQUENCIES),
      until: calendarDay().optional(),
      timeZone: z.string().optional(),
    })
    .optional(),
});

const patchBody = writeBody.omit({ repeat: true }).partial();

const agendaBody = z.object({
  title: z.string().trim().max(300).optional(),
  durationMinutes: z.coerce.number().int().min(1).max(24 * 60).nullable().optional(),
  workPackageId: z.string().regex(/^\d+$/, 'That task is not valid.').nullable().optional(),
  presenterId: z.string().regex(/^\d+$/).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
});

type MeetingRow = {
  id: string;
  title: string;
  projectId: string | null;
  location: string | null;
  startsAt: Date;
  durationMinutes: number;
  agenda: string | null;
  minutes: string | null;
  state: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  participants: { userId: string; invited: boolean; attended: boolean }[];
  series: { id: string; frequency: string; until: Date | null } | null;
};

const withParticipants = {
  participants: { select: { userId: true, invited: true, attended: true } },
  series: { select: { id: true, frequency: true, until: true } },
} as const;

/** Every user id a meeting mentions, for one directory lookup per response. */
function peopleIn(meetings: MeetingRow[]): string[] {
  return meetings.flatMap((meeting) => [
    meeting.createdBy,
    ...meeting.participants.map((participant) => participant.userId),
  ]);
}

function toEpmMeeting(
  row: MeetingRow,
  names: Map<string, string>,
  projects: Map<string, string>,
  can: EpmMeeting['can'],
): EpmMeeting {
  return {
    id: row.id,
    title: row.title,
    ...(row.projectId
      ? { projectId: row.projectId, ...(projects.has(row.projectId) ? { projectName: projects.get(row.projectId)! } : {}) }
      : {}),
    ...(row.location ? { location: row.location } : {}),
    startsAt: row.startsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    // Derived, never stored: an end kept alongside a duration is two values that
    // can be edited apart, and then nobody knows which one the meeting is.
    endsAt: new Date(row.startsAt.getTime() + row.durationMinutes * 60_000).toISOString(),
    state: row.state as MeetingState,
    ...(row.agenda ? { agenda: row.agenda } : {}),
    ...(row.minutes ? { minutes: row.minutes } : {}),
    createdBy: row.createdBy,
    ...(names.has(row.createdBy) ? { createdByName: names.get(row.createdBy)! } : {}),
    participants: row.participants.map((participant) => ({
      userId: participant.userId,
      ...(names.has(participant.userId) ? { name: names.get(participant.userId)! } : {}),
      invited: participant.invited,
      attended: participant.attended,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    can,
    ...(row.series
      ? {
          series: {
            id: row.series.id,
            frequency: row.series.frequency as MeetingFrequency,
            ...(row.series.until ? { until: row.series.until.toISOString().slice(0, 10) } : {}),
          },
        }
      : {}),
  };
}

type AgendaRow = {
  id: string;
  meetingId: string;
  position: number;
  title: string;
  durationMinutes: number | null;
  workPackageId: number | null;
  presenterId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The tasks agenda items are about, as the reader sees them.
 *
 * Read as the caller, so a task in a project they cannot see comes back as an
 * id alone: the item stays on the agenda without telling them what it is.
 */
async function agendaTasks(request: FastifyRequest, ids: number[]): Promise<Map<number, MeetingAgendaTask>> {
  const unique = [...new Set(ids)];
  const found = new Map<number, MeetingAgendaTask>();
  if (unique.length === 0) return found;
  const signal = requestSignal(request);
  const [catalog, identifiers, collection] = await Promise.all([
    getCatalog(signal),
    projectIdentifiers(signal),
    openProject
      .getCollection<WorkPackageWithPoints>(
        '/work_packages',
        { filters: [{ field: 'id', operator: '=', values: unique.map(String) }], pageSize: unique.length },
        signal,
      )
      .catch(() => null),
  ]);
  for (const workPackage of collection?._embedded?.elements ?? []) {
    const task = toEpmTask(workPackage, catalog, identifiers);
    found.set(Number(task.id), {
      id: task.id,
      visible: true,
      key: task.key,
      subject: task.subject,
      status: task.status.name,
      statusCategory: task.statusCategory,
      projectId: task.projectId,
    });
  }
  for (const id of unique) if (!found.has(id)) found.set(id, { id: String(id), visible: false });
  return found;
}

async function toAgendaItems(request: FastifyRequest, rows: AgendaRow[]): Promise<MeetingAgendaItem[]> {
  const [tasks, names] = await Promise.all([
    agendaTasks(request, rows.flatMap((row) => (row.workPackageId === null ? [] : [row.workPackageId]))),
    namesFor(rows.flatMap((row) => (row.presenterId ? [row.presenterId] : []))),
  ]);
  return rows.map((row) => ({
    id: row.id,
    meetingId: row.meetingId,
    position: row.position,
    title: row.title,
    ...(row.durationMinutes === null ? {} : { durationMinutes: row.durationMinutes }),
    ...(row.presenterId
      ? { presenterId: row.presenterId, ...(names.has(row.presenterId) ? { presenterName: names.get(row.presenterId)! } : {}) }
      : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.workPackageId === null ? {} : { task: tasks.get(row.workPackageId)! }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Loads a meeting and checks the caller may see it.
 *
 * Reported as absent rather than forbidden when they may not: a 403 on a record
 * in a project somebody cannot see confirms the record exists, which is exactly
 * what they should not learn.
 */
async function readable(request: FastifyRequest, id: string): Promise<MeetingRow> {
  const meeting = await prisma.meeting.findUnique({ where: { id }, include: withParticipants });
  if (!meeting) throw EpmError.notFound('That meeting');

  await requireScopeRead(request, meeting.projectId).catch(() => {
    throw EpmError.notFound('That meeting');
  });

  return meeting;
}

export const meetingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/meetings', async (request) => {
    const query = listQuery.parse(request.query);
    // Repeating meetings with no end are made ahead and topped up as time passes.
    topUpSeriesSoon();
    const page = resolvePage(query.page, query.pageSize);
    const now = new Date();

    const projectId = optionalProjectId(query.projectId);
    // One project asked for: the ordinary permission check, and a refusal is a
    // refusal — the caller named the project, so its existence is not news.
    if (projectId) await requireScopeRead(request, projectId);

    const projects = await visibleProjects(request);

    const where = {
      // Unfiltered, the list is "projects I can see, plus organisation-wide".
      // Applied in the query rather than after it, so paging and totals are
      // computed over what this person may actually read.
      ...(projectId
        ? { projectId }
        : { OR: [{ projectId: null }, { projectId: { in: [...projects.keys()] } }] }),
      ...(query.state ? { state: query.state } : {}),
      ...(query.window === 'upcoming' ? { startsAt: { gte: now } } : {}),
      ...(query.window === 'past' ? { startsAt: { lt: now } } : {}),
      ...(query.participantId
        ? { participants: { some: { userId: query.participantId } } }
        : {}),
      ...(query.workPackageId
        ? { agendaItems: { some: { workPackageId: Number(query.workPackageId) } } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.meeting.findMany({
        where,
        include: withParticipants,
        // Upcoming reads forwards — the next meeting first. Past reads backwards,
        // most recent first, which is how anybody looking for minutes searches.
        orderBy: { startsAt: query.window === 'past' ? 'desc' : 'asc' },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.meeting.count({ where }),
    ]);

    const names = await namesFor(peopleIn(rows));
    const items = await Promise.all(
      rows.map(async (row) =>
        toEpmMeeting(
          row,
          names,
          projects,
          await abilitiesFor(request, { authorId: row.createdBy, projectId: row.projectId }),
        ),
      ),
    );

    return paginated(items, total, page);
  });

  app.get<{ Params: { id: string } }>('/meetings/:id', async (request) => {
    const row = await readable(request, request.params.id);
    const [names, projects] = await Promise.all([namesFor(peopleIn([row])), visibleProjects(request)]);

    return toEpmMeeting(
      row,
      names,
      projects,
      await abilitiesFor(request, { authorId: row.createdBy, projectId: row.projectId }),
    );
  });

  app.post<{ Body: unknown }>('/meetings', async (request, reply) => {
    const input = writeBody.parse(request.body ?? {});
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    const projectId = optionalProjectId(input.projectId);
    await requireScopeWrite(request, projectId);

    if (input.repeat) {
      const startsAt = new Date(input.startsAt);
      const timeZone = input.repeat.timeZone && isTimeZone(input.repeat.timeZone) ? input.repeat.timeZone : 'UTC';
      if (input.repeat.until && input.repeat.until < input.startsAt.slice(0, 10)) {
        throw EpmError.badRequest('A series cannot end before its first meeting.');
      }
      const participantIds = uniqueParticipants(input.participantIds ?? [userId]);
      const { firstMeetingId } = await createSeries({
        title: input.title,
        projectId: projectId ?? null,
        location: input.location || null,
        durationMinutes: input.durationMinutes,
        agenda: input.agenda || null,
        participantIds,
        frequency: input.repeat.frequency,
        firstStartsAt: startsAt,
        timeZone,
        until: input.repeat.until ?? null,
        createdBy: userId,
      });
      if (!firstMeetingId) throw EpmError.badRequest('That series has no meeting in it.');
      const first = await prisma.meeting.findUniqueOrThrow({ where: { id: firstMeetingId }, include: withParticipants });
      // One invitation, for the first: a mail for every occurrence would bury it.
      void notifyMeetingInvited(first, participantIds, userId);
      const [names, projects] = await Promise.all([namesFor(peopleIn([first])), visibleProjects(request)]);
      reply.code(201);
      return toEpmMeeting(first, names, projects, { update: true, delete: true });
    }

    const row = await prisma.meeting.create({
      data: {
        title: input.title,
        projectId: projectId ?? null,
        location: input.location || null,
        startsAt: new Date(input.startsAt),
        durationMinutes: input.durationMinutes,
        agenda: input.agenda || null,
        minutes: input.minutes || null,
        state: input.state ?? 'planned',
        createdBy: userId,
        participants: {
          // Whoever scheduled it is a participant unless they said otherwise.
          // A meeting with an empty attendee list is almost always an oversight,
          // and the organiser is the one person certainly involved.
          create: uniqueParticipants(input.participantIds ?? [userId]).map((id) => ({ userId: id })),
        },
      },
      include: withParticipants,
    });

    // The invitation. Not awaited: the meeting is saved, and the organiser should
    // not wait on a mail fan-out to see it.
    void notifyMeetingInvited(
      row,
      row.participants.map((participant) => participant.userId),
      userId,
    );

    const [names, projects] = await Promise.all([namesFor(peopleIn([row])), visibleProjects(request)]);

    reply.code(201);
    return toEpmMeeting(row, names, projects, { update: true, delete: true });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/meetings/:id', async (request) => {
    const input = patchBody.parse(request.body ?? {});
    if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');

    const existing = await readable(request, request.params.id);
    await requireRecordWrite(
      request,
      { authorId: existing.createdBy, projectId: existing.projectId },
      'meeting',
    );

    /*
     * Moving a meeting between projects is a scope change, so it is authorised
     * against the destination as well. Without that, somebody could create a
     * meeting in a project they belong to and then move it into one they do not.
     */
    const movingTo = input.projectId === undefined ? undefined : optionalProjectId(input.projectId);
    if (input.projectId !== undefined && (movingTo ?? null) !== existing.projectId) {
      await requireScopeWrite(request, movingTo);
    }

    const row = await prisma.meeting.update({
      where: { id: existing.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.projectId === undefined ? {} : { projectId: movingTo ?? null }),
        ...(input.location === undefined ? {} : { location: input.location || null }),
        ...(input.startsAt === undefined ? {} : { startsAt: new Date(input.startsAt) }),
        ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
        ...(input.agenda === undefined ? {} : { agenda: input.agenda || null }),
        ...(input.minutes === undefined ? {} : { minutes: input.minutes || null }),
        ...(input.state === undefined ? {} : { state: input.state }),
        // The list is replaced wholesale when it is sent, which is what the
        // contract says: a participant list is edited as a list, and a diff would
        // make "remove everybody" indistinguishable from "change nothing".
        // Attendance is deliberately preserved for anybody still on it.
        ...(input.participantIds === undefined
          ? {}
          : {
              participants: {
                deleteMany: { userId: { notIn: uniqueParticipants(input.participantIds) } },
                upsert: uniqueParticipants(input.participantIds).map((id) => ({
                  where: { meetingId_userId: { meetingId: existing.id, userId: id } },
                  create: { userId: id },
                  update: {},
                })),
              },
            }),
      },
      include: withParticipants,
    });

    /*
     * Re-invited when the time moved, or when somebody new was added.
     *
     * The dedupe key inside carries the start time, so a participant who was
     * already invited to a meeting that has not moved gets nothing — which is why
     * saving an agenda does not mail the room again. A person newly added to an
     * unmoved meeting is new to that key, so they do hear about it.
     */
    const invited = row.participants.map((participant) => participant.userId);
    if (input.startsAt !== undefined || input.participantIds !== undefined) {
      void notifyMeetingInvited(row, invited, request.auth?.userId ?? '');
    }

    const [names, projects] = await Promise.all([namesFor(peopleIn([row])), visibleProjects(request)]);
    return toEpmMeeting(row, names, projects, { update: true, delete: true });
  });

  /**
   * Records who actually turned up.
   *
   * Its own endpoint rather than part of the patch above, because it is a
   * different act at a different time: the agenda is edited before a meeting and
   * attendance after it, and folding the two together means a late edit to the
   * participant list can silently discard the attendance already recorded.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>('/meetings/:id/attendance', async (request) => {
    const body = z
      .object({
        attended: z.array(z.string()).max(200),
      })
      .parse(request.body ?? {});

    const existing = await readable(request, request.params.id);
    await requireRecordWrite(
      request,
      { authorId: existing.createdBy, projectId: existing.projectId },
      'meeting',
    );

    const attended = new Set(uniqueParticipants(body.attended));

    await prisma.$transaction(
      existing.participants.map((participant) =>
        prisma.meetingParticipant.update({
          where: {
            meetingId_userId: { meetingId: existing.id, userId: participant.userId },
          },
          data: { attended: attended.has(participant.userId) },
        }),
      ),
    );

    // Anybody marked present who was never invited is added, rather than
    // ignored: people join meetings they were not on the list for, and the
    // minutes have to be able to say who was in the room.
    const uninvited = [...attended].filter(
      (id) => !existing.participants.some((participant) => participant.userId === id),
    );
    if (uninvited.length > 0) {
      await prisma.meetingParticipant.createMany({
        data: uninvited.map((userId) => ({
          meetingId: existing.id,
          userId,
          invited: false,
          attended: true,
        })),
        skipDuplicates: true,
      });
    }

    const row = await prisma.meeting.findUniqueOrThrow({
      where: { id: existing.id },
      include: withParticipants,
    });
    const [names, projects] = await Promise.all([namesFor(peopleIn([row])), visibleProjects(request)]);
    return toEpmMeeting(row, names, projects, { update: true, delete: true });
  });

  /**
   * Ends a repeating meeting's series after this occurrence. Later occurrences
   * are removed unless something happened in them; those are kept and counted.
   */
  app.post<{ Params: { id: string } }>('/meetings/:id/end-series', async (request) => {
    const existing = await readable(request, request.params.id);
    await requireRecordWrite(request, { authorId: existing.createdBy, projectId: existing.projectId }, 'meeting');
    if (!existing.series) throw EpmError.badRequest('That meeting does not repeat.');
    return endSeriesAfter(existing.id);
  });

  /** The agenda, item by item, in order. */
  app.get<{ Params: { id: string } }>('/meetings/:id/agenda-items', async (request) => {
    const meeting = await readable(request, request.params.id);
    const rows = await prisma.meetingAgendaItem.findMany({
      where: { meetingId: meeting.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return toAgendaItems(request, rows);
  });

  /**
   * Adds an item, perhaps about a task. A task item takes the task's title
   * unless it is given one; the task must be one the caller can see.
   */
  app.post<{ Params: { id: string }; Body: unknown }>('/meetings/:id/agenda-items', async (request, reply) => {
    const input = agendaBody.parse(request.body ?? {});
    const meeting = await readable(request, request.params.id);
    await requireRecordWrite(request, { authorId: meeting.createdBy, projectId: meeting.projectId }, 'meeting');

    let title = input.title?.trim() ?? '';
    const workPackageId = input.workPackageId ? Number(input.workPackageId) : null;
    if (workPackageId !== null) {
      const task = (await agendaTasks(request, [workPackageId])).get(workPackageId);
      if (!task?.visible) throw EpmError.badRequest('That task could not be found.');
      if (!title) title = task.subject ?? '';
    }
    if (!title) throw EpmError.badRequest('A title is required.');

    const last = await prisma.meetingAgendaItem.aggregate({ where: { meetingId: meeting.id }, _max: { position: true } });
    const row = await prisma.meetingAgendaItem.create({
      data: {
        meetingId: meeting.id,
        position: (last._max.position ?? 0) + 1,
        title,
        durationMinutes: input.durationMinutes ?? null,
        workPackageId,
        presenterId: input.presenterId ?? null,
        notes: input.notes || null,
        createdBy: request.auth!.userId,
      },
    });
    reply.code(201);
    return (await toAgendaItems(request, [row]))[0];
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: unknown }>(
    '/meetings/:id/agenda-items/:itemId',
    async (request) => {
      const input = agendaBody.parse(request.body ?? {});
      if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');
      const meeting = await readable(request, request.params.id);
      await requireRecordWrite(request, { authorId: meeting.createdBy, projectId: meeting.projectId }, 'meeting');
      const item = await prisma.meetingAgendaItem.findFirst({ where: { id: request.params.itemId, meetingId: meeting.id } });
      if (!item) throw EpmError.notFound('That agenda item');

      const workPackageId =
        input.workPackageId === undefined ? undefined : input.workPackageId ? Number(input.workPackageId) : null;
      if (workPackageId) {
        const task = (await agendaTasks(request, [workPackageId])).get(workPackageId);
        if (!task?.visible) throw EpmError.badRequest('That task could not be found.');
      }
      if (input.title !== undefined && !input.title.trim()) throw EpmError.badRequest('A title is required.');

      const row = await prisma.meetingAgendaItem.update({
        where: { id: item.id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title.trim() }),
          ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
          ...(workPackageId === undefined ? {} : { workPackageId }),
          ...(input.presenterId === undefined ? {} : { presenterId: input.presenterId }),
          ...(input.notes === undefined ? {} : { notes: input.notes || null }),
        },
      });
      return (await toAgendaItems(request, [row]))[0];
    },
  );

  /** Puts the agenda in the order given: every item, by id. */
  app.put<{ Params: { id: string }; Body: unknown }>('/meetings/:id/agenda-items/order', async (request) => {
    const { ids } = z.object({ ids: z.array(z.string()).max(500) }).parse(request.body ?? {});
    const meeting = await readable(request, request.params.id);
    await requireRecordWrite(request, { authorId: meeting.createdBy, projectId: meeting.projectId }, 'meeting');
    const items = await prisma.meetingAgendaItem.findMany({ where: { meetingId: meeting.id }, select: { id: true } });
    const known = new Set(items.map((item) => item.id));
    if (ids.length !== known.size || ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) {
      throw EpmError.badRequest('Give every item on the agenda, once each.');
    }
    await prisma.$transaction(
      ids.map((id, index) => prisma.meetingAgendaItem.update({ where: { id }, data: { position: index + 1 } })),
    );
    const rows = await prisma.meetingAgendaItem.findMany({ where: { meetingId: meeting.id }, orderBy: { position: 'asc' } });
    return toAgendaItems(request, rows);
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/meetings/:id/agenda-items/:itemId', async (request, reply) => {
    const meeting = await readable(request, request.params.id);
    await requireRecordWrite(request, { authorId: meeting.createdBy, projectId: meeting.projectId }, 'meeting');
    const deleted = await prisma.meetingAgendaItem.deleteMany({ where: { id: request.params.itemId, meetingId: meeting.id } });
    if (deleted.count === 0) throw EpmError.notFound('That agenda item');
    reply.code(204);
  });

  app.delete<{ Params: { id: string } }>('/meetings/:id', async (request, reply) => {
    const existing = await readable(request, request.params.id);
    await requireRecordWrite(
      request,
      { authorId: existing.createdBy, projectId: existing.projectId },
      'meeting',
    );

    // Participants go with it, by the cascade on the relation.
    await prisma.meeting.delete({ where: { id: existing.id } });
    reply.code(204);
  });
};

/** Numeric OpenProject ids, de-duplicated, order preserved. */
function uniqueParticipants(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const id of ids) {
    // Anything that is not an OpenProject user id is dropped rather than
    // refused: the picker cannot produce one, so a bad value is a client bug and
    // failing the whole write over it would lose the rest of the meeting.
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}
