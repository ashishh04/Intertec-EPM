import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppRole } from '../auth/roles.js';
import { reportingCurrency } from '../domain/currency.js';
import { contextConventions, contextLanguage, dateOf, message, render, type Message } from '../lib/i18n.js';
import { DELIVERY_ROLES, MANAGEMENT_ROLES, PEOPLE_ROLES } from './tool-roles.js';
import { budgetExposure, deliveryForecast, recommendedActions, riskExposure } from './analysis-tools.js';
import { ToolError, callApi, projectIdFrom, projectNamed } from './tool-api.js';
import type { ChatTool } from './bedrock.js';
import type {
  DashboardMetrics,
  EpmMeeting,
  EpmNewsPost,
  EpmProject,
  EpmSprint,
  EpmTask,
  EpmUser,
  EpmWikiPage,
  Paginated,
  TeamMemberWorkload,
  TimeReport,
  WikiTreeNode,
} from '../types/epm.js';

/**
 * What the assistant may look at.
 *
 * Every tool is a GET against EPM's own API, dispatched in-process with the
 * caller's session cookie. That is the whole permission model: the assistant
 * sees exactly what the person asking would see on the page, because it is
 * the same handler, the same auth hook and the same upstream token. Nothing
 * here reads OpenProject or the database directly, and nothing writes.
 *
 * Results are trimmed to what a sentence needs and capped in size, since every
 * byte returned is a byte the model has to read back on the next round.
 *
 * Money never reaches the model with the finance switch off: a tool that can
 * carry it leaves it out of what it returns, whichever question it was asked
 * for. Turning off the finance tools alone was not enough: the forecasts and a
 * project's health both quote budget and spend. And every amount that does go
 * back carries its currency, or the model picks one (it wrote $ for AED).
 */

export { ToolError };

export interface ToolContext {
  app: FastifyInstance;
  request: FastifyRequest;
  userId: string;
  /** The asker's EPM role. Employee until their permissions are read. */
  role: AppRole;
  /** Whether the administrators let Pragnya give money. Off until the settings are read. */
  allowFinance: boolean;
  /** Whether they let it give other people's workload. Off until the settings are read. */
  allowPeople: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Chip text for the UI, past tense: "Looked up overdue tasks". A message, not
   * a string, so a stored chip can be written out again for whoever reads it.
   */
  label(args: Record<string, unknown>): Message;
  execute(context: ToolContext, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Whether this person is offered the tool at all: what they hold, and what
   * the administrators allow Pragnya. The API checks again on every call; this
   * keeps the model from even trying what would only be refused.
   */
  allowed?(access: ToolAccess): boolean;
  /**
   * The EPM roles this tool is for, matching the screens each role works in
   * (`tool-roles.ts`). Absent means every internal role. Checked before
   * `allowed`, offered and again when the tool runs.
   */
  roles?: readonly AppRole[];
}

export interface ToolAccess {
  /** A global permission, or one held on any project. */
  can(permission: string): boolean;
  allowFinance: boolean;
  allowPeople: boolean;
  /** The asker's EPM role. */
  role: AppRole;
}

/** Ceiling on a tool result, in JSON characters, before it is truncated. */
const RESULT_CAP = 4_096;

/** Most rows any list tool returns. */
const ROW_CAP = 25;

/** Users by id, for turning an assignee or owner id into a name. Never fails. */
async function usersById(context: ToolContext): Promise<Map<string, EpmUser>> {
  const users = await callApi<EpmUser[]>(context, '/users').catch(() => [] as EpmUser[]);
  return new Map(users.map((user) => [user.id, user]));
}

/** Projects by id, for a task's project name. Never fails. */
async function projectsById(context: ToolContext): Promise<Map<string, EpmProject>> {
  const projects = await callApi<EpmProject[]>(context, '/projects').catch(
    () => [] as EpmProject[],
  );
  return new Map(projects.map((project) => [project.id, project]));
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const strList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string');
    return items.length > 0 ? items : undefined;
  }
  const single = str(value);
  return single ? single.split(',').map((part) => part.trim()).filter(Boolean) : undefined;
};

const limitOf = (value: unknown, fallback: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), ROW_CAP);
};

function trimTask(
  task: EpmTask,
  projects: Map<string, EpmProject>,
  users: Map<string, EpmUser>,
) {
  return {
    id: task.id,
    key: task.key,
    subject: task.subject,
    projectId: task.projectId,
    project: projects.get(task.projectId)?.name ?? null,
    status: task.status.name,
    statusCategory: task.statusCategory,
    priority: task.priority,
    assignee: task.assigneeId ? users.get(task.assigneeId)?.name ?? null : null,
    dueDate: task.dueDate ?? null,
    storyPoints: task.storyPoints ?? null,
    progress: task.progress,
  };
}

/**
 * Whether a project's budget and spend may go back for this person: the finance
 * switch, and a role whose work is money. HR and employees are told their role
 * does not cover it, and that is only true of a figure the model does not have.
 */
const showsProjectMoney = (context: ToolContext) => context.allowFinance && MANAGEMENT_ROLES.includes(context.role);

function trimProject(project: EpmProject, users: Map<string, EpmUser>, money: boolean) {
  return {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    status: project.status,
    health: project.health.overall,
    // Why: the explanation and each criterion's figure and reason, so an answer
    // about health quotes the same evidence the project page shows. And
    // whether a person overrode it, with their reason — a pinned value is
    // never to be presented as a measured one. The budget criterion's reason
    // spells out the budget, the spend and the plan to date.
    healthExplanation: project.healthDetail.explanation,
    healthCriteria: project.healthDetail.criteria
      .filter((criterion) => money || criterion.criterion !== 'budget')
      .map((criterion) => ({
        criterion: criterion.criterion,
        level: criterion.level ?? 'not assessed',
        value: criterion.value,
        unit: criterion.unit,
        reason: criterion.reason,
      })),
    calculatedHealth: project.healthCalculated.overall,
    healthOverride: project.healthOverride
      ? {
          reason: project.healthOverride.reason,
          setBy: users.get(project.healthOverride.setBy)?.name ?? null,
          setAt: project.healthOverride.setAt,
        }
      : null,
    progress: project.progress,
    owner: project.ownerId ? users.get(project.ownerId)?.name ?? null : null,
    plannedStart: project.startDate ?? null,
    plannedFinish: project.dueDate ?? null,
    forecastFinish: project.forecastFinish ?? null,
    taskCount: project.taskCount,
    completedTaskCount: project.completedTaskCount,
    openRiskCount: project.openRiskCount,
    ...(money
      ? {
          // Actual cost to date: logged hours at each person's rate.
          spentToDate: project.budgetUsed,
          budgetTotal: project.budgetTotal,
          currency: reportingCurrency(),
        }
      : {}),
  };
}

function trimSprint(sprint: EpmSprint, projects: Map<string, EpmProject>) {
  return {
    id: sprint.id,
    name: sprint.name,
    goal: sprint.goal || null,
    state: sprint.state,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    committedPoints: sprint.committedPoints,
    completedPoints: sprint.completedPoints,
    projects: sprint.projectIds.map((id) => projects.get(id)?.name ?? `#${id}`),
    // A sprint opens in the workspace; there is no page of its own to link to.
    link: `/agile?sprint=${sprint.id}`,
  };
}

const listTasks: ToolDefinition = {
  name: 'list_tasks',
  description:
    'Find tasks (work packages). Filter by project, assignee, status, due-date bucket or a ' +
    'search term. Returns at most 25 rows with key, subject, project, status, assignee and due date.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Restrict to one project, by id or by name.' },
      assignee: {
        type: 'string',
        description: "A user id, or 'me' for the person asking.",
      },
      status: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'],
        },
        description: 'Status categories to include.',
      },
      bucket: {
        type: 'string',
        enum: ['overdue', 'today', 'upcoming', 'completed', 'open'],
        description: 'Due-date bucket. overdue/today/upcoming imply open tasks only.',
      },
      search: { type: 'string', description: 'Matches the subject or the task number.' },
      sortBy: { type: 'string', enum: ['dueDate', 'priority', 'updatedAt', 'subject', 'status'] },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    },
    additionalProperties: false,
  },
  label(args) {
    const bucket = str(args.bucket);
    const mine = args.assignee === 'me';
    const search = str(args.search);
    if (search) return message('Looked up tasks matching “{search}”', { search });
    if (bucket && mine) {
      return message('Looked up my {bucket, select, overdue {overdue tasks} today {tasks due today} upcoming {upcoming tasks} completed {completed tasks} other {open tasks}}', { bucket });
    }
    if (bucket) {
      return message('Looked up {bucket, select, overdue {overdue tasks} today {tasks due today} upcoming {upcoming tasks} completed {completed tasks} other {open tasks}}', { bucket });
    }
    if (mine) return message('Looked up my tasks');
    return message('Looked up tasks');
  },
  async execute(context, args) {
    const assignee = str(args.assignee);
    const limit = limitOf(args.limit, ROW_CAP);
    const projectId = await projectIdFrom(context, args.projectId);

    const [page, projects, users] = await Promise.all([
      callApi<Paginated<EpmTask>>(context, '/tasks', {
        projectId,
        assigneeId: assignee === 'me' ? context.userId : assignee,
        status: strList(args.status)?.join(','),
        bucket: str(args.bucket),
        search: str(args.search),
        sortBy: str(args.sortBy),
        sortDir: str(args.sortBy) === 'updatedAt' ? 'desc' : 'asc',
        page: '1',
        pageSize: String(limit),
      }),
      projectsById(context),
      usersById(context),
    ]);

    return {
      total: page.total,
      items: page.items.map((task) => trimTask(task, projects, users)),
    };
  },
};

/** The project a call means. A name given as the id is a name all the same. */
function projectReference(args: Record<string, unknown>): { id?: string; name?: string } {
  const given = str(args.projectId);
  const id = given && /^\d+$/.test(given) ? given : undefined;
  return { id, name: str(args.name) ?? (id ? undefined : given) };
}

const getProject: ToolDefinition = {
  name: 'get_project',
  description:
    'One project in detail: status, health, progress, owner, dates, budget and open risks. ' +
    'Give either the id or the name.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      name: { type: 'string', description: 'Project name or identifier; the best match is used.' },
    },
    additionalProperties: false,
  },
  label(args) {
    const { id, name } = projectReference(args);
    if (name) return message('Checked {name} project health', { name });
    return id ? message('Checked project #{id} health', { id }) : message('Checked a project');
  },
  async execute(context, args) {
    const { id, name } = projectReference(args);
    const users = usersById(context);
    const money = showsProjectMoney(context);

    if (id) {
      const project = await callApi<EpmProject>(context, `/projects/${encodeURIComponent(id)}`);
      return { ...trimProject(project, await users, money), description: project.description ?? null };
    }

    if (!name) throw new ToolError('Give a project id or a name.');

    const { project, others } = await projectNamed(context, name);
    return {
      ...trimProject(project, await users, money),
      description: project.description ?? null,
      ...(others.length > 0
        ? { alsoMatched: others.slice(0, 5).map((other) => other.name) }
        : {}),
    };
  },
};

const listProjects: ToolDefinition = {
  name: 'list_projects',
  description: 'Projects the person can see, with status, health and progress.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['on_track', 'at_risk', 'delayed', 'completed', 'paused'],
      },
      search: { type: 'string', description: 'Matches the name or identifier.' },
    },
    additionalProperties: false,
  },
  label(args) {
    const status = str(args.status);
    return status
      ? message('Listed {status, select, on_track {on track} at_risk {at risk} delayed {delayed} completed {completed} paused {paused} other {matching}} projects', { status })
      : message('Listed projects');
  },
  async execute(context, args) {
    const [projects, users] = await Promise.all([
      callApi<EpmProject[]>(context, '/projects', {
        status: str(args.status),
        search: str(args.search),
      }),
      usersById(context),
    ]);
    const money = showsProjectMoney(context);
    // The list stays compact: the per-criterion evidence belongs to the
    // single-project tool, and repeating it for every project would push
    // whole projects out of the result cap.
    return projects.map((project) => {
      const { healthCriteria: _criteria, healthExplanation: _explanation, ...summary } = trimProject(project, users, money);
      return summary;
    });
  },
};

const teamWorkload: ToolDefinition = {
  roles: PEOPLE_ROLES,
  name: 'team_workload',
  allowed: (access) => access.allowPeople,
  description:
    'Workload per person this week: allocation as a percentage of capacity, open tasks ' +
    'assigned, hours logged and capacity. Optionally scoped to one team.',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string' },
    },
    additionalProperties: false,
  },
  label(args) {
    return str(args.teamId) ? message('Checked the team workload') : message('Checked everyone’s workload');
  },
  async execute(context, args) {
    const teamId = str(args.teamId);

    const [rows, users, team] = await Promise.all([
      callApi<TeamMemberWorkload[]>(context, '/teams/workloads', { teamId }),
      usersById(context),
      teamId
        ? callApi<{ name?: string }>(context, `/teams/${encodeURIComponent(teamId)}`).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);

    return {
      team: team?.name ?? null,
      people: rows.map((row) => ({
        userId: row.userId,
        name: users.get(row.userId)?.name ?? null,
        allocationPct: row.allocation,
        assignedTasks: row.assignedTasks,
        hoursLogged: row.hoursLogged,
        hoursCapacity: row.hoursCapacity,
      })),
    };
  },
};

const getSprint: ToolDefinition = {
  roles: DELIVERY_ROLES,
  name: 'get_sprint',
  description:
    'A sprint: state, dates, committed and completed points, projects. Without a name ' +
    'the active sprint is returned, or the most recent one if none is active.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    additionalProperties: false,
  },
  label(args) {
    const name = str(args.name);
    return name ? message('Looked at sprint “{name}”', { name }) : message('Looked at the current sprint');
  },
  async execute(context, args) {
    const name = str(args.name);
    const [sprints, projects] = await Promise.all([
      callApi<EpmSprint[]>(context, '/sprints'),
      projectsById(context),
    ]);

    if (sprints.length === 0) throw new ToolError('There are no sprints.');

    let sprint: EpmSprint | undefined;
    if (name) {
      const needle = name.toLowerCase();
      sprint =
        sprints.find((candidate) => candidate.name.toLowerCase() === needle) ??
        sprints.find((candidate) => candidate.name.toLowerCase().includes(needle));
      if (!sprint) throw new ToolError(`No sprint matches “${name}”.`);
    } else {
      sprint =
        sprints.find((candidate) => candidate.state === 'active') ??
        [...sprints].sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
    }

    return {
      ...trimSprint(sprint as EpmSprint, projects),
      otherSprints: sprints
        .filter((candidate) => candidate.id !== (sprint as EpmSprint).id)
        .slice(0, 10)
        .map((candidate) => ({ name: candidate.name, state: candidate.state })),
    };
  },
};

const dashboardMetrics: ToolDefinition = {
  name: 'dashboard_metrics',
  description:
    "The person's dashboard counts: their open tasks, due this week, in progress, blocked, " +
    'overdue, active projects and projects at risk, with week-on-week trends.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  label() {
    return message('Read the dashboard metrics');
  },
  async execute(context) {
    const metrics = await callApi<DashboardMetrics>(context, '/dashboard/metrics');
    const trend = (key: keyof DashboardMetrics['trends']) => {
      const value = metrics.trends[key];
      return value.direction === 'flat'
        ? 'flat'
        : `${value.direction} ${value.changePct}% ${value.periodLabel}`;
    };
    return {
      myOpenTasks: metrics.myTasks,
      myTasksDueThisWeek: metrics.myTasksDueThisWeek,
      inProgress: metrics.inProgress,
      blocked: metrics.inProgressBlocked,
      overdue: metrics.overdue,
      overdueCritical: metrics.overdueCritical,
      activeProjects: metrics.activeProjects,
      projectsAtRisk: metrics.projectsAtRisk,
      trends: {
        myTasks: trend('myTasks'),
        inProgress: trend('inProgress'),
        overdue: trend('overdue'),
        activeProjects: trend('activeProjects'),
      },
    };
  },
};

const listPeople: ToolDefinition = {
  name: 'list_people',
  description:
    'People in EPM with their role and department. Use it to turn a name into a user id ' +
    'before filtering tasks by assignee.',
  parameters: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Matches name, role or department.' },
    },
    additionalProperties: false,
  },
  label(args) {
    const search = str(args.search);
    return search ? message('Looked up people matching “{search}”', { search }) : message('Looked up people');
  },
  async execute(context, args) {
    const users = await callApi<EpmUser[]>(context, '/users');
    const search = str(args.search)?.toLowerCase();
    const matching = search
      ? users.filter((user) =>
          [user.name, user.role, user.department].some((field) =>
            field.toLowerCase().includes(search),
          ),
        )
      : users;

    return matching.map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role || null,
      department: user.department || null,
    }));
  },
};

/* -------------------------------------------------------------------------- */
/* Collaboration and time                                                      */
/* -------------------------------------------------------------------------- */

/** An instant as a sentence can hold it: "Tue 6 Oct 2026, 15:00-16:30 UTC". */
function meetingWhen(meeting: EpmMeeting): string {
  const starts = new Date(meeting.startsAt);
  const ends = new Date(meeting.endsAt);
  if (Number.isNaN(starts.getTime())) return meeting.startsAt;

  const day = starts.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const clock = (value: Date) =>
    value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

  // UTC named explicitly. The model has no idea what zone the reader is in, and
  // a bare "15:00" for a meeting is the one number nobody can afford to misread.
  return Number.isNaN(ends.getTime())
    ? `${day}, ${clock(starts)} UTC`
    : `${day}, ${clock(starts)}-${clock(ends)} UTC`;
}

function trimMeeting(meeting: EpmMeeting) {
  return {
    id: meeting.id,
    title: meeting.title,
    when: meetingWhen(meeting),
    startsAt: meeting.startsAt,
    durationMinutes: meeting.durationMinutes,
    state: meeting.state,
    location: meeting.location || null,
    // Null, not "Organisation-wide": a string here would be read back as the
    // name of a project. Absence is the fact, and the model can word it.
    project: meeting.projectName ?? null,
    organiser: meeting.createdByName ?? null,
    invited: meeting.participants.length,
    // Only meaningful once a meeting has happened. Before that it is zero for
    // every meeting, which reads as "nobody came" rather than "not yet".
    attended: meeting.state === 'held' ? meeting.participants.filter((p) => p.attended).length : null,
    hasAgenda: Boolean(meeting.agenda),
    hasMinutes: Boolean(meeting.minutes),
  };
}

const listMeetings: ToolDefinition = {
  name: 'list_meetings',
  description:
    'Meetings in EPM: what is scheduled, what has already happened, who was invited and whether ' +
    'minutes exist. Use it for any question about meetings or what is coming up. Defaults to ' +
    'upcoming. Returns summaries only - call get_meeting for an agenda or minutes.',
  parameters: {
    type: 'object',
    properties: {
      window: {
        type: 'string',
        enum: ['upcoming', 'past', 'all'],
        description: 'Default upcoming. Past reads most recent first.',
      },
      state: { type: 'string', enum: ['planned', 'held', 'cancelled'] },
      projectId: { type: 'string', description: 'Only meetings for this project, by id or by name.' },
      participantId: {
        type: 'string',
        description: "A user id from list_people, or 'me' for the person asking.",
      },
      limit: { type: 'number', description: 'Up to 25. Default 10.' },
    },
    additionalProperties: false,
  },
  label(args) {
    const window = str(args.window) ?? 'upcoming';
    if (window === 'past') return message('Looked up past meetings');
    if (window === 'all') return message('Looked up meetings');
    return message('Looked up upcoming meetings');
  },
  async execute(context, args) {
    const limit = limitOf(args.limit, 10);
    const participant = str(args.participantId);
    const page = await callApi<Paginated<EpmMeeting>>(context, '/meetings', {
      window: str(args.window) ?? 'upcoming',
      state: str(args.state),
      projectId: await projectIdFrom(context, args.projectId),
      participantId: participant === 'me' ? context.userId : participant,
      pageSize: String(limit),
    });

    return {
      total: page.total,
      meetings: page.items.slice(0, limit).map(trimMeeting),
    };
  },
};

const getMeeting: ToolDefinition = {
  name: 'get_meeting',
  description:
    'One meeting in full: its agenda, its minutes once they are written, and who was invited ' +
    'against who actually attended. Needs an id from list_meetings.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Meeting id from list_meetings.' } },
    required: ['id'],
    additionalProperties: false,
  },
  label(args) {
    const id = str(args.id);
    return id ? message('Opened meeting {id}', { id }) : message('Opened a meeting');
  },
  async execute(context, args) {
    const id = str(args.id);
    if (!id) throw new ToolError('A meeting id is required.');

    const meeting = await callApi<EpmMeeting>(context, `/meetings/${encodeURIComponent(id)}`);
    return {
      ...trimMeeting(meeting),
      agenda: meeting.agenda || null,
      minutes: meeting.minutes || null,
      participants: meeting.participants.map((person) => ({
        // Absent for anyone the caller cannot read, and left absent rather than
        // filled with an id the model would read out as if it were a name.
        name: person.name ?? null,
        invited: person.invited,
        attended: person.attended,
      })),
    };
  },
};

const listNews: ToolDefinition = {
  name: 'list_news',
  description:
    'Announcements posted in EPM, newest first. Use it for "what is the latest news" or any ' +
    'question about announcements. Drafts are never returned.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Only announcements for this project, by id or by name.' },
      limit: { type: 'number', description: 'Up to 25. Default 10.' },
    },
    additionalProperties: false,
  },
  label() {
    return message('Looked up announcements');
  },
  async execute(context, args) {
    const limit = limitOf(args.limit, 10);
    const page = await callApi<Paginated<EpmNewsPost>>(context, '/news', {
      projectId: await projectIdFrom(context, args.projectId),
      pageSize: String(limit),
    });

    return {
      total: page.total,
      news: page.items.slice(0, limit).map((post) => ({
        id: post.id,
        title: post.title,
        summary: post.summary || null,
        project: post.projectName ?? null,
        author: post.authorName ?? null,
        publishedAt: post.publishedAt ?? null,
      })),
    };
  },
};

/** The wiki tree nests; searching it does not. */
function flattenWiki(nodes: WikiTreeNode[]): { slug: string; title: string }[] {
  const flat: { slug: string; title: string }[] = [];
  const walk = (list: WikiTreeNode[]) => {
    for (const node of list) {
      flat.push({ slug: node.slug, title: node.title });
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return flat;
}

/** How much of a page comes back: enough to answer from, not the whole thing. */
const WIKI_EXCERPT = 600;

/** Pages whose body is fetched per search. Each one is its own round trip. */
const WIKI_FETCH_CAP = 3;

const searchWiki: ToolDefinition = {
  name: 'search_wiki',
  description:
    'Searches wiki page titles and returns the start of each page that matches. Use it for ' +
    '"what does the wiki say about X", process questions and written-down decisions. Only ' +
    'titles are matched, not body text, so try a short topic word. Full page: /wiki/{slug}.',
  parameters: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Matched against page titles.' },
      projectId: {
        type: 'string',
        description: "Omit for the organisation wiki; pass a project, by id or by name, for that project's.",
      },
    },
    additionalProperties: false,
  },
  label(args) {
    const search = str(args.search);
    return search ? message('Searched the wiki for “{search}”', { search }) : message('Looked up the wiki');
  },
  async execute(context, args) {
    const projectId = await projectIdFrom(context, args.projectId);
    const tree = await callApi<WikiTreeNode[]>(context, '/wiki/tree', { projectId });
    const pages = flattenWiki(tree);

    const search = str(args.search)?.toLowerCase();
    const matching = search ? pages.filter((p) => p.title.toLowerCase().includes(search)) : pages;

    // Nothing matched: the titles that do exist are more use than an empty
    // answer, because the model can suggest the nearest one.
    if (matching.length === 0) {
      return { matches: 0, pages: [], availableTitles: pages.slice(0, ROW_CAP).map((p) => p.title) };
    }

    // Bodies for the first few only. The tree already carries every title, so a
    // broad match still answers "which pages exist" without fetching them all.
    const fetched = await Promise.all(
      matching.slice(0, WIKI_FETCH_CAP).map(async (page) => {
        const full = await callApi<EpmWikiPage>(context, '/wiki/page', {
          slug: page.slug,
          projectId,
        }).catch(() => undefined);
        const body = full?.body ?? '';
        return {
          slug: page.slug,
          title: page.title,
          excerpt: body.length > WIKI_EXCERPT ? `${body.slice(0, WIKI_EXCERPT)}...` : body || null,
          updatedBy: full?.updatedByName ?? null,
        };
      }),
    );

    return {
      matches: matching.length,
      pages: fetched,
      otherTitles: matching.slice(WIKI_FETCH_CAP, ROW_CAP).map((p) => p.title),
    };
  },
};

const timeSummary: ToolDefinition = {
  name: 'time_summary',
  description:
    'Hours logged over a date range, grouped, with what they cost. Use it for "how many hours have ' +
    'I logged" (pass userId \'me\'), "how much time went on X", "what have we spent" and cost ' +
    'questions. Cost is partial by design: ' +
    'hours belonging to somebody with no hourly rate count as hours but are left out of the ' +
    'money, and the result says how many those were. Report that gap rather than hiding it. ' +
    'When costHidden is true the person asking may not see hourly rates or costs: give hours ' +
    'only and say that costs are not shown to them — never estimate a cost. For an employee it ' +
    'covers only their own hours, whatever is asked.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start date, YYYY-MM-DD. Required.' },
      to: { type: 'string', description: 'End date, YYYY-MM-DD. Required.' },
      groupBy: {
        type: 'string',
        enum: ['project', 'user', 'activity', 'workPackage', 'week', 'day'],
        description: 'Default project. Leave it out unless they ask for the hours broken down some other way.',
      },
      projectId: { type: 'string', description: 'One project, by id or by name.' },
      userId: { type: 'string', description: "A user id from list_people, or 'me' for the person asking." },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  label(args) {
    const from = str(args.from);
    const to = str(args.to);
    const by = str(args.groupBy) ?? 'project';
    return from && to
      ? message('Summed logged time {from} to {to} by {by, select, user {person} activity {activity} workPackage {task} week {week} day {day} other {project}}', { from: dateOf(from), to: dateOf(to), by })
      : message('Summed logged time');
  },
  async execute(context, args) {
    const from = str(args.from);
    const to = str(args.to);
    if (!from || !to) throw new ToolError('A from and a to date are both required, as YYYY-MM-DD.');

    const groupBy = str(args.groupBy) ?? 'project';
    const asked = str(args.userId);
    // An employee's reach is their own time (My Time); the organisation's
    // hours are a reporting screen for managers and HR.
    const userId = context.role === 'employee' || asked === 'me' ? context.userId : asked;
    // Hours per person are workload by another name, so the workload switch
    // covers them. A project's total stays: that is about the project.
    if (!context.allowPeople && (userId ? userId !== context.userId : groupBy === 'user')) {
      throw new ToolError('Hours per person are not available: this organisation has switched off answers about people’s workload.');
    }

    const report = await callApi<TimeReport>(context, '/time-entries/report', {
      from,
      to,
      groupBy,
      projectId: await projectIdFrom(context, args.projectId),
      userId,
    });

    // Without leave to read rates the report carries no money at all (BRL-01);
    // the finance switch takes out the same figures, and the model is told.
    const costHidden = !context.allowFinance || (report.costHidden ?? false);
    return {
      from: report.from,
      to: report.to,
      groupedBy: report.groupBy,
      totalHours: report.totalHours,
      costHidden,
      ...(costHidden
        ? {}
        : {
            // Null rather than 0 when nothing in range was costed, matching the
            // API: zero is a real cost, and "nobody has a rate" is not zero.
            totalCost: report.totalCost ?? null,
            currency: report.currency,
            hoursWithoutRate: report.hoursWithoutRate ?? null,
          }),
      // The range held more entries than one report may read, so every figure
      // here is a floor. Carried through because a partial total presented as a
      // whole one is worse than no total at all.
      truncated: report.truncated,
      rows: report.rows.slice(0, ROW_CAP).map((row) => ({
        label: row.label,
        hours: row.hours,
        entries: row.entries,
        ...(costHidden ? {} : { cost: row.cost ?? null, hoursWithoutRate: row.hoursWithoutRate ?? null }),
      })),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* The newer modules: timesheets, claims, approvals, finance, resources,      */
/* scenarios. Each a GET through the API as the person asking.                */
/* -------------------------------------------------------------------------- */

const myTimesheet: ToolDefinition = {
  name: 'my_timesheet',
  description:
    'The timesheet of the person asking for the period containing a day (default today): its status ' +
    '(draft, submitted, approved), hours logged against the bounds, anything stopping it being submitted, ' +
    'and a rejection reason. Use it for "show my timesheet", "is my timesheet in" or "why can I not ' +
    'submit". For how many hours have been logged, use time_summary.',
  parameters: { type: 'object', properties: { day: { type: 'string', description: 'YYYY-MM-DD; default today.' } }, additionalProperties: false },
  label: () => message('Looked up your timesheet'),
  async execute(context, args) {
    const sheet = await callApi<Record<string, unknown>>(context, '/timesheets/mine', { day: str(args.day) });
    return { period: sheet.period, status: sheet.status, hours: sheet.hours, bounds: sheet.bounds, problems: sheet.problems, rejection: sheet.rejection, locked: sheet.locked, link: '/timesheets' };
  },
};

const teamTimesheets: ToolDefinition = {
  roles: PEOPLE_ROLES,
  name: 'team_timesheets',
  description:
    'Timesheets of a period for the people the asker manages (or everyone, for whoever manages timesheets): ' +
    'who has submitted, who is approved, who is outstanding. Use for "who has not submitted". Report the list ' +
    'as facts, never as a judgement of anyone.',
  parameters: {
    type: 'object',
    properties: {
      day: { type: 'string', description: 'A day in the period, YYYY-MM-DD.' },
      status: { type: 'string', enum: ['outstanding', 'submitted', 'approved', 'rejected'] },
    },
    additionalProperties: false,
  },
  label: () => message('Looked up timesheets'),
  allowed: (access) => access.allowPeople,
  async execute(context, args) {
    const overview = await callApi<{ rows?: Record<string, unknown>[]; counts?: unknown; period?: unknown }>(context, '/timesheets/overview', {
      day: str(args.day),
      status: str(args.status),
    });
    return {
      period: overview.period,
      counts: overview.counts,
      rows: (overview.rows ?? []).slice(0, ROW_CAP).map((row) => ({ person: row.personName ?? row.name, status: row.status, hours: row.hours })),
    };
  },
};

const expenseClaims: ToolDefinition = {
  name: 'expense_claims',
  description:
    'Expense claims: the asker\u2019s own (scope mine, the default), or everyone\u2019s for whoever manages claims ' +
    '(scope all), with amount, currency, status and project. Use for "what claims do I have pending".',
  parameters: {
    type: 'object',
    properties: { scope: { type: 'string', enum: ['mine', 'all'] }, status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'posted'] } },
    additionalProperties: false,
  },
  label: (args) => (str(args.scope) === 'all' ? message('Looked up expense claims') : message('Looked up your expense claims')),
  async execute(context, args) {
    const claims = await callApi<Record<string, unknown>[]>(context, '/expenses', { scope: str(args.scope) ?? 'mine', status: str(args.status) });
    return claims.slice(0, ROW_CAP).map((claim) => ({
      id: claim.id,
      description: claim.description,
      ...(context.allowFinance ? { amount: claim.amount, currency: claim.currency } : {}),
      status: claim.status,
      project: claim.projectName,
      spentOn: claim.spentOn,
      link: `/expenses/${claim.id}`,
    }));
  },
};

const approvalsWaiting: ToolDefinition = {
  name: 'approvals_waiting',
  description: 'Approval requests waiting for the person asking to decide: what, on which project, at which step. Use for "what do I need to approve".',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  label: () => message('Looked up approvals waiting for you'),
  async execute(context) {
    const requests = await callApi<Record<string, unknown>[]>(context, '/approvals/inbox');
    return requests
      .slice(0, ROW_CAP)
      .map((request) => ({ title: request.title, project: request.projectName, subject: request.subjectType, requestedAt: request.requestedAt, link: request.link ?? '/approvals' }));
  },
};

const financeFigures: ToolDefinition = {
  roles: MANAGEMENT_ROLES,
  name: 'finance_figures',
  description:
    'Finance for one project, a portfolio, or every project the asker can see: kind cash_flow (planned ' +
    'against actual spend by month), margin (estimated against actual), or forecast (labour revenue by ' +
    'month, weighted). In the reporting currency. Use only for finance questions.',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['cash_flow', 'margin', 'forecast'] }, projectId: { type: 'string', description: 'One project, by id or by name.' }, portfolioId: { type: 'string' } },
    required: ['kind'],
    additionalProperties: false,
  },
  label: (args) => message('Looked up {kind, select, cash_flow {cash flow} margin {margin} forecast {the revenue forecast} other {finance}}', { kind: str(args.kind) ?? 'finance' }),
  allowed: (access) => access.allowFinance && access.can('finance:view'),
  async execute(context, args) {
    const kind = str(args.kind);
    const path = kind === 'margin' ? '/finance/margin' : kind === 'forecast' ? '/finance/forecast' : '/finance/cash-flow';
    const data = await callApi<Record<string, unknown>>(context, path, { projectId: await projectIdFrom(context, args.projectId), portfolioId: str(args.portfolioId) });
    if (kind === 'cash_flow') {
      const combined = data.combined as { points?: unknown[]; totals?: unknown } | undefined;
      return { currency: data.currency, totals: combined?.totals, months: (combined?.points ?? []).slice(-12), reconciliation: data.reconciliation, link: '/finance' };
    }
    if (kind === 'margin') {
      return {
        currency: data.currency,
        combined: data.combined,
        projects: ((data.projects as Record<string, unknown>[]) ?? []).slice(0, ROW_CAP).map((row) => ({ name: row.name, margin: row.margin, billing: row.billingModel })),
        link: '/finance',
      };
    }
    return { currency: data.currency, total: data.total, months: data.combined, link: '/finance' };
  },
};

const earnedValue: ToolDefinition = {
  roles: MANAGEMENT_ROLES,
  name: 'earned_value',
  description:
    'Earned value for one project, a portfolio or the instance: planned value, earned value, actual cost, SPI, CPI, EAC. ' +
    'Use for "are we on budget or on schedule" in earned value terms.',
  parameters: { type: 'object', properties: { projectId: { type: 'string', description: 'One project, by id or by name.' }, portfolioId: { type: 'string' } }, additionalProperties: false },
  label: () => message('Looked up earned value'),
  allowed: (access) => access.allowFinance,
  async execute(context, args) {
    const projectId = await projectIdFrom(context, args.projectId);
    const scope = projectId ? `project:${projectId}` : str(args.portfolioId) ? `portfolio:${str(args.portfolioId)}` : 'instance';
    const data = await callApi<Record<string, unknown>>(context, '/earned-value', { scope });
    return { scope, currency: reportingCurrency(), totals: data.totals, link: '/insights/earned-value' };
  },
};

const resourceOverload: ToolDefinition = {
  roles: MANAGEMENT_ROLES,
  name: 'resource_overload',
  description:
    'Who is over-allocated in the coming weeks, and by how much: committed hours against available ' +
    'hours per person per week. For resource planners. Report figures neutrally, never as a judgement.',
  parameters: { type: 'object', properties: { weeks: { type: 'number', description: 'Weeks ahead, default 8.' } }, additionalProperties: false },
  label: () => message('Looked up over-allocation'),
  allowed: (access) => access.allowPeople && access.can('resources:plan'),
  async execute(context, args) {
    const rows = await callApi<Record<string, unknown>[]>(context, '/resources/over-allocations', { weeks: String(limitOf(args.weeks, 8)) });
    return rows.slice(0, ROW_CAP).map((row) => ({ person: row.name, week: row.week, available: row.available, committed: row.committed, excess: row.excess }));
  },
};

const scenarios: ToolDefinition = {
  roles: MANAGEMENT_ROLES,
  name: 'scenarios',
  description: 'Portfolio scenarios: their names, status (draft, awaiting approval, applied, rejected) and when they were made. For whoever plans scenarios.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  label: () => message('Looked up scenarios'),
  allowed: (access) => access.can('scenarios:manage'),
  async execute(context) {
    const rows = await callApi<Record<string, unknown>[]>(context, '/scenarios');
    return rows.slice(0, ROW_CAP).map((row) => ({ name: row.name, status: row.status, made: row.capturedAt, projects: row.projects, link: `/scenarios/${row.id}` }));
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  listTasks,
  getProject,
  listProjects,
  teamWorkload,
  getSprint,
  dashboardMetrics,
  listPeople,
  listMeetings,
  getMeeting,
  listNews,
  searchWiki,
  timeSummary,
  myTimesheet,
  teamTimesheets,
  expenseClaims,
  approvalsWaiting,
  financeFigures,
  earnedValue,
  resourceOverload,
  scenarios,
  // The analyses (BR-501, BR-502), in a file of their own.
  riskExposure,
  budgetExposure,
  deliveryForecast,
  recommendedActions,
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

/** The name a guardrail's refusal goes by among the chips: not a tool, nothing ran. */
export const GUARDRAIL = 'guardrail';

/**
 * A chip's words for the person reading, from the call it records.
 *
 * Written out on every read rather than kept: a stored chip's name and arguments
 * say all there is to say, so one from an earlier conversation follows the
 * reader's language as a new one does, however it was stored at the time.
 */
export function chipLabel(name: string, args: Record<string, unknown> = {}): string {
  const tool = findTool(name);
  const label =
    name === GUARDRAIL ? message('Declined by your organisation’s settings') : tool ? tool.label(args) : message('Tried {name}', { name });
  return render(contextLanguage(), label, contextConventions());
}

/** Whether this person may use a tool: their role first, then what they hold and the policy. */
export function toolAllowed(tool: ToolDefinition, access: ToolAccess): boolean {
  // Not one tool for a client or vendor. Pragnya is refused to them before any
  // of this runs (service.ts); this holds even if that check ever did not.
  if (access.role === 'external') return false;
  if (tool.roles && !tool.roles.includes(access.role)) return false;
  return !tool.allowed || tool.allowed(access);
}

/** The tools this person is offered, in the shape the Messages API expects. */
export function toolSchemas(access?: ToolAccess): ChatTool[] {
  return TOOLS.filter((tool) => !access || toolAllowed(tool, access)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as ChatTool['input_schema'],
  }));
}

/**
 * Serialises a result under the size cap.
 *
 * Arrays lose rows from the end and say how many went; anything else is cut
 * mid-string, which is worse but only happens for a single object that has
 * outgrown a page of JSON.
 */
export function capResult(value: unknown): string {
  const full = JSON.stringify(value);
  if (full.length <= RESULT_CAP) return full;

  const rows: unknown[] | undefined = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : undefined;

  if (rows) {
    let keep = rows.length;
    while (keep > 0) {
      keep -= 1;
      const truncated = `…(${rows.length - keep} more)`;
      const candidate = Array.isArray(value)
        ? JSON.stringify([...rows.slice(0, keep), truncated])
        : JSON.stringify({ ...(value as object), items: rows.slice(0, keep), truncated });
      if (candidate.length <= RESULT_CAP) return candidate;
    }
  }

  return `${full.slice(0, RESULT_CAP - 1)}…`;
}
