import { prisma } from '../db/prisma.js';
import { addDays } from '../lib/dates.js';
import { appLog } from '../lib/log.js';
import { HORIZON_DAYS, occurrences, type MeetingFrequency } from './meeting-series.js';
import { localDay } from './report-schedule.js';

/**
 * Making a repeating meeting's occurrences.
 *
 * Each occurrence is an ordinary meeting row carrying the series id. They are
 * made ahead, to the series' end or HORIZON_DAYS ahead for one with no end,
 * and topped up as time passes. A unique key on (series, start) means making
 * them again changes nothing, so a top-up can run as often as it likes.
 */

export interface SeriesInput {
  title: string;
  projectId: string | null;
  location: string | null;
  durationMinutes: number;
  agenda: string | null;
  participantIds: string[];
  frequency: MeetingFrequency;
  firstStartsAt: Date;
  timeZone: string;
  until: string | null;
  createdBy: string;
}

type SeriesRow = {
  id: string;
  title: string;
  projectId: string | null;
  location: string | null;
  durationMinutes: number;
  agenda: string | null;
  participantIds: string[];
  frequency: string;
  firstStartsAt: Date;
  timeZone: string;
  until: Date | null;
  generatedThrough: Date | null;
  createdBy: string;
};

const dayOf = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/** Makes the occurrences of a series not yet made, through the horizon. Returns the meetings made. */
async function fill(series: SeriesRow, now = new Date()): Promise<string[]> {
  const through = addDays(localDay(series.timeZone, now), HORIZON_DAYS);
  const due = occurrences(
    {
      frequency: series.frequency as MeetingFrequency,
      firstStartsAt: series.firstStartsAt,
      timeZone: series.timeZone,
      until: dayOf(series.until),
    },
    through,
  );
  if (due.length === 0) return [];

  // Occurrences someone deleted on purpose stay deleted: only those after the
  // latest one ever made are made, never one at or before it.
  const madeThrough = series.generatedThrough?.getTime() ?? 0;
  const fresh = due.filter((startsAt) => startsAt.getTime() > madeThrough);
  if (fresh.length === 0) return [];

  const existing = await prisma.meeting.findMany({
    where: { seriesId: series.id },
    select: { startsAt: true },
  });
  const made = new Set(existing.map((row) => row.startsAt.getTime()));

  const created: string[] = [];
  for (const startsAt of fresh) {
    if (made.has(startsAt.getTime())) continue;
    try {
      const row = await prisma.meeting.create({
        data: {
          title: series.title,
          projectId: series.projectId,
          location: series.location,
          startsAt,
          durationMinutes: series.durationMinutes,
          agenda: series.agenda,
          state: 'planned',
          createdBy: series.createdBy,
          seriesId: series.id,
          participants: { create: series.participantIds.map((userId) => ({ userId })) },
        },
        select: { id: true },
      });
      created.push(row.id);
    } catch (error) {
      // Another top-up made it first: the unique key did its job.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  await prisma.meetingSeries.update({
    where: { id: series.id },
    data: { generatedThrough: fresh[fresh.length - 1] },
  });
  return created;
}

/** Creates a series and its occurrences. Returns the series id and the first occurrence's id. */
export async function createSeries(input: SeriesInput): Promise<{ seriesId: string; firstMeetingId: string | null }> {
  const series = await prisma.meetingSeries.create({
    data: {
      title: input.title,
      projectId: input.projectId,
      location: input.location,
      durationMinutes: input.durationMinutes,
      agenda: input.agenda,
      participantIds: input.participantIds,
      frequency: input.frequency,
      firstStartsAt: input.firstStartsAt,
      timeZone: input.timeZone,
      until: input.until ? new Date(`${input.until}T00:00:00.000Z`) : null,
      createdBy: input.createdBy,
    },
  });
  const created = await fill(series);
  return { seriesId: series.id, firstMeetingId: created[0] ?? null };
}

let lastTopUp = 0;
const TOP_UP_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Tops up every series that is still running. Cheap to call: at most once
 * every six hours per process, and in the background, so a list of meetings
 * never waits on it.
 */
export function topUpSeriesSoon(): void {
  if (Date.now() - lastTopUp < TOP_UP_EVERY_MS) return;
  lastTopUp = Date.now();
  void (async () => {
    const today = new Date();
    const running = await prisma.meetingSeries.findMany({
      where: { OR: [{ until: null }, { until: { gte: new Date(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`) } }] },
    });
    let made = 0;
    for (const series of running) made += (await fill(series, today)).length;
    if (made > 0) appLog.info({ made }, 'Meeting series topped up');
  })().catch((error: unknown) => {
    lastTopUp = 0;
    appLog.warn({ err: error }, 'Could not top up meeting series');
  });
}

/**
 * Ends a series after one of its occurrences: no occurrence is made after it,
 * and those already made after it are removed unless something happened in
 * them (minutes written, attendance taken, or the meeting marked held).
 * Returns how many were removed and how many were kept.
 */
export async function endSeriesAfter(meetingId: string): Promise<{ removed: number; kept: number }> {
  const meeting = await prisma.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    select: { seriesId: true, startsAt: true, series: { select: { timeZone: true } } },
  });
  if (!meeting.seriesId || !meeting.series) return { removed: 0, kept: 0 };

  const lastDay = localDay(meeting.series.timeZone, meeting.startsAt);
  const later = await prisma.meeting.findMany({
    where: { seriesId: meeting.seriesId, startsAt: { gt: meeting.startsAt } },
    select: { id: true, state: true, minutes: true, participants: { where: { attended: true }, select: { userId: true } } },
  });
  const removable = later.filter((row) => row.state !== 'held' && !row.minutes && row.participants.length === 0);

  await prisma.$transaction([
    prisma.meetingSeries.update({
      where: { id: meeting.seriesId },
      data: { until: new Date(`${lastDay}T00:00:00.000Z`) },
    }),
    prisma.meeting.deleteMany({ where: { id: { in: removable.map((row) => row.id) } } }),
  ]);
  return { removed: removable.length, kept: later.length - removable.length };
}
