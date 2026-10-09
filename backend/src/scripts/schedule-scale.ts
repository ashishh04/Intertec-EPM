import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { OpenProjectError } from '../lib/errors.js';
import { openProject } from '../openproject/client.js';

/**
 * The critical path at scale (BR-102, BR-104).
 *
 * Builds a real network on the instance — `--projects` projects of
 * `--per-project` work packages each, in chains of ten joined by `follows`
 * relations with lag, and chains joined to their neighbours — then measures
 * EPM over it through its HTTP API, as a person would meet it:
 *
 *   1. a recalculation of the whole network as it stands: its size, and how
 *      long reading, computing, storing and mirroring took;
 *   2. a date moved through EPM — the first item of a chain, three working
 *      days later, which moves the float of everything it reaches: how long
 *      that request took, whether the critical path read straight after it
 *      answered at once (the network is above `EPM_SCHEDULE_SYNC_LIMIT`, so a
 *      read must not wait for the pass), and how long the pass the change
 *      started took;
 *   3. a cold pass: the test projects' stored figures and OpenProject field
 *      values cleared first, so every row is written and every value mirrored
 *      — the worst case, as on a first deployment.
 *
 * The projects are built and removed with the system key, straight through
 * OpenProject's API; nothing else on the instance is touched.
 *
 *   env -u PORT npx tsx --env-file-if-exists=.env src/scripts/schedule-scale.ts [--projects 4] [--per-project 500] [--keep]
 *   env -u PORT npx tsx --env-file-if-exists=.env src/scripts/schedule-scale.ts --reuse [--keep]
 *   env -u PORT npx tsx --env-file-if-exists=.env src/scripts/schedule-scale.ts --cleanup
 *
 * `--keep` leaves the projects in place, for the 500-item Gantt check;
 * `--reuse` measures the projects an earlier `--keep` left instead of building
 * new ones; `--cleanup` deletes every project an earlier run left. Building
 * queues journal and notification jobs in OpenProject — about two per work
 * package and relation — which it works through over the following half hour.
 * Needs a running
 * backend with the critical path on (SCALE_BASE_URL, default
 * http://localhost:8000/api) and the admin account (AUTHZ_ADMIN_USER,
 * AUTHZ_ADMIN_PASSWORD).
 */

const BASE = process.env.SCALE_BASE_URL ?? 'http://localhost:8000/api';
const ADMIN = {
  username: process.env.AUTHZ_ADMIN_USER ?? 'admin',
  password: process.env.AUTHZ_ADMIN_PASSWORD ?? 'Admin@12345',
};
const NAME = 'Critical path scale test';
/**
 * OpenProject's own worker count: more at once only queues there, and a write
 * that waits past the client's timeout is sent again by the client — which
 * for a create makes a second one.
 */
const CONCURRENCY = 4;
/** Writes get far longer than reads, for the same reason. */
const WRITE_TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const PROJECTS = option('projects', 4);
const PER_PROJECT = option('per-project', 500);
const KEEP = args.includes('--keep');
const REUSE = args.includes('--reuse');
const CLEANUP_ONLY = args.includes('--cleanup');

async function signIn(): Promise<string> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!response.ok) throw new Error(`Sign-in failed: ${response.status}`);
  return (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
}

async function call<T>(cookie: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; ms: number; body: T }> {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { cookie, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, ms: Math.round(performance.now() - started), body: (text ? JSON.parse(text) : undefined) as T };
}

/** Runs `work` over `items`, `CONCURRENCY` at a time. */
async function inParallel<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const at = next;
        next += 1;
        results[at] = await work(items[at]!);
      }
    }),
  );
  return results;
}

const DAY = 86_400_000;
const isoOf = (time: number) => new Date(time).toISOString().slice(0, 10);
/** `count` weekdays on from a weekday. */
function addWorkdays(from: number, count: number): number {
  let at = from;
  for (let left = count; left > 0; ) {
    at += DAY;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return at;
}

async function leftovers(): Promise<{ id: number; name: string }[]> {
  const projects = await openProject.getAll<{ id: number; name: string }>('/projects', { pageSize: 500 });
  return projects.items.filter((project) => project.name.startsWith(NAME));
}

async function removeProjects(projects: { id: number; name: string }[]): Promise<void> {
  for (const project of projects) {
    await openProject.request(`/projects/${project.id}`, { method: 'DELETE' }).catch((error: unknown) => {
      console.log(`  could not delete ${project.name} (#${project.id}): ${error instanceof Error ? error.message : String(error)}`);
    });
    console.log(`  deleted ${project.name} (#${project.id}); OpenProject removes its work packages in the background`);
  }
}

/**
 * Creating a relation also writes both work packages, so two relations that
 * share one conflict (409). They are created in waves in which no work package
 * appears twice, and a conflict that still happens is retried.
 */
async function relate(relation: { successor: number; predecessor: number; lag: number }): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await openProject.request(`/work_packages/${relation.successor}/relations`, {
        method: 'POST',
        timeoutMs: WRITE_TIMEOUT_MS,
        body: {
          type: 'follows',
          lag: relation.lag,
          _links: { to: { href: `/api/v3/work_packages/${relation.predecessor}` } },
        },
      });
      return;
    } catch (error) {
      // Made already, by an attempt that answered too late to count.
      if (error instanceof OpenProjectError && /UniqueViolation|already been taken/i.test(error.message)) return;
      if (!(error instanceof OpenProjectError && error.upstreamStatus === 409) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.random() * 200));
    }
  }
}

function waves<T extends { successor: number; predecessor: number }>(relations: T[]): T[][] {
  const result: { members: T[]; used: Set<number> }[] = [];
  for (const relation of relations) {
    let wave = result.find((candidate) => !candidate.used.has(relation.successor) && !candidate.used.has(relation.predecessor));
    if (!wave) {
      wave = { members: [], used: new Set() };
      result.push(wave);
    }
    wave.members.push(relation);
    wave.used.add(relation.successor);
    wave.used.add(relation.predecessor);
  }
  return result.map((wave) => wave.members);
}

/** Every project this run created, so a failure part-way still removes them. */
const created: { id: number; name: string }[] = [];

/** The projects an earlier run kept, with their work packages in creation order. */
async function existing(projects: { id: number; name: string }[]): Promise<{ projectIds: number[]; workPackageIds: number[][] }> {
  const sorted = [...projects].sort((a, b) => a.id - b.id);
  const workPackageIds: number[][] = [];
  for (const project of sorted) {
    const page = await openProject.getAll<{ id: number }>(`/projects/${project.id}/work_packages`, {
      pageSize: 1000,
      filters: [{ field: 'status', operator: '*', values: [] }],
    });
    workPackageIds.push(page.items.map((item) => item.id).sort((a, b) => a - b));
  }
  return { projectIds: sorted.map((project) => project.id), workPackageIds };
}

async function build(): Promise<{ projectIds: number[]; workPackageIds: number[][] }> {
  const stamp = Date.now().toString(36);
  // Monday of next week, so every copy starts on a working day.
  const today = new Date();
  const monday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + ((8 - today.getUTCDay()) % 7 || 7) * DAY;

  const projectIds: number[] = [];
  const workPackageIds: number[][] = [];
  for (let index = 0; index < PROJECTS; index += 1) {
    const name = `${NAME} ${index + 1} (temporary)`;
    const project = await openProject.request<{ id: number }>('/projects', {
      method: 'POST',
      timeoutMs: WRITE_TIMEOUT_MS,
      body: { name, identifier: `cp-scale-${stamp}-${index + 1}` },
    });
    projectIds.push(project.id);
    created.push({ id: project.id, name });

    // Chains of ten: each step follows the one before it, with a lag of 0 or 1,
    // and every fifth step also follows the same step of the previous chain.
    const chains = Math.ceil(PER_PROJECT / 10);
    const specs = Array.from({ length: PER_PROJECT }, (_, n) => {
      const chain = Math.floor(n / 10);
      const step = n % 10;
      const duration = 1 + ((chain + step) % 3);
      const start = addWorkdays(monday, step * 4 + (chain % 5));
      return { n, chain, step, start: isoOf(start), due: isoOf(addWorkdays(start, duration - 1)) };
    });
    const started = performance.now();
    const ids = await inParallel(specs, async (spec) => {
      const created = await openProject.request<{ id: number }>(`/projects/${project.id}/work_packages`, {
        method: 'POST',
        timeoutMs: WRITE_TIMEOUT_MS,
        query: { notify: 'false' },
        body: {
          subject: `Chain ${spec.chain + 1} step ${spec.step + 1}`,
          startDate: spec.start,
          dueDate: spec.due,
          _links: { type: { href: '/api/v3/types/1' } },
        },
      });
      return created.id;
    });
    workPackageIds.push(ids);

    const relations = specs.flatMap((spec) => [
      ...(spec.step > 0 ? [{ successor: ids[spec.n]!, predecessor: ids[spec.n - 1]!, lag: spec.step % 2 }] : []),
      ...(spec.chain > 0 && spec.step % 5 === 0 && spec.chain < chains ? [{ successor: ids[spec.n]!, predecessor: ids[spec.n - 10]!, lag: 0 }] : []),
    ]);
    for (const wave of waves(relations)) await inParallel(wave, relate);
    console.log(
      `  project #${project.id}: ${ids.length} work packages and ${relations.length} relations in ${Math.round((performance.now() - started) / 1000)} s`,
    );
  }
  return { projectIds, workPackageIds };
}

interface Run {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  workPackages: number;
  relations: number;
  scheduled: number;
  changed: number;
  mirrored: number;
  readMs?: number;
  computeMs?: number;
  storeMs?: number;
  mirrorMs?: number;
  durationMs?: number;
  error?: string;
  mirrorError?: string;
}
interface Status {
  syncLimit: number;
  pending: boolean;
  lastCompleted?: Run;
  lastRun?: Run;
}

/** Waits for a completed pass that started after `since`. */
async function passAfter(cookie: string, since: number, timeoutMs = 300_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await call<Status>(cookie, '/schedule/status');
    const run = body.lastRun;
    if (run && Date.parse(run.startedAt) >= since && run.status !== 'running') {
      if (run.status === 'failed') throw new Error(`The pass failed: ${run.error}`);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No pass finished in time.');
}

const describe = (run: Run) =>
  `${run.workPackages} work packages, ${run.relations} relations, ${run.scheduled} scheduled — ` +
  `read ${run.readMs} ms, compute ${run.computeMs} ms, store ${run.storeMs} ms (${run.changed} rows), ` +
  `mirror ${run.mirrorMs} ms (${run.mirrored} work packages) — ${run.durationMs} ms in all`;

async function main() {
  await runAsSystem(async () => {
    const stale = await leftovers();
    if (CLEANUP_ONLY) {
      console.log(stale.length === 0 ? 'Nothing to clean up.' : `Removing ${stale.length} project(s) left by an earlier run:`);
      await removeProjects(stale);
      return;
    }
    if (stale.length > 0 && !REUSE) {
      console.log(`Projects from an earlier run are still there; run with --reuse to measure them, or --cleanup first:`);
      for (const project of stale) console.log(`  ${project.name} (#${project.id})`);
      process.exitCode = 1;
      return;
    }
    if (REUSE && stale.length === 0) {
      console.log('Nothing to reuse: build the projects first, with --keep.');
      process.exitCode = 1;
      return;
    }
    if (REUSE) created.push(...stale);

    let failed = false;
    const verdict = (ok: boolean, text: string) => {
      if (!ok) failed = true;
      console.log(`   ${ok ? 'PASS' : 'FAIL'}: ${text}`);
    };

    try {
      if (REUSE) console.log(`Measuring ${stale.length} project(s) an earlier run kept…`);
      else console.log(`Building ${PROJECTS} × ${PER_PROJECT} work packages on the instance…`);
      const built = REUSE ? await existing(stale) : await build();
      const cookie = await signIn();

      console.log('\n1. Recalculating the whole network as it stands');
      let since = Date.now();
      const asked = await call<Status>(cookie, '/schedule/recalculate', { method: 'POST' });
      console.log(`   POST /schedule/recalculate answered ${asked.status} in ${asked.ms} ms`);
      verdict(asked.status === 200 || asked.status === 202, 'an administrator may ask for it');
      const run = await passAfter(cookie, since - 1000);
      console.log(`   pass: ${describe(run)}`);
      verdict((run.durationMs ?? Infinity) <= 5000, 'within five seconds');

      console.log('\n2. Moving a date through EPM');
      const projectId = built.projectIds[0]!;
      const first = built.workPackageIds[0]![0]!;
      const current = await openProject.request<{ startDate: string; dueDate: string }>(`/work_packages/${first}`);
      const shift = (date: string) => isoOf(addWorkdays(Date.parse(`${date}T00:00:00Z`), 3));
      const before = Date.now();
      const moved = await call(cookie, `/tasks/${first}`, {
        method: 'PATCH',
        body: { startDate: shift(current.startDate), dueDate: shift(current.dueDate) },
      });
      console.log(`   PATCH /tasks/${first} (${current.startDate} → ${shift(current.startDate)}) answered ${moved.status} in ${moved.ms} ms`);
      const read = await call<{ pending: boolean; items: unknown[] }>(cookie, `/projects/${projectId}/critical-path`);
      console.log(
        `   GET /projects/${projectId}/critical-path straight after answered ${read.status} in ${read.ms} ms, ` +
          `${read.body.items.length} items, pending: ${read.body.pending}`,
      );
      const status = await call<Status>(cookie, '/schedule/status');
      verdict(
        moved.status === 200 && read.status === 200 && read.body.pending === true && read.ms < 1000,
        `the change and the read straight after it did not wait for the pass (network ${run.workPackages} > sync limit ${status.body.syncLimit})`,
      );
      const after = await passAfter(cookie, before);
      console.log(`   the pass that change started: ${describe(after)}`);
      verdict(after.changed > 0, 'the change moved figures, and the pass stored them');
      verdict((after.durationMs ?? Infinity) <= 5000, 'that pass ran within five seconds');
      console.log(`   fresh figures ${Date.parse(after.startedAt) - before + (after.durationMs ?? 0)} ms after the change began`);

      console.log('\n3. A cold pass: every figure stored and mirrored afresh');
      const testWorkPackages = built.workPackageIds.flat();
      const cleared = await prisma.scheduleFloat.deleteMany({ where: { projectId: { in: built.projectIds } } });
      for (let at = 0; at < testWorkPackages.length; at += 2000) {
        await openProject.request('/epm_admin/schedule/values', {
          method: 'POST',
          root: true,
          timeoutMs: WRITE_TIMEOUT_MS,
          body: {
            values: testWorkPackages.slice(at, at + 2000).map((id) => ({ id, totalFloat: null, freeFloat: null, critical: null })),
          },
        });
      }
      console.log(`   cleared ${cleared.count} stored figures and the fields of ${testWorkPackages.length} work packages`);
      since = Date.now();
      await call<Status>(cookie, '/schedule/recalculate', { method: 'POST' });
      const cold = await passAfter(cookie, since - 1000);
      console.log(`   pass: ${describe(cold)}`);
      verdict(cold.changed >= testWorkPackages.length && cold.mirrored >= testWorkPackages.length, 'every test item was stored and mirrored again');
      verdict((cold.durationMs ?? Infinity) <= 5000, 'within five seconds');

      console.log(`\nProjects for the Gantt check: ${built.projectIds.map((id) => `#${id}`).join(', ')}`);
    } catch (error) {
      failed = true;
      console.log(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!KEEP) {
        console.log('\nRemoving the test projects');
        await removeProjects(created);
      } else {
        console.log('\nKept; remove them with --cleanup.');
      }
      await prisma.$disconnect();
    }
    if (failed) process.exitCode = 1;
  });
}

await main();
