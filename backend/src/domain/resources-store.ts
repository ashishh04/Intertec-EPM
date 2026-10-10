import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { contextLanguage, message, t } from '../lib/i18n.js';
import { getUsers } from '../mapping/users.js';
import type {
  AvailabilityWeek,
  CapacityBand,
  CapacityCell,
  CapacityCellDetail,
  CapacityGrid,
  CapacityGroup,
  CapacityGrouping,
  CapacityRow,
  CarrierKind,
  DemandContribution,
  HrImportPerson,
  HrImportResult,
  HrReconcileResult,
  LoggedTime,
  OverAllocation,
  PersonAvailability,
  ResourceAllocation,
  ResourceRole,
  ResourceSettings,
  TimeOffEntry,
  TimeOffKind,
  WorkScheduleRow,
} from '../types/epm.js';
import { withAudit } from './audit.js';
import { dayOf, isoOf } from './critical-path.js';
import { DEFAULT_WEEKLY_CAPACITY, modelFacts, type ModelFacts, type TimeFact } from './measure-facts.js';
import {
  AvailabilityModel,
  bandOf,
  DEFAULT_THRESHOLDS,
  instanceCalendarOf,
  isOverAllocated,
  loadOf,
  placeholderKey,
  ratioOf,
  round2,
  standardPattern,
  weekOf,
  weeklyLoads,
  type CarrierInput,
  type CarrierWeek,
  type DemandItem,
  type InstanceCalendar,
  type ScheduleRow,
} from './resource-model.js';

/**
 * Resources and capacity (Module 6): EPM's records — roles, work schedules,
 * time off, planned allocations, the resource settings — and how they meet
 * the analytics model to answer who is available, what falls on them, and
 * where it does not fit (BR-110, BR-312 to BR-315).
 *
 * People's availability is EPM's own record of what the HR source says: a
 * schedule with an employment fraction, and time off, imported from it or
 * entered here (`importHr`), and checked against it (`reconcileHr`). Public
 * holidays are the instance calendar's, for everyone.
 */

const CACHE_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_RESOURCE_SETTINGS: ResourceSettings = {
  version: 0,
  thresholds: { ...DEFAULT_THRESHOLDS },
  hoursPerDay: 8,
  billableByDefault: true,
  nonBillableActivityIds: [],
};

const settingsSchema = z.object({
  thresholds: z.object({ under: z.number(), full: z.number(), over: z.number() }),
  hoursPerDay: z.number(),
  billableByDefault: z.boolean(),
  nonBillableActivityIds: z.array(z.union([z.string(), z.number()]).transform(String)).max(200),
});

let settingsCache: { at: number; value: ResourceSettings } | undefined;

export async function getResourceSettings(): Promise<ResourceSettings> {
  if (settingsCache && Date.now() - settingsCache.at < CACHE_MS) return settingsCache.value;
  const top = await prisma.resourceSettingSet.findFirst({ orderBy: { version: 'desc' } });
  const value: ResourceSettings = top
    ? { ...DEFAULT_RESOURCE_SETTINGS, ...(top.settings as object), version: top.version, updatedAt: top.createdAt.toISOString(), updatedBy: top.createdBy }
    : DEFAULT_RESOURCE_SETTINGS;
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Saves a new version and journals it (BR-314, BR-315). */
export async function saveResourceSettings(input: unknown, actorId: string): Promise<ResourceSettings> {
  const parsed = settingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The resource settings are not complete.', parsed.error.issues);
  const next = parsed.data;
  const { under, full, over } = next.thresholds;
  if (!(under >= 0 && under <= full && full <= over && over <= 500)) {
    throw EpmError.validation('The thresholds must rise: spare below full, full up to over, and over no more than 500%.');
  }
  if (!(next.hoursPerDay > 0 && next.hoursPerDay <= 24)) throw EpmError.validation('A working day is between 0 and 24 hours.');
  next.nonBillableActivityIds = [...new Set(next.nonBillableActivityIds)].sort();
  const current = await getResourceSettings();
  const same =
    current.thresholds.under === under &&
    current.thresholds.full === full &&
    current.thresholds.over === over &&
    current.hoursPerDay === next.hoursPerDay &&
    current.billableByDefault === next.billableByDefault &&
    JSON.stringify(current.nonBillableActivityIds) === JSON.stringify(next.nonBillableActivityIds);
  if (same) throw EpmError.conflict('Those are already the settings in force.');

  const saved = await withAudit(
    async (tx) => {
      const top = await tx.resourceSettingSet.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      return tx.resourceSettingSet.create({
        data: { version: (top?.version ?? 0) + 1, settings: next as unknown as object, createdBy: actorId },
      });
    },
    (row) => ({
      actorId,
      entityType: 'resource-settings',
      entityId: String(row.version),
      action: 'resources.settings.updated',
      summary: message('Resource settings version {version} saved.', { version: row.version }),
      before: { ...current },
      after: { version: row.version, ...next },
    }),
  );
  settingsCache = undefined;
  forgetShared();
  return { ...next, version: saved.version, updatedAt: saved.createdAt.toISOString(), updatedBy: actorId };
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                      */
/* -------------------------------------------------------------------------- */

const roleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
});

export async function listRoles(includeArchived = false): Promise<ResourceRole[]> {
  const rows = await prisma.resourceRole.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    include: { _count: { select: { people: true, placeholders: true } } },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archivedAt !== null,
    people: row._count.people,
    placeholders: row._count.placeholders,
  }));
}

const roleClash = (error: unknown, name: string): never => {
  if ((error as { code?: string })?.code === 'P2002' || /resource_roles_name_lower_key/.test(String((error as Error)?.message))) {
    throw EpmError.conflict(message('A role called {name} already exists.', { name }));
  }
  throw error;
};

export async function createRole(input: unknown, actorId: string): Promise<ResourceRole> {
  const parsed = roleSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('A role needs a name.', parsed.error.issues);
  const { name, description } = parsed.data;
  const row = await withAudit(
    (tx) => tx.resourceRole.create({ data: { name, description: description ?? null } }),
    (created) => ({
      actorId,
      entityType: 'resource-role',
      entityId: created.id,
      action: 'resources.role.created',
      summary: message('Role {name} created.', { name }),
      after: { name, description: description ?? null },
    }),
  ).catch((error: unknown) => roleClash(error, name));
  forgetShared();
  return { id: row.id, name: row.name, description: row.description, archived: false, people: 0, placeholders: 0 };
}

export async function updateRole(id: string, input: unknown, actorId: string): Promise<ResourceRole> {
  const parsed = roleSchema
    .partial()
    .extend({ archived: z.boolean().optional() })
    .safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('That is not a change a role can take.', parsed.error.issues);
  const before = await prisma.resourceRole.findUnique({ where: { id } });
  if (!before) throw EpmError.notFound('That role');
  const data = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description ?? null } : {}),
    ...(parsed.data.archived !== undefined ? { archivedAt: parsed.data.archived ? (before.archivedAt ?? new Date()) : null } : {}),
  };
  await withAudit(
    (tx) => tx.resourceRole.update({ where: { id }, data }),
    (row) => ({
      actorId,
      entityType: 'resource-role',
      entityId: id,
      action: 'resources.role.updated',
      summary: message('Role {name} changed.', { name: row.name }),
      before: { name: before.name, description: before.description, archived: before.archivedAt !== null },
      after: { name: row.name, description: row.description, archived: row.archivedAt !== null },
    }),
  ).catch((error: unknown) => roleClash(error, parsed.data.name ?? before.name));
  forgetShared();
  const [role] = (await listRoles(true)).filter((entry) => entry.id === id);
  return role!;
}

/** Gives a person a role, or takes it away (null). */
export async function setPersonRole(personId: string, roleId: string | null, actorId: string): Promise<{ personId: string; roleId: string | null }> {
  if (roleId !== null) {
    const role = await prisma.resourceRole.findUnique({ where: { id: roleId } });
    if (!role || role.archivedAt) throw EpmError.validation('That role is not one people can be given.');
  }
  const before = await prisma.userProfile.findUnique({ where: { openProjectId: personId }, select: { resourceRoleId: true } });
  await withAudit(
    (tx) =>
      tx.userProfile.upsert({
        where: { openProjectId: personId },
        create: { openProjectId: personId, resourceRoleId: roleId },
        update: { resourceRoleId: roleId },
      }),
    () => ({
      actorId,
      entityType: 'employee',
      entityId: personId,
      action: 'employee.role.changed',
      summary: message('Role changed for person {id}.', { id: personId }),
      before: { roleId: before?.resourceRoleId ?? null },
      after: { roleId },
    }),
  );
  forgetShared();
  return { personId, roleId };
}

/* -------------------------------------------------------------------------- */
/* Schedules and time off (BR-312)                                            */
/* -------------------------------------------------------------------------- */

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scheduleSchema = z.object({
  effectiveFrom: dateSchema,
  hours: z.array(z.number().min(0).max(24)).length(7),
  fraction: z.number().min(0).max(2),
});
const TIME_OFF_KINDS = ['leave', 'sick', 'training', 'other'] as const satisfies readonly TimeOffKind[];
const timeOffSchema = z.object({
  startsOn: dateSchema,
  endsOn: dateSchema,
  hoursPerDay: z.number().min(0).max(24).nullish(),
  kind: z.enum(TIME_OFF_KINDS).optional(),
  note: z.string().trim().max(500).nullish(),
});

const dateOnly = (value: string) => new Date(`${value}T00:00:00Z`);
const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const weekHoursOf = (hours: readonly number[], fraction: number) => round2(hours.reduce((sum, value) => sum + value, 0) * fraction);

const toScheduleRow = (row: {
  id: string;
  effectiveFrom: Date;
  hours: unknown;
  fraction: number;
  source: string;
  createdAt: Date;
  createdBy: string;
}): WorkScheduleRow => {
  const hours = (row.hours as number[]).map(Number);
  return {
    id: row.id,
    effectiveFrom: isoDate(row.effectiveFrom),
    hours,
    fraction: row.fraction,
    weeklyHours: weekHoursOf(hours, row.fraction),
    source: row.source === 'hr' ? 'hr' : 'epm',
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
};

const toTimeOff = (
  row: { id: string; openProjectId: string; startsOn: Date; endsOn: Date; hoursPerDay: number | null; kind: string; note: string | null; source: string; externalId: string | null },
  full: boolean,
): TimeOffEntry => ({
  id: row.id,
  personId: row.openProjectId,
  startsOn: isoDate(row.startsOn),
  endsOn: isoDate(row.endsOn),
  hoursPerDay: row.hoursPerDay,
  source: row.source === 'hr' ? 'hr' : 'epm',
  ...(full ? { kind: (TIME_OFF_KINDS as readonly string[]).includes(row.kind) ? (row.kind as TimeOffKind) : 'other', note: row.note, externalId: row.externalId } : {}),
});

/**
 * Keeps a person's weekly capacity with their schedule: the one in force
 * today, its hours times its fraction. Weekly capacity is what the rest of EPM
 * reads — the people directory, the team totals — so it must not drift.
 */
async function alignCapacity(personId: string): Promise<void> {
  const now = dateOnly(todayIso());
  const row = await prisma.workSchedule.findFirst({
    where: { openProjectId: personId, effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) return;
  const weekly = Math.round(weekHoursOf((row.hours as number[]).map(Number), row.fraction) * 4) / 4;
  await prisma.userProfile.upsert({
    where: { openProjectId: personId },
    create: { openProjectId: personId, hoursCapacity: weekly },
    update: { hoursCapacity: weekly },
  });
}

/**
 * After someone's weekly capacity is set directly — the staffing dialog — a
 * person with a schedule gets one from today with the same pattern, at the
 * fraction that gives that capacity. Without it the schedule would go on
 * deciding their availability, and the number just typed would do nothing.
 */
export async function alignScheduleToCapacity(personId: string, weeklyHours: number, actorId: string): Promise<void> {
  const rows = await prisma.workSchedule.findMany({ where: { openProjectId: personId }, orderBy: { effectiveFrom: 'asc' } });
  if (rows.length === 0) return;
  const todayDate = todayIso();
  const inForce = [...rows].reverse().find((row) => isoDate(row.effectiveFrom) <= todayDate) ?? rows[0]!;
  const settings = await getResourceSettings();
  const data = await loadResourceShared();
  let hours = (inForce.hours as number[]).map(Number);
  if (hours.reduce((sum, value) => sum + value, 0) <= 0) hours = standardPattern(data.calendar, settings.hoursPerDay);
  const full = hours.reduce((sum, value) => sum + value, 0);
  const fraction = Math.min(2, Math.round((weeklyHours / full) * 10_000) / 10_000);
  if (Math.abs(weekHoursOf(hours, inForce.fraction) - weeklyHours) < 0.01 && isoDate(inForce.effectiveFrom) <= todayDate) return;
  await prisma.workSchedule.upsert({
    where: { openProjectId_effectiveFrom: { openProjectId: personId, effectiveFrom: dateOnly(todayDate) } },
    create: { openProjectId: personId, effectiveFrom: dateOnly(todayDate), hours, fraction, source: 'epm', createdBy: actorId },
    update: { hours, fraction, source: 'epm' },
  });
  forgetShared();
}

/** A person's schedules, time off and available hours week by week. */
export async function personAvailability(
  personId: string,
  options: { from?: string; weeks?: number; full: boolean },
): Promise<PersonAvailability> {
  const shared = await loadResourceShared();
  const person = shared.carriers.get(personId);
  if (!person || person.kind !== 'person') throw EpmError.notFound('That person');
  const [schedules, timeOff] = await Promise.all([
    prisma.workSchedule.findMany({ where: { openProjectId: personId }, orderBy: { effectiveFrom: 'asc' } }),
    prisma.timeOff.findMany({ where: { openProjectId: personId }, orderBy: { startsOn: 'desc' } }),
  ]);
  const first = weekOf(dayOf(options.from ?? todayIso()));
  const count = Math.min(Math.max(options.weeks ?? 12, 1), 104);
  const weeks: AvailabilityWeek[] = [];
  for (let week = first; week < first + count * 7; week += 7) {
    const scheduled = shared.availability.scheduledSum(personId, week, week + 6);
    const available = shared.availability.sum(personId, week, week + 6);
    weeks.push({ week: isoOf(week), scheduled: round2(scheduled), off: round2(scheduled - available), available: round2(available) });
  }
  return {
    personId,
    name: person.name,
    roleId: person.roleId,
    weeklyHours: person.weeklyHours,
    schedules: schedules.map(toScheduleRow),
    timeOff: timeOff.map((row) => toTimeOff(row, options.full)),
    weeks,
  };
}

export async function setSchedule(personId: string, input: unknown, actorId: string, source: 'epm' | 'hr' = 'epm'): Promise<WorkScheduleRow> {
  const parsed = scheduleSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('A schedule is a date, seven daily hours and a fraction.', parsed.error.issues);
  const { effectiveFrom, hours, fraction } = parsed.data;
  const before = await prisma.workSchedule.findUnique({
    where: { openProjectId_effectiveFrom: { openProjectId: personId, effectiveFrom: dateOnly(effectiveFrom) } },
  });
  const row = await withAudit(
    (tx) =>
      tx.workSchedule.upsert({
        where: { openProjectId_effectiveFrom: { openProjectId: personId, effectiveFrom: dateOnly(effectiveFrom) } },
        create: { openProjectId: personId, effectiveFrom: dateOnly(effectiveFrom), hours, fraction, source, createdBy: actorId },
        update: { hours, fraction, source },
      }),
    () => ({
      actorId,
      entityType: 'employee',
      entityId: personId,
      action: 'employee.schedule.changed',
      summary: message('Work schedule from {date} set: {hours, number} hours a week.', {
        date: effectiveFrom,
        hours: weekHoursOf(hours, fraction),
      }),
      before: before ? { hours: before.hours, fraction: before.fraction } : null,
      after: { effectiveFrom, hours, fraction, source },
    }),
  );
  await alignCapacity(personId);
  forgetShared();
  return toScheduleRow(row);
}

export async function deleteSchedule(personId: string, id: string, actorId: string): Promise<void> {
  const row = await prisma.workSchedule.findFirst({ where: { id, openProjectId: personId } });
  if (!row) throw EpmError.notFound('That schedule');
  await withAudit(
    (tx) => tx.workSchedule.delete({ where: { id } }),
    () => ({
      actorId,
      entityType: 'employee',
      entityId: personId,
      action: 'employee.schedule.removed',
      summary: message('Work schedule from {date} removed.', { date: isoDate(row.effectiveFrom) }),
      before: { effectiveFrom: isoDate(row.effectiveFrom), hours: row.hours, fraction: row.fraction },
    }),
  );
  await alignCapacity(personId);
  forgetShared();
}

const checkStretch = (startsOn: string, endsOn: string) => {
  if (endsOn < startsOn) throw EpmError.validation('Time off ends on or after the day it starts.');
  if (dayOf(endsOn) - dayOf(startsOn) > 366) throw EpmError.validation('One stretch of time off is a year at most.');
};

export async function addTimeOff(personId: string, input: unknown, actorId: string): Promise<TimeOffEntry> {
  const parsed = timeOffSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('Time off is a first and a last day, and the hours of each, or whole days.', parsed.error.issues);
  const value = parsed.data;
  checkStretch(value.startsOn, value.endsOn);
  const row = await withAudit(
    (tx) =>
      tx.timeOff.create({
        data: {
          openProjectId: personId,
          startsOn: dateOnly(value.startsOn),
          endsOn: dateOnly(value.endsOn),
          hoursPerDay: value.hoursPerDay ?? null,
          kind: value.kind ?? 'leave',
          note: value.note ?? null,
          createdBy: actorId,
        },
      }),
    (created) => ({
      actorId,
      entityType: 'employee',
      entityId: personId,
      action: 'employee.time-off.added',
      summary: message('Time off from {from} to {to} added.', { from: value.startsOn, to: value.endsOn }),
      after: { id: created.id, startsOn: value.startsOn, endsOn: value.endsOn, hoursPerDay: value.hoursPerDay ?? null },
    }),
  );
  forgetShared();
  return toTimeOff(row, true);
}

export async function updateTimeOff(personId: string, id: string, input: unknown, actorId: string): Promise<TimeOffEntry> {
  const before = await prisma.timeOff.findFirst({ where: { id, openProjectId: personId } });
  if (!before) throw EpmError.notFound('That time off');
  const parsed = timeOffSchema.partial().safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('That is not a change time off can take.', parsed.error.issues);
  const value = parsed.data;
  const startsOn = value.startsOn ?? isoDate(before.startsOn);
  const endsOn = value.endsOn ?? isoDate(before.endsOn);
  checkStretch(startsOn, endsOn);
  const row = await withAudit(
    (tx) =>
      tx.timeOff.update({
        where: { id },
        data: {
          startsOn: dateOnly(startsOn),
          endsOn: dateOnly(endsOn),
          ...(value.hoursPerDay !== undefined ? { hoursPerDay: value.hoursPerDay ?? null } : {}),
          ...(value.kind !== undefined ? { kind: value.kind } : {}),
          ...(value.note !== undefined ? { note: value.note ?? null } : {}),
        },
      }),
    () => ({
      actorId,
      entityType: 'employee',
      entityId: personId,
      action: 'employee.time-off.changed',
      summary: message('Time off from {from} to {to} changed.', { from: startsOn, to: endsOn }),
      before: { startsOn: isoDate(before.startsOn), endsOn: isoDate(before.endsOn), hoursPerDay: before.hoursPerDay },
      after: { startsOn, endsOn, hoursPerDay: value.hoursPerDay ?? before.hoursPerDay },
    }),
  );
  forgetShared();
  return toTimeOff(row, true);
}

export async function deleteTimeOff(personId: string, id: string, actorId: string): Promise<void> {
  const before = await prisma.timeOff.findFirst({ where: { id, openProjectId: personId } });
  if (!before) throw EpmError.notFound('That time off');
  await withAudit(
    (tx) => tx.timeOff.delete({ where: { id } }),
    () => ({
      actorId,
      entityType: 'employee',
      entityId: personId,
      action: 'employee.time-off.removed',
      summary: message('Time off from {from} to {to} removed.', { from: isoDate(before.startsOn), to: isoDate(before.endsOn) }),
      before: { startsOn: isoDate(before.startsOn), endsOn: isoDate(before.endsOn), hoursPerDay: before.hoursPerDay },
    }),
  );
  forgetShared();
}

/* -------------------------------------------------------------------------- */
/* The HR source (BR-312)                                                     */
/* -------------------------------------------------------------------------- */

const hrPersonSchema = z.object({
  personId: z.union([z.string(), z.number()]).transform(String).optional(),
  email: z.string().trim().max(320).optional(),
  effectiveFrom: dateSchema.optional(),
  fraction: z.number().min(0).max(2).optional(),
  hours: z.array(z.number().min(0).max(24)).length(7).optional(),
  timeOff: z
    .array(
      z.object({
        externalId: z.union([z.string(), z.number()]).transform(String),
        startsOn: dateSchema,
        endsOn: dateSchema,
        hoursPerDay: z.number().min(0).max(24).nullish(),
        kind: z.enum(TIME_OFF_KINDS).optional(),
      }),
    )
    .max(1000)
    .optional(),
});

/** Who a row from the HR source is: by OpenProject id, or by the email the directory knows. */
async function resolvePeople(): Promise<(person: { personId?: string; email?: string }) => string | null> {
  const users = await getUsers();
  const byId = new Set(users.map((user) => user.id));
  const byEmail = new Map(users.filter((user) => user.email).map((user) => [user.email.toLowerCase(), user.id]));
  return (person) => {
    if (person.personId && byId.has(person.personId)) return person.personId;
    if (person.email) return byEmail.get(person.email.toLowerCase()) ?? null;
    return null;
  };
}

/**
 * Takes the HR source's view of people's availability: a schedule with an
 * employment fraction from a date, and time off by the source's own ids — so
 * importing the same extract twice changes nothing the second time. Journalled
 * as one change.
 */
export async function importHr(input: unknown, actorId: string): Promise<HrImportResult> {
  const parsed = z.object({ people: z.array(hrPersonSchema).max(5000) }).safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The HR extract is not in the expected form.', parsed.error.issues);
  const resolve = await resolvePeople();
  const settings = await getResourceSettings();
  const shared = await loadResourceShared();
  const result: HrImportResult = { people: 0, schedules: 0, timeOffCreated: 0, timeOffUpdated: 0, unknown: [] };

  for (const person of parsed.data.people) {
    const personId = resolve(person);
    if (!personId) {
      result.unknown.push(person.email ?? person.personId ?? '?');
      continue;
    }
    result.people += 1;
    if (person.fraction !== undefined || person.hours !== undefined) {
      const effectiveFrom = person.effectiveFrom ?? todayIso();
      const inForce = shared.availability.scheduleOn(personId, dayOf(effectiveFrom));
      const hours = person.hours ?? [...(inForce?.hours ?? standardPattern(shared.calendar, settings.hoursPerDay))];
      const fraction = person.fraction ?? inForce?.fraction ?? 1;
      await prisma.workSchedule.upsert({
        where: { openProjectId_effectiveFrom: { openProjectId: personId, effectiveFrom: dateOnly(effectiveFrom) } },
        create: { openProjectId: personId, effectiveFrom: dateOnly(effectiveFrom), hours, fraction, source: 'hr', createdBy: actorId },
        update: { hours, fraction, source: 'hr' },
      });
      result.schedules += 1;
      await alignCapacity(personId);
    }
    for (const entry of person.timeOff ?? []) {
      checkStretch(entry.startsOn, entry.endsOn);
      const existing = await prisma.timeOff.findUnique({ where: { source_externalId: { source: 'hr', externalId: entry.externalId } } });
      const data = {
        openProjectId: personId,
        startsOn: dateOnly(entry.startsOn),
        endsOn: dateOnly(entry.endsOn),
        hoursPerDay: entry.hoursPerDay ?? null,
        kind: entry.kind ?? 'leave',
      };
      if (existing) {
        await prisma.timeOff.update({ where: { id: existing.id }, data });
        result.timeOffUpdated += 1;
      } else {
        await prisma.timeOff.create({ data: { ...data, source: 'hr', externalId: entry.externalId, createdBy: actorId } });
        result.timeOffCreated += 1;
      }
    }
  }
  await withAudit(
    async () => result,
    () => ({
      actorId,
      entityType: 'resource-hr',
      entityId: 'import',
      action: 'resources.hr.imported',
      summary: message('HR availability imported for {count, plural, one {# person} other {# people}}.', { count: result.people }),
      after: { ...result },
    }),
  );
  forgetShared();
  return result;
}

/**
 * Checks EPM's available hours against the HR source's for the same people
 * and periods (BR-312's acceptance): each row is matched when the two agree to
 * the hundredth of an hour.
 */
export async function reconcileHr(input: unknown): Promise<HrReconcileResult> {
  const parsed = z
    .object({
      rows: z
        .array(
          z.object({
            personId: z.union([z.string(), z.number()]).transform(String).optional(),
            email: z.string().trim().max(320).optional(),
            from: dateSchema,
            to: dateSchema,
            availableHours: z.number(),
          }),
        )
        .max(5000),
    })
    .safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The HR figures are not in the expected form.', parsed.error.issues);
  const resolve = await resolvePeople();
  const shared = await loadResourceShared();
  const out: HrReconcileResult = { rows: [], matched: 0, differing: 0, unknown: 0 };
  for (const row of parsed.data.rows) {
    const personId = resolve(row);
    const person = personId ? shared.carriers.get(personId) : undefined;
    const epm = person && row.to >= row.from ? round2(shared.availability.sum(personId!, dayOf(row.from), dayOf(row.to))) : null;
    const difference = epm === null ? null : round2(epm - row.availableHours);
    const matches = difference !== null && Math.abs(difference) < 0.01;
    out.rows.push({
      person: row.email ?? row.personId ?? '?',
      personId: personId ?? null,
      name: person?.name ?? null,
      from: row.from,
      to: row.to,
      hr: row.availableHours,
      epm,
      difference,
      matches,
    });
    if (epm === null) out.unknown += 1;
    else if (matches) out.matched += 1;
    else out.differing += 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Planned allocations (BR-313)                                               */
/* -------------------------------------------------------------------------- */

const allocationSchema = z.object({
  projectId: z.union([z.string(), z.number()]).transform(String),
  personId: z.union([z.string(), z.number()]).transform(String).nullish(),
  placeholderId: z.string().nullish(),
  roleId: z.string().nullish(),
  startsOn: dateSchema,
  endsOn: dateSchema,
  hoursPerWeek: z.number().gt(0).max(168),
  note: z.string().trim().max(500).nullish(),
});

async function allocationView(row: {
  id: string;
  projectId: number;
  personId: string | null;
  placeholderId: string | null;
  roleId: string | null;
  startsOn: Date;
  endsOn: Date;
  hoursPerWeek: number;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}): Promise<ResourceAllocation> {
  const shared = await loadResourceShared();
  return toAllocationView(row, shared);
}

function toAllocationView(
  row: {
    id: string;
    projectId: number;
    personId: string | null;
    placeholderId: string | null;
    roleId: string | null;
    startsOn: Date;
    endsOn: Date;
    hoursPerWeek: number;
    note: string | null;
    createdBy: string;
    createdAt: Date;
  },
  shared: ResourceShared,
): ResourceAllocation {
  const carrier = row.personId
    ? shared.carriers.get(row.personId)?.name
    : row.placeholderId
      ? shared.carriers.get(placeholderKey(row.placeholderId))?.name
      : row.roleId
        ? shared.roles.get(row.roleId)?.name
        : undefined;
  return {
    id: row.id,
    projectId: String(row.projectId),
    projectName: shared.facts.projects.get(row.projectId)?.name ?? `#${row.projectId}`,
    personId: row.personId,
    placeholderId: row.placeholderId,
    roleId: row.roleId,
    carrierName: carrier ?? '—',
    startsOn: isoDate(row.startsOn),
    endsOn: isoDate(row.endsOn),
    hoursPerWeek: row.hoursPerWeek,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAllocations(filter: { projectId?: string; personId?: string; placeholderId?: string; roleId?: string }): Promise<ResourceAllocation[]> {
  const rows = await prisma.resourceAllocation.findMany({
    where: {
      ...(filter.projectId ? { projectId: Number(filter.projectId) } : {}),
      ...(filter.personId ? { personId: filter.personId } : {}),
      ...(filter.placeholderId ? { placeholderId: filter.placeholderId } : {}),
      ...(filter.roleId ? { roleId: filter.roleId } : {}),
    },
    orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }],
  });
  const shared = await loadResourceShared();
  return rows.map((row) => toAllocationView(row, shared));
}

async function checkAllocation(value: z.infer<typeof allocationSchema>): Promise<void> {
  const named = [value.personId, value.placeholderId].filter(Boolean).length;
  if (named > 1) throw EpmError.validation('A booking is for one person or one placeholder.');
  if (named === 0 && !value.roleId) throw EpmError.validation('A booking names a person, a placeholder, or at least a role.');
  if (value.endsOn < value.startsOn) throw EpmError.validation('A booking ends on or after the day it starts.');
  if (value.placeholderId) {
    const placeholder = await prisma.placeholderPerson.findUnique({ where: { id: value.placeholderId } });
    if (!placeholder || placeholder.convertedTo) throw EpmError.validation('That placeholder cannot be booked.');
  }
  if (value.roleId) {
    const role = await prisma.resourceRole.findUnique({ where: { id: value.roleId } });
    if (!role || role.archivedAt) throw EpmError.validation('That role is not one people can be given.');
  }
}

export async function createAllocation(input: unknown, actorId: string): Promise<ResourceAllocation> {
  const parsed = allocationSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('A booking is a project, who, the dates and the hours a week.', parsed.error.issues);
  const value = parsed.data;
  await checkAllocation(value);
  const row = await withAudit(
    (tx) =>
      tx.resourceAllocation.create({
        data: {
          projectId: Number(value.projectId),
          personId: value.personId ?? null,
          placeholderId: value.placeholderId ?? null,
          roleId: value.roleId ?? null,
          startsOn: dateOnly(value.startsOn),
          endsOn: dateOnly(value.endsOn),
          hoursPerWeek: value.hoursPerWeek,
          note: value.note ?? null,
          createdBy: actorId,
        },
      }),
    (created) => ({
      actorId,
      entityType: 'resource-allocation',
      entityId: created.id,
      action: 'resources.allocation.created',
      summary: message('{hours, number} hours a week booked to project {project} from {from} to {to}.', {
        hours: value.hoursPerWeek,
        project: value.projectId,
        from: value.startsOn,
        to: value.endsOn,
      }),
      after: { ...value },
    }),
  );
  forgetShared();
  return allocationView(row);
}

export async function updateAllocation(id: string, input: unknown, actorId: string): Promise<ResourceAllocation> {
  const before = await prisma.resourceAllocation.findUnique({ where: { id } });
  if (!before) throw EpmError.notFound('That booking');
  const parsed = allocationSchema.partial().safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('That is not a change a booking can take.', parsed.error.issues);
  const merged = {
    projectId: parsed.data.projectId ?? String(before.projectId),
    personId: parsed.data.personId !== undefined ? parsed.data.personId : before.personId,
    placeholderId: parsed.data.placeholderId !== undefined ? parsed.data.placeholderId : before.placeholderId,
    roleId: parsed.data.roleId !== undefined ? parsed.data.roleId : before.roleId,
    startsOn: parsed.data.startsOn ?? isoDate(before.startsOn),
    endsOn: parsed.data.endsOn ?? isoDate(before.endsOn),
    hoursPerWeek: parsed.data.hoursPerWeek ?? before.hoursPerWeek,
    note: parsed.data.note !== undefined ? parsed.data.note : before.note,
  };
  await checkAllocation(merged);
  const row = await withAudit(
    (tx) =>
      tx.resourceAllocation.update({
        where: { id },
        data: {
          projectId: Number(merged.projectId),
          personId: merged.personId ?? null,
          placeholderId: merged.placeholderId ?? null,
          roleId: merged.roleId ?? null,
          startsOn: dateOnly(merged.startsOn),
          endsOn: dateOnly(merged.endsOn),
          hoursPerWeek: merged.hoursPerWeek,
          note: merged.note ?? null,
        },
      }),
    () => ({
      actorId,
      entityType: 'resource-allocation',
      entityId: id,
      action: 'resources.allocation.updated',
      summary: message('Booking to project {project} changed.', { project: merged.projectId }),
      before: { ...before, startsOn: isoDate(before.startsOn), endsOn: isoDate(before.endsOn) },
      after: { ...merged },
    }),
  );
  forgetShared();
  return allocationView(row);
}

export async function deleteAllocation(id: string, actorId: string): Promise<void> {
  const before = await prisma.resourceAllocation.findUnique({ where: { id } });
  if (!before) throw EpmError.notFound('That booking');
  await withAudit(
    (tx) => tx.resourceAllocation.delete({ where: { id } }),
    () => ({
      actorId,
      entityType: 'resource-allocation',
      entityId: id,
      action: 'resources.allocation.deleted',
      summary: message('Booking to project {project} removed.', { project: before.projectId }),
      before: { ...before, startsOn: isoDate(before.startsOn), endsOn: isoDate(before.endsOn) },
    }),
  );
  forgetShared();
}

export async function allocationOf(id: string): Promise<{ projectId: number } | null> {
  return prisma.resourceAllocation.findUnique({ where: { id }, select: { projectId: true } });
}

/* -------------------------------------------------------------------------- */
/* The model, shared                                                          */
/* -------------------------------------------------------------------------- */

export interface CarrierInfo {
  key: string;
  kind: 'person' | 'placeholder';
  id: string;
  name: string;
  roleId: string | null;
  teamId: string | null;
  departmentId: string | null;
  weeklyHours: number;
}

export interface ResourceShared {
  at: number;
  facts: ModelFacts;
  settings: ResourceSettings;
  calendar: InstanceCalendar;
  availability: AvailabilityModel;
  /** Active people and unconverted placeholders, by carrier key. */
  carriers: Map<string, CarrierInfo>;
  roles: Map<string, { name: string; archived: boolean }>;
  teams: Map<string, string>;
  departments: Map<string, string>;
  allocations: {
    id: string;
    projectId: number;
    personId: string | null;
    placeholderId: string | null;
    roleId: string | null;
    startsOn: Date;
    endsOn: Date;
    hoursPerWeek: number;
    note: string | null;
    createdBy: string;
    createdAt: Date;
  }[];
  /** Whether a time entry is billable (BR-315). */
  billable: (entry: TimeFact) => boolean;
  /** Demand from open assigned work and planned allocations (BR-313). */
  demand: DemandItem[];
  /** Assigned work with hours and no dates: on no day. */
  undated: { items: number; hours: number };
}

let shared: { at: number; value: Promise<ResourceShared> } | undefined;

export function forgetShared(): void {
  shared = undefined;
}

/** Hours still to do: OpenProject's remaining work, or the estimate less what % complete says is done. */
export const remainingOf = (work: { remainingHours: number | null; estimatedHours: number | null; doneRatio: number | null }): number => {
  if (work.remainingHours !== null) return Math.max(0, work.remainingHours);
  if (work.estimatedHours === null) return 0;
  return Math.max(0, work.estimatedHours * (1 - Math.min(100, Math.max(0, work.doneRatio ?? 0)) / 100));
};

export async function loadResourceShared(): Promise<ResourceShared> {
  const facts = await modelFacts();
  if (shared && Date.now() - shared.at < CACHE_MS) {
    const value = await shared.value;
    if (value.facts === facts) return value;
  }
  const value = buildShared(facts);
  shared = { at: Date.now(), value };
  value.catch(() => {
    shared = undefined;
  });
  return value;
}

async function buildShared(facts: ModelFacts): Promise<ResourceShared> {
  const [settings, profiles, placeholders, schedules, timeOff, roles, allocations, projectProfiles] = await Promise.all([
    getResourceSettings(),
    prisma.userProfile.findMany({ select: { openProjectId: true, teamId: true, departmentId: true, resourceRoleId: true, hoursCapacity: true } }),
    prisma.placeholderPerson.findMany({ where: { convertedTo: null } }),
    prisma.workSchedule.findMany({ orderBy: { effectiveFrom: 'asc' } }),
    prisma.timeOff.findMany(),
    prisma.resourceRole.findMany(),
    prisma.resourceAllocation.findMany(),
    prisma.projectProfile.findMany({ where: { billable: { not: null } }, select: { openProjectId: true, billable: true } }),
  ]);

  const calendar = instanceCalendarOf(facts.calendar.nonWorking, facts.calendar.workingWeekdays);
  const profileById = new Map(profiles.map((row) => [row.openProjectId, row]));
  const teams = new Map([...facts.teams.values()].map((team) => [team.id, team.name]));
  const departments = new Map([...facts.departments.values()].map((department) => [department.id, department.name]));
  const teamDepartment = new Map([...facts.teams.values()].map((team) => [team.id, team.departmentId ?? null]));

  const schedulesBy = new Map<string, ScheduleRow[]>();
  for (const row of schedules) {
    const list = schedulesBy.get(row.openProjectId) ?? [];
    list.push({ effectiveFrom: dayOf(isoDate(row.effectiveFrom)), hours: (row.hours as number[]).map(Number), fraction: row.fraction });
    schedulesBy.set(row.openProjectId, list);
  }
  const timeOffBy = new Map<string, CarrierInput['timeOff']>();
  for (const row of timeOff) {
    const list = timeOffBy.get(row.openProjectId) ?? [];
    list.push({ from: dayOf(isoDate(row.startsOn)), to: dayOf(isoDate(row.endsOn)), hoursPerDay: row.hoursPerDay });
    timeOffBy.set(row.openProjectId, list);
  }

  const carriers = new Map<string, CarrierInfo>();
  const inputs = new Map<string, CarrierInput>();
  for (const person of facts.people.values()) {
    if (person.status !== 'active') continue;
    const key = String(person.id);
    const profile = profileById.get(key);
    const teamId = profile?.teamId ?? person.teamId;
    const weeklyHours = profile?.hoursCapacity ?? person.weeklyCapacityHours ?? DEFAULT_WEEKLY_CAPACITY;
    carriers.set(key, {
      key,
      kind: 'person',
      id: key,
      name: person.name,
      roleId: profile?.resourceRoleId ?? null,
      teamId: teamId ?? null,
      departmentId: (teamId ? teamDepartment.get(teamId) : null) ?? profile?.departmentId ?? person.departmentId ?? null,
      weeklyHours,
    });
    inputs.set(key, { weeklyHours, schedules: schedulesBy.get(key) ?? [], timeOff: timeOffBy.get(key) ?? [] });
  }
  for (const placeholder of placeholders) {
    const key = placeholderKey(placeholder.id);
    carriers.set(key, {
      key,
      kind: 'placeholder',
      id: placeholder.id,
      name: placeholder.name,
      roleId: placeholder.resourceRoleId,
      teamId: placeholder.teamId,
      departmentId: (placeholder.teamId ? teamDepartment.get(placeholder.teamId) : null) ?? placeholder.departmentId,
      weeklyHours: placeholder.hoursCapacity,
    });
    inputs.set(key, { weeklyHours: placeholder.hoursCapacity, schedules: [], timeOff: [] });
  }
  const availability = new AvailabilityModel(calendar, inputs);

  const projectBillable = new Map(projectProfiles.map((row) => [Number(row.openProjectId), row.billable === true]));
  const nonBillable = new Set(settings.nonBillableActivityIds);
  const billable = (entry: TimeFact) => {
    const project = entry.projectId === null ? settings.billableByDefault : (projectBillable.get(entry.projectId) ?? settings.billableByDefault);
    return project && !(entry.activityId !== null && nonBillable.has(String(entry.activityId)));
  };

  const demand: DemandItem[] = [];
  const undated = { items: 0, hours: 0 };
  for (const work of facts.workPackages) {
    if (work.isClosed || work.assigneeId === null) continue;
    if (facts.projects.get(work.projectId)?.active === false) continue;
    const hours = remainingOf(work);
    if (!(hours > 0)) continue;
    const carrier = String(work.assigneeId);
    if (!work.startDate && !work.dueDate) {
      undated.items += 1;
      undated.hours += hours;
      continue;
    }
    demand.push({
      id: `wp:${work.id}`,
      kind: 'work',
      carrier,
      roleId: carriers.get(carrier)?.roleId ?? null,
      projectId: work.projectId,
      hours,
      start: work.startDate ? dayOf(work.startDate) : null,
      due: work.dueDate ? dayOf(work.dueDate) : null,
    });
  }
  for (const allocation of allocations) {
    const carrier = allocation.personId ?? (allocation.placeholderId ? placeholderKey(allocation.placeholderId) : null);
    demand.push({
      id: `allocation:${allocation.id}`,
      kind: 'allocation',
      carrier,
      roleId: allocation.roleId ?? (carrier ? (carriers.get(carrier)?.roleId ?? null) : null),
      projectId: allocation.projectId,
      hours: allocation.hoursPerWeek,
      start: dayOf(isoDate(allocation.startsOn)),
      due: dayOf(isoDate(allocation.endsOn)),
    });
  }
  undated.hours = round2(undated.hours);

  return {
    at: Date.now(),
    facts,
    settings,
    calendar,
    availability,
    carriers,
    roles: new Map(roles.map((role) => [role.id, { name: role.name, archived: role.archivedAt !== null }])),
    teams,
    departments,
    allocations,
    billable,
    demand,
    undated,
  };
}

/* -------------------------------------------------------------------------- */
/* The grid: heatmap, forecast (BR-313, BR-314)                               */
/* -------------------------------------------------------------------------- */

export interface GridQuery {
  from?: string;
  weeks?: number;
  group?: CapacityGrouping;
  teamId?: string;
  roleId?: string;
  departmentId?: string;
  placeholders?: boolean;
}

const roleKey = (roleId: string) => `role:${roleId}`;

function carriersFor(data: ResourceShared, query: GridQuery): CarrierInfo[] {
  return [...data.carriers.values()].filter(
    (carrier) =>
      (query.placeholders !== false || carrier.kind === 'person') &&
      (!query.teamId || carrier.teamId === query.teamId) &&
      (!query.roleId || carrier.roleId === query.roleId) &&
      (!query.departmentId || carrier.departmentId === query.departmentId),
  );
}

/** Roles booked with nobody named, as rows of their own: demand with nobody to meet it. */
function unstaffedRoles(data: ResourceShared, query: GridQuery): string[] {
  if (query.teamId || query.departmentId) return [];
  const roles = new Set<string>();
  for (const item of data.demand) {
    if (item.kind === 'allocation' && item.carrier === null && item.roleId && (!query.roleId || item.roleId === query.roleId)) roles.add(item.roleId);
  }
  return [...roles];
}

/** Hours each carrier logged in each week, and how many of them billable. */
function loggedByWeek(data: ResourceShared, carriers: ReadonlySet<string>, fromWeek: number, toWeek: number) {
  const out = new Map<string, Map<number, { logged: number; billable: number }>>();
  for (const entry of data.facts.time) {
    if (entry.userId === null) continue;
    const key = String(entry.userId);
    if (!carriers.has(key)) continue;
    const week = weekOf(dayOf(entry.spentOn));
    if (week < fromWeek || week > toWeek) continue;
    const weeks = out.get(key) ?? new Map<number, { logged: number; billable: number }>();
    const cell = weeks.get(week) ?? { logged: 0, billable: 0 };
    cell.logged += entry.hours;
    if (data.billable(entry)) cell.billable += entry.hours;
    weeks.set(week, cell);
    out.set(key, weeks);
  }
  return out;
}

function cellOf(week: CarrierWeek, logged: number, today: number, data: ResourceShared): CapacityCell {
  const actual = week.week + 6 < today;
  const load = loadOf(week);
  const ratio = actual ? ratioOf(logged, week.available) : ratioOf(load, week.available);
  return {
    week: isoOf(week.week),
    basis: actual ? 'actual' : 'forecast',
    available: round2(week.available),
    committed: round2(week.committed),
    planned: round2(week.planned),
    logged: round2(logged),
    ratio: ratio === null ? null : Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
    band: bandForRatio(ratio, data),
    over: !actual && isOverAllocated(week),
  };
}

const bandForRatio = (ratio: number | null, data: ResourceShared): CapacityBand =>
  ratio === null ? 'none' : bandOf(Number.isFinite(ratio) ? ratio : Number.POSITIVE_INFINITY, data.settings.thresholds);

const sumCells = (cells: CapacityCell[][], weeks: number[], today: number, data: ResourceShared): CapacityCell[] =>
  weeks.map((week, index) => {
    const parts = cells.map((row) => row[index]!);
    const total: CarrierWeek = {
      carrier: '',
      week,
      available: parts.reduce((sum, cell) => sum + cell.available, 0),
      committed: parts.reduce((sum, cell) => sum + cell.committed, 0),
      planned: parts.reduce((sum, cell) => sum + cell.planned, 0),
      contributions: [],
    };
    const cell = cellOf(total, parts.reduce((sum, part) => sum + part.logged, 0), today, data);
    // A group is over when anyone in it is: a team's spare hours do not do
    // another member's work.
    return { ...cell, over: cell.over || parts.some((part) => part.over) };
  });

export async function capacityGrid(query: GridQuery): Promise<CapacityGrid> {
  const data = await loadResourceShared();
  const today = dayOf(todayIso());
  const fromWeek = weekOf(query.from ? dayOf(query.from) : today);
  const count = Math.min(Math.max(query.weeks ?? 12, 1), 52);
  const weeks = Array.from({ length: count }, (_, index) => fromWeek + index * 7);
  const toWeek = weeks.at(-1)!;
  const group = query.group ?? 'team';

  const carriers = carriersFor(data, query);
  const keys = new Set(carriers.map((carrier) => carrier.key));
  const loads = weeklyLoads(data.demand, data.availability, keys, fromWeek, toWeek, today);
  const logged = loggedByWeek(data, keys, fromWeek, toWeek);
  const rows: CapacityRow[] = carriers.map((carrier) => ({
    key: carrier.key,
    kind: carrier.kind,
    id: carrier.id,
    name: carrier.name,
    roleId: carrier.roleId,
    teamId: carrier.teamId,
    departmentId: carrier.departmentId,
    cells: weeks.map((week) => cellOf(loads.get(carrier.key)!.get(week)!, logged.get(carrier.key)?.get(week)?.logged ?? 0, today, data)),
  }));

  // Roles booked with nobody named: demand with no hours against it.
  for (const roleId of unstaffedRoles(data, query)) {
    const items = data.demand.filter((item) => item.kind === 'allocation' && item.carrier === null && item.roleId === roleId);
    const asCarrier = items.map((item) => ({ ...item, carrier: roleKey(roleId) }));
    const roleLoads = weeklyLoads(asCarrier, data.availability, [roleKey(roleId)], fromWeek, toWeek, today).get(roleKey(roleId))!;
    rows.push({
      key: roleKey(roleId),
      kind: 'role',
      id: roleId,
      name: data.roles.get(roleId)?.name ?? roleId,
      roleId,
      teamId: null,
      departmentId: null,
      cells: weeks.map((week) => cellOf(roleLoads.get(week)!, 0, today, data)),
    });
  }

  const language = contextLanguage();
  const groupOf = (row: CapacityRow): { key: string; name: string } => {
    if (group === 'none') return { key: 'all', name: t(language, 'Everyone') };
    if (group === 'role') {
      return row.roleId ? { key: row.roleId, name: data.roles.get(row.roleId)?.name ?? row.roleId } : { key: 'none', name: t(language, 'No role') };
    }
    if (group === 'department') {
      return row.departmentId
        ? { key: row.departmentId, name: data.departments.get(row.departmentId) ?? row.departmentId }
        : { key: 'none', name: t(language, 'No department') };
    }
    if (row.kind === 'role') return { key: 'unstaffed', name: t(language, 'Booked to a role, nobody named') };
    return row.teamId ? { key: row.teamId, name: data.teams.get(row.teamId) ?? row.teamId } : { key: 'none', name: t(language, 'No team') };
  };
  const groups = new Map<string, CapacityGroup>();
  for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const { key, name } = groupOf(row);
    const entry = groups.get(key) ?? { key, name, cells: [], rows: [] };
    entry.rows.push(row);
    groups.set(key, entry);
  }
  for (const entry of groups.values()) entry.cells = sumCells(entry.rows.map((row) => row.cells), weeks, today, data);
  const ordered = [...groups.values()].sort((a, b) => Number(a.key === 'none') - Number(b.key === 'none') || a.name.localeCompare(b.name));

  return {
    weeks: weeks.map(isoOf),
    today: isoOf(today),
    group,
    thresholds: data.settings.thresholds,
    groups: ordered,
    undated: data.undated,
    asOf: data.facts.asOf,
  };
}

/* -------------------------------------------------------------------------- */
/* Over-allocation and what is behind a cell (BR-110, BR-313, BR-314)         */
/* -------------------------------------------------------------------------- */

function describe(data: ResourceShared, carrierKey: string, contribution: { itemId: string; hours: number }): DemandContribution {
  const carrierName = carrierKey.startsWith('role:')
    ? (data.roles.get(carrierKey.slice(5))?.name ?? carrierKey)
    : (data.carriers.get(carrierKey)?.name ?? carrierKey);
  if (contribution.itemId.startsWith('wp:')) {
    const id = Number(contribution.itemId.slice(3));
    const work = data.facts.workPackages.find((entry) => entry.id === id);
    return {
      itemId: contribution.itemId,
      kind: 'work',
      hours: round2(contribution.hours),
      carrierKey,
      carrierName,
      projectId: String(work?.projectId ?? ''),
      projectName: (work && data.facts.projects.get(work.projectId)?.name) ?? '',
      workPackageId: String(id),
      subject: work?.subject ?? `#${id}`,
      startDate: work?.startDate ?? null,
      dueDate: work?.dueDate ?? null,
    };
  }
  const allocationId = contribution.itemId.slice('allocation:'.length);
  const allocation = data.allocations.find((entry) => entry.id === allocationId);
  return {
    itemId: contribution.itemId,
    kind: 'allocation',
    hours: round2(contribution.hours),
    carrierKey,
    carrierName,
    projectId: String(allocation?.projectId ?? ''),
    projectName: (allocation && data.facts.projects.get(allocation.projectId)?.name) ?? '',
    allocationId,
    hoursPerWeek: allocation?.hoursPerWeek,
    startDate: allocation ? isoDate(allocation.startsOn) : null,
    dueDate: allocation ? isoDate(allocation.endsOn) : null,
  };
}

/** Every week from this one on that someone is asked for more than they have, with what it is made of (BR-110). */
export async function overAllocations(query: GridQuery): Promise<OverAllocation[]> {
  const data = await loadResourceShared();
  const today = dayOf(todayIso());
  const fromWeek = weekOf(today);
  const count = Math.min(Math.max(query.weeks ?? 12, 1), 52);
  const toWeek = fromWeek + (count - 1) * 7;
  const carriers = carriersFor(data, query);
  const loads = weeklyLoads(data.demand, data.availability, carriers.map((carrier) => carrier.key), fromWeek, toWeek, today);
  const out: OverAllocation[] = [];
  for (const carrier of carriers) {
    for (const week of loads.get(carrier.key)!.values()) {
      if (!isOverAllocated(week)) continue;
      out.push({
        key: carrier.key,
        kind: carrier.kind,
        id: carrier.id,
        name: carrier.name,
        teamId: carrier.teamId,
        roleId: carrier.roleId,
        week: isoOf(week.week),
        available: round2(week.available),
        committed: round2(week.committed),
        planned: round2(week.planned),
        excess: round2(loadOf(week) - week.available),
        contributions: week.contributions.map((part) => describe(data, carrier.key, part)),
      });
    }
  }
  return out.sort((a, b) => a.week.localeCompare(b.week) || b.excess - a.excess || a.name.localeCompare(b.name));
}

/**
 * What is behind one cell of the heatmap: a person's, placeholder's or
 * unstaffed role's week — or a group's, when `key` is `group:<grouping>:<id>`
 * — with the demand that falls in it and the time logged in it.
 */
export async function cellDetail(key: string, weekIso: string, query: GridQuery): Promise<CapacityCellDetail> {
  const data = await loadResourceShared();
  const today = dayOf(todayIso());
  const week = weekOf(dayOf(weekIso));

  let members: { key: string; name: string }[];
  let name: string;
  if (key.startsWith('group:')) {
    const [, grouping, ...rest] = key.split(':');
    const groupId = rest.join(':');
    const grid = await capacityGrid({ ...query, from: isoOf(week), weeks: 1, group: grouping as CapacityGrouping });
    const group = grid.groups.find((entry) => entry.key === groupId);
    if (!group) throw EpmError.notFound('That group');
    members = group.rows.map((row) => ({ key: row.key, name: row.name }));
    name = group.name;
  } else if (key.startsWith('role:')) {
    const roleId = key.slice(5);
    if (!data.roles.has(roleId)) throw EpmError.notFound('That role');
    members = [{ key, name: data.roles.get(roleId)!.name }];
    name = members[0]!.name;
  } else {
    const carrier = data.carriers.get(key);
    if (!carrier) throw EpmError.notFound('That person');
    members = [{ key, name: carrier.name }];
    name = carrier.name;
  }

  const total: CarrierWeek = { carrier: key, week, available: 0, committed: 0, planned: 0, contributions: [] };
  const contributions: DemandContribution[] = [];
  let loggedHours = 0;
  const logged = new Map<string, LoggedTime>();
  for (const member of members) {
    const isRole = member.key.startsWith('role:');
    const items = isRole
      ? data.demand
          .filter((item) => item.kind === 'allocation' && item.carrier === null && item.roleId === member.key.slice(5))
          .map((item) => ({ ...item, carrier: member.key }))
      : data.demand.filter((item) => item.carrier === member.key);
    const cell = weeklyLoads(items, data.availability, [member.key], week, week, today).get(member.key)!.get(week)!;
    total.available += cell.available;
    total.committed += cell.committed;
    total.planned += cell.planned;
    for (const part of cell.contributions) contributions.push(describe(data, member.key, part));
    if (isRole) continue;
    for (const entry of data.facts.time) {
      if (entry.userId === null || String(entry.userId) !== member.key) continue;
      const day = dayOf(entry.spentOn);
      if (day < week || day > week + 6) continue;
      loggedHours += entry.hours;
      const work = entry.workPackageId !== null ? data.facts.workPackages.find((item) => item.id === entry.workPackageId) : undefined;
      const lineKey = `${entry.projectId ?? ''}:${entry.workPackageId ?? ''}`;
      const line = logged.get(lineKey) ?? {
        workPackageId: entry.workPackageId === null ? null : String(entry.workPackageId),
        subject: work?.subject ?? null,
        projectId: entry.projectId === null ? null : String(entry.projectId),
        projectName: entry.projectId === null ? null : (data.facts.projects.get(entry.projectId)?.name ?? null),
        hours: 0,
      };
      line.hours += entry.hours;
      logged.set(lineKey, line);
    }
  }
  return {
    key,
    name,
    week: isoOf(week),
    cell: cellOf(total, loggedHours, today, data),
    contributions: contributions.sort((a, b) => b.hours - a.hours),
    logged: [...logged.values()].map((line) => ({ ...line, hours: round2(line.hours) })).sort((a, b) => b.hours - a.hours),
  };
}

/* -------------------------------------------------------------------------- */
/* The BI layer (BR-312 to BR-315)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rewrites `analytics.fact_capacity_week`: every active person's weeks, from
 * half a year back to half a year on — hours available, assigned work and
 * planned allocations falling in each (from the current week on), and the time
 * they logged, billable and not. And `analytics.dim_resource_role`.
 */
export async function materialiseCapacity(day = todayIso()): Promise<number> {
  const data = await loadResourceShared();
  const today = dayOf(day);
  const fromWeek = weekOf(today) - 26 * 7;
  const toWeek = weekOf(today) + 25 * 7;
  const people = [...data.carriers.values()].filter((carrier) => carrier.kind === 'person');
  const keys = new Set(people.map((person) => person.key));
  const loads = weeklyLoads(data.demand, data.availability, keys, fromWeek, toWeek, today);
  const logged = loggedByWeek(data, keys, fromWeek, toWeek);
  const now = new Date().toISOString();
  const rows: Record<string, string | number | boolean | null>[] = [];
  for (const person of people) {
    for (const [week, cell] of loads.get(person.key)!) {
      const time = logged.get(person.key)?.get(week);
      // Past weeks: the whole week's hours, which `weeklyLoads` gives them.
      rows.push({
        person_id: Number(person.id),
        week_start: isoOf(week),
        week_start_key: Number(isoOf(week).replaceAll('-', '')),
        role_id: person.roleId,
        team_id: person.teamId,
        department_id: person.departmentId,
        available_hours: round2(cell.available),
        demand_hours: round2(cell.committed),
        planned_hours: round2(cell.planned),
        logged_hours: round2(time?.logged ?? 0),
        billable_hours: round2(time?.billable ?? 0),
        non_billable_hours: round2((time?.logged ?? 0) - (time?.billable ?? 0)),
        is_forecast: week + 6 >= today,
        computed_at: now,
      });
    }
  }
  const roles = [...data.roles.entries()].map(([role_id, role]) => ({ role_id, name: role.name, is_archived: role.archived }));
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('DELETE FROM analytics.fact_capacity_week');
      for (let index = 0; index < rows.length; index += 2000) {
        await tx.$executeRawUnsafe(
          `INSERT INTO analytics.fact_capacity_week
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
               person_id integer, week_start date, week_start_key integer, role_id text, team_id text, department_id text,
               available_hours double precision, demand_hours double precision, planned_hours double precision,
               logged_hours double precision, billable_hours double precision, non_billable_hours double precision,
               is_forecast boolean, computed_at timestamptz)`,
          JSON.stringify(rows.slice(index, index + 2000)),
        );
      }
      await tx.$executeRawUnsafe('DELETE FROM analytics.dim_resource_role');
      if (roles.length > 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO analytics.dim_resource_role
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(role_id text, name text, is_archived boolean)`,
          JSON.stringify(roles),
        );
      }
    },
    { timeout: 60_000 },
  );
  return rows.length;
}

/** Hours a carrier is available over a period, both days included. */
export async function availableHours(carrierKey: string, from: string, to: string): Promise<number> {
  const data = await loadResourceShared();
  return round2(data.availability.sum(carrierKey, dayOf(from), dayOf(to)));
}

export type { CarrierKind };
