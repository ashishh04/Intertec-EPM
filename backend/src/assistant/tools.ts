import type { FastifyInstance, FastifyRequest } from 'fastify';

import { env } from '../config/env.js';
import type { ChatTool } from './bedrock.js';
import type {
  DashboardMetrics,
  EpmProject,
  EpmSprint,
  EpmTask,
  EpmUser,
  Paginated,
  TeamMemberWorkload,
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

export const TOOLS: readonly ToolDefinition[] = [
  listTasks,
  getProject,
  listProjects,
  teamWorkload,
  getSprint,
  dashboardMetrics,
  listPeople,
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
