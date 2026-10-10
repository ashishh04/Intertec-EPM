import type { ApprovalRequest, Timesheet } from '@prisma/client';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { daysBetween, isoWeekLabel, today as todayIso } from '../lib/dates.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError } from '../lib/errors.js';
import { contextConventions, contextLanguage, dateOf, message, msg, render, type Message } from '../lib/i18n.js';
import { listProjects } from '../mapping/projects.js';
import { getUsers } from '../mapping/users.js';
import { linkId, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type { TimesheetOverview, TimesheetRow, TimesheetStatus, TimesheetSummary, TimesheetView } from '../types/epm.js';
import { cancelRequest, registerSubjectAdapter, requestsFor, submitSubject, type LoadedSubject } from './approvals.js';
import { withAudit } from './audit.js';
import { automationUserId } from './automation-account.js';
import { dayOf as dayNumberOf } from './critical-path.js';
import { loadResourceShared } from './resources-store.js';
import { entriesOf, getTimeSettings, periodClosed, periodOf, type LoggedEntry } from './time-rules.js';

/**
 * Timesheets (BR-304 to BR-306): a person's logged time for one period, sent
 * through the approval engine as one subject — their line manager, then the
 * owners of the projects the time is on — and locked while it is submitted or
 * approved. A rejection returns it to draft with the reason; an approved one
 * can be reopened by whoever manages timesheets.
 *
 * The time itself stays in OpenProject. A period has no timesheet row until it
 * is first submitted; until then it is a draft made of whatever is logged.
 */

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const round2 = (value: number) => Math.round(value * 100) / 100;
const say = (value: Message) => render(contextLanguage(), value, contextConventions());

export interface TimesheetViewer {
  id: string;
  /** timesheets:manage — every timesheet, the overview of everyone, reopening. */
  manage: boolean;
}

async function nameOf(id: string | null | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const users = await runAsSystem(() => getUsers()).catch(() => []);
  return users.find((user) => user.id === id)?.name;
}

/** The person's timesheet row covering a day, whatever period it was made for. */
async function rowCovering(personId: string, day: string): Promise<Timesheet | null> {
  return prisma.timesheet.findFirst({
    where: { personId, periodStart: { lte: date(day) }, periodEnd: { gte: date(day) } },
    orderBy: { periodStart: 'desc' },
  });
}

/** The key a timesheet goes by: its ISO week, or its month. */
const keyOf = (start: string, end: string) => (daysBetween(start, end) > 7 ? `TS-${start.slice(0, 7)}` : `TS-${isoWeekLabel(start)}`);

interface Figures {
  periodStart: string;
  periodEnd: string;
  entries: LoggedEntry[];
  hours: number;
  unattributedHours: number;
  available: number;
  minimum: number | null;
  maximum: number | null;
  /** What stops it being submitted, as messages. */
  problems: Message[];
}

/** The time in a period and what the settings make of it. */
async function figures(personId: string, start: string, end: string, status: TimesheetStatus): Promise<Figures> {
  const [settings, entries, shared] = await Promise.all([getTimeSettings(), entriesOf(personId, start, end), loadResourceShared()]);
  const hours = round2(entries.reduce((sum, entry) => sum + entry.hours, 0));
  const unattributedHours = round2(entries.filter((entry) => !entry.workPackageId).reduce((sum, entry) => sum + entry.hours, 0));
  const available = round2(shared.availability.sum(personId, dayNumberOf(start), dayNumberOf(end)));
  const { minimum: min, maximum: max, requireWorkPackage } = settings.timesheets;
  const minimum = min.basis === 'available' ? available : min.basis === 'fixed' ? min.hours : null;
  const maximum = max.basis === 'fixed' ? max.hours : null;

  const problems: Message[] = [];
  if (status === 'draft') {
    if (start > todayIso()) problems.push(message('This period has not started yet.'));
    if (minimum !== null && hours + 1e-9 < minimum) {
      problems.push(message('{hours, number} hours are logged; this period needs at least {minimum, number}.', { hours, minimum }));
    }
    if (maximum !== null && hours > maximum + 1e-9) {
      problems.push(message('{hours, number} hours are logged; this period allows at most {maximum, number}.', { hours, maximum }));
    }
    if (requireWorkPackage && unattributedHours > 0) {
      problems.push(
        message('{hours, number} hours are on no work package; every hour on a timesheet must be on one.', { hours: unattributedHours }),
      );
    }
  }
  return { periodStart: start, periodEnd: end, entries, hours, unattributedHours, available, minimum, maximum, problems };
}

/** One person's timesheet for the period a day falls in. */
export async function timesheetView(personId: string, day: string, viewer: TimesheetViewer): Promise<TimesheetView> {
  const settings = await getTimeSettings();
  const row = await rowCovering(personId, day);
  const period = row ? { start: iso(row.periodStart), end: iso(row.periodEnd) } : periodOf(day, settings.timesheets.period);
  return viewOf(personId, period.start, period.end, row, viewer);
}

export async function timesheetById(id: string, viewer: TimesheetViewer): Promise<TimesheetView> {
  const row = await prisma.timesheet.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That timesheet');
  return viewOf(row.personId, iso(row.periodStart), iso(row.periodEnd), row, viewer);
}

async function viewOf(personId: string, start: string, end: string, row: Timesheet | null, viewer: TimesheetViewer): Promise<TimesheetView> {
  const status = (row?.status ?? 'draft') as TimesheetStatus;
  const [numbers, personName, projects, requests] = await Promise.all([
    figures(personId, start, end, status),
    nameOf(personId),
    runAsSystem(() => listProjects()).catch(() => []),
    row ? requestsFor('timesheet', row.id, viewer.id, viewer.manage) : Promise.resolve([]),
  ]);

  const byProject = new Map<string, { projectId: string; projectName: string; hours: number }>();
  for (const entry of numbers.entries) {
    const current = byProject.get(entry.projectId) ?? {
      projectId: entry.projectId,
      projectName: entry.projectName || projects.find((project) => String(project.id) === entry.projectId)?.name || `#${entry.projectId}`,
      hours: 0,
    };
    current.hours = round2(current.hours + entry.hours);
    byProject.set(entry.projectId, current);
  }

  const own = viewer.id === personId;
  const request = requests[0];
  return {
    id: row?.id,
    personId,
    personName: personName ?? `#${personId}`,
    periodStart: start,
    periodEnd: end,
    closed: periodClosed(end),
    status,
    hours: numbers.hours,
    entries: numbers.entries.length,
    unattributedHours: numbers.unattributedHours,
    available: numbers.available,
    bounds: { minimum: numbers.minimum, maximum: numbers.maximum },
    projects: [...byProject.values()].sort((a, b) => b.hours - a.hours),
    problems: numbers.problems.map(say),
    locked: status !== 'draft',
    submittedAt: row?.submittedAt?.toISOString(),
    approvedAt: row?.approvedAt?.toISOString(),
    rejection:
      status === 'draft' && row?.rejectedAt && row.rejectedBy
        ? { at: row.rejectedAt.toISOString(), by: row.rejectedBy, byName: await nameOf(row.rejectedBy), reason: row.rejectionReason ?? '' }
        : undefined,
    reopened:
      row?.reopenedAt && row.reopenedBy
        ? { at: row.reopenedAt.toISOString(), by: row.reopenedBy, byName: await nameOf(row.reopenedBy), reason: row.reopenReason ?? '' }
        : undefined,
    request,
    can: {
      submit: own && status === 'draft' && numbers.problems.length === 0,
      withdraw: (own || viewer.manage) && status === 'submitted' && request?.status === 'pending',
      reopen: viewer.manage && status === 'approved',
    },
  };
}

/** A person's own timesheets, newest first: what they have submitted. */
export async function timesheetHistory(personId: string): Promise<TimesheetSummary[]> {
  const rows = await prisma.timesheet.findMany({ where: { personId }, orderBy: { periodStart: 'desc' }, take: 52 });
  return rows.map((row) => ({
    id: row.id,
    periodStart: iso(row.periodStart),
    periodEnd: iso(row.periodEnd),
    status: row.status as TimesheetStatus,
    rejected: row.status === 'draft' && Boolean(row.rejectedAt),
    hours: row.hours,
    submittedAt: row.submittedAt?.toISOString(),
    approvedAt: row.approvedAt?.toISOString(),
    rejectedAt: row.status === 'draft' ? row.rejectedAt?.toISOString() : undefined,
  }));
}

/* -------------------------------------------------------------------------- */
/* Submitting, withdrawing, reopening                                         */
/* -------------------------------------------------------------------------- */

/**
 * Submits a person's timesheet for the period a day falls in (BR-304): refused
 * when its hours fall outside the bounds or any hour is on no work package,
 * naming which; otherwise sent for approval and its time locked.
 */
export async function submitTimesheet(personId: string, day: string, actorId: string): Promise<TimesheetView> {
  if (actorId !== personId) throw EpmError.forbidden('Only the person whose time it is can submit their timesheet.');
  const settings = await getTimeSettings();
  const existing = await rowCovering(personId, day);
  const period = existing ? { start: iso(existing.periodStart), end: iso(existing.periodEnd) } : periodOf(day, settings.timesheets.period);
  const status = (existing?.status ?? 'draft') as TimesheetStatus;
  if (status !== 'draft') {
    throw EpmError.conflict(
      message('This timesheet has already been {status, select, approved {approved} other {submitted}}.', { status }),
    );
  }
  const numbers = await figures(personId, period.start, period.end, status);
  if (numbers.problems.length > 0) throw EpmError.validation(numbers.problems[0]!);

  const row =
    existing ??
    (await prisma.timesheet.upsert({
      where: { personId_periodStart: { personId, periodStart: date(period.start) } },
      create: { personId, periodStart: date(period.start), periodEnd: date(period.end) },
      update: {},
    }));
  const requestId = await submitSubject('timesheet', row.id, actorId);

  await withAudit(
    (tx) =>
      tx.timesheet.update({
        where: { id: row.id },
        data: {
          status: 'submitted',
          submittedAt: new Date(),
          hours: numbers.hours,
          entries: numbers.entries.length,
          requestId,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
        },
      }),
    {
      actorId,
      entityType: 'timesheet',
      entityId: row.id,
      action: 'timesheet.submitted',
      summary: message('Timesheet for {from} to {to} submitted with {hours, number} hours.', {
        from: dateOf(period.start),
        to: dateOf(period.end),
        hours: numbers.hours,
      }),
      after: { periodStart: period.start, periodEnd: period.end, hours: numbers.hours, entries: numbers.entries.length, requestId },
    },
  );
  return timesheetById(row.id, { id: actorId, manage: false });
}

/** Withdraws a submitted timesheet: it returns to draft and its time unlocks. */
export async function withdrawTimesheet(id: string, viewer: TimesheetViewer): Promise<TimesheetView> {
  const row = await prisma.timesheet.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That timesheet');
  if (row.personId !== viewer.id && !viewer.manage) throw EpmError.forbidden('Only the person whose timesheet it is can withdraw it.');
  if (row.status !== 'submitted' || !row.requestId) throw EpmError.conflict('Only a submitted timesheet can be withdrawn.');
  await cancelRequest({ requestId: row.requestId, actorId: viewer.id, mayCancelAny: viewer.manage });
  return timesheetById(id, viewer);
}

/** Opens an approved timesheet again, with a reason: it returns to draft and its time unlocks. */
export async function reopenTimesheet(id: string, viewer: TimesheetViewer, rawReason: unknown): Promise<TimesheetView> {
  if (!viewer.manage) throw EpmError.forbidden('Only someone who manages timesheets can reopen one.');
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (reason.length < 3) throw EpmError.validation('Say why it is being reopened: the person is shown the reason.');
  const row = await prisma.timesheet.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That timesheet');
  if (row.status !== 'approved') throw EpmError.conflict('Only an approved timesheet can be reopened.');
  await withAudit(
    (tx) =>
      tx.timesheet.update({
        where: { id },
        data: { status: 'draft', reopenedAt: new Date(), reopenedBy: viewer.id, reopenReason: reason.slice(0, 2000), approvedAt: null },
      }),
    {
      actorId: viewer.id,
      entityType: 'timesheet',
      entityId: id,
      action: 'timesheet.reopened',
      summary: message('Timesheet for {from} to {to} reopened.', { from: dateOf(iso(row.periodStart)), to: dateOf(iso(row.periodEnd)) }),
      reason,
    },
  );
  return timesheetById(id, viewer);
}

/* -------------------------------------------------------------------------- */
/* The approval engine's view of a timesheet                                  */
/* -------------------------------------------------------------------------- */

async function loadTimesheet(id: string): Promise<LoadedSubject> {
  const row = await prisma.timesheet.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That timesheet');
  const start = iso(row.periodStart);
  const end = iso(row.periodEnd);
  const [entries, name, profiles] = await Promise.all([
    entriesOf(row.personId, start, end),
    nameOf(row.personId),
    prisma.projectProfile.findMany({ where: { timesheetApproval: false }, select: { openProjectId: true } }),
  ]);
  // The owners asked are those of the projects the time is on, unless a
  // project has said its owner does not approve timesheets (BR-305).
  const optedOut = new Set(profiles.map((profile) => profile.openProjectId));
  const projectIds = [...new Set(entries.map((entry) => entry.projectId))].filter((projectId) => projectId && !optedOut.has(projectId));
  return {
    id,
    key: keyOf(start, end),
    title: `${name ?? `#${row.personId}`}, ${start} – ${end}`,
    projectId: '',
    projectName: '',
    facts: { projectId: '', customFields: {} },
    value: round2(entries.reduce((sum, entry) => sum + entry.hours, 0)),
    valueLabel: msg('Hours'),
    projectIds,
  };
}

async function onOutcome(
  outcome: 'approved' | 'rejected' | 'withdrawn',
  request: ApprovalRequest,
  detail: { actorId: string | null; comment?: string },
): Promise<void> {
  const row = await prisma.timesheet.findUnique({ where: { id: request.subjectId } });
  // A request this timesheet has moved on from changes nothing.
  if (!row || row.requestId !== request.id || row.status !== 'submitted') return;
  const period = { from: dateOf(iso(row.periodStart)), to: dateOf(iso(row.periodEnd)) };
  if (outcome === 'approved') {
    await withAudit((tx) => tx.timesheet.update({ where: { id: row.id }, data: { status: 'approved', approvedAt: new Date() } }), {
      actorId: detail.actorId,
      entityType: 'timesheet',
      entityId: row.id,
      action: 'timesheet.approved',
      summary: message('Timesheet for {from} to {to} approved.', period),
    });
  } else if (outcome === 'rejected') {
    await withAudit(
      (tx) =>
        tx.timesheet.update({
          where: { id: row.id },
          data: { status: 'draft', rejectedAt: new Date(), rejectedBy: detail.actorId, rejectionReason: detail.comment ?? null },
        }),
      {
        actorId: detail.actorId,
        entityType: 'timesheet',
        entityId: row.id,
        action: 'timesheet.rejected',
        summary: message('Timesheet for {from} to {to} rejected and returned to draft.', period),
        reason: detail.comment ?? null,
      },
    );
  } else {
    await withAudit((tx) => tx.timesheet.update({ where: { id: row.id }, data: { status: 'draft' } }), {
      actorId: detail.actorId,
      entityType: 'timesheet',
      entityId: row.id,
      action: 'timesheet.withdrawn',
      summary: message('Timesheet for {from} to {to} withdrawn.', period),
      reason: detail.comment ?? null,
    });
  }
}

registerSubjectAdapter({ type: 'timesheet', load: loadTimesheet, link: (id) => `/timesheets/${id}`, onOutcome });

/* -------------------------------------------------------------------------- */
/* The overview (BR-306)                                                      */
/* -------------------------------------------------------------------------- */

interface OpTimeEntry {
  hours: string;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
}

/** The people whose timesheets a viewer may see: everyone, or those they manage as team lead or department manager. */
export async function managedPeople(viewerId: string): Promise<Set<string>> {
  const [teams, departments, shared] = await Promise.all([
    prisma.team.findMany({ where: { leadId: viewerId }, select: { id: true } }),
    prisma.department.findMany({ where: { managerId: viewerId }, select: { id: true } }),
    loadResourceShared(),
  ]);
  const teamIds = new Set(teams.map((team) => team.id));
  const departmentIds = new Set(departments.map((department) => department.id));
  const people = new Set<string>();
  for (const person of shared.facts.people.values()) {
    if ((person.teamId && teamIds.has(person.teamId)) || (person.departmentId && departmentIds.has(person.departmentId))) {
      people.add(String(person.id));
    }
  }
  people.delete(viewerId);
  return people;
}

export interface OverviewQuery {
  day: string;
  status?: 'submitted' | 'approved' | 'rejected' | 'outstanding';
  teamId?: string;
  departmentId?: string;
  projectId?: string;
  personId?: string;
}

/**
 * Everyone's timesheet for one period (BR-306): submitted, approved, rejected
 * and outstanding. Outstanding means expected and not in: someone active, with
 * hours available in the period (BR-312), whose timesheet for a period that
 * has ended is not submitted or approved. A person with no available hours —
 * on leave all week, or a service account given no capacity — is not expected.
 */
export async function timesheetOverview(query: OverviewQuery, scope: Set<string> | 'all'): Promise<TimesheetOverview> {
  const settings = await getTimeSettings();
  const { start, end } = periodOf(query.day, settings.timesheets.period);
  const closed = periodClosed(end);
  const [shared, automation, rows, entries] = await Promise.all([
    loadResourceShared(),
    automationUserId().catch(() => undefined),
    prisma.timesheet.findMany({ where: { periodStart: date(start) } }),
    runAsSystem(() =>
      openProject.getAll<OpTimeEntry>('/time_entries', { filters: [{ field: 'spent_on', operator: '<>d', values: [start, end] }], pageSize: 200 }),
    ),
  ]);

  const hoursBy = new Map<string, number>();
  const projectsBy = new Map<string, Set<string>>();
  for (const entry of entries.items) {
    const userId = linkId(entry._links ?? {}, 'user');
    if (!userId) continue;
    hoursBy.set(userId, (hoursBy.get(userId) ?? 0) + (durationToHours(entry.hours) ?? 0));
    const projects = projectsBy.get(userId) ?? new Set<string>();
    projects.add(linkId(entry._links ?? {}, 'project') ?? '');
    projectsBy.set(userId, projects);
  }
  const rowBy = new Map(rows.map((row) => [row.personId, row]));

  const all: TimesheetRow[] = [];
  for (const carrier of shared.carriers.values()) {
    if (carrier.kind !== 'person' || carrier.id === automation) continue;
    if (scope !== 'all' && !scope.has(carrier.id)) continue;
    const person = shared.facts.people.get(Number(carrier.id));
    const row = rowBy.get(carrier.id);
    const status: TimesheetRow['status'] = (row?.status as TimesheetStatus | undefined) ?? 'missing';
    const available = round2(shared.availability.sum(carrier.id, dayNumberOf(start), dayNumberOf(end)));
    const inNow = status === 'submitted' || status === 'approved';
    all.push({
      personId: carrier.id,
      personName: carrier.name,
      teamId: person?.teamId ?? undefined,
      departmentId: person?.departmentId ?? undefined,
      timesheetId: row?.id,
      status,
      rejected: status === 'draft' && Boolean(row?.rejectedAt),
      hours: round2(hoursBy.get(carrier.id) ?? 0),
      available,
      submittedAt: row?.submittedAt?.toISOString(),
      approvedAt: row?.approvedAt?.toISOString(),
      rejectedAt: status === 'draft' ? row?.rejectedAt?.toISOString() : undefined,
      outstanding: closed && !inNow && available > 0,
    });
  }

  const filtered = all.filter(
    (row) =>
      (!query.teamId || row.teamId === query.teamId) &&
      (!query.departmentId || row.departmentId === query.departmentId) &&
      (!query.personId || row.personId === query.personId) &&
      (!query.projectId || projectsBy.get(row.personId)?.has(query.projectId)),
  );
  const counts = {
    submitted: filtered.filter((row) => row.status === 'submitted').length,
    approved: filtered.filter((row) => row.status === 'approved').length,
    rejected: filtered.filter((row) => row.rejected).length,
    outstanding: filtered.filter((row) => row.outstanding).length,
  };
  const shown = filtered
    .filter((row) =>
      query.status === 'outstanding'
        ? row.outstanding
        : query.status === 'rejected'
          ? row.rejected
          : query.status
            ? row.status === query.status
            : true,
    )
    .sort((a, b) => a.personName.localeCompare(b.personName));
  return { periodStart: start, periodEnd: end, closed, rows: shown, counts };
}
