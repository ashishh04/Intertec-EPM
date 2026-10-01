import type { FastifyInstance, FastifyRequest } from 'fastify';

import { env } from '../config/env.js';
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
 */

export interface ToolContext {
  app: FastifyInstance;
  request: FastifyRequest;
  userId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Chip text for the UI, past tense: "Looked up overdue tasks". */
  label(args: Record<string, unknown>): string;
  execute(context: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

/** Ceiling on a tool result, in JSON characters, before it is truncated. */
const RESULT_CAP = 4_096;

/** Most rows any list tool returns. */
const ROW_CAP = 25;

/**
 * Failure the model can read: the message is what the API said, which is
 * already written for a person. Distinct from other errors so the service can
 * hand it to the model as a tool result instead of ending the conversation.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * GET through the API as the caller.
 *
 * `inject` is inherited from the root instance, so calling it on the plugin's
 * own `app` still routes through the root: every onRequest and preHandler
 * hook, the session lookup, the async credential context, all of it.
 */
async function callApi<T>(
  context: ToolContext,
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : '';

  const response = await context.app.inject({
    method: 'GET',
    url: `${env.API_PREFIX}${path}${suffix}`,
    headers: { cookie: context.request.headers.cookie ?? '' },
  });

  if (response.statusCode >= 400) {
    let message = `That request failed (${response.statusCode}).`;
    try {
      const body = response.json<{ message?: string }>();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON; the generic sentence stands.
    }
    throw new ToolError(message);
  }

  return response.json<T>();
}

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

function trimProject(project: EpmProject, users: Map<string, EpmUser>) {
  return {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    status: project.status,
    health: project.health.overall,
    progress: project.progress,
    owner: project.ownerId ? users.get(project.ownerId)?.name ?? null : null,
    startDate: project.startDate ?? null,
    dueDate: project.dueDate ?? null,
    taskCount: project.taskCount,
    completedTaskCount: project.completedTaskCount,
    openRiskCount: project.openRiskCount,
    budgetUsed: project.budgetUsed,
    budgetTotal: project.budgetTotal,
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
  };
}

const quote = (value: string) => `“${value}”`;

const listTasks: ToolDefinition = {
  name: 'list_tasks',
  description:
    'Find tasks (work packages). Filter by project, assignee, status, due-date bucket or a ' +
    'search term. Returns at most 25 rows with key, subject, project, status, assignee and due date.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Restrict to one project by id.' },
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
    if (search) return `Looked up tasks matching ${quote(search)}`;
    if (bucket && mine) return `Looked up my ${bucket} tasks`;
    if (bucket) return `Looked up ${bucket} tasks`;
    if (mine) return 'Looked up my tasks';
    return 'Looked up tasks';
  },
  async execute(context, args) {
    const assignee = str(args.assignee);
    const limit = limitOf(args.limit, ROW_CAP);

    const [page, projects, users] = await Promise.all([
      callApi<Paginated<EpmTask>>(context, '/tasks', {
        projectId: str(args.projectId),
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
    const name = str(args.name);
    if (name) return `Checked ${name} project health`;
    const id = str(args.projectId);
    return id ? `Checked project #${id} health` : 'Checked a project';
  },
  async execute(context, args) {
    const id = str(args.projectId);
    const name = str(args.name);
    const users = usersById(context);

    if (id) {
      const project = await callApi<EpmProject>(context, `/projects/${encodeURIComponent(id)}`);
      return { ...trimProject(project, await users), description: project.description ?? null };
    }

    if (!name) throw new ToolError('Give a project id or a name.');

    const candidates = await callApi<EpmProject[]>(context, '/projects', { search: name });
    const needle = name.toLowerCase();
    const project =
      candidates.find((candidate) => candidate.name.toLowerCase() === needle) ??
      candidates.find((candidate) => candidate.identifier.toLowerCase() === needle) ??
      candidates[0];

    if (!project) throw new ToolError(`No project matches ${quote(name)}.`);

    const others = candidates.filter((candidate) => candidate.id !== project.id);
    return {
      ...trimProject(project, await users),
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
    return status ? `Listed ${status.replace('_', ' ')} projects` : 'Listed projects';
  },
  async execute(context, args) {
    const [projects, users] = await Promise.all([
      callApi<EpmProject[]>(context, '/projects', {
        status: str(args.status),
        search: str(args.search),
      }),
      usersById(context),
    ]);
    return projects.map((project) => trimProject(project, users));
  },
};

const teamWorkload: ToolDefinition = {
  name: 'team_workload',
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
    return str(args.teamId) ? 'Checked the team workload' : 'Checked everyone’s workload';
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
    return name ? `Looked at sprint ${quote(name)}` : 'Looked at the current sprint';
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
      if (!sprint) throw new ToolError(`No sprint matches ${quote(name)}.`);
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
    return 'Read the dashboard metrics';
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
    return search ? `Looked up people matching ${quote(search)}` : 'Looked up people';
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
      projectId: { type: 'string', description: 'Only meetings for this project.' },
      participantId: {
        type: 'string',
        description: "A user id from list_people. For 'my meetings', pass the caller's own id.",
      },
      limit: { type: 'number', description: 'Up to 25. Default 10.' },
    },
    additionalProperties: false,
  },
  label(args) {
    const window = str(args.window) ?? 'upcoming';
    if (window === 'past') return 'Looked up past meetings';
    if (window === 'all') return 'Looked up meetings';
    return 'Looked up upcoming meetings';
  },
  async execute(context, args) {
    const limit = limitOf(args.limit, 10);
    const page = await callApi<Paginated<EpmMeeting>>(context, '/meetings', {
      window: str(args.window) ?? 'upcoming',
      state: str(args.state),
      projectId: str(args.projectId),
      participantId: str(args.participantId),
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
    return id ? `Opened meeting ${id}` : 'Opened a meeting';
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
      projectId: { type: 'string', description: 'Only announcements for this project.' },
      limit: { type: 'number', description: 'Up to 25. Default 10.' },
    },
    additionalProperties: false,
  },
  label() {
    return 'Looked up announcements';
  },
  async execute(context, args) {
    const limit = limitOf(args.limit, 10);
    const page = await callApi<Paginated<EpmNewsPost>>(context, '/news', {
      projectId: str(args.projectId),
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
        description: "Omit for the organisation wiki; pass a project id for that project's.",
      },
    },
    additionalProperties: false,
  },
  label(args) {
    const search = str(args.search);
    return search ? `Searched the wiki for ${quote(search)}` : 'Looked up the wiki';
  },
  async execute(context, args) {
    const projectId = str(args.projectId);
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
    'Hours logged over a date range, grouped, with what they cost. Use it for "how much time ' +
    'went on X", "what have we spent", timesheet and cost questions. Cost is partial by design: ' +
    'hours belonging to somebody with no hourly rate count as hours but are left out of the ' +
    'money, and the result says how many those were. Report that gap rather than hiding it.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start date, YYYY-MM-DD. Required.' },
      to: { type: 'string', description: 'End date, YYYY-MM-DD. Required.' },
      groupBy: {
        type: 'string',
        enum: ['project', 'user', 'activity', 'workPackage', 'week', 'day'],
        description: 'Default project.',
      },
      projectId: { type: 'string' },
      userId: { type: 'string', description: 'A user id from list_people.' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  label(args) {
    const from = str(args.from);
    const to = str(args.to);
    const by = str(args.groupBy) ?? 'project';
    return from && to ? `Summed logged time ${from} to ${to} by ${by}` : 'Summed logged time';
  },
  async execute(context, args) {
    const from = str(args.from);
    const to = str(args.to);
    if (!from || !to) throw new ToolError('A from and a to date are both required, as YYYY-MM-DD.');

    const report = await callApi<TimeReport>(context, '/time-entries/report', {
      from,
      to,
      groupBy: str(args.groupBy) ?? 'project',
      projectId: str(args.projectId),
      userId: str(args.userId),
    });

    return {
      from: report.from,
      to: report.to,
      groupedBy: report.groupBy,
      totalHours: report.totalHours,
      // Null rather than 0 when nothing in range was costed, matching the API:
      // zero is a real cost, and "nobody has a rate" is not zero.
      totalCost: report.totalCost ?? null,
      currency: report.currency,
      hoursWithoutRate: report.hoursWithoutRate,
      // The range held more entries than one report may read, so every figure
      // here is a floor. Carried through because a partial total presented as a
      // whole one is worse than no total at all.
      truncated: report.truncated,
      rows: report.rows.slice(0, ROW_CAP).map((row) => ({
        label: row.label,
        hours: row.hours,
        entries: row.entries,
        cost: row.cost ?? null,
        hoursWithoutRate: row.hoursWithoutRate,
      })),
    };
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
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

/** The tool list in the shape the Messages API expects. */
export function toolSchemas(): ChatTool[] {
  return TOOLS.map((tool) => ({
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
