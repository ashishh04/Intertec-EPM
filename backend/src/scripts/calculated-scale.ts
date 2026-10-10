import { runAsSystem } from '../auth/context.js';
import { OpenProjectError } from '../lib/errors.js';
import { openProject } from '../openproject/client.js';

/**
 * Calculated fields at scale (BR-408).
 *
 * Builds a thousand work packages in a project of its own — 875 standalone and
 * 25 parents of four children each, with estimates and dates — defines three
 * calculated fields on it through EPM's API (a roll-up over the tree, a
 * condition on a date and a working-day count from today), and measures, as a
 * person meets it:
 *
 *   1. the first pass over the new fields: every value computed and written,
 *      the worst case, with how long reading, computing, storing and
 *      mirroring took;
 *   2. a change through EPM — one child's estimate — how long the request
 *      took, and how long until its parent's roll-up showed the new figure;
 *   3. the 1,000-row table: the project's work with the three calculated
 *      columns and their sums, read through EPM's task query API, as five
 *      pages of 200 at once — repeated, with the 50th and 95th percentiles
 *      against NFR01's two seconds — and a view filtered on a calculated field.
 *
 * Then everything is removed: the fields with their OpenProject fields, and
 * the project with its work packages (OpenProject deletes those in the
 * background).
 *
 *   env -u PORT npx tsx --env-file-if-exists=.env src/scripts/calculated-scale.ts [--total 1000] [--parents 25] [--children 4] [--rounds 20] [--keep]
 *   env -u PORT npx tsx --env-file-if-exists=.env src/scripts/calculated-scale.ts --cleanup
 *
 * Needs a running backend (SCALE_BASE_URL, default http://localhost:8000/api)
 * and the admin account (AUTHZ_ADMIN_USER, AUTHZ_ADMIN_PASSWORD). The work
 * packages are made with the system key, straight through OpenProject's API.
 * A standalone work package is quick to make; a child is several times
 * slower, because making it writes its parent too (its derived work and
 * dates) — and one parent's children have to be made one after another — so
 * the tree is kept to a hundred children. Building queues journal jobs in
 * OpenProject, about one per work package, which it works through over the
 * following minutes.
 */

const BASE = process.env.SCALE_BASE_URL ?? 'http://localhost:8000/api';
const ADMIN = {
  username: process.env.AUTHZ_ADMIN_USER ?? 'admin',
  password: process.env.AUTHZ_ADMIN_PASSWORD ?? 'Admin@12345',
};
const NAME = 'Calculated fields scale test';
const CONCURRENCY = 4;
const WRITE_TIMEOUT_MS = 120_000;
/** NFR01: interactive views within two seconds at the 95th percentile. */
const TARGET_MS = 2_000;

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const TOTAL = option('total', 1000);
const PARENTS = option('parents', 25);
const CHILDREN = option('children', 4);
/** Work packages with no parent and no children, to make up the total. */
const STANDALONE = Math.max(0, TOTAL - PARENTS * (1 + CHILDREN));
const ROUNDS = option('rounds', 20);
const KEEP = args.includes('--keep');
const CLEANUP_ONLY = args.includes('--cleanup');

type Json = Record<string, any>;

async function signIn(): Promise<string> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!response.ok) throw new Error(`Sign-in failed: ${response.status}`);
  return (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
}

async function call<T = Json>(cookie: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; ms: number; body: T }> {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { cookie, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, ms: Math.round(performance.now() - started), body: (text ? JSON.parse(text) : undefined) as T };
}

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
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

async function leftovers(): Promise<{ id: number; name: string }[]> {
  const projects = await runAsSystem(() => openProject.getAll<{ id: number; name: string }>('/projects', { pageSize: 500 }));
  return projects.items.filter((project) => project.name.startsWith(NAME));
}

async function removeProjects(projects: { id: number; name: string }[]): Promise<void> {
  for (const project of projects) {
    await runAsSystem(() => openProject.request(`/projects/${project.id}`, { method: 'DELETE' })).catch((error: unknown) => {
      console.log(`  could not delete ${project.name} (#${project.id}): ${error instanceof Error ? error.message : String(error)}`);
    });
    console.log(`  deleted ${project.name} (#${project.id}); OpenProject removes its work packages in the background`);
  }
}

/** Calculated fields this script defined, by their key's suffix. */
async function removeFields(cookie: string, suffix?: string): Promise<void> {
  const list = (await call<Json[]>(cookie, '/calculated-fields')).body ?? [];
  const ours = list.filter((field) => String(field.key).startsWith('scale') && (!suffix || String(field.key).endsWith(`_${suffix}`)));
  // Readers before what they read: the roll-up reads only itself.
  for (const field of ours.sort((a, b) => String(b.key).localeCompare(String(a.key)))) {
    const gone = await call(cookie, `/calculated-fields/${field.id}`, { method: 'DELETE' });
    console.log(`  deleted calculated field ${field.key}: ${gone.status}`);
  }
}

async function build(): Promise<{ projectId: number; parents: number[]; children: number[][] }> {
  const stamp = Date.now().toString(36);
  const name = `${NAME} (temporary)`;
  const project = await runAsSystem(() =>
    openProject.request<{ id: number }>('/projects', {
      method: 'POST',
      timeoutMs: WRITE_TIMEOUT_MS,
      body: { name, identifier: `calc-scale-${stamp}` },
    }),
  );
  created.push({ id: project.id, name });
  const create = (body: Json) =>
    runAsSystem(async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return (
            await openProject.request<{ id: number }>(`/projects/${project.id}/work_packages`, {
              method: 'POST',
              timeoutMs: WRITE_TIMEOUT_MS,
              query: { notify: 'false' },
              body: { _links: { type: { href: '/api/v3/types/1' } }, ...body },
            })
          ).id;
        } catch (error) {
          if (!(error instanceof OpenProjectError && error.upstreamStatus === 409) || attempt >= 8) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt + Math.random() * 300));
        }
      }
    });

  const started = performance.now();
  const today = Date.now();
  // Standalone work: estimates from one to eight hours (every fifth has none),
  // dates spread from ten days ago to a fortnight ahead — some late, some not.
  const standalone = await inParallel(
    Array.from({ length: STANDALONE }, (_, n) => n),
    (n) => {
      const start = today + ((n % 20) - 10) * DAY;
      return create({
        subject: `Item ${n + 1}`,
        ...(n % 5 === 4 ? {} : { estimatedTime: `PT${(n % 8) + 1}H` }),
        startDate: isoOf(start),
        dueDate: isoOf(start + (n % 5) * DAY),
      });
    },
  );
  const parents = await inParallel(
    Array.from({ length: PARENTS }, (_, n) => n),
    (n) => create({ subject: `Parent ${n + 1}`, estimatedTime: 'PT2H' }),
  );
  // A child's creation writes its parent too (its derived dates and work), so
  // one parent's children are made one after another — two at once conflict —
  // while different parents' are made side by side.
  const children = await inParallel(parents, async (parentId) => {
    const ids: number[] = [];
    for (let n = 0; n < CHILDREN; n += 1) {
      const start = today + (n * 2 - 4) * DAY;
      ids.push(
        await create({
          subject: `Child ${n + 1} of #${parentId}`,
          ...(n % 4 === 3 ? {} : { estimatedTime: `PT${n + 1}H` }),
          // Two days long, from four days ago onwards: the first late, the rest not.
          startDate: isoOf(start),
          dueDate: isoOf(start + 2 * DAY),
          _links: { type: { href: '/api/v3/types/1' }, parent: { href: `/api/v3/work_packages/${parentId}` } },
        }),
      );
    }
    return ids;
  });
  console.log(
    `  project #${project.id}: ${standalone.length + parents.length + children.flat().length} work packages ` +
      `(${standalone.length} standalone, ${parents.length} parents of ${CHILDREN}) in ${Math.round((performance.now() - started) / 1000)} s`,
  );
  return { projectId: project.id, parents, children };
}

const created: { id: number; name: string }[] = [];

async function main(): Promise<void> {
  console.log(`Calculated fields at scale, against ${BASE}\n`);
  const cookie = await signIn();

  if (CLEANUP_ONLY) {
    await removeFields(cookie);
    await removeProjects(await leftovers());
    return;
  }

  const suffix = Date.now().toString(36);
  try {
    console.log('Building');
    const { projectId, parents, children } = await build();

    console.log('\nDefining three calculated fields on it');
    const key = (name: string) => `${name}_${suffix}`;
    const define = async (name: string, label: string, resultType: string, expression: string) => {
      const made = await call(cookie, '/calculated-fields', {
        method: 'POST',
        body: { key: key(name), name: `${label} ${suffix}`, resultType, expression, projectIds: [String(projectId)] },
      });
      if (made.status !== 201) throw new Error(`${name}: ${made.status} ${JSON.stringify(made.body)}`);
      console.log(`  ${key(name)} = ${expression}  (${made.ms} ms to define)`);
      return made.body;
    };
    const definedAt = Date.now();
    const total = await define('scaleTotal', 'Scale total', 'number', `COALESCE(estimatedHours, 0) + COALESCE(SUM_CHILDREN(${key('scaleTotal')}), 0)`);
    const late = await define('scaleLate', 'Scale late', 'boolean', 'dueDate < TODAY()');
    const left = await define('scaleLeft', 'Scale days left', 'number', 'WORKING_DAYS_BETWEEN(TODAY(), dueDate)');

    // 1. The first pass over the new fields.
    let pass: Json | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = (await call(cookie, '/calculated-fields/status')).body;
      const last = status.lastCompleted as Json | undefined;
      if (last && Date.parse(last.startedAt) >= definedAt && last.fields >= 3 && !status.pending) {
        pass = last;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!pass) throw new Error('No pass completed over the new fields within two minutes.');
    console.log('\n1. The first pass over the new fields (every value computed and written)');
    console.log(
      `  ${pass.workPackages} work packages, ${pass.fields} fields, ${pass.evaluated} values (${pass.empty} empty), ${pass.changed} stored, ${pass.mirrored} work packages mirrored`,
    );
    console.log(
      `  read ${pass.readMs} ms, compute ${pass.computeMs} ms, store ${pass.storeMs} ms, mirror ${pass.mirrorMs} ms: ${pass.durationMs} ms in all`,
    );

    // 2. A change through EPM, and how long until the roll-up shows it.
    const parentId = parents[0]!;
    const childId = children[0]![0]!;
    const before = ((await call<Json[]>(cookie, `/work-packages/${parentId}/calculated-values`)).body ?? []).find((value) => value.key === key('scaleTotal'))?.value;
    const moved = await call(cookie, `/tasks/${childId}`, { method: 'PATCH', body: { estimatedHours: 25 } });
    const movedAt = performance.now();
    let after: unknown;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      after = ((await call<Json[]>(cookie, `/work-packages/${parentId}/calculated-values`)).body ?? []).find((value) => value.key === key('scaleTotal'))?.value;
      if (after !== before) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const lastPass = ((await call(cookie, '/calculated-fields/status')).body.lastCompleted ?? {}) as Json;
    console.log('\n2. One child’s estimate changed through EPM');
    console.log(`  the request answered in ${moved.ms} ms (${moved.status}); the parent's roll-up went ${before} → ${after}`);
    console.log(`  ${Math.round(performance.now() - movedAt)} ms from the answer to the new roll-up; that pass took ${lastPass.durationMs} ms`);

    // 3. The 1,000-row view as EPM's task table reads it: one page at a time —
    // 15 rows by default, up to 100 — with sums over the whole view, one
    // request after another as one person's are. Each round reads the page with
    // the three calculated columns and, straight after, the same page without
    // them (the baseline), so both meet the instance in the same state. Rounds
    // alternate between the first page and one deep in the view.
    const base = ['id', 'subject', 'type', 'status', 'estimatedTime', 'dueDate'];
    const withCalculated = [...base, total.column, late.column, left.column].join(',');
    const withoutCalculated = base.join(',');
    const read = (size: number, offset: number, columns: string, filters = '') =>
      call(cookie, `/queries/default?projectId=${projectId}&pageSize=${size}&offset=${offset}&showSums=true&columns=${columns}${filters}`);
    const results: { label: string; calc: number[]; plain: number[] }[] = [];
    let rows = 0;
    let sum: unknown;
    for (const size of [15, 100]) {
      const deep = Math.max(1, Math.floor(1000 / size / 2));
      const calc: number[] = [];
      const plain: number[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const offset = round % 2 === 0 ? 1 : deep;
        const answer = await read(size, offset, withCalculated);
        calc.push(answer.ms);
        rows = answer.body.total ?? rows;
        sum = answer.body.sums?.[total.column] ?? sum;
        plain.push((await read(size, offset, withoutCalculated)).ms);
      }
      results.push({ label: `a page of ${size}`, calc, plain });
    }
    const lateFilter = `&filters=${encodeURIComponent(JSON.stringify([{ [late.column]: { operator: '=', values: ['t'] } }]))}`;
    const filtered: number[] = [];
    let lateCount = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const answer = await read(15, 1, withCalculated, lateFilter);
      filtered.push(answer.ms);
      lateCount = answer.body.total ?? 0;
    }
    console.log(`\n3. The ${rows}-row view as the task table reads it, ${ROUNDS} rounds each, one request at a time`);
    for (const result of results) {
      console.log(
        `  ${result.label} with the 3 calculated columns and sums: p50 ${percentile(result.calc, 50)} ms, p95 ${percentile(result.calc, 95)} ms; ` +
          `without them (baseline): p50 ${percentile(result.plain, 50)} ms, p95 ${percentile(result.plain, 95)} ms`,
      );
    }
    console.log(`  the roll-up summed over the whole view: ${sum}`);
    console.log(`  filtered on Late = yes (${lateCount} of ${rows}), a page of 15: p50 ${percentile(filtered, 50)} ms, p95 ${percentile(filtered, 95)} ms`);
    const within = results.every((result) => percentile(result.calc, 95) <= TARGET_MS) && percentile(filtered, 95) <= TARGET_MS;
    console.log(`  NFR01 (p95 within ${TARGET_MS} ms) with calculated columns: ${within ? 'met' : 'NOT met'}`);
    process.exitCode = within ? 0 : 1;
  } finally {
    if (!KEEP) {
      console.log('\nCleaning up');
      await removeFields(cookie, suffix).catch((error: unknown) => console.log(`  ${error instanceof Error ? error.message : String(error)}`));
      await removeProjects(created);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
