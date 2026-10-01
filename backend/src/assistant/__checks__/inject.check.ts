import assert from 'node:assert/strict';

import { buildApp } from '../../app.js';
import { env } from '../../config/env.js';
import { ToolError, capResult, findTool, type ToolContext } from '../tools.js';

/**
 * Proves that `inject` called on an encapsulated child instance dispatches
 * through the root: the auth hooks run, the session resolves, and a request
 * without the cookie is refused. This is what the tools rely on.
 *
 * Needs the local stack (OpenProject + Postgres) and the dev admin account.
 * Run with `env -u PORT npx tsx --env-file-if-exists=.env src/assistant/__checks__/inject.check.ts`.
 */

const app = await buildApp();

// A plugin nested two levels down, the way assistantRoutes sits under
// registerRoutes under the root.
await app.register(
  async (outer) => {
    await outer.register(async (inner) => {
      inner.get<{ Querystring: { cookie?: string } }>('/__inject-check', async (request) => {
        const withCookie = await inner.inject({
          method: 'GET',
          url: `${env.API_PREFIX}/me`,
          headers: { cookie: request.headers.cookie ?? '' },
        });
        const withoutCookie = await inner.inject({
          method: 'GET',
          url: `${env.API_PREFIX}/me`,
        });
        // Every tool, as this caller, against the live API. A ToolError is a
        // legitimate answer (no sprints, say); a thrown anything-else is not.
        const context: ToolContext = { app: inner, request, userId: request.auth?.userId ?? '' };
        const runs: Array<Record<string, unknown>> = [];
        let firstProject: string | undefined;
        let firstMeeting: string | undefined;

        const samples: Array<[string, Record<string, unknown>]> = [
          ['list_tasks', { bucket: 'overdue', assignee: 'me', limit: 5 }],
          ['list_tasks', { search: 'a', status: ['todo', 'in_progress'], sortBy: 'dueDate', limit: 3 }],
          ['list_projects', {}],
          ['get_project', {}], // placeholder, filled with a real name below
          ['team_workload', {}],
          ['get_sprint', {}],
          ['dashboard_metrics', {}],
          ['list_people', { search: 'admin' }],
          ['list_meetings', { window: 'all', limit: 5 }],
          ['get_meeting', {}], // placeholder, filled with a real id below
          ['list_news', { limit: 5 }],
          ['search_wiki', {}],
          ['time_summary', { from: '2026-09-01', to: '2026-09-30', groupBy: 'project' }],
        ];

        for (const [name, sampleArgs] of samples) {
          const tool = findTool(name);
          assert.ok(tool, `tool ${name} exists`);
          // Two tools need an id the run before them discovered. Without it they
          // are a placeholder, and a ToolError for a missing id would pass while
          // proving nothing.
          const args =
            name === 'get_project' && firstProject
              ? { name: firstProject }
              : name === 'get_meeting' && firstMeeting
                ? { id: firstMeeting }
                : sampleArgs;
          try {
            const value = await tool.execute(context, args);
            const json = capResult(value);
            if (name === 'list_projects' && Array.isArray(value) && value.length > 0) {
              firstProject = (value[0] as { name: string }).name;
            }
            if (name === 'list_meetings') {
              const meetings = (value as { meetings?: { id: string }[] }).meetings;
              if (meetings?.length) firstMeeting = meetings[0]!.id;
            }
            runs.push({
              tool: name,
              label: tool.label(args),
              ok: true,
              bytes: json.length,
              sample: JSON.stringify(value).slice(0, 160),
            });
          } catch (error) {
            runs.push({
              tool: name,
              label: tool.label(args),
              ok: false,
              kind: error instanceof ToolError ? 'ToolError' : (error as Error).name,
              message: (error as Error).message,
            });
          }
        }

        return {
          withCookie: { status: withCookie.statusCode, name: withCookie.json<{ name?: string }>().name },
          withoutCookie: { status: withoutCookie.statusCode },
          runs,
        };
      });
    });
  },
  { prefix: '/__check' },
);

await app.ready();

try {
  const login = await app.inject({
    method: 'POST',
    url: `${env.API_PREFIX}/auth/login`,
    payload: {
      username: 'admin',
      password: process.env.AUTHZ_ADMIN_PASSWORD ?? 'Admin@12345',
    },
  });
  assert.equal(login.statusCode, 200, `login: ${login.body}`);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const result = await app.inject({
    method: 'GET',
    url: '/__check/__inject-check',
    headers: { cookie },
  });
  assert.equal(result.statusCode, 200, `check route: ${result.body}`);
  const body = result.json<{
    withCookie: { status: number; name?: string };
    withoutCookie: { status: number };
    runs: Array<Record<string, unknown>>;
  }>();

  assert.equal(body.withCookie.status, 200, 'inject with cookie reaches /me');
  assert.ok(body.withCookie.name, 'session resolved to a person');
  assert.equal(body.withoutCookie.status, 401, 'inject without cookie is refused');
  console.log(
    'ok  child-instance inject runs the root auth hooks:',
    JSON.stringify({ withCookie: body.withCookie, withoutCookie: body.withoutCookie }),
  );
  for (const run of body.runs) console.log(run.ok ? 'ok ' : 'err', JSON.stringify(run));
  const unexpected = body.runs.filter((run) => !run.ok && run.kind !== 'ToolError');
  assert.equal(unexpected.length, 0, 'every tool either answers or raises a ToolError');
} finally {
  await app.close();
}
