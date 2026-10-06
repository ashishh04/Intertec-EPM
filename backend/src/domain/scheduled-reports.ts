import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { loadPermissions } from '../auth/capabilities.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../email/outbox.js';
import { EpmError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import { linkId, linkTitle, openProject } from '../openproject/client.js';
import type { OpWorkPackage } from '../openproject/types.js';
import { recordAuditQuietly } from './audit.js';
import { buildDashboard, DASHBOARD_IDS, DASHBOARDS, type DashboardId, type DashboardTable } from './dashboards.js';
import { modelFacts } from './measure-facts.js';
import { contextFor, prepare, type Scope, type Viewer } from './measures.js';
import { documentOf, formatValue, renderPdf, renderXlsx, type ReportDocument } from './report-render.js';
import {
  describeTiming,
  isTimeZone,
  localDay,
  nextOccurrence,
  PERIOD_PRESETS,
  periodFor,
  type PeriodPreset,
  type ScheduleTiming,
} from './report-schedule.js';
import { isOverdue } from './work-definitions.js';

/**
 * Scheduled report distribution (BRQ-08: BR-207 to BR-210).
 *
 * A schedule binds a dashboard or a saved view to a frequency, a time in a
 * time zone and recipients. When an occurrence is due, one run renders a copy
 * per recipient — each with that recipient's own access, so a project they
 * cannot see is left out of theirs and the email says so (BR-209) — as a PDF
 * and an Excel workbook, and queues an email carrying them (BR-208). The
 * outbox retries a failed send and tells operations when retries run out.
 * Every run, every copy and every email's fate is logged, by schedule and by
 * date (BR-210).
 *
 * External addresses are sent to only once someone other than whoever set
 * them has approved them; their copy is rendered with the schedule owner's
 * access, since an outside address has none of its own.
 */

type Schedule = Prisma.ReportScheduleGetPayload<object>;

const FORMATS = ['pdf', 'xlsx'] as const;
type Format = (typeof FORMATS)[number];

const CONTENT_TYPES: Record<Format, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/* -------------------------------------------------------------------------- */
/* Definitions                                                                */
/* -------------------------------------------------------------------------- */

const EMAIL = z.string().trim().toLowerCase().email('That is not an email address.');

export const scheduleInput = z
  .object({
    name: z.string().trim().min(1, 'A schedule needs a name.').max(120),
    description: z.string().trim().max(1000).optional().nullable(),
    active: z.boolean().default(true),
    sourceKind: z.enum(['dashboard', 'view']),
    sourceId: z.string().trim().min(1, 'Choose what the report shows.'),
    scope: z
      .string()
      .regex(/^(instance|portfolio:[\w-]+|project:\d+|department:[\w-]+|team:[\w-]+|person:\d+)$/, 'That scope is not one EPM knows.')
      .default('instance'),
    periodPreset: z.enum(PERIOD_PRESETS).default('last-4-weeks'),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    weekday: z.number().int().min(1).max(7).optional().nullable(),
    dayOfMonth: z.number().int().min(0).max(28).optional().nullable(),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'The time is HH:MM, e.g. 07:00.'),
    timezone: z.string().refine(isTimeZone, 'That is not a time zone this server knows.').default('UTC'),
    windowMinutes: z.number().int().min(5).max(24 * 60).default(120),
    formats: z.array(z.enum(FORMATS)).min(1, 'Choose at least one format.').max(2),
    recipientUserIds: z.array(z.string().regex(/^\d+$/)).max(200).default([]),
    externalEmails: z.array(EMAIL).max(50).default([]),
  })
  .superRefine((input, context) => {
    if (input.sourceKind === 'dashboard' && !DASHBOARD_IDS.includes(input.sourceId as DashboardId)) {
      context.addIssue({ code: 'custom', path: ['sourceId'], message: 'That is not a dashboard.' });
    }
    if (input.sourceKind === 'view' && !/^\d+$/.test(input.sourceId)) {
      context.addIssue({ code: 'custom', path: ['sourceId'], message: 'That is not a saved view.' });
    }
    if (input.frequency === 'weekly' && !input.weekday) {
      context.addIssue({ code: 'custom', path: ['weekday'], message: 'A weekly report needs a day of the week.' });
    }
    if (input.frequency === 'monthly' && (input.dayOfMonth === undefined || input.dayOfMonth === null)) {
      context.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'A monthly report needs a day of the month.' });
    }
    if (input.recipientUserIds.length + input.externalEmails.length === 0) {
      context.addIssue({ code: 'custom', path: ['recipientUserIds'], message: 'A report needs at least one recipient.' });
    }
  });

export type ScheduleInput = z.infer<typeof scheduleInput>;

const timingOf = (schedule: Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth' | 'timeOfDay' | 'timezone'>): ScheduleTiming => ({
  frequency: schedule.frequency as ScheduleTiming['frequency'],
  weekday: schedule.weekday,
  dayOfMonth: schedule.dayOfMonth,
  timeOfDay: schedule.timeOfDay,
  timeZone: schedule.timezone,
});

async function sourceLabel(schedule: Pick<Schedule, 'sourceKind' | 'sourceId' | 'scope'>): Promise<string> {
  if (schedule.sourceKind === 'view') return `Saved view #${schedule.sourceId}`;
  const dashboard = DASHBOARDS.find((entry) => entry.id === schedule.sourceId)?.title ?? schedule.sourceId;
  return `${dashboard} — ${await scopeName(schedule.scope)}`;
}

async function scopeName(scope: string): Promise<string> {
  if (scope === 'instance') return 'All projects';
  const [kind, id] = scope.split(':') as [string, string];
  const facts = await modelFacts();
  const name =
    kind === 'portfolio'
      ? facts.portfolios.get(id)?.name
      : kind === 'project'
        ? facts.projects.get(Number(id))?.name
        : kind === 'department'
          ? facts.departments.get(id)?.name
          : kind === 'team'
            ? facts.teams.get(id)?.name
            : facts.people.get(Number(id))?.name;
  return name ?? `${kind} ${id}`;
}

export interface ScheduleView {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  sourceKind: 'dashboard' | 'view';
  sourceId: string;
  scope: string;
  periodPreset: PeriodPreset;
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number | null;
  dayOfMonth: number | null;
  timeOfDay: string;
  timezone: string;
  windowMinutes: number;
  formats: Format[];
  recipientUserIds: string[];
  externalEmails: string[];
  externalApproval: { required: boolean; approved: boolean; approvedBy?: string; approvedAt?: string; setBy?: string };
  ownerId: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  describedTiming: string;
  sourceLabel: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

async function toView(schedule: Schedule, lastRunStatus: string | null = null): Promise<ScheduleView> {
  return {
    id: schedule.id,
    name: schedule.name,
    description: schedule.description,
    active: schedule.active,
    sourceKind: schedule.sourceKind as ScheduleView['sourceKind'],
    sourceId: schedule.sourceId,
    scope: schedule.scope,
    periodPreset: schedule.periodPreset as PeriodPreset,
    frequency: schedule.frequency as ScheduleView['frequency'],
    weekday: schedule.weekday,
    dayOfMonth: schedule.dayOfMonth,
    timeOfDay: schedule.timeOfDay,
    timezone: schedule.timezone,
    windowMinutes: schedule.windowMinutes,
    formats: schedule.formats as Format[],
    recipientUserIds: schedule.recipientUserIds,
    externalEmails: schedule.externalEmails,
    externalApproval: {
      required: schedule.externalEmails.length > 0,
      approved: schedule.externalEmails.length > 0 && Boolean(schedule.externalApprovedAt),
      approvedBy: schedule.externalApprovedBy ?? undefined,
      approvedAt: schedule.externalApprovedAt?.toISOString(),
      setBy: schedule.externalSetBy ?? undefined,
    },
    ownerId: schedule.ownerId,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    lastRunStatus,
    describedTiming: describeTiming(timingOf(schedule)),
    sourceLabel: await sourceLabel(schedule),
    version: schedule.version,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

export async function listSchedules(): Promise<ScheduleView[]> {
  const schedules = await prisma.reportSchedule.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  const last = await prisma.reportRun.findMany({
    where: { scheduleId: { in: schedules.map((schedule) => schedule.id) } },
    orderBy: { startedAt: 'desc' },
    distinct: ['scheduleId'],
    select: { scheduleId: true, status: true },
  });
  const statusOf = new Map(last.map((run) => [run.scheduleId, run.status]));
  return Promise.all(schedules.map((schedule) => toView(schedule, statusOf.get(schedule.id) ?? null)));
}

export async function getSchedule(id: string): Promise<ScheduleView> {
  const schedule = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!schedule) throw EpmError.notFound('That scheduled report');
  return toView(schedule);
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

function journal(scheduleId: string, action: string, summary: string, actorId: string, extra: { reason?: string; before?: unknown; after?: unknown } = {}) {
  return recordAuditQuietly([
    { actorId, entityType: 'report_schedule', entityId: scheduleId, action, summary, ...extra },
  ]);
}

export async function createSchedule(raw: unknown, actorId: string): Promise<ScheduleView> {
  const input = scheduleInput.parse(raw);
  const now = new Date();
  const schedule = await prisma.reportSchedule.create({
    data: {
      ...input,
      description: input.description ?? null,
      weekday: input.frequency === 'weekly' ? input.weekday : null,
      dayOfMonth: input.frequency === 'monthly' ? input.dayOfMonth : null,
      externalSetBy: input.externalEmails.length > 0 ? actorId : null,
      ownerId: actorId,
      nextRunAt: input.active ? nextOccurrence(timingOf({ ...input, weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null }), now) : null,
    },
  });
  await journal(schedule.id, 'report.schedule.created', `Scheduled report "${schedule.name}" created`, actorId, { after: input });
  return toView(schedule);
}

export async function updateSchedule(id: string, raw: unknown, actorId: string): Promise<ScheduleView> {
  const existing = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That scheduled report');
  const input = scheduleInput.parse(raw);
  const externalChanged = !sameList(existing.externalEmails, input.externalEmails);
  const timing = timingOf({ ...input, weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null });

  const schedule = await prisma.reportSchedule.update({
    where: { id },
    data: {
      ...input,
      description: input.description ?? null,
      weekday: input.frequency === 'weekly' ? input.weekday : null,
      dayOfMonth: input.frequency === 'monthly' ? input.dayOfMonth : null,
      // A changed list of outside addresses needs approving again.
      ...(externalChanged
        ? { externalSetBy: input.externalEmails.length > 0 ? actorId : null, externalApprovedBy: null, externalApprovedAt: null }
        : {}),
      nextRunAt: input.active ? nextOccurrence(timing, new Date()) : null,
      version: { increment: 1 },
    },
  });
  await journal(id, 'report.schedule.updated', `Scheduled report "${schedule.name}" changed`, actorId, {
    before: { ...existing, nextRunAt: undefined, lastRunAt: undefined },
    after: input,
  });
  return toView(schedule);
}

/** A schedule that has run keeps its log: it is switched off rather than deleted. */
export async function deleteSchedule(id: string, actorId: string): Promise<'deleted' | 'deactivated'> {
  const existing = await prisma.reportSchedule.findUnique({ where: { id }, include: { _count: { select: { runs: true } } } });
  if (!existing) throw EpmError.notFound('That scheduled report');
  if (existing._count.runs > 0) {
    await prisma.reportSchedule.update({ where: { id }, data: { active: false, nextRunAt: null } });
    await journal(id, 'report.schedule.deactivated', `Scheduled report "${existing.name}" switched off (it has runs, so it is kept)`, actorId);
    return 'deactivated';
  }
  await prisma.reportSchedule.delete({ where: { id } });
  await journal(id, 'report.schedule.deleted', `Scheduled report "${existing.name}" deleted`, actorId);
  return 'deleted';
}

/** Approves the outside addresses — never by the person who set them (BR-209). */
export async function approveExternal(id: string, actorId: string): Promise<ScheduleView> {
  const existing = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!existing) throw EpmError.notFound('That scheduled report');
  if (existing.externalEmails.length === 0) throw EpmError.badRequest('This report has no external recipients to approve.');
  if (existing.externalSetBy === actorId) {
    throw EpmError.forbidden('External recipients must be approved by someone other than whoever added them.');
  }
  const schedule = await prisma.reportSchedule.update({
    where: { id },
    data: { externalApprovedBy: actorId, externalApprovedAt: new Date() },
  });
  await journal(id, 'report.schedule.external_approved', `External recipients of "${schedule.name}" approved`, actorId, {
    after: { externalEmails: schedule.externalEmails },
  });
  return toView(schedule);
}

/* -------------------------------------------------------------------------- */
/* Rendering one copy                                                         */
/* -------------------------------------------------------------------------- */

/** The projects in which a person may read work packages, asked of OpenProject with the service key. */
export async function viewerForUser(userId: string): Promise<Viewer> {
  const permissions = await runAsSystem(() => loadPermissions(userId));
  const visibleProjectIds = new Set<number>();
  for (const [projectId, set] of permissions.byProject) if (set['project:view']) visibleProjectIds.add(Number(projectId));
  return { visibleProjectIds };
}

function parseScope(raw: string): Scope {
  if (raw === 'instance') return { kind: 'instance' };
  const [kind, id] = raw.split(':') as [Scope['kind'], string];
  return { kind, id };
}

interface Copy {
  document: ReportDocument;
  title: string;
  projectIds: number[];
  excluded: number;
}

/** A dashboard as this recipient may see it, and how much of its scope they cannot. */
async function dashboardCopy(schedule: Schedule, viewer: Viewer, period: { from: string; to: string }, today: string): Promise<Copy | { withheld: string }> {
  const scope = parseScope(schedule.scope);
  const facts = await modelFacts();
  const everyone: Viewer = { visibleProjectIds: new Set(facts.projects.keys()) };
  const [whole, theirs] = await Promise.all([prepare(everyone), prepare(viewer)]);
  const all = contextFor(whole, scope, period, today).projects.map((project) => project.id);
  const mine = contextFor(theirs, scope, period, today).projects.map((project) => project.id);

  if (scope.kind === 'project' && mine.length === 0) {
    return { withheld: 'They cannot access the project this report is about.' };
  }
  const dashboard = await buildDashboard(schedule.sourceId as DashboardId, scope, period, viewer, today, theirs);
  return {
    document: documentOf(dashboard),
    title: `${dashboard.title} — ${dashboard.scope.name}`,
    projectIds: mine,
    excluded: all.filter((id) => !mine.includes(id)).length,
  };
}

/** A saved view's work packages, as this recipient may see them. */
async function viewCopy(schedule: Schedule, viewer: Viewer, period: { from: string; to: string }, today: string): Promise<Copy | { withheld: string }> {
  const rows: OpWorkPackage[] = [];
  let name = `Saved view #${schedule.sourceId}`;
  for (let offset = 1; offset <= 50; offset += 1) {
    const page = await runAsSystem(() =>
      openProject.request<{ name?: string; _embedded?: { results?: { total?: number; _embedded?: { elements?: OpWorkPackage[] } } } }>(
        `/queries/${schedule.sourceId}`,
        { query: { pageSize: 200, offset } },
      ),
    );
    name = page.name ?? name;
    const elements = page._embedded?.results?._embedded?.elements ?? [];
    rows.push(...elements);
    if (elements.length === 0 || rows.length >= (page._embedded?.results?.total ?? 0)) break;
  }

  const facts = await modelFacts();
  const visible = rows.filter((wp) => viewer.visibleProjectIds.has(Number(linkId(wp._links, 'project'))));
  const projectIds = [...new Set(visible.map((wp) => Number(linkId(wp._links, 'project'))))];
  const allProjects = new Set(rows.map((wp) => Number(linkId(wp._links, 'project'))));
  const statusClosed = (wp: OpWorkPackage) => facts.statuses.get(Number(linkId(wp._links, 'status')))?.isClosed ?? false;
  const overdue = visible.filter((wp) => isOverdue({ isClosed: statusClosed(wp), dueDate: wp.dueDate ?? wp.date ?? null }, today));

  const table: DashboardTable = {
    id: 'work',
    title: name,
    columns: [
      { key: 'name', label: 'Work package' },
      { key: 'project', label: 'Project' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'assignee', label: 'Assignee' },
      { key: 'due', label: 'Due' },
    ],
    rows: visible.map((wp) => ({
      key: `wp:${wp.id}`,
      link: { kind: 'work_package', id: String(wp.id) },
      cells: {
        name: `#${wp.id} ${wp.subject}`,
        project: linkTitle(wp._links, 'project') ?? '',
        type: linkTitle(wp._links, 'type') ?? '',
        status: linkTitle(wp._links, 'status') ?? '',
        assignee: linkTitle(wp._links, 'assignee') ?? null,
        due: wp.dueDate ?? wp.date ?? null,
      },
    })),
  };
  const measure = (id: string, label: string, value: number, definition: string) => ({
    id,
    label,
    unit: 'count' as const,
    definition,
    applicable: true,
    value,
  });
  return {
    document: {
      scopeName: name,
      period,
      asOf: new Date().toISOString(),
      tiles: ['view.count', 'view.overdue'],
      measures: {
        'view.count': measure('view.count', 'Work packages', visible.length, `The work packages the saved view "${name}" selects.`),
        'view.overdue': measure('view.overdue', 'Overdue', overdue.length, 'Of those, open and due before today.'),
      },
      tables: [table],
      series: [],
    },
    title: name,
    projectIds,
    excluded: [...allProjects].filter((id) => !viewer.visibleProjectIds.has(id)).length,
  };
}

/* -------------------------------------------------------------------------- */
/* A run                                                                      */
/* -------------------------------------------------------------------------- */

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';

interface Recipient {
  kind: 'user' | 'external';
  userId?: string;
  email?: string;
  name: string;
  firstName: string;
}

async function recipientsOf(schedule: Schedule): Promise<{ recipients: Recipient[]; inactive: Map<string, string> }> {
  const facts = await modelFacts();
  const inactive = new Map<string, string>();
  const recipients: Recipient[] = [];
  for (const userId of schedule.recipientUserIds) {
    const person = facts.users.get(Number(userId));
    const status = facts.people.get(Number(userId))?.status;
    if (person && status && status !== 'active') inactive.set(userId, `Their account is ${status}.`);
    const name = person?.name ?? `User ${userId}`;
    recipients.push({ kind: 'user', userId, name, firstName: name.split(' ')[0] ?? name });
  }
  for (const email of schedule.externalEmails) recipients.push({ kind: 'external', email, name: email, firstName: 'there' });
  return { recipients, inactive };
}

export interface RunOutcome {
  runId: string;
  status: string;
  deliveries: number;
  withheld: number;
}

/**
 * Runs a schedule: one copy per recipient, rendered with their access, each
 * queued as an email with its files. `scheduledFor` is the occurrence; a run
 * asked for by hand has none. Two servers noticing the same occurrence create
 * one run between them: the second insert is refused by the unique key.
 */
export async function runSchedule(
  scheduleId: string,
  options: { trigger: 'schedule' | 'manual'; scheduledFor?: Date; triggeredBy?: string; now?: Date },
): Promise<RunOutcome | null> {
  const schedule = await prisma.reportSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw EpmError.notFound('That scheduled report');
  const now = options.now ?? new Date();
  const anchor = options.scheduledFor ?? now;
  const today = localDay(schedule.timezone, anchor);
  const period = periodFor(schedule.periodPreset as PeriodPreset, today);

  let run;
  try {
    run = await prisma.reportRun.create({
      data: {
        scheduleId,
        scheduledFor: options.scheduledFor ?? null,
        trigger: options.trigger,
        triggeredBy: options.triggeredBy ?? null,
        status: 'running',
        definition: { ...schedule, nextRunAt: undefined, lastRunAt: undefined } as unknown as Prisma.InputJsonValue,
        periodFrom: period.from,
        periodTo: period.to,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }

  let deliveries = 0;
  let withheld = 0;
  try {
    const { recipients, inactive } = await recipientsOf(schedule);
    const externalApproved = Boolean(schedule.externalApprovedAt);
    const ownerViewer = await viewerForUser(schedule.ownerId);
    const periodLabel = `${dayLabel(period.from)} – ${dayLabel(period.to)}`;

    for (const recipient of recipients) {
      const base = {
        runId: run.id,
        recipientKind: recipient.kind,
        recipientUserId: recipient.userId ?? null,
        recipientEmail: recipient.email ?? null,
      };
      const withhold = async (reason: string) => {
        await prisma.reportDelivery.create({ data: { ...base, renderStatus: 'withheld', reason } });
        withheld += 1;
      };

      if (recipient.kind === 'external' && !externalApproved) {
        await withhold('External recipients have not been approved.');
        continue;
      }
      if (recipient.userId && inactive.has(recipient.userId)) {
        await withhold(inactive.get(recipient.userId)!);
        continue;
      }

      try {
        const viewer = recipient.kind === 'user' ? await viewerForUser(recipient.userId!) : ownerViewer;
        const copy =
          schedule.sourceKind === 'view'
            ? await viewCopy(schedule, viewer, period, today)
            : await dashboardCopy(schedule, viewer, period, today);
        if ('withheld' in copy) {
          await withhold(copy.withheld);
          continue;
        }

        const preparedFor =
          recipient.kind === 'user'
            ? `Prepared for ${recipient.name}, with their access`
            : `Prepared for ${recipient.email}, with the access of the report's owner`;
        const visibilityNote =
          copy.excluded > 0
            ? `${copy.excluded} ${copy.excluded === 1 ? 'project' : 'projects'} in this report's scope ${copy.excluded === 1 ? 'is' : 'are'} not included: ${recipient.kind === 'user' ? 'you do not have access to' : 'the report owner has no access to'} ${copy.excluded === 1 ? 'it' : 'them'}.`
            : undefined;
        const content = {
          title: copy.title,
          subtitle: `${schedule.name} · ${periodLabel}${copy.document.asOf ? ` · data as of ${copy.document.asOf.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
          preparedFor,
          visibilityNote,
          generatedAt: now,
          document: copy.document,
        };

        const delivery = await prisma.reportDelivery.create({
          data: {
            ...base,
            renderStatus: 'rendered',
            projectIds: copy.projectIds.map(String),
            excludedProjects: copy.excluded,
          },
        });
        const files = (schedule.formats as Format[]).map((format) => {
          const bytes = format === 'pdf' ? renderPdf(content) : renderXlsx(content);
          return { format, bytes, filename: `${slug(schedule.name)}-${period.to}.${format}` };
        });
        const artifacts = await Promise.all(
          files.map((file) =>
            prisma.reportArtifact.create({
              data: {
                deliveryId: delivery.id,
                format: file.format,
                filename: file.filename,
                contentType: CONTENT_TYPES[file.format],
                content: Buffer.from(file.bytes),
                size: file.bytes.length,
              },
              select: { id: true, filename: true },
            }),
          ),
        );

        const figures = copy.document.tiles
          .map((id) => copy.document.measures[id])
          .filter((measure): measure is NonNullable<typeof measure> => Boolean(measure))
          .slice(0, 8)
          .map((measure) => ({ label: measure.label, value: formatValue(measure.value, measure.unit) }));
        const url =
          recipient.kind === 'user' && schedule.sourceKind === 'dashboard'
            ? `${env.APP_BASE_URL.replace(/\/+$/, '')}/insights/${schedule.sourceId}?${schedule.scope !== 'instance' ? `scope=${encodeURIComponent(schedule.scope)}&` : ''}from=${period.from}&to=${period.to}`
            : undefined;

        const outcome = await enqueueEmail({
          recipientId: recipient.kind === 'user' ? recipient.userId! : `external:${recipient.email}`,
          ...(recipient.kind === 'external' ? { toEmail: recipient.email } : {}),
          template: 'scheduled-report',
          channel: 'immediate',
          dedupeKey: `report:${run.id}:${delivery.id}`,
          payload: {
            firstName: recipient.firstName,
            reportName: schedule.name,
            title: copy.title,
            periodLabel,
            figures,
            excludedProjects: copy.excluded,
            url,
            artifactIds: artifacts.map((artifact) => artifact.id),
            attachmentNames: artifacts.map((artifact) => artifact.filename),
          },
        });

        if (outcome === 'queued') {
          const row = await prisma.emailOutbox.findFirst({
            where: { dedupeKey: `report:${run.id}:${delivery.id}` },
            select: { id: true },
          });
          await prisma.reportDelivery.update({ where: { id: delivery.id }, data: { outboxId: row?.id ?? null } });
          deliveries += 1;
        } else {
          const reasons: Record<string, string> = {
            'no-address': 'They have no email address.',
            'opted-out': 'Email is turned off in their settings.',
            paused: 'Their notifications are paused.',
            away: 'They are out of office.',
            duplicate: 'Already sent.',
            error: 'The email could not be queued.',
          };
          await prisma.reportDelivery.update({
            where: { id: delivery.id },
            data: { renderStatus: 'withheld', reason: reasons[outcome] ?? outcome },
          });
          withheld += 1;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 300) : 'The copy could not be rendered.';
        await prisma.reportDelivery.create({ data: { ...base, renderStatus: 'failed', reason } });
        appLog.warn({ err: error, scheduleId, runId: run.id }, 'A scheduled report copy could not be rendered');
      }
    }

    await prisma.reportRun.update({ where: { id: run.id }, data: { status: 'rendered', finishedAt: new Date() } });
    await prisma.reportSchedule.update({ where: { id: scheduleId }, data: { lastRunAt: now } });
    return { runId: run.id, status: 'rendered', deliveries, withheld };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'The run did not complete.';
    await prisma.reportRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), error: message } });
    appLog.warn({ err: error, scheduleId, runId: run.id }, 'A scheduled report run failed');
    return { runId: run.id, status: 'failed', deliveries, withheld };
  }
}

/**
 * Every occurrence due by `now`: run if still within its window, recorded as
 * missed if not, and the schedule moved on to its next occurrence either way.
 */
export async function runDue(now = new Date()): Promise<{ ran: number; missed: number }> {
  const due = await prisma.reportSchedule.findMany({
    where: { active: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
  });
  let ran = 0;
  let missed = 0;

  for (const schedule of due) {
    let occurrence = schedule.nextRunAt!;
    // Bounded: a server down for months records at most this many misses.
    for (let step = 0; step < 60 && occurrence.getTime() <= now.getTime(); step += 1) {
      const late = now.getTime() - occurrence.getTime() > schedule.windowMinutes * 60_000;
      if (late) {
        await prisma.reportRun
          .create({
            data: {
              scheduleId: schedule.id,
              scheduledFor: occurrence,
              trigger: 'schedule',
              status: 'missed',
              definition: { ...schedule, nextRunAt: undefined, lastRunAt: undefined } as unknown as Prisma.InputJsonValue,
              finishedAt: now,
              error: `Not sent: the scheduler was not running within ${schedule.windowMinutes} minutes of the time it was due.`,
            },
          })
          .catch((error: unknown) => {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
          });
        missed += 1;
      } else {
        const outcome = await runSchedule(schedule.id, { trigger: 'schedule', scheduledFor: occurrence, now });
        if (outcome) ran += 1;
      }
      occurrence = nextOccurrence(timingOf(schedule), occurrence);
    }
    await prisma.reportSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: occurrence } });
  }
  return { ran, missed };
}

/* -------------------------------------------------------------------------- */
/* The log (BR-210)                                                           */
/* -------------------------------------------------------------------------- */

export interface DeliveryView {
  id: string;
  recipientKind: 'user' | 'external';
  recipientUserId?: string;
  recipientEmail?: string;
  renderStatus: 'rendered' | 'withheld' | 'failed';
  reason?: string;
  projectCount: number;
  excludedProjects: number;
  emailStatus: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'withheld' | 'none';
  attempts: number;
  lastError?: string;
  sentAt?: string;
  artifacts: { id: string; format: Format; filename: string; size: number }[];
}

export interface RunView {
  id: string;
  scheduleId: string;
  scheduleName: string;
  scheduledFor: string | null;
  trigger: 'schedule' | 'manual';
  triggeredBy?: string;
  status: 'running' | 'rendered' | 'missed' | 'failed';
  /** How delivery went, from each copy's email. */
  deliveryState: 'delivered' | 'partial' | 'pending' | 'failed' | 'none';
  periodFrom?: string;
  periodTo?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  recipients: number;
  delivered: number;
  failed: number;
  withheld: number;
  deliveries?: DeliveryView[];
}

type RunWithDeliveries = Prisma.ReportRunGetPayload<{
  include: { schedule: { select: { name: true } }; deliveries: { include: { artifacts: { select: { id: true; format: true; filename: true; size: true } } } } };
}>;

async function runViews(runs: RunWithDeliveries[], withDeliveries: boolean): Promise<RunView[]> {
  const outboxIds = runs.flatMap((run) => run.deliveries.map((delivery) => delivery.outboxId)).filter((id): id is string => Boolean(id));
  const outbox = new Map(
    (
      await prisma.emailOutbox.findMany({
        where: { id: { in: outboxIds } },
        select: { id: true, status: true, attempts: true, lastError: true, sentAt: true },
      })
    ).map((row) => [row.id, row]),
  );

  return runs.map((run) => {
    const deliveries: DeliveryView[] = run.deliveries.map((delivery) => {
      const email = delivery.outboxId ? outbox.get(delivery.outboxId) : undefined;
      return {
        id: delivery.id,
        recipientKind: delivery.recipientKind as DeliveryView['recipientKind'],
        recipientUserId: delivery.recipientUserId ?? undefined,
        recipientEmail: delivery.recipientEmail ?? undefined,
        renderStatus: delivery.renderStatus as DeliveryView['renderStatus'],
        reason: delivery.reason ?? undefined,
        projectCount: delivery.projectIds.length,
        excludedProjects: delivery.excludedProjects,
        emailStatus: delivery.renderStatus !== 'rendered' ? 'withheld' : email ? (email.status as DeliveryView['emailStatus']) : 'none',
        attempts: email?.attempts ?? 0,
        lastError: email?.lastError ?? undefined,
        sentAt: email?.sentAt?.toISOString(),
        artifacts: delivery.artifacts.map((artifact) => ({ ...artifact, format: artifact.format as Format })),
      };
    });
    const delivered = deliveries.filter((delivery) => delivery.emailStatus === 'sent').length;
    const failed = deliveries.filter((delivery) => delivery.emailStatus === 'failed' || delivery.renderStatus === 'failed').length;
    const withheld = deliveries.filter((delivery) => delivery.renderStatus === 'withheld').length;
    const pending = deliveries.filter((delivery) => ['queued', 'sending'].includes(delivery.emailStatus)).length;
    const deliveryState: RunView['deliveryState'] =
      deliveries.length === 0 || deliveries.length === withheld
        ? 'none'
        : pending > 0
          ? 'pending'
          : failed === 0 && delivered + withheld === deliveries.length
            ? withheld > 0
              ? 'partial'
              : 'delivered'
            : delivered === 0
              ? 'failed'
              : 'partial';
    return {
      id: run.id,
      scheduleId: run.scheduleId,
      scheduleName: run.schedule.name,
      scheduledFor: run.scheduledFor?.toISOString() ?? null,
      trigger: run.trigger as RunView['trigger'],
      triggeredBy: run.triggeredBy ?? undefined,
      status: run.status as RunView['status'],
      deliveryState,
      periodFrom: run.periodFrom ?? undefined,
      periodTo: run.periodTo ?? undefined,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      error: run.error ?? undefined,
      recipients: deliveries.length,
      delivered,
      failed,
      withheld,
      ...(withDeliveries ? { deliveries } : {}),
    };
  });
}

const RUN_INCLUDE = {
  schedule: { select: { name: true } },
  deliveries: {
    include: { artifacts: { select: { id: true, format: true, filename: true, size: true }, orderBy: { format: 'asc' as const } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

/** Runs by schedule and by date, newest first (BR-210). */
export async function listRuns(filter: {
  scheduleId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: RunView[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.ReportRunWhereInput = {
    ...(filter.scheduleId ? { scheduleId: filter.scheduleId } : {}),
    ...(filter.from || filter.to
      ? {
          startedAt: {
            ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00.000Z`) } : {}),
            ...(filter.to ? { lt: new Date(Date.parse(`${filter.to}T00:00:00.000Z`) + 86_400_000) } : {}),
          },
        }
      : {}),
  };
  const pageSize = Math.min(Math.max(filter.pageSize, 1), 100);
  const total = await prisma.reportRun.count({ where });
  const page = Math.min(Math.max(filter.page, 1), Math.max(1, Math.ceil(total / pageSize)));
  const runs = await prisma.reportRun.findMany({
    where,
    include: RUN_INCLUDE,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { items: await runViews(runs, false), total, page, pageSize };
}

export async function getRun(id: string): Promise<RunView> {
  const run = await prisma.reportRun.findUnique({ where: { id }, include: RUN_INCLUDE });
  if (!run) throw EpmError.notFound('That run');
  return (await runViews([run], true))[0]!;
}

export async function getArtifact(runId: string, artifactId: string) {
  const artifact = await prisma.reportArtifact.findFirst({
    where: { id: artifactId, delivery: { runId } },
    select: { filename: true, contentType: true, content: true },
  });
  if (!artifact) throw EpmError.notFound('That file');
  return artifact;
}

/** Drops runs past the records policy, and files past theirs. */
export async function purgeExpired(now = new Date()): Promise<{ runs: number; artifacts: number }> {
  const runs = await prisma.reportRun.deleteMany({
    where: { startedAt: { lt: new Date(now.getTime() - env.EPM_REPORT_RUN_RETENTION_DAYS * 86_400_000) } },
  });
  const artifacts = await prisma.reportArtifact.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - env.EPM_REPORT_ARTIFACT_RETENTION_DAYS * 86_400_000) } },
  });
  return { runs: runs.count, artifacts: artifacts.count };
}

/** What a schedule can be built from: the dashboards, and the saved views the caller can see. */
export async function sourceOptions(): Promise<{ dashboards: { id: string; title: string }[]; views: { id: string; name: string }[] }> {
  const views = await openProject
    .getAll<{ id: number; name: string }>('/queries', { pageSize: 100 })
    .then((result) => result.items.map((query) => ({ id: String(query.id), name: query.name })))
    .catch(() => [] as { id: string; name: string }[]);
  return { dashboards: DASHBOARDS.map(({ id, title }) => ({ id, title })), views };
}
