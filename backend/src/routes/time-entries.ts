import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { addDays, daysBetween, isoWeekLabel, startOfIsoWeek } from '../lib/dates.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { durationToHours, hoursToDuration } from '../lib/duration.js';
import { paginated, resolvePage } from '../lib/pagination.js';
import { requestSignal } from '../lib/request-signal.js';
import { getUsers } from '../mapping/users.js';
import { linkId, linkTitle, openProject, type OpFilter } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type { EpmTimeEntry, TimeReport, TimeReportGrouping, TimeReportRow } from '../types/epm.js';

/**
 * Logged time.
 *
 * Authorised by OpenProject rather than by EPM's permission map, and
 * deliberately so. The capabilities vocabulary defines no action for time
 * entries — there is nothing to map `time:log` or `time:view` from — so a
 * check here would be a guess, and the previous behaviour was to refuse
 * everything rather than guess. Refusing everything is also a guess; it just
 * happens to be wrong in the safe direction.
 *
 * The authoritative answer exists: OpenProject applies `log_time` and
 * `view_time_entries` per project on every one of these endpoints, and says so
 * with a 403 carrying its own reason. So each route forwards the caller's
 * token and translates the refusal. That is the same reasoning as
 * `guard.requireLink` — the instance decides, per record and per user, and is
 * stricter than any mapping could be.
 *
 * Nothing here is an Enterprise feature; time tracking is core OpenProject.
 */

interface OpTimeEntry {
  id: number;
  createdAt: string;
  updatedAt: string;
  spentOn: string;
  hours: string;
  comment?: { raw?: string };
  _links?: Record<string, HalLink | undefined>;
}

const listQuery = z.object({
  projectId: z.string().optional(),
  workPackageId: z.string().optional(),
  userId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const writeBody = z.object({
  projectId: z.string().optional(),
  workPackageId: z.string().optional(),
  hours: z.coerce.number().positive('Log a positive number of hours.').max(24, 'A single entry cannot exceed 24 hours.'),
  spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'spentOn must be a date, e.g. 2026-09-25.'),
  comment: z.string().max(4000).optional(),
  activityId: z.string().optional(),
});

const patchBody = writeBody.partial();

/**
 * A `user` filter value: a numeric id, or the literal `me`.
 *
 * `me` is not a convenience — it is the only value that reliably works for the
 * question "my own time". OpenProject validates this filter against the
 * principals the caller can see, and for somebody who belongs to no project that
 * set does not even include their own numeric id: the answer is "Filters User
 * filter has invalid values", and a person opening their own empty timesheet was
 * shown an error instead of an empty week.
 *
 * `me` sidesteps the question entirely. OpenProject resolves it server-side from
 * the token, so it is valid for every caller by construction.
 */
function principal(value: string | undefined, what: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'me') return 'me';
  return numeric(value, what);
}

/** Ids that reach an upstream path must be digits, and are checked before they do. */
function numeric(value: string | undefined, what: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw EpmError.badRequest(`That ${what} is not valid.`);
  return value;
}

function toEpmTimeEntry(entry: OpTimeEntry): EpmTimeEntry {
  const links = entry._links ?? {};

  return {
    id: String(entry.id),
    // Stored as an ISO-8601 duration; the contract is plain hours.
    hours: durationToHours(entry.hours) ?? 0,
    spentOn: entry.spentOn,
    comment: entry.comment?.raw || undefined,
    projectId: linkId(links, 'project') ?? '',
    projectName: linkTitle(links, 'project'),
    workPackageId: linkId(links, 'workPackage'),
    workPackageSubject: linkTitle(links, 'workPackage'),
    userId: linkId(links, 'user') ?? '',
    activityId: linkId(links, 'activity'),
    activityName: linkTitle(links, 'activity'),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    // From the entry's own affordances: a person may log their own time and
    // still have no business editing someone else's.
    can: {
      update: Object.hasOwn(links, 'updateImmediately') || Object.hasOwn(links, 'update'),
      delete: Object.hasOwn(links, 'delete'),
    },
  };
}

/**
 * Turns an upstream refusal into EPM's own error, message intact.
 *
 * A 403 here is the authorisation answer, not an integration fault: the caller
 * lacks `log_time` or `view_time_entries` in that project, and OpenProject's
 * sentence says which. 404 on a time entry route generally means the module is
 * switched off for the project rather than that the row is missing, so it is
 * reported as such instead of as a bare "not found".
 */
function rethrow(what: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof OpenProjectError) {
      if (error.upstreamStatus === 403) throw EpmError.forbidden(error.message);
      if (error.upstreamStatus === 422) throw EpmError.validation(error.message);
      if (error.upstreamStatus === 404) throw EpmError.notFound(what);
    }
    throw error;
  };
}

/** The HAL body for a write, from the flat contract. */
function toUpstreamBody(input: z.infer<typeof patchBody>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const links: Record<string, { href: string | null }> = {};

  if (input.hours !== undefined) body.hours = hoursToDuration(input.hours);
  if (input.spentOn !== undefined) body.spentOn = input.spentOn;
  if (input.comment !== undefined) body.comment = { raw: input.comment };

  const projectId = numeric(input.projectId, 'project');
  if (projectId) links.project = { href: `/api/v3/projects/${projectId}` };

  const workPackageId = numeric(input.workPackageId, 'work package');
  if (workPackageId) links.workPackage = { href: `/api/v3/work_packages/${workPackageId}` };

  const activityId = numeric(input.activityId, 'activity');
  if (activityId) links.activity = { href: `/api/v3/time_entries/activities/${activityId}` };

  if (Object.keys(links).length > 0) body._links = links;
  return body;
}

async function entryById(request: FastifyRequest, id: string): Promise<OpTimeEntry> {
  if (!/^\d+$/.test(id)) throw EpmError.notFound('That time entry');

  return openProject
    .request<OpTimeEntry>(`/time_entries/${id}`, { signal: requestSignal(request) })
    .catch(rethrow('That time entry'));
}

/**
 * A report range, grouped.
 *
 * Both bounds are required. An unbounded report would walk every time entry
 * the instance holds, which is neither a question anyone asks nor one this can
 * answer within a request.
 */
const reportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be a date, e.g. 2026-09-01.'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be a date, e.g. 2026-09-30.'),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  groupBy: z
    .enum(['user', 'project', 'activity', 'workPackage', 'week', 'day'])
    .default('project'),
});

/** A year. Beyond this the walk below stops being a request and becomes a job. */
const REPORT_MAX_DAYS = 366;

/** How many entries one report may read, at 200 per upstream page. */
const REPORT_MAX_PAGES = 25;

/** The group an entry falls in, and what to call it. */
function groupOf(
  entry: EpmTimeEntry,
  groupBy: TimeReportGrouping,
  userNames: Map<string, string>,
): { key: string; label: string } {
  switch (groupBy) {
    case 'user':
      return {
        key: entry.userId,
        // The directory is the only place a name lives; an entry logged by
        // someone since deleted keeps its id rather than going blank.
        label: userNames.get(entry.userId) ?? `Person ${entry.userId}`,
      };
    case 'project':
      return { key: entry.projectId, label: entry.projectName ?? `Project ${entry.projectId}` };
    case 'activity':
      // An instance may allow an entry with no activity, and those hours are
      // still hours — they group together rather than disappearing.
      return { key: entry.activityId ?? 'none', label: entry.activityName ?? 'No activity' };
    case 'workPackage':
      return entry.workPackageId
        ? {
            key: entry.workPackageId,
            label: entry.workPackageSubject ?? `#${entry.workPackageId}`,
          }
        : { key: 'none', label: 'Logged to the project' };
    case 'week': {
      const monday = startOfIsoWeek(entry.spentOn);
      return { key: monday, label: isoWeekLabel(entry.spentOn) };
    }
    case 'day':
      return { key: entry.spentOn, label: entry.spentOn };
  }
}

/**
 * The report's own error translation.
 *
 * One upstream rejection is worth intercepting by name. OpenProject answers a
 * `user` filter it does not accept with "Filters User filter has invalid
 * values", which reached the screen verbatim and told the reader nothing they
 * could act on — the person they picked looks perfectly real to them.
 *
 * The cause is always the same: that person belongs to no project, so there is
 * no time of theirs this caller could ever see. Said plainly, with the fix.
 */
function rethrowReport(hasUserFilter: boolean): (error: unknown) => never {
  return (error) => {
    if (
      hasUserFilter &&
      error instanceof OpenProjectError &&
      /user filter has invalid values/i.test(error.message)
    ) {
      throw EpmError.badRequest(
        'That person cannot be reported on: they are not a member of any project, so they have no time entries anybody can see. Add them to a project first.',
      );
    }

    return rethrow('Time entries')(error);
  };
}

/** Rows ordered by hours, except time buckets, which order by time. */
function sortRows(rows: TimeReportRow[], groupBy: TimeReportGrouping): TimeReportRow[] {
  return groupBy === 'week' || groupBy === 'day'
    ? rows.sort((a, b) => a.key.localeCompare(b.key))
    : rows.sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
}

/** Two decimals. Hours are quarter-hours upstream, but sums of them are not. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The people who can legitimately appear in a time report.
 *
 * OpenProject's `user` filter on time entries does not accept any user id: it
 * validates against principals the caller could actually see time for, which in
 * practice means members of a project. Handing it somebody from the directory
 * who belongs to no project is answered with "Filters User filter has invalid
 * values", a 400 that the report surfaced as an unexplained failure.
 *
 * So the picker is fed from memberships rather than from `/users`. That is the
 * same set OpenProject validates against, which is the only way the control can
 * offer a choice that is guaranteed to work — filtering the failure message into
 * something friendlier would have left the control still offering it.
 *
 * Groups and placeholders are dropped: neither logs time, so neither belongs in
 * a filter over logged time.
 */
async function reportablePeople(signal: AbortSignal): Promise<{ id: string; name: string }[]> {
  const memberships = await openProject
    .getAll<{ _links?: { principal?: { href?: string; title?: string } } }>(
      '/memberships',
      { pageSize: 200 },
      { signal },
    )
    .catch(() => ({ items: [] as { _links?: { principal?: { href?: string; title?: string } } }[] }));

  const byId = new Map<string, string>();
  for (const membership of memberships.items) {
    const principal = membership._links?.principal;
    const href = principal?.href ?? '';
    // Only `/users/:id`; `/groups/:id` and `/placeholder_users/:id` are skipped.
    const match = /\/users\/(\d+)$/.exec(href);
    if (match && principal?.title) byId.set(match[1]!, principal.title);
  }

  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const timeEntryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Logged time, filtered.
   *
   * With no filters this is the caller's own visible time across the instance,
   * which is what a personal timesheet wants. OpenProject scopes it to what
   * they may see regardless of what is asked for.
   */
  app.get('/time-entries', async (request) => {
    const query = listQuery.parse(request.query);
    const signal = requestSignal(request);

    const filters: OpFilter[] = [];
    const projectId = numeric(query.projectId, 'project');
    if (projectId) filters.push({ field: 'project', operator: '=', values: [projectId] });

    const workPackageId = numeric(query.workPackageId, 'work package');
    if (workPackageId) {
      filters.push({ field: 'work_package', operator: '=', values: [workPackageId] });
    }

    const userId = principal(query.userId, 'person');
    if (userId) filters.push({ field: 'user', operator: '=', values: [userId] });

    // An absent bound is how the client expresses "no end", as elsewhere.
    if (query.from || query.to) {
      filters.push({
        field: 'spent_on',
        operator: '<>d',
        values: [query.from ?? '', query.to ?? ''],
      });
    }

    const page = resolvePage(query.page, query.pageSize);

    const collection = await openProject
      .getCollection<OpTimeEntry>(
        '/time_entries',
        { filters, sortBy: [['spentOn', 'desc']], offset: page.page, pageSize: page.pageSize },
        signal,
      )
      .catch(rethrow('Time entries'));

    const items = (collection._embedded?.elements ?? []).map(toEpmTimeEntry);
    return paginated(items, collection.total ?? items.length, page);
  });

  /**
   * Logged time, aggregated over a range.
   *
   * This is the Time & Costs report. It exists because the list endpoint
   * cannot answer the question it asks: "how many hours went where" over a
   * quarter is thousands of rows, and paging them into the browser to sum them
   * there would be slow, wrong on every page but the last, and would put every
   * comment anyone ever wrote on the wire for a number.
   *
   * Scoped by OpenProject, not here. The walk uses the caller's token, so the
   * total is the total of what they may see — a project lead's report and an
   * administrator's differ, correctly, and neither needs EPM to work out why.
   *
   * Cost comes from EPM's own hourly rates, because OpenProject publishes none.
   * Hours belonging to someone with no rate are counted in `hoursWithoutRate`
   * and left out of the cost rather than priced at zero: a report that says
   * "1,200 hours, 800 of them uncosted" is useful, and one that quietly halves
   * the bill is not.
   */
  /**
   * Who may be filtered on in the Time & Costs report.
   *
   * A separate endpoint rather than reusing `/users`, because the two answer
   * different questions: `/users` is the directory, this is the subset the
   * time-entry filter will accept.
   */
  app.get('/time-entries/people', async (request) => reportablePeople(requestSignal(request)));

  app.get('/time-entries/report', async (request): Promise<TimeReport> => {
    const query = reportQuery.parse(request.query);
    const signal = requestSignal(request);

    if (query.to < query.from) throw EpmError.badRequest('The range ends before it starts.');
    const span = daysBetween(query.from, query.to);
    if (span > REPORT_MAX_DAYS) {
      throw EpmError.badRequest(`A report covers at most ${REPORT_MAX_DAYS} days.`);
    }

    const filters: OpFilter[] = [
      { field: 'spent_on', operator: '<>d', values: [query.from, query.to] },
    ];
    const projectId = numeric(query.projectId, 'project');
    if (projectId) filters.push({ field: 'project', operator: '=', values: [projectId] });
    const userId = principal(query.userId, 'person');
    if (userId) filters.push({ field: 'user', operator: '=', values: [userId] });

    /*
     * Three reads in parallel, none of which depends on the others: the entries
     * themselves, the rates that price them, and the directory that names the
     * people. Sequencing them would triple the latency of the slowest page in
     * the product for no reason.
     */
    const [collection, rates, users] = await Promise.all([
      openProject
        .getAll<OpTimeEntry>(
          '/time_entries',
          { filters, sortBy: [['spentOn', 'asc']] },
          { signal, maxPages: REPORT_MAX_PAGES },
        )
        .catch(rethrowReport(Boolean(userId))),
      // Only the costed people. Most instances will have few, and reading the
      // whole table to find them is the same query without the filter.
      prisma.userProfile
        .findMany({
          where: { hourlyRate: { not: null } },
          select: { openProjectId: true, hourlyRate: true },
        })
        .catch(() => []),
      // Names only matter when grouping by person, but the report also needs
      // them for nothing else, so this is skipped otherwise.
      query.groupBy === 'user' ? getUsers(signal).catch(() => []) : Promise.resolve([]),
    ]);

    const rateOf = new Map(rates.map((row) => [row.openProjectId, row.hourlyRate ?? 0]));
    const userNames = new Map(users.map((user) => [user.id, user.name]));

    const entries = collection.items.map(toEpmTimeEntry);

    const rows = new Map<string, TimeReportRow>();
    // Pre-seeded with every day in range so the chart has a flat line rather
    // than a gap where nobody logged anything.
    const byDay = new Map<string, number>();
    for (let day = query.from; day <= query.to; day = addDays(day, 1)) byDay.set(day, 0);

    let totalHours = 0;
    let totalCost = 0;
    let costedHours = 0;
    let hoursWithoutRate = 0;

    for (const entry of entries) {
      const { key, label } = groupOf(entry, query.groupBy, userNames);
      const rate = rateOf.get(entry.userId);
      const row = rows.get(key) ?? { key, label, hours: 0, hoursWithoutRate: 0, entries: 0 };

      row.hours += entry.hours;
      row.entries += 1;
      totalHours += entry.hours;

      if (rate === undefined) {
        row.hoursWithoutRate += entry.hours;
        hoursWithoutRate += entry.hours;
      } else {
        row.cost = (row.cost ?? 0) + entry.hours * rate;
        totalCost += entry.hours * rate;
        costedHours += entry.hours;
      }

      rows.set(key, row);
      // An entry can only fall outside the seeded range if upstream returned
      // one the filter should have excluded; counting it in the totals but not
      // in the chart is better than inventing a bucket for it.
      if (byDay.has(entry.spentOn)) byDay.set(entry.spentOn, byDay.get(entry.spentOn)! + entry.hours);
    }

    const rounded = sortRows(
      [...rows.values()].map((row) => ({
        ...row,
        hours: round(row.hours),
        hoursWithoutRate: round(row.hoursWithoutRate),
        ...(row.cost === undefined ? {} : { cost: round(row.cost) }),
      })),
      query.groupBy,
    );

    return {
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      totalHours: round(totalHours),
      // Absent rather than zero when nothing was costed: zero is a real cost,
      // and the two have to be tellable apart in the UI.
      ...(costedHours > 0 ? { totalCost: round(totalCost) } : {}),
      hoursWithoutRate: round(hoursWithoutRate),
      currency: env.EPM_CURRENCY,
      rows: rounded,
      byDay: [...byDay.entries()].map(([date, hours]) => ({ date, hours: round(hours) })),
      truncated: collection.truncated,
    };
  });

  app.get<{ Params: { id: string } }>('/time-entries/:id', async (request) => {
    return toEpmTimeEntry(await entryById(request, request.params.id));
  });

  /**
   * Logs time.
   *
   * A work package implies its project, so either is enough; naming neither
   * gives OpenProject nothing to authorise against and is refused here rather
   * than upstream, where it reads as a schema error.
   */
  app.post<{ Body: unknown }>('/time-entries', async (request, reply) => {
    const input = writeBody.parse(request.body ?? {});

    if (!input.projectId && !input.workPackageId) {
      throw EpmError.badRequest('Log time against a project or a work package.');
    }

    const created = await openProject
      .request<OpTimeEntry>('/time_entries', {
        method: 'POST',
        body: toUpstreamBody(input),
        signal: requestSignal(request),
      })
      .catch(rethrow('That project'));

    reply.code(201);
    return toEpmTimeEntry(created);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/time-entries/:id', async (request) => {
    const input = patchBody.parse(request.body ?? {});
    if (Object.keys(input).length === 0) throw EpmError.badRequest('Nothing to change.');

    // Read first so a caller who may not touch this entry is refused before
    // anything is written, and with OpenProject's own reason.
    const { id } = request.params;
    await entryById(request, id);

    const updated = await openProject
      .request<OpTimeEntry>(`/time_entries/${id}`, {
        method: 'PATCH',
        body: toUpstreamBody(input),
        signal: requestSignal(request),
      })
      .catch(rethrow('That time entry'));

    return toEpmTimeEntry(updated);
  });

  app.delete<{ Params: { id: string } }>('/time-entries/:id', async (request, reply) => {
    const { id } = request.params;
    if (!/^\d+$/.test(id)) throw EpmError.notFound('That time entry');

    await openProject
      .request<void>(`/time_entries/${id}`, { method: 'DELETE', signal: requestSignal(request) })
      .catch(rethrow('That time entry'));

    reply.code(204);
  });
};
