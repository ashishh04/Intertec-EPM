import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Load test for NFR01 (Module 20): interactive views within 2 s at the 95th
 * percentile under the modelled concurrent load — 500 people at once over
 * 100,000 work packages (the team's figure, 19 Oct 2026).
 *
 * The people are the load users `backend/openproject/load-test/load-data.rb`
 * makes. Each virtual user signs in as one of them and then works as a person
 * does, a screen at a time with a pause between: the home page, their own
 * work, a project's tasks (a planner, one in ten, reads the 1,000-row view as
 * five pages of 200), a task opened with its comments, relations and files,
 * the calendar, notifications, their timesheet. Every request is timed; the
 * report gives each screen's and each route's p50, p95 and p99 and the error
 * rate, and passes only if every screen's p95 is within the target and errors
 * stay under 1 %.
 *
 * Sign-in is limited to 10 a minute from one address (a deliberate defence
 * against password spraying), so the users sign in once, paced within it, and
 * their sessions are kept in a file and reused by later runs while they last.
 * 500 people take about 55 minutes to sign in the first time.
 *
 *   LOAD_PASSWORD=… npx tsx src/scripts/load-test.ts --base https://staging.example/api \
 *     [--users 500] [--prefix lt] [--ramp 300] [--duration 900] [--think 5000] \
 *     [--sessions .load-test/sessions.json] [--report .load-test/report.json] [--target 2000]
 *   npx tsx src/scripts/load-test.ts --sign-in-only …   (sign everyone in, then stop)
 *
 * FOR A TEST INSTANCE: it is real traffic, from real accounts, at the scale it is told.
 */

type Json = Record<string, any>;

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);

const BASE = option('base', process.env.LOAD_BASE_URL ?? 'http://localhost:8000/api').replace(/\/$/, '');
const USERS = Number(option('users', '500'));
const PREFIX = option('prefix', 'lt');
const RAMP_S = Number(option('ramp', '300'));
const DURATION_S = Number(option('duration', '900'));
const THINK_MS = Number(option('think', '5000'));
const TARGET_MS = Number(option('target', '2000'));
const SESSIONS = option('sessions', '.load-test/sessions.json');
const REPORT = option('report', '.load-test/report.json');
const PASSWORD = process.env.LOAD_PASSWORD ?? '';
const SIGN_IN_PER_MINUTE = 9;

if (!PASSWORD) {
  console.error('Set LOAD_PASSWORD to the load users’ password.');
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const login = (n: number) => `${PREFIX}-user-${String(n).padStart(3, '0')}`;

/* ---------------------------------------------------------------- timings */

const samples = new Map<string, number[]>();
let requests = 0;
let errors = 0;
const errorKinds = new Map<string, number>();
const record = (key: string, ms: number) => {
  let list = samples.get(key);
  if (!list) samples.set(key, (list = []));
  list.push(ms);
};
const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);

/** One request, timed under its route's name; errors counted, never thrown. */
async function hit(cookie: string, route: string, path: string): Promise<{ ok: boolean; ms: number; json: Json | null }> {
  const started = performance.now();
  let ok = false;
  let json: Json | null = null;
  try {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    ok = response.ok;
    json = (await response.json().catch(() => null)) as Json | null;
    if (!ok) errorKinds.set(`${route} ${response.status}`, (errorKinds.get(`${route} ${response.status}`) ?? 0) + 1);
  } catch (error) {
    errorKinds.set(`${route} ${(error as Error).name}`, (errorKinds.get(`${route} ${(error as Error).name}`) ?? 0) + 1);
  }
  const ms = performance.now() - started;
  requests += 1;
  if (!ok) errors += 1;
  record(`route ${route}`, ms);
  return { ok, ms, json };
}

/** A screen: its requests at once, as the page makes them; its time is the slowest. */
async function screen(name: string, cookie: string, calls: [string, string][]): Promise<Json[]> {
  const started = performance.now();
  const results = await Promise.all(calls.map(([route, path]) => hit(cookie, route, path)));
  record(`screen ${name}`, performance.now() - started);
  return results.map((result) => result.json ?? {});
}

/* ---------------------------------------------------------------- sessions */

function loadSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}
function saveSessions(sessions: Record<string, string>) {
  mkdirSync(dirname(SESSIONS), { recursive: true });
  writeFileSync(SESSIONS, JSON.stringify(sessions), { mode: 0o600 });
}
async function stillValid(cookie: string) {
  const response = await fetch(`${BASE}/me`, { headers: { cookie } }).catch(() => null);
  return response?.ok === true;
}
async function signIn(username: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    if (response.ok) return (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
    if (response.status === 429) await sleep(65_000);
    else return null;
  }
  return null;
}
async function sessionsFor(count: number): Promise<Record<string, string>> {
  const sessions = loadSessions();
  const gap = 60_000 / SIGN_IN_PER_MINUTE;
  for (let n = 1; n <= count; n += 1) {
    const user = login(n);
    if (sessions[user] && (await stillValid(sessions[user]!))) continue;
    const cookie = await signIn(user);
    if (cookie) {
      sessions[user] = cookie;
      saveSessions(sessions);
    } else {
      console.warn(`  could not sign in ${user}`);
    }
    console.log(`  signed in ${n} of ${count}`);
    await sleep(gap);
  }
  return sessions;
}

/* ---------------------------------------------------------------- a person */

const pick = <T>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)];
const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const listOf = (json: Json) => ((json.items ?? json.data ?? json.elements ?? (Array.isArray(json) ? json : [])) as Json[]) ?? [];

async function person(cookie: string, planner: boolean, until: number) {
  const me = (await hit(cookie, '/me', '/me')).json ?? {};
  const pause = () => sleep(THINK_MS * (0.5 + Math.random()));
  while (Date.now() < until) {
    await screen('home', cookie, [
      ['/dashboard/metrics', '/dashboard/metrics'],
      ['/notifications', '/notifications?pageSize=20'],
      ['/activity', '/activity?limit=20'],
    ]);
    await pause();
    const [mine] = await screen('my work', cookie, [
      ['/tasks (mine)', `/tasks?assigneeId=${me.id}&bucket=open&pageSize=50`],
      ['/timesheets/mine', '/timesheets/mine'],
    ]);
    await pause();
    const [projects] = await screen('projects', cookie, [['/projects', '/projects']]);
    const project = pick(listOf(projects ?? {}).filter((entry) => String(entry.identifier ?? '').startsWith(`${PREFIX}-p-`)));
    await pause();
    if (project) {
      if (planner) {
        // The 1,000-row view: five pages of 200 at once.
        await screen('project tasks (1,000 rows)', cookie, [1, 2, 3, 4, 5].map((page) => ['/tasks (project, 200)', `/tasks?projectId=${project.id}&page=${page}&pageSize=200`] as [string, string]));
      } else {
        await screen('project tasks', cookie, [['/tasks (project, 50)', `/tasks?projectId=${project.id}&pageSize=50`]]);
      }
      await pause();
    }
    const task = pick(listOf(mine ?? {}));
    if (task?.id) {
      await screen('task', cookie, [
        ['/tasks/:id', `/tasks/${task.id}`],
        ['/work-packages/:id/comments', `/work-packages/${task.id}/comments`],
        ['/work-packages/:id/relations', `/work-packages/${task.id}/relations`],
        ['/work-packages/:id/attachments', `/work-packages/${task.id}/attachments`],
      ]);
      await pause();
    }
    await screen('calendar', cookie, [['/calendar/events', `/calendar/events?from=${isoDay(-7)}&to=${isoDay(35)}`]]);
    await pause();
  }
}

/* ---------------------------------------------------------------- the run */

const sessions = await sessionsFor(USERS);
if (flag('sign-in-only')) {
  console.log(`Signed in: ${Object.keys(sessions).length}. Sessions kept in ${SESSIONS}.`);
  process.exit(0);
}

const people = Array.from({ length: USERS }, (_, i) => sessions[login(i + 1)]).filter((cookie): cookie is string => Boolean(cookie));
console.log(`Running ${people.length} people: ramp ${RAMP_S} s, then ${DURATION_S} s; think ${THINK_MS} ms; target p95 ≤ ${TARGET_MS} ms.`);
const started = Date.now();
const until = started + (RAMP_S + DURATION_S) * 1000;
const progress = setInterval(() => {
  console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${requests} requests, ${errors} errors`);
}, 30_000);
await Promise.all(
  people.map(async (cookie, index) => {
    await sleep((RAMP_S * 1000 * index) / Math.max(1, people.length));
    await person(cookie, index % 10 === 0, until);
  }),
);
clearInterval(progress);

const rows = [...samples.entries()]
  .map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return { key, count: sorted.length, p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), p99: Math.round(percentile(sorted, 99)) };
  })
  .sort((a, b) => a.key.localeCompare(b.key));
const screens = rows.filter((row) => row.key.startsWith('screen '));
const errorRate = requests === 0 ? 1 : errors / requests;
const pass = screens.length > 0 && screens.every((row) => row.p95 <= TARGET_MS) && errorRate < 0.01;
const report = {
  base: BASE,
  at: new Date().toISOString(),
  people: people.length,
  rampSeconds: RAMP_S,
  durationSeconds: DURATION_S,
  thinkMs: THINK_MS,
  targetP95Ms: TARGET_MS,
  requests,
  errors,
  errorRate: Number(errorRate.toFixed(4)),
  errorKinds: Object.fromEntries(errorKinds),
  rows,
  pass,
};
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.table(rows);
console.log(`${requests} requests, ${(errorRate * 100).toFixed(2)} % errors. ${pass ? 'PASS' : 'FAIL'}: every screen's p95 within ${TARGET_MS} ms and errors under 1 %. Report: ${REPORT}`);
process.exit(pass ? 0 : 1);
