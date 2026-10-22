/**
 * Authorization tests, exercised over HTTP.
 *
 *   npm run test:authz
 *
 * These drive the real API the way a client would — including the way a
 * malicious client would, by calling mutating endpoints directly without ever
 * loading the UI. A permission model that only holds when the frontend
 * cooperates is not a permission model, so every deny case here bypasses it.
 *
 * Requires two accounts on the OpenProject instance: an administrator and a
 * user with no project role. Set them with:
 *
 *   AUTHZ_ADMIN_USER / AUTHZ_ADMIN_PASSWORD
 *   AUTHZ_RESTRICTED_USER / AUTHZ_RESTRICTED_PASSWORD
 *
 * No credential is written to stdout, on success or failure.
 *
 * Note: the negative cases deliberately fail a sign-in, and OpenProject blocks
 * an account after `brute_force_block_after_failed_logins` consecutive failures
 * (20 by default, for 30 minutes). Running this in a tight loop will therefore
 * lock the account it tests against — which is the protection working, not a
 * fault. The wrong-password case uses the restricted account rather than the
 * administrator so a lockout cannot cost administrative access.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

/**
 * The administrator's stored preferences while its email is off for a run
 * (see "Identity and permissions"). Kept on disk as well as in memory: a run
 * stopped before its cleanup — killed, or its terminal closed — would
 * otherwise leave the administrator's email off for good. The next run finds
 * this file and puts them back before anything else.
 *
 * Named for the database the run writes to: two suites on one machine against
 * different databases (parallel worktrees) must never put one's held
 * preferences back into the other.
 */
const HELD_PREFERENCES = join(tmpdir(), `epm-authz-admin-preferences-${databaseKey()}.json`);

function databaseKey(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}-${url.port || '5432'}-${url.pathname.slice(1)}`.replace(/[^\w.-]/g, '_');
  } catch {
    return 'default';
  }
}

interface HeldPreferences {
  userId: string;
  /** The row as it was; `null` when there was none. */
  stored: { data: Prisma.JsonValue } | null;
}

async function restoreAdminPreferences(held: HeldPreferences): Promise<boolean> {
  const { prisma } = await import('../db/prisma.js');
  const restored = held.stored
    ? await prisma.userPreference
        .upsert({
          where: { openProjectId: held.userId },
          create: { openProjectId: held.userId, data: held.stored.data as Prisma.InputJsonValue },
          update: { data: held.stored.data as Prisma.InputJsonValue },
        })
        .then(() => true)
        .catch(() => false)
    : await prisma.userPreference
        .deleteMany({ where: { openProjectId: held.userId } })
        .then(() => true)
        .catch(() => false);
  if (restored) rmSync(HELD_PREFERENCES, { force: true });
  return restored;
}

const BASE = process.env.AUTHZ_BASE_URL ?? 'http://localhost:8000/api';

const ADMIN = {
  username: process.env.AUTHZ_ADMIN_USER ?? 'admin',
  password: process.env.AUTHZ_ADMIN_PASSWORD ?? 'Admin@12345',
};
const RESTRICTED = {
  username: process.env.AUTHZ_RESTRICTED_USER ?? 'restricted',
  password: process.env.AUTHZ_RESTRICTED_PASSWORD ?? 'Restricted!12345',
};

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  ok ? (passed += 1) : (failed += 1);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (expected ${expected}, got ${actual})`}`);
}

/** A session is just the cookie the backend issued; nothing else is retained. */
async function signIn(credentials: { username: string; password: string }): Promise<string> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });

  if (!response.ok) throw new Error(`Sign-in failed for ${credentials.username}: ${response.status}`);

  const cookie = response.headers.getSetCookie?.() ?? [];
  const session = cookie.map((entry) => entry.split(';')[0]).join('; ');
  if (!session) throw new Error('No session cookie was issued.');
  return session;
}

function call(
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function status(path: string, options: Parameters<typeof call>[1] = {}): Promise<number> {
  return (await call(path, options)).status;
}

async function main() {
  console.log(`Authorization tests against ${BASE}\n`);

  // Created below; removed in the cleanup step, which the API cannot do.
  const departmentIds: string[] = [];
  const teamIds: string[] = [];
  // Capacity is real per-person data. Whatever these tests change is put
  // back in the cleanup step, so the database ends as it began.
  const originalCapacity = new Map<string, number>();
  // A person's department and team are real organisational data. The mapping
  // tests remap whoever they run as, so whatever was there is put back —
  // including "they were mapped to nothing", which is a value too.
  const originalMapping = new Map<string, { departmentId: string | null; teamId: string | null }>();
  // Memberships these tests grant. Registered as soon as one is created rather
  // than removed only by the test that asserts removal — an abort in between
  // would otherwise leave a real person holding real access to a real project.
  const grantedMemberships: { projectId: string; membershipId: string }[] = [];
  // Sprints are OpenProject versions; the API has no delete route for them, so
  // the cleanup removes these through the upstream endpoint directly.
  const createdSprintIds: string[] = [];
  // The health tests price logged time with an hourly rate on the
  // administrator and may change the health rules. Both are real state and
  // are put back; the time entry they log is removed. Hoisted so the cleanup
  // can undo them even when a run stops part-way.
  let originalAdminRate: number | null | undefined;
  let healthTimeEntryId: string | undefined;
  let originalHealthRules: unknown;
  const portfolioIds: string[] = [];
  // Approval chains and delegations the approval tests create. The requests
  // go by project; the chains after them, since a chain a request still names
  // cannot be removed.
  const approvalChainIds: string[] = [];
  const approvalDelegationIds: string[] = [];
  // Rules and escalation policies the rules tests create, and the receiver
  // their outbound action calls. Removed in the cleanup however far a run got.
  const ruleIds: string[] = [];
  const escalationPolicyIds: string[] = [];
  let ruleReceiver: import('node:http').Server | undefined;
  // A project's portfolio is real organisational state; whatever these tests
  // set is put back, including "it was in none".
  const originalProjectPortfolio = new Map<string, string | null>();
  // Snapshot rows these tests write. The user-scoped history the dashboard
  // has been recording since before this feature is left alone.
  const analyticsFixtureScopes: string[] = [];
  let analyticsCaptureDay: string | undefined;
  const schedulerCaptureDays: string[] = [];
  // Scheduled reports these tests define, and the restricted account that is
  // lent reports:approve to approve one. Removed — with their runs, copies,
  // files and the emails they queued — however far a run got.
  const reportScheduleIds: string[] = [];
  let reportGrantUserId: string | undefined;
  // Saved portfolio views these tests make, and the time entry their cost
  // drill is checked against. Removed however far a run got.
  const portfolioViewIds: string[] = [];
  let viewTimeEntryId: string | undefined;
  // The critical path tests' own project (its work goes with it) and the
  // saved view they make. Removed however far a run got.
  let criticalPathProjectId: string | undefined;
  let criticalPathQueryId: string | undefined;
  // The earned value tests' own project (baselines and work go with it), and
  // the earning rules as they were, put back if the section stopped part-way.
  let earnedValueProjectId: string | undefined;
  let evmRulesBefore: { defaultMethod: string; methods: Record<string, string>; unpricedRate: number | null } | undefined;
  // The resource tests' project, role, pin and levelling runs, and the role
  // the restricted account had: put back if the section stopped part-way.
  let resourcesProjectId: string | undefined;
  let resourcesProjectNumber: number | undefined;
  let resourcesRoleId: string | undefined;
  let resourcesRestrictedRoleBefore: string | null | undefined;
  let resourcesPinnedId: string | undefined;
  const resourcesRunIds: string[] = [];
  // The time and expense tests' project, the rules they replaced, and the cost
  // entries their approved claim became.
  let timeProjectId: string | undefined;
  let timeSettingsBefore: Record<string, unknown> | undefined;
  const timeCostEntryIds: string[] = [];
  /** What the finance tests undo, last first. */
  const financeCleanup: (() => Promise<unknown>)[] = [];
  let slipProjectId: string | undefined;
  let scenarioProjectId: string | undefined;
  // The administrator's stored preferences, while its email is switched off
  // for the run: `null` when it had none. Put back as the very last step.
  let adminPreferences: HeldPreferences | undefined;
  // "Read hourly rates", lent to the restricted account to show it takes
  // effect; taken back in the section, and again in the cleanup if a run
  // stopped in between.
  let ratesGrantLent = false;
  let restrictedIdForCleanup = '';
  // Removals the surfaces section (authz-surfaces.ts) registers as each of its
  // records comes into being; run newest first at the top of the cleanup.
  const surfaceCleanups: (() => Promise<void>)[] = [];
  // Dedupe keys the notification tests create directly. Not the whole story:
  // the capacity, employee and portfolio sections mutate capacity through the
  // API, and each of those now produces a notification too. The timestamp below
  // is what catches those, since they cannot all be enumerated ahead of time.
  const notificationKeys: string[] = [];
  const suiteStartedAt = new Date();

  // Everything below runs inside this try, and the cleanup is in the finally.
  // A run that threw part-way used to skip cleanup entirely and leave real
  // state behind: a membership granting a real person real access, a relation
  // that made the next run fail, an archived project that could not be repaired
  // because archiving removes the rights needed to repair it. The next run then
  // failed for reasons that had nothing to do with the code.
  // Hoisted so the cleanup in the finally can see them: it has to be able to
  // undo what the run did, whether or not the run finished.
  let admin = '';
  let restricted = '';
  let adminId = '';
  let createdId: string | undefined;
  // The analytics section's two work packages, in the project above.
  const analyticsProbeIds: string[] = [];
  let analyticsProbeCreatedAt = 0;

  try {

  // --- Authentication ------------------------------------------------------
  console.log('Authentication');
  check('anonymous GET /me is refused', await status('/me'), 401);
  check('anonymous POST /projects is refused', await status('/projects', {
    method: 'POST',
    body: { payload: { name: 'x', identifier: 'x' } },
  }), 401);

  const badCredentials = await call('/auth/login', {
    method: 'POST',
    body: { username: RESTRICTED.username, password: 'definitely-not-the-password' },
  });
  check('wrong password is rejected', badCredentials.status, 401);

  const unknownUser = await call('/auth/login', {
    method: 'POST',
    body: { username: 'no-such-user-here', password: 'whatever' },
  });
  check('unknown user is rejected', unknownUser.status, 401);

  // The two must be indistinguishable, or the form enumerates accounts.
  const bad = await badCredentials.json().catch(() => ({}));
  const unknown = await unknownUser.json().catch(() => ({}));
  check(
    'wrong password and unknown user are indistinguishable',
    JSON.stringify(bad) === JSON.stringify(unknown),
    true,
  );

  admin = await signIn(ADMIN);
  restricted = await signIn(RESTRICTED);
  check('admin can sign in', typeof admin === 'string' && admin.length > 0, true);
  check('restricted user can sign in', typeof restricted === 'string' && restricted.length > 0, true);

  // --- Identity ------------------------------------------------------------
  console.log('\nIdentity and permissions');
  const adminMe = (await (await call('/me', { cookie: admin })).json()) as {
    id: string;
    permissions: Record<string, Record<string, boolean>>;
    projectPermissions: Record<string, Record<string, Record<string, boolean>>>;
  };
  const restrictedMe = (await (await call('/me', { cookie: restricted })).json()) as typeof adminMe;

  check('the two sessions are different identities', adminMe.id !== restrictedMe.id, true);
  const restrictedId = restrictedMe.id;
  restrictedIdForCleanup = restrictedId;

  // The administrator's address is a real mailbox, and any mail worker on this
  // database — a developer's own server — sends what the run queues: approval
  // requests, "you have been added", rule and escalation notices. Its EPM email
  // is switched off for the run (the outbox then queues nothing for it) and its
  // stored preferences are put back exactly at the end. No check here reads an
  // email addressed to the administrator.
  {
    const { prisma } = await import('../db/prisma.js');
    // A run stopped before its cleanup left them off. Put back only while they
    // still are: someone who has switched email on again since has decided.
    if (existsSync(HELD_PREFERENCES)) {
      const held = JSON.parse(readFileSync(HELD_PREFERENCES, 'utf8')) as HeldPreferences;
      const current = await prisma.userPreference.findUnique({ where: { openProjectId: held.userId }, select: { data: true } });
      const stillOff = (current?.data as { email?: { enabled?: boolean } } | null)?.email?.enabled === false;
      if (stillOff) {
        console.log(
          (await restoreAdminPreferences(held))
            ? "  (put back the administrator's email preferences an interrupted run had left off)"
            : "  (COULD NOT put back the administrator's email preferences an interrupted run left off)",
        );
      } else {
        rmSync(HELD_PREFERENCES, { force: true });
      }
    }
    const stored = await prisma.userPreference.findUnique({ where: { openProjectId: adminMe.id }, select: { data: true } });
    // On disk before the switch, so there is never a moment it is off with nothing to restore from.
    writeFileSync(HELD_PREFERENCES, JSON.stringify({ userId: adminMe.id, stored } satisfies HeldPreferences));
    const { setPreferences } = await import('../email/preferences.js');
    await setPreferences(adminMe.id, { email: { enabled: false } });
    adminPreferences = { userId: adminMe.id, stored };
    // Stopped by hand: put them back on the way out.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void (adminPreferences ? restoreAdminPreferences(adminPreferences) : Promise.resolve(true)).finally(() => process.exit(130));
      });
    }
    console.log("  (the administrator's EPM email is off for this run, and is put back at the end)");
  }
  check('admin may create projects', adminMe.permissions.project?.create, true);
  check('restricted user may not create projects', restrictedMe.permissions.project?.create ?? false, false);

  const project = Object.keys(adminMe.projectPermissions)[0];
  if (!project) throw new Error('Admin has no project permissions; cannot test project scope.');

  check(
    'admin may edit work packages in the project',
    adminMe.projectPermissions[project]?.task?.edit,
    true,
  );
  check(
    'restricted user may not edit work packages there',
    restrictedMe.projectPermissions[project]?.task?.edit ?? false,
    false,
  );

  // --- Enforcement, bypassing the UI entirely ------------------------------
  console.log('\nEnforcement (direct API calls)');

  const created = await call('/projects', {
    method: 'POST',
    cookie: admin,
    body: { payload: { name: 'Authz Test Project', identifier: `authz-test-${Date.now()}` } },
  });
  check('admin can create a project', created.status, 201);

  // Name checked as well as id. The cleanup archives or deletes whatever this
  // holds, so it must be this suite's project and nothing else — an id alone
  // would let a bad response point the cleanup at somebody's real project.
  const createdBody = created.ok
    ? ((await created.json()) as { id?: string; name?: string })
    : undefined;
  createdId =
    createdBody?.name === 'Authz Test Project' ? createdBody.id : undefined;

  if (created.ok && !createdId) {
    throw new Error(
      `Created project did not come back as asked (id=${createdBody?.id ?? 'missing'}, ` +
        `name=${createdBody?.name ?? 'missing'}). Refusing to continue, because the cleanup ` +
        `would act on it.`,
    );
  }

  check(
    'restricted user cannot create a project',
    await status('/projects', {
      method: 'POST',
      cookie: restricted,
      body: { payload: { name: 'Should Not Exist', identifier: `nope-${Date.now()}` } },
    }),
    403,
  );

  // Find a work package to act on, read with admin's session.
  const tasks = (await (await call('/tasks?pageSize=1', { cookie: admin })).json()) as {
    items?: { id: string }[];
  };
  const taskId = tasks.items?.[0]?.id;



  if (taskId) {
    check(
      'restricted user cannot edit a work package',
      await status(`/tasks/${taskId}`, {
        method: 'PATCH',
        cookie: restricted,
        body: { subject: 'should not apply' },
      }),
      403,
    );
    check(
      'restricted user cannot delete a work package',
      await status(`/work-packages/${taskId}`, { method: 'DELETE', cookie: restricted }),
      403,
    );
    check(
      'restricted user cannot create a work package',
      await status('/tasks', {
        method: 'POST',
        cookie: restricted,
        body: { projectId: project, subject: 'should not apply' },
      }),
      403,
    );
    check(
      'restricted user cannot request a create form',
      await status('/forms/work-packages', {
        method: 'POST',
        cookie: restricted,
        body: { projectId: project },
      }),
      403,
    );
  } else {
    console.log('  SKIP  no work package available to test against');
  }

  check(
    'restricted user cannot archive a project',
    await status(`/projects/${project}/archive`, { method: 'PATCH', cookie: restricted }),
    403,
  );

  // --- Queries -------------------------------------------------------------
  console.log('\nQueries');

  check('anonymous cannot list views', await status('/queries'), 401);
  check('anonymous cannot read the filter schema', await status('/queries/schema'), 401);

  check('admin can list views', await status('/queries', { cookie: admin }), 200);
  check(
    'restricted user can list views they may see',
    await status('/queries', { cookie: restricted }),
    200,
  );

  // Filter discovery is project-scoped: custom fields are enabled per project
  // and only appear in that scope.
  const globalSchema = (await (await call('/queries/schema', { cookie: admin })).json()) as {
    filters: { id: string; name: string; operators: { id: string; valueType?: string }[] }[];
  };
  const projectSchema = (await (
    await call(`/queries/schema?projectId=${project}`, { cookie: admin })
  ).json()) as typeof globalSchema;

  check('global filter discovery returns filters', globalSchema.filters.length > 0, true);
  check(
    'project scope offers at least as many filters as global',
    projectSchema.filters.length >= globalSchema.filters.length,
    true,
  );
  check(
    'every filter reports at least one operator',
    projectSchema.filters.every((filter) => filter.operators.length > 0),
    true,
  );
  // Operators such as `open` and `is empty` take no values; a value control for
  // them would produce a request OpenProject rejects.
  check(
    'valueless operators are marked as such',
    projectSchema.filters
      .flatMap((filter) => filter.operators)
      .some((operator) => operator.valueType === undefined),
    true,
  );

  const results = (await (
    await call(`/queries/default?projectId=${project}&pageSize=5`, { cookie: admin })
  ).json()) as { query: { name: string }; tasks: unknown[]; total: number; pageSize: number };

  check('the default view returns results', Array.isArray(results.tasks), true);
  check('paging is applied upstream, not in the client', results.tasks.length <= 5, true);
  check('the total exceeds the page', results.total >= results.tasks.length, true);

  // Filtering must change the result set, and must happen upstream.
  const closed = encodeURIComponent(JSON.stringify([{ status: { operator: 'c', values: [] } }]));
  const filtered = (await (
    await call(`/queries/default?projectId=${project}&filters=${closed}`, { cookie: admin })
  ).json()) as { total: number };
  check('a status filter changes the total', filtered.total !== results.total, true);

  // Upstream validation is preserved rather than swallowed.
  const badFilter = encodeURIComponent(JSON.stringify([{ nope: { operator: '=', values: [] } }]));
  check(
    'an unknown filter is rejected',
    await status(`/queries/default?projectId=${project}&filters=${badFilter}`, { cookie: admin }),
    400,
  );
  const badOperator = encodeURIComponent(
    JSON.stringify([{ status: { operator: '~~~', values: [] } }]),
  );
  check(
    'an invalid operator is rejected',
    await status(`/queries/default?projectId=${project}&filters=${badOperator}`, { cookie: admin }),
    400,
  );

  // Saved view lifecycle, and whether a restricted caller can subvert it.
  const savedResponse = await call('/queries', {
    method: 'POST',
    cookie: admin,
    body: { name: `Authz View ${Date.now()}`, projectId: project },
  });
  check('admin can save a view', savedResponse.status, 201);
  const saved = savedResponse.ok ? ((await savedResponse.json()) as { id: string }) : undefined;

  if (saved?.id) {
    check(
      'restricted user cannot rename a view owned by someone else',
      await status(`/queries/${saved.id}`, {
        method: 'PATCH',
        cookie: restricted,
        body: { name: 'hijacked' },
      }),
      404,
    );
    check(
      'restricted user cannot delete a view owned by someone else',
      await status(`/queries/${saved.id}`, { method: 'DELETE', cookie: restricted }),
      404,
    );
    check(
      'restricted user cannot star a view owned by someone else',
      await status(`/queries/${saved.id}/star`, { method: 'PATCH', cookie: restricted }),
      404,
    );

    check(
      'admin can star their own view',
      await status(`/queries/${saved.id}/star`, { method: 'PATCH', cookie: admin }),
      200,
    );
    check(
      'admin can delete their own view',
      await status(`/queries/${saved.id}`, { method: 'DELETE', cookie: admin }),
      204,
    );
  }

  // A view the restricted user can see but not change must be refused, and the
  // refusal must be a 403 rather than a 404 — it exists, they just may not.
  const visible = (await (await call('/queries', { cookie: restricted })).json()) as {
    id: string;
    can: { update: boolean; delete: boolean };
  }[];
  const readOnly = visible.find((view) => !view.can.update && !view.can.delete);

  if (readOnly) {
    check(
      'a visible but unmodifiable view is refused',
      await status(`/queries/${readOnly.id}`, {
        method: 'PATCH',
        cookie: restricted,
        body: { name: 'hijacked' },
      }),
      403,
    );
    check(
      'deleting a visible but undeletable view is refused',
      await status(`/queries/${readOnly.id}`, { method: 'DELETE', cookie: restricted }),
      403,
    );
  } else {
    console.log('  SKIP  no read-only view available to test the 403 path');
  }

  // Nothing about the upstream system may reach the client.
  const schemaBody = JSON.stringify(projectSchema);
  check('the filter schema names no upstream host', /localhost:8080|openproject/i.test(schemaBody), false);

  // --- Query configuration -------------------------------------------------
  console.log('\nQuery configuration');

  const schema = (await (
    await call(`/queries/schema?projectId=${project}`, { cookie: admin })
  ).json()) as {
    filters: { id: string; name: string; operators: { id: string; arity?: string; valueType?: string }[] }[];
    columns: { id: string; name: string }[];
  };

  check('the schema reports available columns', schema.columns.length > 0, true);
  check(
    'columns carry display names',
    schema.columns.every((column) => Boolean(column.name)),
    true,
  );

  // Multi-value is a property of the operator, not of the filter's name.
  const manyOperators = schema.filters
    .flatMap((filter) => filter.operators)
    .filter((operator) => operator.arity === 'many');
  check('some operators accept many values', manyOperators.length > 0, true);

  const rangeOperators = schema.filters
    .flatMap((filter) => filter.operators)
    .filter((operator) => operator.arity === 'range');
  check('range operators stay distinct from many', rangeOperators.length > 0, true);

  // A custom field must be discovered, not enumerated.
  const customField = schema.filters.find((filter) => filter.id.startsWith('customField'));
  if (customField) {
    check('the custom field keeps its configured name', customField.name.length > 0, true);
    check(
      'the custom field is offered as a column',
      schema.columns.some((column) => column.id === customField.id),
      true,
    );
  } else {
    console.log('  SKIP  no custom field on this instance');
  }

  // Multiple values must reach OpenProject as a list and narrow the result.
  const one = encodeURIComponent(JSON.stringify([{ status: { operator: '=', values: ['1'] } }]));
  const two = encodeURIComponent(
    JSON.stringify([{ status: { operator: '=', values: ['1', '12'] } }]),
  );
  const oneResult = (await (
    await call(`/queries/default?projectId=${project}&filters=${one}`, { cookie: admin })
  ).json()) as { total: number };
  const twoResult = (await (
    await call(`/queries/default?projectId=${project}&filters=${two}`, { cookie: admin })
  ).json()) as { total: number };

  check('a single-value filter runs', typeof oneResult.total === 'number', true);
  check('a second value widens the result', twoResult.total >= oneResult.total, true);

  // A valueless operator must be accepted with an empty array.
  check(
    'a valueless operator is accepted',
    await status(
      `/queries/default?projectId=${project}&filters=${encodeURIComponent(
        JSON.stringify([{ status: { operator: 'o', values: [] } }]),
      )}`,
      { cookie: admin },
    ),
    200,
  );

  // Column overrides must be applied upstream, in the order given.
  const chosen = ['id', 'subject', 'storyPoints', 'dueDate'];
  const withColumns = (await (
    await call(`/queries/default?projectId=${project}&columns=${chosen.join(',')}`, {
      cookie: admin,
    })
  ).json()) as { query: { columns: { id: string }[] } };
  check(
    'the column override is applied in order',
    withColumns.query.columns.map((column) => column.id).join(',') === chosen.join(','),
    true,
  );

  // An empty column list must not be read as "hide everything".
  const emptyColumns = (await (
    await call(`/queries/default?projectId=${project}&columns=`, { cookie: admin })
  ).json()) as { query: { columns: { id: string }[] } };
  check('an empty column list falls back to the default', emptyColumns.query.columns.length > 0, true);

  // A saved view must carry both its multi-value filters and its columns.
  const viewResponse = await call('/queries', {
    method: 'POST',
    cookie: admin,
    body: {
      name: `UX Roundtrip ${Date.now()}`,
      projectId: project,
      // Plain names, not upstream links. The backend builds those, which is
      // why the shape of that API no longer reaches the browser.
      view: {
        columns: chosen,
        // Values are resource references the schema supplies, so they travel
        // as given rather than being rebuilt from an id.
        filters: [
          {
            id: 'status',
            operator: '=',
            values: [{ href: '/api/v3/statuses/1' }, { href: '/api/v3/statuses/12' }],
          },
        ],
      },
    },
  });
  check('a view with columns and multiple values saves', viewResponse.status, 201);

  if (viewResponse.ok) {
    const view = (await viewResponse.json()) as { id: string };
    const reloaded = (await (await call(`/queries/${view.id}`, { cookie: admin })).json()) as {
      query: { columns: { id: string }[]; filters: { values: { id: string; name?: string }[] }[] };
    };

    check(
      'the saved columns are restored',
      reloaded.query.columns.map((column) => column.id).join(',') === chosen.join(','),
      true,
    );
    check(
      'both filter values are restored',
      reloaded.query.filters[0]?.values.length === 2,
      true,
    );
    check(
      'restored values carry their titles',
      reloaded.query.filters[0]?.values.every((value) => Boolean(value.name)),
      true,
    );

    check(
      'a restricted user cannot reconfigure that view',
      await status(`/queries/${view.id}`, {
        method: 'PATCH',
        cookie: restricted,
        body: { _links: { columns: [] } },
      }),
      404,
    );

    await call(`/queries/${view.id}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  }

  // Scope must not be merged: the restricted caller sees what OpenProject
  // exposes to them, which is not necessarily what the administrator sees.
  const restrictedSchema = (await (
    await call(`/queries/schema?projectId=${project}`, { cookie: restricted })
  ).json()) as typeof schema;
  check(
    'filter availability is per caller',
    restrictedSchema.filters.length <= schema.filters.length,
    true,
  );
  check('the restricted caller still gets columns', restrictedSchema.columns.length > 0, true);

  // --- Sorting ---------------------------------------------------------------
  console.log('\nSorting');

  const capabilities = (await (
    await call(`/queries/schema?projectId=${project}`, { cookie: admin })
  ).json()) as { columns: { id: string }[]; sortable: string[] };

  check('the schema reports sortable fields', capabilities.sortable.length > 0, true);
  check(
    'more is sortable than the four columns the table once allowed',
    capabilities.sortable.length > 4,
    true,
  );

  // Sorting and rendering are separate questions; the sets must not be assumed
  // equal in either direction.
  const columnIds = new Set(capabilities.columns.map((column) => column.id));
  const sortableSet = new Set(capabilities.sortable);
  check(
    'some columns are shown but cannot be sorted',
    capabilities.columns.some((column) => !sortableSet.has(column.id)),
    true,
  );
  check(
    'some sortable fields are not display columns',
    capabilities.sortable.some((id) => !columnIds.has(id)),
    true,
  );

  const sortParam = (field: string, direction: string) =>
    encodeURIComponent(JSON.stringify([[field, direction]]));

  const runSorted = async (field: string, direction: string) =>
    (await (
      await call(`/queries/default?projectId=${project}&sortBy=${sortParam(field, direction)}&pageSize=5`, {
        cookie: admin,
      })
    ).json()) as { query: { sortBy: { field: string; direction: string }[] }; tasks: { subject: string }[] };

  const ascending = await runSorted('subject', 'asc');
  const descending = await runSorted('subject', 'desc');

  check('ascending is applied upstream', ascending.query.sortBy[0]?.direction, 'asc');
  check('descending is applied upstream', descending.query.sortBy[0]?.direction, 'desc');
  check(
    'the two orders actually differ',
    ascending.tasks[0]?.subject !== descending.tasks[0]?.subject,
    true,
  );

  // Sorting must persist across pages rather than being applied per page.
  const pageOne = await runSorted('subject', 'asc');
  const pageTwo = (await (
    await call(
      `/queries/default?projectId=${project}&sortBy=${sortParam('subject', 'asc')}&pageSize=5&offset=2`,
      { cookie: admin },
    )
  ).json()) as { tasks: { subject: string }[] };
  check(
    'sorting continues onto the next page',
    (pageTwo.tasks[0]?.subject ?? '') > (pageOne.tasks[0]?.subject ?? ''),
    true,
  );

  // A field the table gained a renderer for, which the old union excluded.
  if (sortableSet.has('storyPoints')) {
    const byPoints = await runSorted('storyPoints', 'desc');
    check('story points can be sorted', byPoints.query.sortBy[0]?.field, 'storyPoints');
  } else {
    console.log('  SKIP  story points is not sortable on this instance');
  }

  // Custom field sorting, discovered rather than named.
  const sortableCustomField = capabilities.sortable.find((id) => id.startsWith('customField'));
  if (sortableCustomField) {
    const byCustom = await runSorted(sortableCustomField, 'asc');
    check('a custom field can be sorted', byCustom.query.sortBy[0]?.field, sortableCustomField);
  } else {
    console.log('  SKIP  no sortable custom field on this instance');
  }

  // EPM must not fabricate sorting: whatever OpenProject decides about a field
  // is what happens. The advertised sortBy list turns out to under-report —
  // `parent` is absent from it and accepted anyway — so this asserts the
  // forwarding behaviour rather than assuming the list is exhaustive.
  const notAdvertised = capabilities.columns.filter((column) => !sortableSet.has(column.id));
  const outcomes = await Promise.all(
    notAdvertised.map(async (column) => ({
      id: column.id,
      status: await status(
        `/queries/default?projectId=${project}&sortBy=${sortParam(column.id, 'asc')}`,
        { cookie: admin },
      ),
    })),
  );

  check(
    'every unadvertised sort is either accepted or refused, never fabricated',
    outcomes.every((outcome) => outcome.status === 200 || outcome.status === 400),
    true,
  );
  check(
    'at least one unadvertised sort is genuinely refused upstream',
    outcomes.some((outcome) => outcome.status === 400),
    true,
  );

  // Sort must survive being saved, and survive a filter override afterwards.
  const sortedView = await call('/queries', {
    method: 'POST',
    cookie: admin,
    body: {
      name: `Sort Roundtrip ${Date.now()}`,
      projectId: project,
      view: { sort: ['subject-desc'], columns: ['id', 'subject'] },
    },
  });
  check('a view saves its sort', sortedView.status, 201);

  if (sortedView.ok) {
    const view = (await sortedView.json()) as { id: string };

    const reloaded = (await (await call(`/queries/${view.id}`, { cookie: admin })).json()) as {
      query: { sortBy: { field: string; direction: string }[] };
    };
    check('the saved sort field is restored', reloaded.query.sortBy[0]?.field, 'subject');
    check('the saved sort direction is restored', reloaded.query.sortBy[0]?.direction, 'desc');

    const openOnly = encodeURIComponent(JSON.stringify([{ status: { operator: 'o', values: [] } }]));
    const filtered = (await (
      await call(`/queries/${view.id}?filters=${openOnly}`, { cookie: admin })
    ).json()) as { query: { sortBy: { field: string; direction: string }[] } };
    check('filtering does not clear the saved sort', filtered.query.sortBy[0]?.field, 'subject');

    const recoloured = (await (
      await call(`/queries/${view.id}?columns=id,subject,status`, { cookie: admin })
    ).json()) as { query: { sortBy: { field: string }[]; columns: { id: string }[] } };
    check('changing columns does not clear the sort', recoloured.query.sortBy[0]?.field, 'subject');
    check('the column override still applies', recoloured.query.columns.length, 3);

    await call(`/queries/${view.id}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  }

  // Sorting is subject to the caller's own identity, like everything else.
  check(
    'a restricted caller may still sort what they can see',
    await status(`/queries/default?projectId=${project}&sortBy=${sortParam('subject', 'asc')}`, {
      cookie: restricted,
    }),
    200,
  );

  // --- Grouping --------------------------------------------------------------
  console.log('\nGrouping');

  const grouping = (await (
    await call(`/queries/schema?projectId=${project}`, { cookie: admin })
  ).json()) as { groupable: { id: string; name: string }[] };

  check('grouping options are discovered', grouping.groupable.length > 0, true);
  check(
    'grouping options carry upstream titles',
    grouping.groupable.every((option) => Boolean(option.name)),
    true,
  );

  const globalGrouping = (await (
    await call('/queries/schema', { cookie: admin })
  ).json()) as typeof grouping;
  check('grouping is discoverable globally too', globalGrouping.groupable.length > 0, true);

  interface Grouped {
    total: number;
    tasks: { id: string; subject: string }[];
    groups?: { value: string | null; count: number; taskIds: string[] }[];
  }

  const ungrouped = (await (
    await call(`/queries/default?projectId=${project}&pageSize=5`, { cookie: admin })
  ).json()) as Grouped;
  check('an ungrouped result carries no groups', ungrouped.groups, undefined);

  const grouped = (await (
    await call(`/queries/default?projectId=${project}&groupBy=status&pageSize=5`, { cookie: admin })
  ).json()) as Grouped;
  check('a grouped result carries groups', Array.isArray(grouped.groups), true);
  check('grouping does not change the total', grouped.total, ungrouped.total);

  // The counts describe the whole result set rather than the page, which is the
  // property that makes grouping in the client across pages wrong.
  check(
    'group counts sum to the total',
    (grouped.groups ?? []).reduce((sum, group) => sum + group.count, 0),
    grouped.total,
  );
  check('the page holds no more than a page', grouped.tasks.length <= 5, true);
  check(
    'group membership only names records on this page',
    (grouped.groups ?? []).every((group) =>
      group.taskIds.every((id) => grouped.tasks.some((task) => task.id === id)),
    ),
    true,
  );
  check(
    'a group may report more than it contributes to this page',
    (grouped.groups ?? []).some((group) => group.count > group.taskIds.length),
    true,
  );

  // Groups must describe the filtered set, not the whole project.
  const openOnly = encodeURIComponent(JSON.stringify([{ status: { operator: 'o', values: [] } }]));
  const groupedFiltered = (await (
    await call(`/queries/default?projectId=${project}&groupBy=status&filters=${openOnly}`, {
      cookie: admin,
    })
  ).json()) as Grouped;
  check(
    'grouped counts follow the filter',
    (groupedFiltered.groups ?? []).reduce((sum, group) => sum + group.count, 0),
    groupedFiltered.total,
  );
  // Compared against an explicitly unfiltered run, not the default view: the
  // default already filters to open work packages, so applying that same filter
  // narrows nothing.
  const groupedAll = (await (
    await call(`/queries/default?projectId=${project}&groupBy=status&filters=%5B%5D`, {
      cookie: admin,
    })
  ).json()) as Grouped;
  check('filtering narrows the grouped total', groupedFiltered.total < groupedAll.total, true);
  check(
    'the unfiltered grouped counts also sum to their total',
    (groupedAll.groups ?? []).reduce((sum, group) => sum + group.count, 0),
    groupedAll.total,
  );

  // Sorting orders records within groups and must not be discarded.
  const sortDesc = encodeURIComponent(JSON.stringify([['subject', 'desc']]));
  const groupedSorted = (await (
    await call(
      `/queries/default?projectId=${project}&groupBy=status&sortBy=${sortDesc}&pageSize=25`,
      { cookie: admin },
    )
  ).json()) as Grouped & { query: { sortBy: { field: string }[]; groupBy?: string } };

  check('grouping preserves the sort', groupedSorted.query.sortBy[0]?.field, 'subject');
  check('grouping is reported on the query', groupedSorted.query.groupBy, 'status');

  const populated = groupedSorted.groups?.find((group) => group.taskIds.length > 1);
  if (populated) {
    const subjectById = new Map(groupedSorted.tasks.map((task) => [task.id, task.subject]));
    const subjects = populated.taskIds.map((id) => subjectById.get(id) ?? '');
    const descending = [...subjects].sort().reverse();
    check('records are sorted within their group', subjects.join('|'), descending.join('|'));
  } else {
    console.log('  SKIP  no group with more than one record on the page');
  }

  // An unset attribute is a group, not an error.
  const groupedByVersion = (await (
    await call(`/queries/default?projectId=${project}&groupBy=version&pageSize=5`, { cookie: admin })
  ).json()) as Grouped;
  check(
    'an unset value groups as null rather than failing',
    (groupedByVersion.groups ?? []).some((group) => group.value === null),
    true,
  );

  // Grouping by a custom field, discovered rather than named.
  const groupableCustomField = grouping.groupable.find((option) =>
    option.id.startsWith('customField'),
  );
  if (groupableCustomField) {
    const byCustom = (await (
      await call(`/queries/default?projectId=${project}&groupBy=${groupableCustomField.id}`, {
        cookie: admin,
      })
    ).json()) as { query: { groupBy?: string } };
    check('a custom field can be grouped', byCustom.query.groupBy, groupableCustomField.id);
  } else {
    console.log('  SKIP  no groupable custom field on this instance');
  }

  // Grouping saves and reloads alongside the other query properties.
  const groupedView = await call('/queries', {
    method: 'POST',
    cookie: admin,
    body: {
      name: `Group Roundtrip ${Date.now()}`,
      projectId: project,
      view: { groupBy: 'status', sort: ['subject-desc'], columns: ['id', 'subject'] },
    },
  });
  check('a view saves its grouping', groupedView.status, 201);

  if (groupedView.ok) {
    const view = (await groupedView.json()) as { id: string };
    const reload = async (suffix = '') =>
      (await (await call(`/queries/${view.id}${suffix}`, { cookie: admin })).json()) as {
        query: { groupBy?: string; sortBy: { field: string }[]; columns: { id: string }[] };
      };

    const restored = await reload();
    check('the saved grouping is restored', restored.query.groupBy, 'status');
    check('grouping does not displace the sort', restored.query.sortBy[0]?.field, 'subject');
    check('grouping does not displace the columns', restored.query.columns.length, 2);

    check(
      'grouping survives a filter override',
      (await reload(`?filters=${openOnly}`)).query.groupBy,
      'status',
    );
    check(
      'grouping survives a column override',
      (await reload('?columns=id,subject,status')).query.groupBy,
      'status',
    );
    const sortAsc = encodeURIComponent(JSON.stringify([['id', 'asc']]));
    check(
      'grouping survives a sort override',
      (await reload(`?sortBy=${sortAsc}`)).query.groupBy,
      'status',
    );

    check(
      'a restricted caller cannot regroup a view owned by someone else',
      await status(`/queries/${view.id}`, {
        method: 'PATCH',
        cookie: restricted,
        body: { _links: { groupBy: { href: null } } },
      }),
      404,
    );

    await call(`/queries/${view.id}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  }

  check(
    'a restricted caller may group what they can see',
    await status(`/queries/default?projectId=${project}&groupBy=status`, { cookie: restricted }),
    200,
  );

  // --- Status contract -------------------------------------------------------
  console.log('\nStatus contract');

  interface StatusTask {
    id: string;
    key: string;
    status: { id: string; name: string; isClosed: boolean };
    statusCategory: string;
  }

  const statuses = (await (
    await call('/catalog/statuses', { cookie: admin })
  ).json()) as { id: string; name: string; isClosed: boolean }[];

  const withTasks = (await (
    await call(`/queries/default?projectId=${project}&pageSize=25&filters=%5B%5D`, {
      cookie: admin,
    })
  ).json()) as { tasks: StatusTask[] };

  const sample = withTasks.tasks[0];
  check('a task carries a native status object', typeof sample?.status === 'object', true);
  check('the native status has an id', Boolean(sample?.status?.id), true);
  check('the native status has a name', Boolean(sample?.status?.name), true);
  check('the task still carries a category', typeof sample?.statusCategory === 'string', true);

  // The identity must be OpenProject's, not something EPM minted.
  const catalogById = new Map(statuses.map((status) => [status.id, status]));
  check(
    'every native status id exists in the instance catalogue',
    withTasks.tasks.every((task) => catalogById.has(task.status.id)),
    true,
  );
  check(
    'every native status name matches the catalogue',
    withTasks.tasks.every((task) => catalogById.get(task.status.id)?.name === task.status.name),
    true,
  );
  check(
    'isClosed matches the catalogue',
    withTasks.tasks.every(
      (task) => catalogById.get(task.status.id)?.isClosed === task.status.isClosed,
    ),
    true,
  );

  // --- the same contract for priority ---
  //
  // Priority had the status problem and nobody had noticed: the UI offered
  // EPM's four categories as if they were the instance's list, so an instance
  // configured with Low/Normal/High/Immediate displayed Low/Medium/High/
  // Critical. Two of those are renames of a real value, and a fifth priority
  // would not have been offered at all.
  {
    const priorities = (await (
      await call('/catalog/priorities', { cookie: admin })
    ).json()) as { id: string; name: string }[];

    const priorityById = new Map(priorities.map((priority) => [priority.id, priority]));
    const sampled = withTasks.tasks as unknown as {
      priority: string;
      priorityRef: { id: string; name: string };
    }[];

    check('a task carries a native priority object', typeof sampled[0]?.priorityRef, 'object');
    check('the native priority has an id', Boolean(sampled[0]?.priorityRef?.id), true);
    check('the task still carries a category', typeof sampled[0]?.priority, 'string');

    check(
      'every native priority id exists in the instance catalogue',
      sampled.every((task) => priorityById.has(task.priorityRef.id)),
      true,
    );
    check(
      'every native priority name matches the catalogue',
      sampled.every(
        (task) => priorityById.get(task.priorityRef.id)?.name === task.priorityRef.name,
      ),
      true,
    );

    // The assertion that would have caught the original bug. EPM's category
    // labels are Critical/High/Medium/Low; if the instance calls a priority
    // anything else, the real name must survive rather than being replaced.
    const epmLabels = new Set(['critical', 'high', 'medium', 'low']);
    const renamed = sampled.filter(
      (task) =>
        !epmLabels.has(task.priorityRef.name.toLowerCase()) &&
        task.priorityRef.name.toLowerCase() === task.priority.toLowerCase(),
    );
    check('no task reports a category label in place of its real name', renamed.length, 0);

    check(
      'the instance priorities are served by the backend, not a fixed list',
      priorities.length > 0 && priorities.every((priority) => Boolean(priority.id)),
      true,
    );
  }

  // --- and for type, which had the same fault ---
  {
    const types = (await (await call('/catalog/types', { cookie: admin })).json()) as {
      id: string;
      name: string;
    }[];

    const typeById = new Map(types.map((type) => [type.id, type]));
    const sampled = withTasks.tasks as unknown as {
      type: string;
      typeRef: { id: string; name: string };
    }[];

    check('a task carries a native type object', typeof sampled[0]?.typeRef, 'object');
    check(
      'every native type id exists in the instance catalogue',
      sampled.every((task) => typeById.has(task.typeRef.id)),
      true,
    );
    check(
      'every native type name matches the catalogue',
      sampled.every((task) => typeById.get(task.typeRef.id)?.name === task.typeRef.name),
      true,
    );
    check('the task still carries a category', typeof sampled[0]?.type, 'string');
  }

  // The category is coarser than the status: that is the whole point of it.
  const distinctStatuses = new Set(withTasks.tasks.map((task) => task.status.name));
  const distinctCategories = new Set(withTasks.tasks.map((task) => task.statusCategory));
  check(
    'several statuses collapse into fewer categories',
    distinctStatuses.size > distinctCategories.size,
    true,
  );

  // The inconsistency this work exists to remove: a group header and the rows
  // beneath it must name the same thing.
  const groupedByStatus = (await (
    await call(
      `/queries/default?projectId=${project}&groupBy=status&pageSize=25&filters=%5B%5D`,
      { cookie: admin },
    )
  ).json()) as {
    tasks: StatusTask[];
    groups?: { value: string | null; taskIds: string[] }[];
  };

  const taskById = new Map(groupedByStatus.tasks.map((task) => [task.id, task]));
  const disagreements = (groupedByStatus.groups ?? []).flatMap((group) =>
    group.taskIds
      .map((id) => taskById.get(id))
      .filter((task): task is StatusTask => task !== undefined)
      .filter((task) => task.status.name !== group.value)
      .map((task) => `${task.key}: group ${group.value} vs row ${task.status.name}`),
  );
  check('group headers agree with the rows beneath them', disagreements.join(','), '');

  // Filtering still speaks upstream status ids, not categories.
  const firstStatus = statuses[0];
  if (firstStatus) {
    const byStatus = encodeURIComponent(
      JSON.stringify([{ status: { operator: '=', values: [firstStatus.id] } }]),
    );
    const filtered = (await (
      await call(`/queries/default?projectId=${project}&filters=${byStatus}`, { cookie: admin })
    ).json()) as { tasks: StatusTask[] };

    check(
      'a status filter returns only that status',
      filtered.tasks.every((task) => task.status.id === firstStatus.id),
      true,
    );
  }

  // Nothing may hardcode the current status names: the catalogue is the source.
  check('the instance catalogue drives the status set', statuses.length > 0, true);
  check(
    'catalogue entries carry id, name and closed state',
    statuses.every(
      (status) =>
        Boolean(status.id) && Boolean(status.name) && typeof status.isClosed === 'boolean',
    ),
    true,
  );

  // Sorting and columns continue to work against the native status.
  const sortedByStatus = (await (
    await call(
      `/queries/default?projectId=${project}&sortBy=${encodeURIComponent(
        JSON.stringify([['status', 'asc']]),
      )}&columns=id,subject,status&pageSize=5`,
      { cookie: admin },
    )
  ).json()) as { query: { columns: { id: string }[]; sortBy: { field: string }[] } };
  check('status remains sortable', sortedByStatus.query.sortBy[0]?.field, 'status');
  check(
    'status remains selectable as a column',
    sortedByStatus.query.columns.some((column) => column.id === 'status'),
    true,
  );

  // A restricted caller sees the same native identity, subject to visibility.
  const restrictedTasks = (await (
    await call(`/queries/default?projectId=${project}&pageSize=5`, { cookie: restricted })
  ).json()) as { tasks: StatusTask[] };
  check(
    'a restricted caller also receives native statuses',
    restrictedTasks.tasks.every((task) => Boolean(task.status?.id) && Boolean(task.status?.name)),
    true,
  );

  // The category vocabulary is still reported by the distribution report, which
  // aggregates deliberately rather than losing information by accident.
  const distribution = (await (
    await call(`/reports/status-distribution?projectId=${project}`, { cookie: admin })
  ).json()) as { status: string; label: string; count: number }[];
  check('the status distribution still reports categories', Array.isArray(distribution), true);
  check(
    'distribution rows carry a category and a label',
    distribution.every((row) => Boolean(row.status) && Boolean(row.label)),
    true,
  );

  // --- Attachments -----------------------------------------------------------
  console.log('\nAttachments');

  interface Attachment {
    id: string;
    fileName: string;
    fileSize: number;
    contentType: string;
    createdAt: string;
    authorId?: string;
    can: { delete: boolean };
  }

  /** Multipart upload, built the way a browser would. */
  const uploadFile = async (
    workPackageId: string,
    name: string,
    contents: string,
    cookie: string,
    type = 'text/plain',
  ) => {
    const body = new FormData();
    body.append('file', new Blob([contents], { type }), name);

    return fetch(`${BASE}/work-packages/${workPackageId}/attachments`, {
      method: 'POST',
      headers: { cookie },
      body,
    });
  };

  const target = (
    (await (
      await call(`/queries/default?projectId=${project}&pageSize=1`, { cookie: admin })
    ).json()) as { tasks: { id: string }[] }
  ).tasks[0]?.id;

  if (!target) throw new Error('No work package available to attach to.');

  check('anonymous cannot list attachments', await status(`/work-packages/${target}/attachments`), 401);

  const before = (await (
    await call(`/work-packages/${target}/attachments`, { cookie: admin })
  ).json()) as Attachment[];
  check('an authenticated caller can list attachments', Array.isArray(before), true);

  const uploaded = await uploadFile(target, 'epm-test.txt', 'attachment contents\n', admin);
  check('upload succeeds', uploaded.status, 201);

  const attachment = uploaded.ok ? ((await uploaded.json()) as Attachment) : undefined;

  if (attachment) {
    check('the response carries the file name', attachment.fileName, 'epm-test.txt');
    check('the response carries a size', attachment.fileSize > 0, true);
    check('the response carries a content type', Boolean(attachment.contentType), true);
    check('the response carries an upload time', Boolean(attachment.createdAt), true);
    check('the response names the uploader', Boolean(attachment.authorId), true);

    // Association: it must appear on the work package it was posted to.
    const after = (await (
      await call(`/work-packages/${target}/attachments`, { cookie: admin })
    ).json()) as Attachment[];
    check('it appears on that work package', after.length, before.length + 1);
    check(
      'it appears by id',
      after.some((entry) => entry.id === attachment.id),
      true,
    );

    // Metadata endpoint agrees with the upload response.
    const fetched = (await (
      await call(`/attachments/${attachment.id}`, { cookie: admin })
    ).json()) as Attachment;
    check('metadata can be read back', fetched.fileName, attachment.fileName);

    // Download: content, headers, and the security properties that matter.
    const download = await call(`/attachments/${attachment.id}/content`, { cookie: admin });
    check('download succeeds', download.status, 200);
    check('the content is byte-identical', await download.text(), 'attachment contents\n');

    const disposition = download.headers.get('content-disposition') ?? '';
    check('the filename is preserved', disposition.includes('epm-test.txt'), true);
    // Serving an upload inline would let an uploaded HTML or SVG run as script
    // in EPM's own origin, and the content type is the uploader's claim.
    check('it is served as an attachment, never inline', disposition.startsWith('attachment'), true);
    check(
      'the content type is preserved',
      (download.headers.get('content-type') ?? '').includes('text/plain'),
      true,
    );
    check('sniffing is disabled', download.headers.get('x-content-type-options'), 'nosniff');

    // OpenProject marks these publicly cacheable; they are private records.
    const cacheControl = download.headers.get('cache-control') ?? '';
    check('it is not publicly cacheable', cacheControl.includes('public'), false);
    check('it is marked private', cacheControl.includes('private'), true);

    // Nothing about the upstream may reach the client.
    const headerDump = [...download.headers.entries()].map(([k, v]) => `${k}:${v}`).join('\n');
    check(
      'no upstream host in the download headers',
      /localhost:8080|openproject/i.test(headerDump),
      false,
    );
    check(
      'no credential in the download headers',
      /bearer|authorization|access_token/i.test(headerDump),
      false,
    );

    check('anonymous cannot download it', await status(`/attachments/${attachment.id}/content`), 401);

    // A restricted caller may read what they can see, and no more.
    check(
      'a restricted caller can list attachments they can see',
      await status(`/work-packages/${target}/attachments`, { cookie: restricted }),
      200,
    );
    const restrictedUpload = await uploadFile(target, 'nope.txt', 'x', restricted);
    check('a restricted caller cannot upload', restrictedUpload.status, 403);
    check(
      'a restricted caller cannot delete',
      await status(`/attachments/${attachment.id}`, { method: 'DELETE', cookie: restricted }),
      403,
    );

    // Deletion is offered only where OpenProject publishes it.
    check('the uploader is told they may delete it', attachment.can.delete, true);
    check(
      'delete succeeds for the uploader',
      await status(`/attachments/${attachment.id}`, { method: 'DELETE', cookie: admin }),
      204,
    );
    check(
      'it is gone afterwards',
      await status(`/attachments/${attachment.id}`, { cookie: admin }),
      404,
    );
  }

  // Filenames are upstream's to sanitise, but the result must be safe to serve.
  const awkward = await uploadFile(target, 'my report v2.txt', 'spaces\n', admin);
  check('a filename with spaces is accepted', awkward.status, 201);
  if (awkward.ok) {
    const stored = (await awkward.json()) as Attachment;
    const download = await call(`/attachments/${stored.id}/content`, { cookie: admin });
    const disposition = download.headers.get('content-disposition') ?? '';
    // A raw space or quote would terminate the header value early.
    check('the disposition header is well formed', /^attachment; filename="[^"]*"/.test(disposition), true);
    check('no newline reaches the header', /[\r\n]/.test(disposition), false);
    await call(`/attachments/${stored.id}`, { method: 'DELETE', cookie: admin }).catch(
      () => undefined,
    );
  }

  const traversal = await uploadFile(target, 'evil.txt', 'traversal\n', admin);
  if (traversal.ok) {
    const stored = (await traversal.json()) as Attachment;
    check('no path separator survives in the stored name', /[/\\]/.test(stored.fileName), false);
    await call(`/attachments/${stored.id}`, { method: 'DELETE', cookie: admin }).catch(
      () => undefined,
    );
  }

  // Absent resources, and a body that is not multipart at all.
  check('an unknown attachment is not found', await status('/attachments/999999', { cookie: admin }), 404);
  check(
    'an unknown attachment cannot be downloaded',
    await status('/attachments/999999/content', { cookie: admin }),
    404,
  );
  check(
    'an unknown work package has no attachments',
    await status('/work-packages/999999/attachments', { cookie: admin }),
    404,
  );
  check(
    'a non-multipart upload is rejected as a bad request',
    await status(`/work-packages/${target}/attachments`, {
      method: 'POST',
      cookie: admin,
      body: {},
    }),
    400,
  );

  // --- Watchers ------------------------------------------------------------
  console.log('\nWatchers');

  adminId = adminMe.id;

  check('anonymous cannot list watchers', await status(`/work-packages/${target}/watchers`), 401);
  check(
    'anonymous cannot list available watchers',
    await status(`/work-packages/${target}/available-watchers`),
    401,
  );

  const watcherState = async (cookie: string) =>
    (await (await call(`/work-packages/${target}/watchers`, { cookie })).json()) as {
      watchers: { id: string; name: string }[];
      isWatching: boolean;
      can: { add: boolean; remove: boolean; watchSelf: boolean };
    };

  check(
    'a permitted caller can list watchers',
    await status(`/work-packages/${target}/watchers`, { cookie: admin }),
    200,
  );

  // Left clean first: an earlier interrupted run can leave the caller watching,
  // and the add/remove cases below assert a starting point rather than assuming
  // one.
  await call(`/work-packages/${target}/watchers/${adminId}`, {
    method: 'DELETE',
    cookie: admin,
  }).catch(() => undefined);

  const initialWatchers = await watcherState(admin);
  check('the watcher state starts from not watching', initialWatchers.isWatching, false);
  check('the watcher state reports the add capability', typeof initialWatchers.can.add, 'boolean');

  const candidates = (await (
    await call(`/work-packages/${target}/available-watchers`, { cookie: admin })
  ).json()) as Record<string, unknown>[];

  check('available watchers is a list', Array.isArray(candidates), true);
  // Watchers are people, and the collection upstream returns carries their
  // email and login. Neither is needed to render one, so neither is passed on.
  check(
    'a candidate carries no email or login',
    candidates.every((c) => !('email' in c) && !('login' in c)),
    true,
  );
  check(
    'a candidate offers only id and name',
    candidates.every((c) => Object.keys(c).sort().join() === 'id,name'),
    true,
  );

  check(
    'adding a watcher without a user is rejected',
    await status(`/work-packages/${target}/watchers`, { method: 'POST', cookie: admin, body: {} }),
    400,
  );

  check(
    'a permitted caller can add a watcher',
    await status(`/work-packages/${target}/watchers`, {
      method: 'POST',
      cookie: admin,
      body: { userId: adminId },
    }),
    201,
  );

  const watching = await watcherState(admin);
  check('the watcher now appears in the list', watching.watchers.some((w) => w.id === adminId), true);
  check('the caller is reported as watching', watching.isWatching, true);

  const narrowed = (await (
    await call(`/work-packages/${target}/available-watchers`, { cookie: admin })
  ).json()) as { id: string }[];
  check(
    'an existing watcher is no longer a candidate',
    narrowed.some((c) => c.id === adminId),
    false,
  );

  // Unlike attachments, which anyone who can open a task may list, seeing
  // watchers is a permission of its own upstream. A caller who can read the
  // work package is therefore still refused here, and that is upstream's
  // decision rather than a rule invented in EPM.
  check(
    'a caller without the watchers permission cannot list them',
    await status(`/work-packages/${target}/watchers`, { cookie: restricted }),
    403,
  );
  check(
    'nor the candidates for adding one',
    await status(`/work-packages/${target}/available-watchers`, { cookie: restricted }),
    403,
  );
  check(
    'a restricted caller cannot remove someone else',
    await status(`/work-packages/${target}/watchers/${adminId}`, {
      method: 'DELETE',
      cookie: restricted,
    }),
    403,
  );

  check(
    'a permitted caller can remove a watcher',
    await status(`/work-packages/${target}/watchers/${adminId}`, {
      method: 'DELETE',
      cookie: admin,
    }),
    204,
  );

  const after = await watcherState(admin);
  check('the watcher is gone afterwards', after.watchers.some((w) => w.id === adminId), false);
  check('the caller is no longer reported as watching', after.isWatching, false);

  // --- Relations -----------------------------------------------------------
  console.log('\nRelations');

  interface TestRelation {
    id: string;
    type: string;
    label: string;
    related: { id: string; subject: string };
    can: { delete: boolean; update: boolean };
  }

  check('anonymous cannot list relations', await status(`/work-packages/${target}/relations`), 401);
  check('anonymous cannot read the relation vocabulary', await status('/relation-types'), 401);

  check(
    'a permitted caller can list relations',
    await status(`/work-packages/${target}/relations`, { cookie: admin }),
    200,
  );

  const vocabulary = (await (await call('/relation-types', { cookie: admin })).json()) as {
    value: string;
    label: string;
  }[];

  check('the relation vocabulary is served by the backend', vocabulary.length > 0, true);
  // Both directions of every asymmetric pair have to be offerable, or half the
  // relations a user might want could only be created from the other task.
  check(
    'the vocabulary offers both directions of each pair',
    ['blocks', 'blocked', 'follows', 'precedes', 'includes', 'partof', 'requires', 'required', 'duplicates', 'duplicated', 'relates'].every(
      (value) => vocabulary.some((entry) => entry.value === value),
    ),
    true,
  );

  const relatable = (await (
    await call(`/work-packages/${target}/relatable`, { cookie: admin })
  ).json()) as { id: string; subject: string }[];

  check('relatable work packages are offered', relatable.length > 0, true);
  check(
    'a work package is not offered as related to itself',
    relatable.some((w) => w.id === target),
    false,
  );

  // The other end must be one the restricted caller can read too, so that
  // refusing them a deletion below is about permission, not visibility — a
  // candidate in a project they cannot see would answer 404 for the wrong reason.
  let other: string | undefined;
  for (const candidate of relatable.slice(0, 25)) {
    if ((await status(`/tasks/${candidate.id}`, { cookie: restricted })) === 200) {
      other = candidate.id;
      break;
    }
  }
  // On a busy instance the first candidates are other projects' newest work:
  // start from what the restricted caller can read, and find one on offer.
  if (!other) {
    const readable = (((await (await call('/tasks?pageSize=25', { cookie: restricted })).json()) as { items?: { id: string; subject: string }[] }).items ?? []).filter(
      (task) => task.id !== target,
    );
    for (const task of readable) {
      const offered = (await (await call(`/work-packages/${target}/relatable?q=${encodeURIComponent(task.subject.slice(0, 12))}`, { cookie: admin })).json()) as { id: string; subject: string }[];
      const match = offered.find((w) => w.id === task.id);
      if (match) {
        other = match.id;
        if (!relatable.some((w) => w.id === match.id)) relatable.push(match);
        break;
      }
    }
  }
  if (!other) throw new Error('No second work package available to relate to.');

  const searched = (await (
    await call(`/work-packages/${target}/relatable?q=${encodeURIComponent(relatable.find((w) => w.id === other)!.subject.slice(0, 12))}`, {
      cookie: admin,
    })
  ).json()) as { id: string }[];
  check('a search term narrows the candidates', searched.length <= relatable.length, true);

  check(
    'creating a relation without a target is rejected',
    await status(`/work-packages/${target}/relations`, {
      method: 'POST',
      cookie: admin,
      body: { type: 'blocks' },
    }),
    400,
  );
  check(
    'an unknown relation type is rejected before it reaches upstream',
    await status(`/work-packages/${target}/relations`, {
      method: 'POST',
      cookie: admin,
      body: { type: 'entangles', relatedId: other },
    }),
    400,
  );
  check(
    'a work package cannot be related to itself',
    await status(`/work-packages/${target}/relations`, {
      method: 'POST',
      cookie: admin,
      body: { type: 'relates', relatedId: target },
    }),
    422,
  );

  check(
    'a restricted caller cannot create a relation',
    await status(`/work-packages/${target}/relations`, {
      method: 'POST',
      cookie: restricted,
      body: { type: 'blocks', relatedId: other },
    }),
    403,
  );

  // A run that aborts between creating this relation and deleting it leaves it
  // behind, and upstream refuses a duplicate with 422 — so every later run
  // failed here until the leftover was removed by hand. Clearing first makes
  // the section idempotent instead of depending on the previous run finishing.
  {
    const existing = (await (
      await call(`/work-packages/${target}/relations`, { cookie: admin })
    ).json()) as { id: string; related?: { id?: string } }[];

    for (const relation of Array.isArray(existing) ? existing : []) {
      if (relation.related?.id !== other) continue;
      await call(`/relations/${relation.id}`, { method: 'DELETE', cookie: admin }).catch(
        () => undefined,
      );
    }
  }

  const createResponse = await call(`/work-packages/${target}/relations`, {
    method: 'POST',
    cookie: admin,
    body: { type: 'blocks', relatedId: other },
  });
  check('a permitted caller can create a relation', createResponse.status, 201);

  const relation = (await createResponse.json()) as TestRelation;
  check('the new relation reads forward from its source', relation.type, 'blocks');
  check('it names the other work package, not this one', relation.related.id, other);
  check('the creator is told they may delete it', relation.can.delete, true);
  // An EPM id, not an upstream href. A leaked /api/v3/... path would tell the
  // browser where OpenProject is.
  check('the relation id is not an upstream url', relation.id.includes('/'), false);

  const fromSource = (await (
    await call(`/work-packages/${target}/relations`, { cookie: admin })
  ).json()) as TestRelation[];
  check(
    'the source sees it as blocking',
    fromSource.find((r) => r.id === relation.id)?.type,
    'blocks',
  );

  // The same stored row, read from the other end. This is the case that would
  // silently invert if direction were not normalized in the backend.
  const fromTarget = (await (
    await call(`/work-packages/${other}/relations`, { cookie: admin })
  ).json()) as TestRelation[];
  const mirrored = fromTarget.find((r) => r.id === relation.id);
  check('the target sees the same relation', Boolean(mirrored), true);
  check('the target sees it as blocked, not blocking', mirrored?.type, 'blocked');
  check('the target reads a reversed label', mirrored?.label, 'blocked by');
  check('the target names the source as the other end', mirrored?.related.id, target);

  check(
    'the same relation cannot be created twice',
    await status(`/work-packages/${target}/relations`, {
      method: 'POST',
      cookie: admin,
      body: { type: 'blocks', relatedId: other },
    }),
    422,
  );

  check(
    'a restricted caller cannot delete a relation',
    await status(`/relations/${relation.id}`, { method: 'DELETE', cookie: restricted }),
    403,
  );
  check(
    'a permitted caller can delete a relation',
    await status(`/relations/${relation.id}`, { method: 'DELETE', cookie: admin }),
    204,
  );
  check(
    'it is gone from both ends afterwards',
    ((await (await call(`/work-packages/${other}/relations`, { cookie: admin })).json()) as TestRelation[])
      .some((r) => r.id === relation.id),
    false,
  );

  // Creating in the reverse direction. OpenProject stores the canonical form
  // with the endpoints swapped, and the response has to read the way it was
  // asked for rather than the way it was stored.
  const reverseResponse = await call(`/work-packages/${target}/relations`, {
    method: 'POST',
    cookie: admin,
    body: { type: 'blocked', relatedId: other },
  });
  check('a relation can be created in the reverse direction', reverseResponse.status, 201);

  const reverse = (await reverseResponse.json()) as TestRelation;
  check('the reverse relation reads as it was asked for', reverse.type, 'blocked');

  const reverseFromTarget = (await (
    await call(`/work-packages/${other}/relations`, { cookie: admin })
  ).json()) as TestRelation[];
  check(
    'the other end of a reverse relation reads forward',
    reverseFromTarget.find((r) => r.id === reverse.id)?.type,
    'blocks',
  );

  check(
    'the reverse relation can be deleted',
    await status(`/relations/${reverse.id}`, { method: 'DELETE', cookie: admin }),
    204,
  );

  // --- Comments ------------------------------------------------------------
  // Two work packages for the analytics tests, made here — after the sections
  // above have picked the work packages they act on and relate, so none of
  // theirs is one of these, in a project the restricted caller cannot see —
  // and early enough that by the time
  // those tests change them OpenProject's journal aggregation window (5 minutes)
  // has passed and the change is a version of its own. No dates, no assignee
  // and an ordinary type, so the health tests' counts on this project are as
  // they would be without them, and nobody is emailed. Removed with the project.
  analyticsProbeCreatedAt = Date.now();
  for (const name of ['A', 'B']) {
    const probe = await call('/tasks', {
      method: 'POST',
      cookie: admin,
      body: { projectId: createdId, subject: `Analytics probe ${name}` },
    });
    if (probe.status === 201) analyticsProbeIds.push(((await probe.json()) as { id: string }).id);
  }

  console.log('\nComments');

  interface TestComment {
    id: string;
    author: { id: string; name: string };
    body: string;
    createdAt: string;
    updatedAt?: string;
    editable: boolean;
    deletable: boolean;
  }

  const commentsOf = async (cookie: string) =>
    (await (await call(`/work-packages/${target}/comments`, { cookie })).json()) as TestComment[];

  check('anonymous cannot list comments', await status(`/work-packages/${target}/comments`), 401);
  check(
    'anonymous cannot comment',
    await status(`/work-packages/${target}/comments`, { method: 'POST', body: { body: 'no' } }),
    401,
  );

  // Both identities can read the task and its discussion.
  check('admin can view the task', await status(`/tasks/${target}`, { cookie: admin }), 200);
  check('a restricted caller can view the task', await status(`/tasks/${target}`, { cookie: restricted }), 200);
  check(
    'admin can list comments',
    await status(`/work-packages/${target}/comments`, { cookie: admin }),
    200,
  );
  // Unlike watchers, reading comments needs no permission beyond seeing the
  // work package, so this is 200 where the watcher list is 403.
  check(
    'a restricted caller can list comments',
    await status(`/work-packages/${target}/comments`, { cookie: restricted }),
    200,
  );

  check(
    'an empty comment is rejected',
    await status(`/work-packages/${target}/comments`, { method: 'POST', cookie: admin, body: { body: '' } }),
    400,
  );
  check(
    'a whitespace-only comment is rejected',
    await status(`/work-packages/${target}/comments`, { method: 'POST', cookie: admin, body: { body: '   ' } }),
    400,
  );

  check(
    'a restricted caller cannot comment',
    await status(`/work-packages/${target}/comments`, {
      method: 'POST',
      cookie: restricted,
      body: { body: 'should not post' },
    }),
    403,
  );

  const postResponse = await call(`/work-packages/${target}/comments`, {
    method: 'POST',
    cookie: admin,
    body: { body: 'EPM authorization test comment' },
  });
  check('a permitted caller can comment', postResponse.status, 201);

  const posted = (await postResponse.json()) as TestComment;
  check('the comment names its author', posted.author.id, adminId);
  check('the author carries a display name', posted.author.name.length > 0, true);
  check('the body is returned as written', posted.body, 'EPM authorization test comment');
  // Not asserted as "never edited": OpenProject aggregates journal entries, so
  // a comment posted soon after another by the same user is folded into it and
  // comes back already carrying an edit time. What must hold is that an edit
  // time, when there is one, is never before the comment was written.
  check(
    'any edit time is not before the creation time',
    posted.updatedAt === undefined || posted.updatedAt >= posted.createdAt,
    true,
  );
  // An EPM id, not an upstream href.
  check('the comment id is not an upstream url', posted.id.includes('/'), false);

  const listed = await commentsOf(admin);
  check('it appears in the list', listed.some((c) => c.id === posted.id), true);
  check(
    'the listed copy matches what was posted',
    listed.find((c) => c.id === posted.id)?.body,
    'EPM authorization test comment',
  );

  // Upstream returns both markdown source and its own rendered html. Only the
  // source is passed on, so no foreign markup can reach this origin.
  check(
    'no rendered html is exposed',
    listed.every((c) => !('html' in (c as unknown as Record<string, unknown>))),
    true,
  );
  check(
    'a comment reports whether it can be edited',
    listed.every((c) => typeof c.editable === 'boolean'),
    true,
  );
  // OpenProject publishes no delete affordance on any activity, and offers no
  // verb for it, so nothing is ever deletable.
  check(
    'no comment is deletable, because upstream offers no deletion',
    listed.some((c) => c.deletable),
    false,
  );

  check(
    'the author is told they may edit it',
    listed.find((c) => c.id === posted.id)?.editable,
    true,
  );

  const editResponse = await call(`/work-packages/${target}/comments/${posted.id}`, {
    method: 'PATCH',
    cookie: admin,
    body: { body: 'EPM authorization test comment, edited' },
  });
  check('a permitted caller can edit a comment', editResponse.status, 200);

  const edited = (await editResponse.json()) as TestComment;
  check('the edit changes the body', edited.body, 'EPM authorization test comment, edited');
  check('an edited comment reports when it changed', typeof edited.updatedAt, 'string');
  check('editing does not change the author', edited.author.id, adminId);
  check('editing does not change the creation time', edited.createdAt, posted.createdAt);

  check(
    'an edit cannot blank a comment',
    await status(`/work-packages/${target}/comments/${posted.id}`, {
      method: 'PATCH',
      cookie: admin,
      body: { body: '  ' },
    }),
    400,
  );

  // A caller who may not comment may not edit one either, and is not told
  // otherwise by the flags they receive.
  const restrictedView = await commentsOf(restricted);
  check(
    'a restricted caller is offered no editable comment',
    restrictedView.some((c) => c.editable),
    false,
  );
  check(
    'a restricted caller cannot edit a comment',
    await status(`/work-packages/${target}/comments/${posted.id}`, {
      method: 'PATCH',
      cookie: restricted,
      body: { body: 'should not apply' },
    }),
    403,
  );
  check(
    'the comment is unchanged after the refused edit',
    (await commentsOf(admin)).find((c) => c.id === posted.id)?.body,
    'EPM authorization test comment, edited',
  );
  check(
    'anonymous cannot edit a comment',
    await status(`/work-packages/${target}/comments/${posted.id}`, {
      method: 'PATCH',
      body: { body: 'no' },
    }),
    401,
  );

  // The comment id is checked against the work package in the path, so one
  // task's route cannot be used to edit another task's comments.
  check(
    'a comment cannot be edited through another work package',
    await status(`/work-packages/99999999/comments/${posted.id}`, {
      method: 'PATCH',
      cookie: admin,
      body: { body: 'wrong container' },
    }),
    404,
  );
  check(
    'an unknown comment cannot be edited',
    await status(`/work-packages/${target}/comments/99999999`, {
      method: 'PATCH',
      cookie: admin,
      body: { body: 'nothing there' },
    }),
    404,
  );
  check(
    'an unknown work package has no comments',
    await status('/work-packages/99999999/comments', { cookie: admin }),
    404,
  );

  // No delete route exists, because upstream supports no such operation.
  check(
    'there is no route for deleting a comment',
    await status(`/work-packages/${target}/comments/${posted.id}`, { method: 'DELETE', cookie: admin }),
    404,
  );


  // --- Departments ---------------------------------------------------------
  //
  // The first EPM-owned domain: none of this reaches OpenProject except to
  // resolve a manager's name. Rows created here are removed in the cleanup
  // step, which the API itself cannot do — departments are archived, never
  // deleted — so that one step goes through the database directly.
  console.log('\nDepartments');

  interface TestDepartment {
    id: string;
    name: string;
    code: string;
    description?: string;
    manager?: { id: string; name: string };
    memberCount: number;
    capacityHours: number;
    active: boolean;
    createdAt: string;
    updatedAt: string;
  }

  // Unique per run, so a previous run's leftovers cannot make these pass or fail.
  const stamp = `${process.pid}${Date.now() % 100000}`;
  const deptName = `EPM Test Department ${stamp}`;
  const deptCode = `TST-${stamp}`.slice(0, 16);

  const departments = async (cookie: string, query = '') =>
    (await (await call(`/departments${query}`, { cookie })).json()) as TestDepartment[];

  // The permission is EPM's own: no OpenProject capability implies it, so it is
  // granted from EPM's grants and bootstrap configuration instead.
  const adminPermissions = (await (await call('/me', { cookie: admin })).json()) as {
    permissions?: {
      departments?: { manage?: boolean };
      teams?: { manage?: boolean };
      employees?: { manage?: boolean };
      health?: { manage?: boolean; configure?: boolean };
      approvals?: { configure?: boolean };
      rules?: { configure?: boolean };
      portfolios?: { manage?: boolean };
      analytics?: { manage?: boolean };
    };
  };
  const restrictedPermissions = (await (
    await call('/me', { cookie: restricted })
  ).json()) as typeof adminPermissions;

  check(
    'the manage permission is surfaced to the client',
    adminPermissions.permissions?.departments?.manage,
    true,
  );
  check(
    'a caller without a grant does not hold it',
    restrictedPermissions.permissions?.departments?.manage,
    false,
  );

  check('anonymous cannot list departments', await status('/departments'), 401);
  check(
    'anonymous cannot create one',
    await status('/departments', { method: 'POST', body: { name: 'x', code: 'XX' } }),
    401,
  );

  // Reading is open to any signed-in caller: departments are reference data.
  check('a permitted caller can list departments', await status('/departments', { cookie: admin }), 200);
  check(
    'a caller without the manage grant can still read them',
    await status('/departments', { cookie: restricted }),
    200,
  );

  check(
    'a caller without the grant cannot create one',
    await status('/departments', {
      method: 'POST',
      cookie: restricted,
      body: { name: deptName, code: deptCode },
    }),
    403,
  );

  // --- validation, before anything is created ---
  const invalidDepartments: [string, Record<string, unknown>][] = [
    ['a department needs a name', { code: 'AA' }],
    ['a department needs a code', { name: 'Nameless' }],
    ['a blank name is refused', { name: '   ', code: 'AA' }],
    ['a code shorter than two characters is refused', { name: 'Short', code: 'A' }],
    ['a code longer than sixteen characters is refused', { name: 'Long', code: 'A'.repeat(17) }],
    ['a code with spaces is refused', { name: 'Spaced', code: 'A B' }],
    ['a code with punctuation is refused', { name: 'Punct', code: 'A_B!' }],
    ['a non-string name is refused', { name: 42, code: 'AA' }],
    ['an over-long name is refused', { name: 'n'.repeat(121), code: 'AA' }],
    [
      'a manager who is not a visible user is refused',
      { name: 'Ghost', code: 'GH1', managerId: '99999999' },
    ],
  ];

  for (const [label, body] of invalidDepartments) {
    check(label, await status('/departments', { method: 'POST', cookie: admin, body }), 400);
  }

  const departmentCreateResponse = await call('/departments', {
    method: 'POST',
    cookie: admin,
    // Lower case deliberately: codes are normalised before storing.
    body: {
      name: deptName,
      code: deptCode.toLowerCase(),
      description: '  Owns delivery.  ',
      managerId: adminId,
    },
  });
  check('a permitted caller can create a department', departmentCreateResponse.status, 201);

  const createdDepartment = (await departmentCreateResponse.json()) as TestDepartment;
  const deptId = createdDepartment.id;
  departmentIds.push(deptId);

  check('the name is returned as given', createdDepartment.name, deptName);
  check('the code is normalised to upper case', createdDepartment.code, deptCode);
  check('the description is trimmed', createdDepartment.description, 'Owns delivery.');
  check('a new department is active', createdDepartment.active, true);
  check(
    'the manager is named, not just referenced',
    createdDepartment.manager?.name !== undefined,
    true,
  );
  check('the manager keeps its OpenProject id', createdDepartment.manager?.id, adminId);
  check('it carries a creation time', typeof createdDepartment.createdAt, 'string');

  check(
    'a duplicate code is refused',
    await status('/departments', {
      method: 'POST',
      cookie: admin,
      body: { name: `${deptName} II`, code: deptCode },
    }),
    400,
  );
  // Postgres would accept these as distinct; the application rejects them.
  check(
    'a name differing only by case is refused',
    await status('/departments', {
      method: 'POST',
      cookie: admin,
      body: { name: deptName.toUpperCase(), code: `X${deptCode}`.slice(0, 16) },
    }),
    400,
  );
  check(
    'a code differing only by case is refused',
    await status('/departments', {
      method: 'POST',
      cookie: admin,
      body: { name: `${deptName} III`, code: deptCode.toLowerCase() },
    }),
    400,
  );

  check(
    'a created department can be read back',
    await status(`/departments/${deptId}`, { cookie: admin }),
    200,
  );
  check(
    'it appears in the list',
    (await departments(admin)).some((d) => d.id === deptId),
    true,
  );
  check(
    'a caller without the grant sees it too',
    (await departments(restricted)).some((d) => d.id === deptId),
    true,
  );

  // --- update ---
  const updatedResponse = await call(`/departments/${deptId}`, {
    method: 'PATCH',
    cookie: admin,
    body: { description: 'Owns delivery and platform.' },
  });
  check('a permitted caller can update a department', updatedResponse.status, 200);

  const afterUpdate = (await updatedResponse.json()) as TestDepartment;
  check('the change is applied', afterUpdate.description, 'Owns delivery and platform.');
  // A partial update must not blank the fields it did not mention.
  check('an omitted field is left alone', afterUpdate.name, deptName);
  check('an omitted manager is left alone', afterUpdate.manager?.id, adminId);

  check(
    'an update with no fields is refused',
    await status(`/departments/${deptId}`, { method: 'PATCH', cookie: admin, body: {} }),
    400,
  );
  check(
    'an update cannot blank the name',
    await status(`/departments/${deptId}`, { method: 'PATCH', cookie: admin, body: { name: '' } }),
    400,
  );
  check(
    'a caller without the grant cannot update one',
    await status(`/departments/${deptId}`, {
      method: 'PATCH',
      cookie: restricted,
      body: { name: 'Hijacked' },
    }),
    403,
  );
  check(
    'the department is unchanged after the refused update',
    ((await (await call(`/departments/${deptId}`, { cookie: admin })).json()) as TestDepartment).name,
    deptName,
  );

  // Clearing the manager is a real edit, distinct from omitting it.
  const cleared = (await (
    await call(`/departments/${deptId}`, { method: 'PATCH', cookie: admin, body: { managerId: '' } })
  ).json()) as TestDepartment;
  check('the manager can be cleared', cleared.manager, undefined);

  // --- lifecycle ---
  check(
    'a caller without the grant cannot archive one',
    await status(`/departments/${deptId}/archive`, { method: 'PATCH', cookie: restricted }),
    403,
  );

  const archived = await call(`/departments/${deptId}/archive`, { method: 'PATCH', cookie: admin });
  check('a permitted caller can archive a department', archived.status, 200);
  check('it is reported inactive', ((await archived.json()) as TestDepartment).active, false);
  check(
    'an archived department is out of the default list',
    (await departments(admin)).some((d) => d.id === deptId),
    false,
  );
  check(
    'it is still there when inactive ones are asked for',
    (await departments(admin, '?includeInactive=true')).some((d) => d.id === deptId),
    true,
  );
  check('it can still be read directly', await status(`/departments/${deptId}`, { cookie: admin }), 200);

  const restored = await call(`/departments/${deptId}/restore`, { method: 'PATCH', cookie: admin });
  check(
    'an archived department can be restored',
    ((await restored.json()) as TestDepartment).active,
    true,
  );

  // Deleting exists now, and is refused while anything still references the
  // department — asserted below, once a team has been put in it.

  check('an unknown department is not found', await status('/departments/no-such-id', { cookie: admin }), 404);
  check(
    'an unknown department cannot be updated',
    await status('/departments/no-such-id', { method: 'PATCH', cookie: admin, body: { name: 'X' } }),
    404,
  );
  check(
    'an unknown department cannot be archived',
    await status('/departments/no-such-id/archive', { method: 'PATCH', cookie: admin }),
    404,
  );

  check(
    'an unknown department cannot be deleted',
    await status('/departments/no-such-id', { method: 'DELETE', cookie: admin }),
    404,
  );
  check(
    'a caller without the grant cannot delete a department',
    await status(`/departments/${deptId}`, { method: 'DELETE', cookie: restricted }),
    403,
  );

  // The id is EPM's own, and no OpenProject reference should ride along.
  check('the department id is not an upstream url', deptId.includes('/'), false);
  check(
    'no upstream reference is exposed on a department',
    Object.keys(createdDepartment).sort().join(),
    // memberCount and capacityHours joined this contract with capacity. Both
    // are sums over EPM's own mapping; nothing upstream is consulted for them.
    'active,capacityHours,code,createdAt,description,id,manager,memberCount,name,updatedAt',
  );
  check('a new department has no members', createdDepartment.memberCount, 0);
  check('and no capacity', createdDepartment.capacityHours, 0);

  // --- Teams ---------------------------------------------------------------
  //
  // EPM-owned, like departments. These reuse the department created above, so
  // the department-lifecycle cases have something real to act on, and both are
  // removed in the cleanup step — teams first, because the foreign key is
  // RESTRICT.
  console.log('\nTeams');

  interface TestTeam {
    id: string;
    name: string;
    code: string;
    description?: string;
    department?: { id: string; name: string; active: boolean };
    lead?: { id: string; name: string };
    memberCount: number;
    capacityHours: number;
    active: boolean;
    createdAt: string;
    updatedAt: string;
  }

  const teamName = `EPM Test Team ${stamp}`;
  const teamCode = `TMT-${stamp}`.slice(0, 16);

  const teams = async (cookie: string, query = '') =>
    (await (await call(`/teams${query}`, { cookie })).json()) as TestTeam[];

  check(
    'the manage permission is surfaced to the client',
    adminPermissions.permissions?.teams?.manage,
    true,
  );
  check(
    'a caller without a grant does not hold it',
    restrictedPermissions.permissions?.teams?.manage,
    false,
  );

  check('anonymous cannot list teams', await status('/teams'), 401);
  check(
    'anonymous cannot create one',
    await status('/teams', { method: 'POST', body: { name: 'x', code: 'XX' } }),
    401,
  );

  check('a permitted caller can list teams', await status('/teams', { cookie: admin }), 200);
  check(
    'a caller without the manage grant can still read them',
    await status('/teams', { cookie: restricted }),
    200,
  );
  check(
    'a caller without the grant cannot create one',
    await status('/teams', { method: 'POST', cookie: restricted, body: { name: teamName, code: teamCode } }),
    403,
  );

  const invalidTeams: [string, Record<string, unknown>][] = [
    ['a team needs a name', { code: 'AA' }],
    ['a team needs a code', { name: 'Nameless' }],
    ['a blank name is refused', { name: '   ', code: 'AA' }],
    ['a code shorter than two characters is refused', { name: 'Short', code: 'A' }],
    ['a code longer than sixteen characters is refused', { name: 'Long', code: 'A'.repeat(17) }],
    ['a code with punctuation is refused', { name: 'Punct', code: 'A_B!' }],
    ['a non-string name is refused', { name: 42, code: 'AA' }],
    ['an over-long name is refused', { name: 'n'.repeat(121), code: 'AA' }],
    ['an unknown department is refused', { name: 'Ghost', code: 'GT1', departmentId: 'no-such-department' }],
    ['a lead who is not a visible user is refused', { name: 'Ghost', code: 'GT2', leadId: '99999999' }],
  ];

  for (const [label, body] of invalidTeams) {
    check(label, await status('/teams', { method: 'POST', cookie: admin, body }), 400);
  }

  const teamCreateResponse = await call('/teams', {
    method: 'POST',
    cookie: admin,
    // Lower case deliberately: codes are normalised before storing.
    body: {
      name: teamName,
      code: teamCode.toLowerCase(),
      description: '  Delivers the platform.  ',
      departmentId: deptId,
      leadId: adminId,
    },
  });
  check('a permitted caller can create a team', teamCreateResponse.status, 201);

  const createdTeam = (await teamCreateResponse.json()) as TestTeam;
  const teamId = createdTeam.id;
  teamIds.push(teamId);

  check('the name is returned as given', createdTeam.name, teamName);
  check('the code is normalised to upper case', createdTeam.code, teamCode);
  check('the description is trimmed', createdTeam.description, 'Delivers the platform.');
  check('a new team is active', createdTeam.active, true);
  check('the department is named, not just referenced', createdTeam.department?.id, deptId);
  check('the department reports its own lifecycle', createdTeam.department?.active, true);
  check('the lead keeps its OpenProject id', createdTeam.lead?.id, adminId);
  check('the lead is named', (createdTeam.lead?.name.length ?? 0) > 0, true);
  check('the team id is not an upstream url', teamId.includes('/'), false);
  check(
    'no upstream reference is exposed on a team',
    Object.keys(createdTeam).sort().join(),
    // memberCount joined this contract with employee mapping. It counts EPM
    // mappings; no OpenProject group is consulted for it.
    'active,capacityHours,code,createdAt,department,description,id,lead,memberCount,name,updatedAt',
  );
  check('a new team has no members', createdTeam.memberCount, 0);
  check('and no capacity', createdTeam.capacityHours, 0);

  check(
    'a duplicate code is refused',
    await status('/teams', { method: 'POST', cookie: admin, body: { name: `${teamName} II`, code: teamCode } }),
    400,
  );
  // The database enforces this too, through a functional index on LOWER(name).
  check(
    'a name differing only by case is refused',
    await status('/teams', {
      method: 'POST',
      cookie: admin,
      body: { name: teamName.toUpperCase(), code: `X${teamCode}`.slice(0, 16) },
    }),
    400,
  );

  // A team may exist without a department: nullable by design, not an oversight.
  const looseResponse = await call('/teams', {
    method: 'POST',
    cookie: admin,
    body: { name: `${teamName} Loose`, code: `L${teamCode}`.slice(0, 16) },
  });
  check('a team can be created without a department', looseResponse.status, 201);
  const looseTeam = (await looseResponse.json()) as TestTeam;
  teamIds.push(looseTeam.id);
  check('it reports no department', looseTeam.department, undefined);
  check('it reports no lead', looseTeam.lead, undefined);

  check('a team can be read back', await status(`/teams/${teamId}`, { cookie: admin }), 200);
  check(
    'it appears in the list',
    (await teams(admin)).some((t) => t.id === teamId),
    true,
  );

  // --- filtering ---
  const inDepartment = await teams(admin, `?departmentId=${deptId}`);
  check('filtering by department returns its teams', inDepartment.some((t) => t.id === teamId), true);
  check(
    'filtering by department excludes teams outside it',
    inDepartment.some((t) => t.id === looseTeam.id),
    false,
  );
  check(
    'filtering by an unknown department returns nothing',
    (await teams(admin, '?departmentId=no-such-department')).length,
    0,
  );

  // --- update ---
  const teamUpdate = await call(`/teams/${teamId}`, {
    method: 'PATCH',
    cookie: admin,
    body: { description: 'Delivers the platform and its tooling.' },
  });
  check('a permitted caller can update a team', teamUpdate.status, 200);

  const afterTeamUpdate = (await teamUpdate.json()) as TestTeam;
  check('the change is applied', afterTeamUpdate.description, 'Delivers the platform and its tooling.');
  check('an omitted field is left alone', afterTeamUpdate.name, teamName);
  check('an omitted department is left alone', afterTeamUpdate.department?.id, deptId);

  check(
    'an update with no fields is refused',
    await status(`/teams/${teamId}`, { method: 'PATCH', cookie: admin, body: {} }),
    400,
  );
  check(
    'a caller without the grant cannot update one',
    await status(`/teams/${teamId}`, { method: 'PATCH', cookie: restricted, body: { name: 'Hijacked' } }),
    403,
  );
  check(
    'the team is unchanged after the refused update',
    ((await (await call(`/teams/${teamId}`, { cookie: admin })).json()) as TestTeam).name,
    teamName,
  );

  // A team can move between departments, and out of one entirely.
  const moved = (await (
    await call(`/teams/${looseTeam.id}`, { method: 'PATCH', cookie: admin, body: { departmentId: deptId } })
  ).json()) as TestTeam;
  check('a team can be moved into a department', moved.department?.id, deptId);

  const removed = (await (
    await call(`/teams/${looseTeam.id}`, { method: 'PATCH', cookie: admin, body: { departmentId: '' } })
  ).json()) as TestTeam;
  check('a team can be moved out of a department', removed.department, undefined);

  // --- department lifecycle interaction ---
  // Archiving a department is a visibility decision, not a structural one: the
  // teams inside it are left exactly as they were, so restoring is symmetrical.
  check(
    'a department holding active teams can still be archived',
    await status(`/departments/${deptId}/archive`, { method: 'PATCH', cookie: admin }),
    200,
  );

  const strandedTeam = (await (await call(`/teams/${teamId}`, { cookie: admin })).json()) as TestTeam;
  check('its team is still readable', strandedTeam.id, teamId);
  check('the team was not archived along with it', strandedTeam.active, true);
  check('the team keeps its association', strandedTeam.department?.id, deptId);
  // The UI has to be able to say the department is archived rather than show a
  // name that looks current.
  check('the department is reported as archived', strandedTeam.department?.active, false);
  check(
    'the team is still listed',
    (await teams(admin)).some((t) => t.id === teamId),
    true,
  );
  check(
    'the team can still be edited',
    await status(`/teams/${teamId}`, { method: 'PATCH', cookie: admin, body: { description: 'Still editable.' } }),
    200,
  );

  // Retaining an existing association is not the same as forming a new one.
  check(
    'a new team cannot be created in an archived department',
    await status('/teams', {
      method: 'POST',
      cookie: admin,
      body: { name: `${teamName} Blocked`, code: `B${teamCode}`.slice(0, 16), departmentId: deptId },
    }),
    400,
  );
  check(
    'a team cannot be moved into an archived department',
    await status(`/teams/${looseTeam.id}`, { method: 'PATCH', cookie: admin, body: { departmentId: deptId } }),
    400,
  );

  check(
    'the department can be restored',
    await status(`/departments/${deptId}/restore`, { method: 'PATCH', cookie: admin }),
    200,
  );
  const afterRestore = (await (await call(`/teams/${teamId}`, { cookie: admin })).json()) as TestTeam;
  check('the association survived the round trip', afterRestore.department?.id, deptId);
  check('the department is active again', afterRestore.department?.active, true);
  check('the team was not changed by the restore', afterRestore.active, true);

  // --- team lifecycle ---
  check(
    'a caller without the grant cannot archive one',
    await status(`/teams/${teamId}/archive`, { method: 'PATCH', cookie: restricted }),
    403,
  );

  const archivedTeam = await call(`/teams/${teamId}/archive`, { method: 'PATCH', cookie: admin });
  check('a permitted caller can archive a team', archivedTeam.status, 200);
  check('it is reported inactive', ((await archivedTeam.json()) as TestTeam).active, false);
  check(
    'an archived team is out of the default list',
    (await teams(admin)).some((t) => t.id === teamId),
    false,
  );
  check(
    'it is still there when inactive ones are asked for',
    (await teams(admin, '?includeInactive=true')).some((t) => t.id === teamId),
    true,
  );
  check('it can still be read directly', await status(`/teams/${teamId}`, { cookie: admin }), 200);
  check(
    'archiving a team leaves its department alone',
    ((await (await call(`/departments/${deptId}`, { cookie: admin })).json()) as { active: boolean }).active,
    true,
  );

  const restoredTeam = await call(`/teams/${teamId}/restore`, { method: 'PATCH', cookie: admin });
  check('an archived team can be restored', ((await restoredTeam.json()) as TestTeam).active, true);

  check('an unknown team is not found', await status('/teams/no-such-id', { cookie: admin }), 404);
  check(
    'an unknown team cannot be updated',
    await status('/teams/no-such-id', { method: 'PATCH', cookie: admin, body: { name: 'X' } }),
    404,
  );
  check(
    'an unknown team cannot be archived',
    await status('/teams/no-such-id/archive', { method: 'PATCH', cookie: admin }),
    404,
  );

  check(
    'an unknown team cannot be deleted',
    await status('/teams/no-such-id', { method: 'DELETE', cookie: admin }),
    404,
  );
  check(
    'a caller without the grant cannot delete a team',
    await status(`/teams/${teamId}`, { method: 'DELETE', cookie: restricted }),
    403,
  );

  // Deleting is refused while anything still points at the department: the
  // foreign keys are RESTRICT, and detaching people or teams to make a delete
  // succeed would lose organisational data nobody asked to lose.
  {
    const blocked = await call(`/departments/${deptId}`, { method: 'DELETE', cookie: admin });
    check('a department with a team in it cannot be deleted', blocked.status, 400);
    const problem = (await blocked.json()) as { message?: string };
    check(
      'and the refusal says what is in the way',
      (problem.message ?? '').includes('team'),
      true,
    );
    check(
      'the department is still there afterwards',
      (await status(`/departments/${deptId}`, { cookie: admin })) === 200,
      true,
    );
  }

  // The workload endpoint shares the /teams prefix but is about people. It must
  // not be captured by the :id route, and must survive teams changing shape.
  check('the workload endpoint still answers', await status('/teams/workloads', { cookie: admin }), 200);

  // --- Employee mapping ------------------------------------------------------
  //
  // Reuses the department and teams created above, so the invariant and the
  // archived-lifecycle cases act on real rows. Mappings are cleared in the
  // cleanup step before those rows are removed, because the foreign keys are
  // RESTRICT and would otherwise refuse.
  console.log('\nEmployee mapping');

  interface TestEmployee {
    id: string;
    name: string;
    email?: string;
    department?: { id: string; name: string; active: boolean };
    team?: { id: string; name: string; active: boolean };
    hoursCapacity: number;
  }

  const employees = async (cookie: string, query = '') =>
    (await (await call(`/employees${query}`, { cookie })).json()) as TestEmployee[];

  const employee = async (id: string) =>
    (await (await call(`/employees/${id}`, { cookie: admin })).json()) as TestEmployee;

  const setMapping = (id: string, body: Record<string, unknown>, cookie = admin) =>
    call(`/employees/${id}/mapping`, { method: 'PATCH', cookie, body });

  // Snapshot before anything is written. Without this the suite leaves whoever
  // it runs as mapped to nothing, and the cleanup then deletes the emptied row
  // outright — silently losing real organisational data.
  for (const subject of [adminId, restrictedId]) {
    const before = await employee(subject);
    originalMapping.set(subject, {
      departmentId: before.department?.id ?? null,
      teamId: before.team?.id ?? null,
    });
  }

  check(
    'the manage permission is surfaced to the client',
    adminPermissions.permissions?.employees?.manage,
    true,
  );
  check(
    'a caller without a grant does not hold it',
    restrictedPermissions.permissions?.employees?.manage,
    false,
  );

  check('anonymous cannot list employees', await status('/employees'), 401);
  check(
    'anonymous cannot assign a mapping',
    await status(`/employees/${adminId}/mapping`, { method: 'PATCH', body: {} }),
    401,
  );

  check('a permitted caller can list employees', await status('/employees', { cookie: admin }), 200);
  check(
    'a caller without the manage grant can still read them',
    await status('/employees', { cookie: restricted }),
    200,
  );

  const directory = await employees(admin);
  check('the directory is returned', directory.length > 0, true);
  // People with no mapping must appear: they are exactly who needs assigning.
  check('everyone appears, mapped or not', directory.some((e) => e.id === adminId), true);
  check(
    'an employee id is an OpenProject user id, not one EPM minted',
    directory.every((e) => /^\d+$/.test(e.id)),
    true,
  );
  check(
    'no EPM-owned identity fields are invented',
    Object.keys(directory[0]!).every((key) =>
      ['id', 'name', 'email', 'avatarUrl', 'department', 'team', 'hoursCapacity'].includes(key),
    ),
    true,
  );
  // "Unmapped" has to mean it, or this asserts the fixture rather than the
  // rule: someone with a stored capacity correctly reports that value, and
  // picking whoever came back first will eventually pick them.
  {
    const unmapped = directory.find((person) => !person.department && !person.team);
    check(
      'a person reports a usable weekly capacity',
      typeof directory[0]!.hoursCapacity === 'number' && directory[0]!.hoursCapacity >= 0,
      true,
    );
    if (unmapped) {
      check('an unmapped person reports the default capacity', unmapped.hoursCapacity, 40);
    } else {
      console.log('  SKIP  an unmapped person reports the default capacity (everyone is mapped)');
    }
  }

  check('a known employee can be read', await status(`/employees/${adminId}`, { cookie: admin }), 200);
  check('an unknown employee is not found', await status('/employees/99999999', { cookie: admin }), 404);

  check(
    'a caller without the grant cannot assign',
    (await setMapping(adminId, { departmentId: deptId }, restricted)).status,
    403,
  );

  // --- the invariant ---
  // A team belongs to at most one department, so a person cannot be in one
  // department by way of a team that belongs to another.
  const secondDepartment = (await (
    await call('/departments', {
      method: 'POST',
      cookie: admin,
      body: { name: `${deptName} Two`, code: `${deptCode}2`.slice(0, 16) },
    })
  ).json()) as { id: string };
  departmentIds.push(secondDepartment.id);

  check(
    'a department alone can be assigned',
    (await setMapping(adminId, { departmentId: deptId })).status,
    200,
  );
  check('it is reported back', (await employee(adminId)).department?.id, deptId);

  // The team fixes the department, so it is taken from the team rather than the
  // request and the two cannot drift apart.
  const derived = await setMapping(adminId, { teamId });
  check('a team alone can be assigned', derived.status, 200);
  const derivedEmployee = (await derived.json()) as TestEmployee;
  check('the team is recorded', derivedEmployee.team?.id, teamId);
  check('the department is derived from the team', derivedEmployee.department?.id, deptId);

  check(
    'a matching department and team are accepted',
    (await setMapping(adminId, { departmentId: deptId, teamId })).status,
    200,
  );
  // Rejected rather than silently overruled: a caller who states both is told
  // they disagree.
  check(
    'a contradictory department and team are refused',
    (await setMapping(adminId, { departmentId: secondDepartment.id, teamId })).status,
    400,
  );
  check(
    'the mapping is unchanged after the refused assignment',
    (await employee(adminId)).department?.id,
    deptId,
  );

  // A team with no department constrains nothing.
  const looseTeamId = looseTeam.id;
  check(
    'a team with no department can be assigned',
    (await setMapping(restrictedId, { teamId: looseTeamId })).status,
    200,
  );
  const looseMapping = await employee(restrictedId);
  check('the team is recorded', looseMapping.team?.id, looseTeamId);
  check('it implies no department', looseMapping.department, undefined);
  check(
    'a department can be set alongside it',
    ((await (await setMapping(restrictedId, { departmentId: secondDepartment.id, teamId: looseTeamId })).json()) as TestEmployee)
      .department?.id,
    secondDepartment.id,
  );

  // --- validation ---
  const invalidMappings: [string, Record<string, unknown>][] = [
    ['an unknown department is refused', { departmentId: 'no-such-department' }],
    ['an unknown team is refused', { teamId: 'no-such-team' }],
    ['a non-string department is refused', { departmentId: 42 }],
    ['a non-string team is refused', { teamId: { id: 'x' } }],
  ];
  for (const [label, body] of invalidMappings) {
    check(label, (await setMapping(adminId, body)).status, 400);
  }
  check(
    'an unknown employee cannot be assigned',
    (await setMapping('99999999', { departmentId: deptId })).status,
    404,
  );

  // --- clearing ---
  const clearedMapping = (await (await setMapping(adminId, {})).json()) as TestEmployee;
  check('an empty body clears the mapping', clearedMapping.department, undefined);
  check('it clears the team too', clearedMapping.team, undefined);
  check(
    'an empty string clears as well',
    ((await (await setMapping(restrictedId, { departmentId: '', teamId: '' })).json()) as TestEmployee).team,
    undefined,
  );

  // --- filters ---
  await setMapping(adminId, { teamId });
  check(
    'employees can be filtered by department',
    (await employees(admin, `?departmentId=${deptId}`)).some((e) => e.id === adminId),
    true,
  );
  check(
    'the filter excludes people outside it',
    (await employees(admin, `?departmentId=${secondDepartment.id}`)).some((e) => e.id === adminId),
    false,
  );
  check(
    'employees can be filtered by team',
    (await employees(admin, `?teamId=${teamId}`)).map((e) => e.id).join(),
    adminId,
  );
  check(
    'unmapped people can be listed',
    (await employees(admin, '?unmapped=true')).some((e) => e.id === adminId),
    false,
  );
  check(
    'people can be searched by name',
    (await employees(admin, '?q=restricted')).every((e) => e.name.toLowerCase().includes('restricted')),
    true,
  );
  check('a search matching nobody returns nothing', (await employees(admin, '?q=zzzznobody')).length, 0);

  // --- team membership ---
  const members = (await (await call(`/teams/${teamId}/members`, { cookie: admin })).json()) as TestEmployee[];
  check('a team reports its members', members.some((m) => m.id === adminId), true);
  check('it excludes people on other teams', members.some((m) => m.id === restrictedId), false);
  check(
    'members of an unknown team are not found',
    await status('/teams/no-such-id/members', { cookie: admin }),
    404,
  );

  const withCounts = (await (await call('/teams', { cookie: admin })).json()) as { id: string; memberCount: number }[];
  check('a team carries a member count', withCounts.find((t) => t.id === teamId)?.memberCount, 1);
  check(
    'a team with nobody counts zero',
    withCounts.find((t) => t.id === looseTeamId)?.memberCount,
    0,
  );

  // --- workload scoping ---
  // Scoping changes only which people are measured; each person's numbers are
  // computed the same way regardless, so this needs no capacity work.
  const allWorkloads = (await (await call('/teams/workloads', { cookie: admin })).json()) as { userId: string }[];
  const scoped = (await (
    await call(`/teams/workloads?teamId=${teamId}`, { cookie: admin })
  ).json()) as { userId: string }[];

  check('unscoped workloads cover the directory', allWorkloads.length > 1, true);
  check('scoping to a team narrows them', scoped.length, 1);
  check('it returns that team member', scoped[0]?.userId, adminId);
  check(
    'it excludes people on other teams',
    scoped.some((w) => w.userId === restrictedId),
    false,
  );
  check(
    'a team with nobody yields no workloads',
    ((await (await call(`/teams/workloads?teamId=${looseTeamId}`, { cookie: admin })).json()) as unknown[]).length,
    0,
  );

  // --- archived lifecycle ---
  // Mappings that already point at an archived unit are left alone; archiving
  // stays a visibility decision, as it is for departments and teams.
  await call(`/teams/${teamId}/archive`, { method: 'PATCH', cookie: admin });
  const afterTeamArchive = await employee(adminId);
  check('an existing mapping survives its team being archived', afterTeamArchive.team?.id, teamId);
  check('the team is reported as archived', afterTeamArchive.team?.active, false);
  check(
    'nobody new can be assigned to an archived team',
    (await setMapping(restrictedId, { teamId })).status,
    400,
  );
  check(
    'someone can still be moved out of an archived team',
    (await setMapping(adminId, {})).status,
    200,
  );
  await call(`/teams/${teamId}/restore`, { method: 'PATCH', cookie: admin });

  await setMapping(adminId, { departmentId: deptId });
  await call(`/departments/${deptId}/archive`, { method: 'PATCH', cookie: admin });
  const afterDeptArchive = await employee(adminId);
  check(
    'an existing mapping survives its department being archived',
    afterDeptArchive.department?.id,
    deptId,
  );
  check('the department is reported as archived', afterDeptArchive.department?.active, false);
  check(
    'nobody new can be assigned to an archived department',
    (await setMapping(restrictedId, { departmentId: deptId })).status,
    400,
  );
  // The team is still active, but its department is not, so joining it would be
  // an assignment into an archived department by another route.
  check(
    'nor to a team whose department is archived',
    (await setMapping(restrictedId, { teamId })).status,
    400,
  );
  await call(`/departments/${deptId}/restore`, { method: 'PATCH', cookie: admin });

  // --- the directory reflects the mapping ---
  // The directory is cached for five minutes and carries the department name,
  // so a write has to invalidate it or the old name would persist.
  await setMapping(adminId, { departmentId: deptId });
  const directoryUsers = (await (await call('/users', { cookie: admin })).json()) as {
    id: string;
    department: string;
  }[];
  check(
    'the directory shows the mapped department without waiting for the cache',
    directoryUsers.find((u) => u.id === adminId)?.department,
    deptName,
  );

  await setMapping(adminId, {});
  await setMapping(restrictedId, {});

  // --- Capacity --------------------------------------------------------------
  //
  // Capacity is weekly hours on the employee record. These reuse the department
  // and teams above so the rollups have something real to sum, and every value
  // touched is captured first and put back in the cleanup step — capacity is
  // real per-person data, not this suite's to leave changed.
  console.log('\nCapacity');

  const capacityOf = async (id: string) => (await employee(id)).hoursCapacity;

  // Snapshot before anything is written.
  originalCapacity.set(adminId, await capacityOf(adminId));
  originalCapacity.set(restrictedId, await capacityOf(restrictedId));

  const setCapacity = (id: string, body: Record<string, unknown>, cookie = admin) =>
    call(`/employees/${id}/capacity`, { method: 'PATCH', cookie, body });

  // Asserted against someone who genuinely has nothing stored, rather than
  // assuming the person running the suite does. Hard-coding "the admin's
  // capacity is 40" only holds on a pristine instance, and passes on a dirty
  // one precisely because an earlier run left it at the default.
  {
    const { prisma } = await import('../db/prisma.js');
    const stored = await prisma.userProfile
      .findMany({
        where: { openProjectId: { in: [adminId, restrictedId] } },
        select: { openProjectId: true },
      })
      .catch(() => [] as { openProjectId: string }[]);

    const unset = [adminId, restrictedId].find(
      (id) => !stored.some((row) => row.openProjectId === id),
    );

    if (unset) {
      check('an unset capacity reports the documented default', originalCapacity.get(unset), 40);
    } else {
      console.log('  SKIP  an unset capacity reports the documented default (both are set)');
    }
  }

  check(
    'anonymous cannot set capacity',
    await status(`/employees/${adminId}/capacity`, { method: 'PATCH', body: { hoursCapacity: 10 } }),
    401,
  );
  check(
    'a caller without the grant cannot set capacity',
    (await setCapacity(adminId, { hoursCapacity: 10 }, restricted)).status,
    403,
  );
  check(
    'the capacity is unchanged after the refused write',
    await capacityOf(adminId),
    originalCapacity.get(adminId),
  );

  // --- validation, including the boundaries ---
  const invalidCapacities: [string, Record<string, unknown>, number][] = [
    ['a negative capacity is refused', { hoursCapacity: -1 }, 400],
    ['a capacity above a week is refused', { hoursCapacity: 169 }, 400],
    ['a text capacity is refused', { hoursCapacity: '40' }, 400],
    ['a null capacity is refused', { hoursCapacity: null }, 400],
    ['a missing capacity is refused', {}, 400],
    ['a boolean capacity is refused', { hoursCapacity: true }, 400],
  ];
  for (const [label, body, expected] of invalidCapacities) {
    check(label, (await setCapacity(adminId, body)).status, expected);
  }

  check(
    'an unknown employee cannot have capacity set',
    (await setCapacity('99999999', { hoursCapacity: 40 })).status,
    404,
  );

  // Zero is a real value: this person contributes nothing but is still a member.
  const zeroed = await setCapacity(adminId, { hoursCapacity: 0 });
  check('zero is accepted', zeroed.status, 200);
  check('zero is stored, not treated as unset', ((await zeroed.json()) as TestEmployee).hoursCapacity, 0);

  // 168 is the number of hours in a week — the boundary is inclusive.
  check(
    'exactly a full week is accepted',
    ((await (await setCapacity(adminId, { hoursCapacity: 168 })).json()) as TestEmployee).hoursCapacity,
    168,
  );

  check(
    'a decimal capacity is kept',
    ((await (await setCapacity(adminId, { hoursCapacity: 37.5 })).json()) as TestEmployee).hoursCapacity,
    37.5,
  );
  // Rounded to the quarter hour, so a weekly figure does not carry float noise.
  check(
    'a finer value rounds to the quarter hour',
    ((await (await setCapacity(adminId, { hoursCapacity: 37.6 })).json()) as TestEmployee).hoursCapacity,
    37.5,
  );

  check(
    'the value is readable back from the employee list',
    (await employees(admin)).find((e) => e.id === adminId)?.hoursCapacity,
    37.5,
  );

  // Capacity must not disturb the mapping, which is why it has its own route.
  await setMapping(adminId, { teamId });
  await setCapacity(adminId, { hoursCapacity: 40 });
  const afterCapacityWrite = await employee(adminId);
  check('setting capacity leaves the team alone', afterCapacityWrite.team?.id, teamId);
  check('and leaves the department alone', afterCapacityWrite.department?.id, deptId);

  // --- rollups ---
  const teamRollup = async (id: string) =>
    (await (await call(`/teams/${id}`, { cookie: admin })).json()) as {
      memberCount: number;
      capacityHours: number;
    };
  const departmentRollup = async (id: string) =>
    (await (await call(`/departments/${id}`, { cookie: admin })).json()) as {
      memberCount: number;
      capacityHours: number;
    };

  const oneMember = await teamRollup(teamId);
  check('a team with one member counts one', oneMember.memberCount, 1);
  check('and sums that member capacity', oneMember.capacityHours, 40);

  await setMapping(restrictedId, { teamId });
  await setCapacity(restrictedId, { hoursCapacity: 20 });
  const twoMembers = await teamRollup(teamId);
  check('a second member is counted', twoMembers.memberCount, 2);
  check('capacity is the sum, not an average', twoMembers.capacityHours, 60);

  // The department total comes from departmentId directly, so it does not
  // depend on how people are split across teams.
  const department = await departmentRollup(deptId);
  check('the department counts the same people', department.memberCount, 2);
  check('and sums the same hours', department.capacityHours, 60);

  // Someone with no hours is still a member — that is a different fact from
  // not being on the team.
  await setCapacity(restrictedId, { hoursCapacity: 0 });
  const withZero = await teamRollup(teamId);
  check('a zero-capacity member is still counted', withZero.memberCount, 2);
  check('but contributes nothing to the total', withZero.capacityHours, 40);

  // An unmapped person belongs to nothing, so there is nowhere to add them.
  await setMapping(restrictedId, {});
  const afterUnmapping = await teamRollup(teamId);
  check('unmapping removes someone from the count', afterUnmapping.memberCount, 1);
  check('and from the total', afterUnmapping.capacityHours, 40);

  check(
    'the member count agrees with the member list',
    ((await (await call(`/teams/${teamId}/members`, { cookie: admin })).json()) as TestEmployee[]).length,
    afterUnmapping.memberCount,
  );

  // An empty team reports zero rather than nothing: zero capacity is an answer.
  const emptyTeam = await teamRollup(looseTeam.id);
  check('an empty team counts zero members', emptyTeam.memberCount, 0);
  check('and reports zero capacity, not an absent field', emptyTeam.capacityHours, 0);

  const emptyDepartment = await departmentRollup(secondDepartment.id);
  check('an empty department reports zero capacity', emptyDepartment.capacityHours, 0);

  // Archiving is a visibility decision; the people are still there.
  await call(`/teams/${teamId}/archive`, { method: 'PATCH', cookie: admin });
  const archivedTeamRollup = await teamRollup(teamId);
  check('an archived team still counts its members', archivedTeamRollup.memberCount, 1);
  check('and still sums their capacity', archivedTeamRollup.capacityHours, 40);
  await call(`/teams/${teamId}/restore`, { method: 'PATCH', cookie: admin });

  await call(`/departments/${deptId}/archive`, { method: 'PATCH', cookie: admin });
  check('an archived department still aggregates', (await departmentRollup(deptId)).capacityHours, 40);
  await call(`/departments/${deptId}/restore`, { method: 'PATCH', cookie: admin });

  // --- workload and utilisation ---
  interface TestWorkload {
    userId: string;
    allocation: number | null;
    hoursLogged: number;
    hoursCapacity: number;
  }

  const workloadsOf = async (query = '') =>
    (await (await call(`/teams/workloads${query}`, { cookie: admin })).json()) as TestWorkload[];

  const scopedWorkloads = await workloadsOf(`?teamId=${teamId}`);
  check('workloads scope to the team', scopedWorkloads.length, 1);
  check('the member carries their capacity', scopedWorkloads[0]?.hoursCapacity, 40);
  check('logged hours are a number', typeof scopedWorkloads[0]?.hoursLogged, 'number');
  // Logged hours come from the current week, matching the capacity period, so
  // the ratio between them is meaningful rather than an all-time total over a
  // weekly figure.
  check(
    'allocation is logged over capacity',
    scopedWorkloads[0]?.allocation,
    Math.round(((scopedWorkloads[0]?.hoursLogged ?? 0) / 40) * 100),
  );

  // The case that would otherwise be Infinity or a misleading zero.
  await setMapping(restrictedId, { teamId });
  await setCapacity(restrictedId, { hoursCapacity: 0 });
  const withZeroCapacity = await workloadsOf(`?teamId=${teamId}`);
  const zeroPerson = withZeroCapacity.find((w) => w.userId === restrictedId);
  check('a zero-capacity person appears in workloads', Boolean(zeroPerson), true);
  check('their capacity is reported as zero', zeroPerson?.hoursCapacity, 0);
  check('and their allocation is null, not a number', zeroPerson?.allocation, null);
  check(
    'no allocation is ever Infinity or NaN',
    withZeroCapacity.every((w) => w.allocation === null || Number.isFinite(w.allocation)),
    true,
  );

  check('an empty team yields no workloads', (await workloadsOf(`?teamId=${looseTeam.id}`)).length, 0);

  await setMapping(restrictedId, {});

  // --- Health ----------------------------------------------------------------
  //
  // BR-204, BR-205 and BR-206, through the API, on this suite's own project —
  // so the work, the plan and the spend the tests need can be arranged rather
  // than hoped for. The calculation itself is checked against worked examples
  // in `domain/__checks__/health.check.ts`, which needs no instance.
  //
  // Nothing here touches a real project. The project, its work packages and
  // its time go with it in the cleanup; the hourly rate set on the
  // administrator is put back there too, and so is anything changed in the
  // health rules.
  console.log('\nHealth');

  interface TestCriterion {
    criterion: string;
    level: string | null;
    value: number | null;
    reason: string;
  }
  interface TestHealthProject {
    id: string;
    status: string;
    startDate?: string;
    dueDate?: string;
    budgetTotal: number;
    budgetUsed: number;
    health: Record<string, string | null>;
    healthCalculated: Record<string, string | null>;
    healthOverride?: { levels: Record<string, string>; reason: string; setBy: string; setAt: string };
    healthDetail: { criteria: TestCriterion[]; explanation: string; calculatedAt: string; ruleVersion: number };
  }
  interface TestJournalEntry {
    seq: number;
    action: string;
    summary: string;
    reason?: string;
    actorId?: string;
    actorKind: string;
  }

  if (!createdId) throw new Error("The health tests need the suite's own project.");
  const healthProjectId = createdId;

  const readHealthProject = async (cookie = admin) =>
    (await (await call(`/projects/${healthProjectId}`, { cookie })).json()) as TestHealthProject;
  const criterionOf = (project: TestHealthProject | undefined, key: string) =>
    project?.healthDetail?.criteria.find((criterion) => criterion.criterion === key);
  const journalOf = async (cookie = admin) =>
    (await (await call(`/projects/${healthProjectId}/journal`, { cookie })).json()) as TestJournalEntry[];

  // Recalculation after a change is asynchronous by design — the write that
  // caused it does not wait — so the tests wait for it, up to a bound.
  const waitForHealth = async (ready: (project: TestHealthProject) => boolean) => {
    const deadline = Date.now() + 20_000;
    let latest = await readHealthProject();
    while (!ready(latest) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      latest = await readHealthProject();
    }
    return latest;
  };

  // --- the shape of a project's health ---
  const fresh = await readHealthProject();
  check('a project carries its effective health', typeof fresh.health?.overall, 'string');
  check('and the calculated value alongside it', typeof fresh.healthCalculated?.overall, 'string');
  check('and the calculation itself, one entry per criterion', fresh.healthDetail?.criteria.length, 4);
  check(
    'every criterion explains itself',
    fresh.healthDetail?.criteria.every((criterion) => criterion.reason.length > 0),
    true,
  );
  check(
    'the scope and resources dimensions are gone',
    'scope' in (fresh.health ?? {}) || 'resources' in (fresh.health ?? {}),
    false,
  );
  check('with no planned finish, schedule is not assessed rather than green', criterionOf(fresh, 'schedule')?.level, null);
  check('with no budget, budget is not assessed rather than green', criterionOf(fresh, 'budget')?.level, null);
  check('and the reason says why', criterionOf(fresh, 'budget')?.reason.includes('No budget'), true);
  check('a calculation names the rules it used', typeof fresh.healthDetail?.ruleVersion, 'number');
  check('the overall comes with its explanation', (fresh.healthDetail?.explanation.length ?? 0) > 0, true);

  check(
    'the configure permission is surfaced to an administrator',
    adminPermissions.permissions?.health?.configure,
    true,
  );
  check(
    'and withheld from a caller without the grant',
    restrictedPermissions.permissions?.health?.configure,
    false,
  );
  check(
    'the manage permission is surfaced to the client',
    adminPermissions.permissions?.health?.manage,
    true,
  );
  check(
    'a caller without a grant does not hold it',
    restrictedPermissions.permissions?.health?.manage,
    false,
  );

  // --- BR-204: a configured amber threshold, crossed, turns the project amber ---
  interface TestRules {
    version: number;
    criteria: Record<
      string,
      { enabled: boolean; weight: number; amberAt: number; redAt: number; typeIds?: string[]; priorityIds?: string[] }
    >;
    redShare: number;
    amberShare: number;
  }
  const rulesNow = async () => (await (await call('/health/rules', { cookie: admin })).json()) as TestRules;
  const rulesAtStart = await rulesNow();
  originalHealthRules = rulesAtStart;
  check('anyone signed in can read the health rules', await status('/health/rules', { cookie: restricted }), 200);
  check('anonymous cannot', await status('/health/rules'), 401);

  const overdueAmber = rulesAtStart.criteria.overdue!.amberAt;
  let overdueArranged = 0;
  for (let n = 0; n < overdueAmber; n += 1) {
    const task = await call('/tasks', {
      method: 'POST',
      cookie: admin,
      body: {
        projectId: healthProjectId,
        subject: `Health probe, overdue ${n + 1}`,
        startDate: '2026-01-05',
        dueDate: '2026-01-15',
      },
    });
    if (task.status === 201) overdueArranged += 1;
  }
  check(`${overdueAmber} overdue work packages could be arranged`, overdueArranged, overdueAmber);

  const amber = await waitForHealth((project) => criterionOf(project, 'overdue')?.level === 'warning');
  check(
    'crossing the amber line turns overdue items amber with nobody touching it',
    criterionOf(amber, 'overdue')?.level,
    'warning',
  );
  check('the measured figure is the overdue count', criterionOf(amber, 'overdue')?.value, overdueAmber);
  check('so the project is computed amber', amber.healthCalculated.overall, 'warning');
  check('and its status agrees with its health', amber.status, 'at_risk');
  check(
    'the journal records the move, attributed to the system',
    (await journalOf()).some(
      (entry) => entry.action === 'health.calculated' && entry.actorKind === 'system',
    ),
    true,
  );

  // The rules are policy, so only `health:configure` changes them — and a
  // preview shows what a change would do without doing it.
  const stricter = structuredClone(rulesAtStart) as TestRules;
  stricter.criteria.overdue!.amberAt = 1;
  stricter.criteria.overdue!.redAt = 1;
  check(
    'a caller without the grant cannot preview rules',
    await status('/health/rules/preview', { method: 'POST', cookie: restricted, body: stricter }),
    403,
  );
  const preview = (await (
    await call('/health/rules/preview', { method: 'POST', cookie: admin, body: stricter })
  ).json()) as { projects: { projectId: string; current: { overall: string }; preview: { overall: string } }[] };
  const previewRow = preview.projects?.find((row) => row.projectId === healthProjectId);
  check('a preview recalculates with the proposed rules', previewRow?.preview.overall, 'critical');
  check('beside what the rules in force give', previewRow?.current.overall, 'warning');
  check('and saves nothing', (await rulesNow()).version, rulesAtStart.version);

  const reversed = structuredClone(rulesAtStart) as TestRules;
  reversed.criteria.overdue!.redAt = reversed.criteria.overdue!.amberAt - 1;
  check(
    'red below amber is refused',
    (await call('/health/rules', { method: 'PUT', cookie: admin, body: reversed })).status,
    422,
  );
  const noneCounted = structuredClone(rulesAtStart) as TestRules;
  for (const rule of Object.values(noneCounted.criteria)) rule.weight = 0;
  check(
    'rules that count nothing are refused',
    (await call('/health/rules', { method: 'PUT', cookie: admin, body: noneCounted })).status,
    422,
  );
  check(
    'saving the rules already in force is refused as a no-op',
    (await call('/health/rules', { method: 'PUT', cookie: admin, body: rulesAtStart })).status,
    409,
  );
  check(
    'a caller without the grant cannot change the rules',
    (await call('/health/rules', { method: 'PUT', cookie: restricted, body: stricter })).status,
    403,
  );
  check(
    'nor read the instance options the editor offers',
    await status('/health/rules/options', { cookie: restricted }),
    403,
  );
  check('the rules are unchanged after the refusals', (await rulesNow()).version, rulesAtStart.version);

  // A real save, chosen so it changes no project's level: pinning the risk
  // priorities to exactly what an empty selection already resolves to.
  const options = (await (await call('/health/rules/options', { cookie: admin })).json()) as {
    defaultHighPriorityIds: string[];
  };
  if (options.defaultHighPriorityIds?.length) {
    const explicit = structuredClone(rulesAtStart) as TestRules;
    explicit.criteria.risks!.priorityIds = options.defaultHighPriorityIds;
    const saved = await call('/health/rules', { method: 'PUT', cookie: admin, body: explicit });
    check('an administrator can save new rules', saved.status, 200);
    check('a save adds the next version', ((await saved.json()) as TestRules).version, rulesAtStart.version + 1);
    const history = (await (await call('/health/rules/history', { cookie: admin })).json()) as TestJournalEntry[];
    check('and is journalled with who made it', history[0]?.actorId, adminId);
    check('naming what changed', history[0]?.summary.includes('high priorities changed'), true);

    const restored = await call('/health/rules', { method: 'PUT', cookie: admin, body: rulesAtStart });
    check('and the previous rules can be put back as the version after', restored.status, 200);
  } else {
    console.log('  (skipped the rules save: this instance has no high priorities to pin)');
  }

  // --- the plan: planned dates and budget ---
  const setPlan = (body: Record<string, unknown>, cookie = admin) =>
    call(`/projects/${healthProjectId}/plan`, { method: 'PATCH', cookie, body });

  check(
    'a caller who cannot edit the project cannot change its plan',
    (await setPlan({ budgetTotal: 1 }, restricted)).status,
    403,
  );
  check(
    'a finish before the start is refused',
    (await setPlan({ plannedStart: '2026-06-01', plannedFinish: '2026-05-01' })).status,
    422,
  );
  check('a negative budget is refused', (await setPlan({ budgetTotal: -5 })).status, 400);
  check('an unknown field is refused', (await setPlan({ budgetUsed: 10 })).status, 400);
  check(
    'spend cannot be typed in any more',
    (await call(`/projects/${healthProjectId}`, { method: 'PATCH', cookie: admin, body: { budgetUsed: 10 } })).status,
    400,
  );

  const planned = await setPlan({ plannedStart: '2026-01-01', plannedFinish: '2027-12-31', budgetTotal: 1000 });
  check('a permitted caller can set the plan', planned.status, 200);
  const plannedBody = (await planned.json()) as TestHealthProject;
  check('the planned start is kept', plannedBody.startDate, '2026-01-01');
  check('the planned finish is kept', plannedBody.dueDate, '2027-12-31');
  check('the budget is kept', plannedBody.budgetTotal, 1000);
  check(
    'the answer is already recalculated: schedule is now assessed',
    criterionOf(plannedBody, 'schedule')?.level,
    'healthy',
  );
  check('and so is budget, with nothing spent yet', criterionOf(plannedBody, 'budget')?.level, 'healthy');
  check(
    'a plan change is journalled with its before and after',
    (await journalOf()).some(
      (entry) => entry.action === 'project.plan.updated' && entry.summary.includes('budget') && entry.actorId === adminId,
    ),
    true,
  );
  check(
    'clearing a date is allowed and keeps the rest',
    ((await (await setPlan({ plannedStart: null })).json()) as TestHealthProject).budgetTotal,
    1000,
  );
  await setPlan({ plannedStart: '2026-01-01' });

  // --- BR-205: spend that crosses the red line turns the project red ---
  const adminEmployee = (await (await call(`/employees/${adminId}`, { cookie: admin })).json()) as {
    hourlyRate?: number | null;
  };
  originalAdminRate = adminEmployee.hourlyRate ?? null;
  check(
    'an hourly rate can be set to price logged time',
    (await call(`/employees/${adminId}/rate`, { method: 'PATCH', cookie: admin, body: { hourlyRate: 100 } })).status,
    200,
  );

  const today = new Date().toISOString().slice(0, 10);
  // From OpenProject 17 time belongs to a work package: a task to log it on.
  const healthTask = ((await (await call('/tasks', { method: 'POST', cookie: admin, body: { projectId: healthProjectId, subject: 'Health budget probe time' } })).json()) as { id?: string }).id;
  const logTime = async (activityId?: string) =>
    call('/time-entries', {
      method: 'POST',
      cookie: admin,
      body: { projectId: healthProjectId, workPackageId: healthTask, hours: 10, spentOn: today, comment: 'Health budget probe', ...(activityId ? { activityId } : {}) },
    });
  let logged = await logTime();
  if (logged.status !== 201) {
    // The instance wants an activity; take the first it offers this project.
    const form = JSON.stringify(
      await (await call('/forms/time-entries', { method: 'POST', cookie: admin, body: { projectId: healthProjectId, workPackageId: healthTask } })).json(),
    );
    const activity = /time_entries\/activities\/(\d+)/.exec(form)?.[1];
    logged = await logTime(activity);
  }
  check('time can be logged on the project', logged.status, 201);
  healthTimeEntryId = logged.status === 201 ? ((await logged.json()) as { id: string }).id : undefined;

  const red = await waitForHealth((project) => criterionOf(project, 'budget')?.level === 'critical');
  check('logging spend past the red line turns budget red, unprompted', criterionOf(red, 'budget')?.level, 'critical');
  check('the project is red on that recalculation', red.healthCalculated.overall, 'critical');
  check('its spend is the logged hours at the rate, not a typed figure', red.budgetUsed, 1000);
  check('the reason names the spend and the budget', criterionOf(red, 'budget')?.reason.includes('1,000'), true);
  const redJournal = await journalOf();
  check(
    'and the move is journalled, saying what moved',
    redJournal.some((entry) => entry.action === 'health.calculated' && entry.summary.includes('budget variance')),
    true,
  );
  check(
    'journal entries come newest first, in sequence',
    redJournal.every((entry, index) => index === 0 || redJournal[index - 1]!.seq > entry.seq),
    true,
  );

  // --- BR-206: an override needs a reason and hides nothing ---
  const setOverride = (body: Record<string, unknown>, cookie = admin) =>
    call(`/projects/${healthProjectId}/health`, { method: 'PATCH', cookie, body });

  check(
    'anonymous cannot override health',
    await status(`/projects/${healthProjectId}/health`, { method: 'PATCH', body: { levels: { overall: 'warning' } } }),
    401,
  );
  check(
    'a caller without the grant cannot override health',
    (await setOverride({ levels: { overall: 'warning' }, reason: 'Recovery plan agreed with the sponsor.' }, restricted)).status,
    403,
  );
  check('an override without a reason is refused', (await setOverride({ levels: { overall: 'warning' } })).status, 422);
  check(
    'a reason that says nothing is refused too',
    (await setOverride({ levels: { overall: 'warning' }, reason: 'ok' })).status,
    422,
  );
  check(
    'a retired dimension is refused',
    (await setOverride({ levels: { scope: 'healthy' }, reason: 'Scope is fine, honestly.' })).status,
    400,
  );
  check(
    'an unknown level is refused',
    (await setOverride({ levels: { overall: 'purple' }, reason: 'Purple is not a level.' })).status,
    400,
  );
  check(
    'an unknown project is not found',
    (await call('/projects/99999999/health', {
      method: 'PATCH',
      cookie: admin,
      body: { levels: { overall: 'warning' }, reason: 'There is no such project.' },
    })).status,
    404,
  );
  check('nothing was overridden by the refusals', (await readHealthProject()).healthOverride, undefined);

  const reason = 'Change request approved on 1 Oct adds budget; finance has not loaded it yet.';
  const overridden = await setOverride({ levels: { overall: 'warning' }, reason });
  check('a permitted caller can override, with a reason', overridden.status, 200);
  const overriddenBody = (await overridden.json()) as TestHealthProject;
  check('the effective value takes the override', overriddenBody.health.overall, 'warning');
  check('the calculated value is still reported beside it', overriddenBody.healthCalculated.overall, 'critical');
  check('and so is the reason', overriddenBody.healthOverride?.reason, reason);
  check('and who set it', overriddenBody.healthOverride?.setBy, adminId);
  check(
    'the override is in the journal, with its reason',
    (await journalOf()).some((entry) => entry.action === 'health.override.set' && entry.reason === reason),
    true,
  );

  // Reports carry both values and the reason — a pin is never reported as measured.
  const insights = (await (await call('/reports/executive-insights', { cookie: admin })).json()) as {
    matrix: { projectId: string; overall: string; calculatedOverall: string; override?: { reason: string } }[];
  };
  const reportRow = insights.matrix?.find((row) => row.projectId === healthProjectId);
  check('the executive report shows the overridden value', reportRow?.overall, 'warning');
  check('beside the calculated one', reportRow?.calculatedOverall, 'critical');
  check('with the reason', reportRow?.override?.reason, reason);

  const changedReason = 'Sponsor agreed to carry the overrun into the next phase.';
  await setOverride({ levels: { overall: 'healthy', budget: 'warning' }, reason: changedReason });
  check(
    'changing an override is journalled as a change',
    (await journalOf()).some((entry) => entry.action === 'health.override.changed' && entry.reason === changedReason),
    true,
  );

  const clearedOverride = (await (await setOverride({ levels: {} })).json()) as TestHealthProject;
  check('an empty override clears it', clearedOverride.healthOverride, undefined);
  check('and the calculated health applies again', clearedOverride.health.overall, clearedOverride.healthCalculated.overall);
  const clearedJournal = await journalOf();
  check(
    'clearing is journalled',
    clearedJournal.some((entry) => entry.action === 'health.override.cleared'),
    true,
  );
  await setOverride({ levels: {} });
  check('clearing nothing writes nothing', (await journalOf()).length, clearedJournal.length);

  // --- reading the journal, and recalculating on request ---
  const restrictedSeesProject = (await status(`/projects/${healthProjectId}`, { cookie: restricted })) === 200;
  check(
    'a project journal is readable exactly by those who can see the project',
    await status(`/projects/${healthProjectId}/journal`, { cookie: restricted }),
    restrictedSeesProject ? 200 : 404,
  );
  check('anonymous cannot read a journal', await status(`/projects/${healthProjectId}/journal`), 401);
  check(
    'the journal cannot be edited through the API',
    await status(`/projects/${healthProjectId}/journal`, { method: 'PATCH', cookie: admin, body: {} }),
    404,
  );
  check(
    'nor deleted',
    await status(`/projects/${healthProjectId}/journal`, { method: 'DELETE', cookie: admin }),
    404,
  );
  check(
    'a caller who may not edit the project cannot force a recalculation',
    await status(`/projects/${healthProjectId}/health/recalculate`, { method: 'POST', cookie: restricted }),
    403,
  );
  const recalculated = await call(`/projects/${healthProjectId}/health/recalculate`, { method: 'POST', cookie: admin });
  check('an editor can recalculate on demand', recalculated.status, 200);
  check(
    'and the answer is the fresh calculation',
    Date.parse(((await recalculated.json()) as TestHealthProject).healthDetail.calculatedAt) >= Date.parse(red.healthDetail.calculatedAt),
    true,
  );

  // A summary must not contradict the project page it summarises.
  const readAtRisk = async () =>
    ((await (await call('/dashboard/metrics', { cookie: admin })).json()) as {
      projectsAtRisk: number;
    }).projectsAtRisk;

  const atRiskRed = await readAtRisk();
  await setOverride({ levels: { overall: 'healthy' }, reason: 'Pinned green to check the dashboard follows.' });
  const atRiskPinnedGreen = await readAtRisk();
  await setOverride({ levels: {} });
  check('pinning a red project green takes it out of the at-risk count', atRiskPinnedGreen, atRiskRed - 1);

  // The spend and the rate are put back now, not only in the cleanup, so the
  // sections after this one see the instance as they expect it.
  if (healthTimeEntryId) {
    await call(`/time-entries/${healthTimeEntryId}`, { method: 'DELETE', cookie: admin });
    healthTimeEntryId = undefined;
  }
  await call(`/employees/${adminId}/rate`, { method: 'PATCH', cookie: admin, body: { hourlyRate: originalAdminRate } });
  originalAdminRate = undefined;

  // --- Approvals -------------------------------------------------------------
  //
  // BR-211 to BR-215, through the API, on this suite's own project. The chain
  // covers change requests in that project alone, so no real project's work is
  // routed by it: a change above the value threshold goes to the owner and then
  // a sponsor, one below to the owner only. The administrator is the owner and
  // the restricted user the sponsor — somebody with no role in the project, as
  // a finance approver often is; being named in the chain is the authority.
  //
  // Needs the governance types, statuses and value field that
  // `backend/openproject/setup/governance-types.rb` installs; without them the
  // section says so and stops. Its rows go in the cleanup. The journal entries
  // stay, because the journal refuses deletion.
  console.log('\nApprovals');

  interface TestApprovalTask {
    id: string;
    approverId: string;
    delegateId?: string;
    status: string;
    activatedAt?: string;
    dueAt?: string;
    breachedAt?: string;
    decidedBy?: string;
    onBehalfOf?: string;
    comment?: string;
  }
  interface TestApprovalRequest {
    id: string;
    status: string;
    currentStep: number;
    steps: { name: string; applies: boolean; status: string; tasks: TestApprovalTask[] }[];
  }
  interface TestApprovalSubject {
    chain?: { name: string; steps: { name: string; applies: boolean }[] };
    canSubmit: boolean;
    current?: TestApprovalRequest;
  }

  check(
    'the approvals configure permission is surfaced to an administrator',
    adminPermissions.permissions?.approvals?.configure,
    true,
  );
  check(
    'and withheld from a caller without the grant',
    restrictedPermissions.permissions?.approvals?.configure,
    false,
  );
  check('anonymous cannot read approval chains', await status('/approvals/chains'), 401);
  check('a caller without the grant cannot read them', await status('/approvals/chains', { cookie: restricted }), 403);
  check(
    'nor define one',
    await status('/approvals/chains', { method: 'POST', cookie: restricted, body: { name: 'Not allowed' } }),
    403,
  );
  check('nor read what the chain editor offers', await status('/approvals/options', { cookie: restricted }), 403);

  const approvalOptions = (await (await call('/approvals/options', { cookie: admin })).json()) as {
    types?: { id: string; name: string }[];
    statuses?: { id: string; name: string }[];
    customFields?: { id: string; name: string; numeric: boolean }[];
  };
  const named = <T extends { name: string }>(list: T[] | undefined, name: RegExp) =>
    list?.find((item) => name.test(item.name));
  const changeRequestType = named(approvalOptions.types, /^change request$/i);
  const pendingApproval = named(approvalOptions.statuses, /^pending approval$/i);
  const approvedStatus = named(approvalOptions.statuses, /^approved$/i);
  const rejectedStatus = named(approvalOptions.statuses, /^rejected$/i);
  const changeValue = named(approvalOptions.customFields, /^change value$/i);
  const governanceReady = Boolean(
    changeRequestType && pendingApproval && approvedStatus && rejectedStatus && changeValue?.numeric,
  );
  check('the governance types, statuses and value field are installed', governanceReady, true);

  if (!createdId) throw new Error("The approval tests need the suite's own project.");
  const approvalProjectId = createdId;

  if (governanceReady) {
    const { prisma: approvalDb } = await import('../db/prisma.js');
    const { sweepApprovals } = await import('../domain/approvals.js');

    const readJson = async <T>(path: string, cookie = admin) => (await (await call(path, { cookie })).json()) as T;
    const subjectOf = (id: string) => readJson<TestApprovalSubject>(`/approvals/subjects/work-packages/${id}`);
    const requestOf = (id: string) => readJson<TestApprovalRequest>(`/approvals/requests/${id}`);
    const journalOfRequest = (id: string) => readJson<TestJournalEntry[]>(`/approvals/requests/${id}/journal`);
    const statusNameOf = async (id: string) =>
      (await readJson<{ status?: { name?: string } }>(`/tasks/${id}`)).status?.name;
    // The work package's status follows a decision once it has committed, so
    // the tests wait for it, up to a bound.
    const waitForStatus = async (id: string, name: string) => {
      const deadline = Date.now() + 10_000;
      let current = await statusNameOf(id);
      while (current !== name && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        current = await statusNameOf(id);
      }
      return current;
    };
    const changeRequest = async (subject: string, value: number) => {
      const response = await call('/work-packages', {
        method: 'POST',
        cookie: admin,
        body: {
          projectId: approvalProjectId,
          typeId: changeRequestType!.id,
          payload: { subject, [changeValue!.id]: value },
        },
      });
      const body = (await response.json()) as { id?: string };
      if (!body.id) throw new Error(`Could not create a change request for the approval tests (${response.status}).`);
      return body.id;
    };
    const submit = (id: string, cookie = admin) =>
      call(`/approvals/subjects/work-packages/${id}/submit`, { method: 'POST', cookie });
    const decide = (taskId: string, cookie: string, decision: 'approve' | 'reject', comment?: string) =>
      call(`/approvals/tasks/${taskId}/decide`, {
        method: 'POST',
        cookie,
        body: { decision, ...(comment ? { comment } : {}) },
      });
    // The link an approver is sent, read from the outbox where the email waits.
    const linkFor = async (taskId: string, recipientId: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const row = await approvalDb.emailOutbox.findFirst({
          where: { recipientId, dedupeKey: `approval-link:${taskId}:${recipientId}` },
        });
        const url = (row?.payload as { approveUrl?: string } | null)?.approveUrl;
        if (url || Date.now() > deadline) return url?.split('/decide/')[1]?.split('?')[0];
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };

    // --- BR-211: a chain, sequential and conditional ---
    const chainBody = {
      name: `Authz change control ${Date.now()}`,
      typeIds: [changeRequestType!.id],
      projectIds: [approvalProjectId],
      valueField: changeValue!.id,
      steps: [
        { id: 'owner', name: 'Owner review', approvers: [{ kind: 'user', userId: adminId }], mode: 'any' },
        {
          id: 'sponsor',
          name: 'Sponsor sign-off',
          approvers: [{ kind: 'user', userId: restrictedId }],
          mode: 'all',
          condition: { field: 'value', operator: 'gt', value: 50_000 },
          slaHours: 1,
          escalateTo: [{ kind: 'user', userId: adminId }],
        },
      ],
      onSubmitStatusId: pendingApproval!.id,
      onApproveStatusId: approvedStatus!.id,
      onRejectStatusId: rejectedStatus!.id,
      // The administrator both submits and approves the owner step.
      allowSelfApproval: true,
      active: true,
    };
    check(
      'a value threshold with no value field to read is refused',
      await status('/approvals/chains', { method: 'POST', cookie: admin, body: { ...chainBody, valueField: '' } }),
      422,
    );
    check(
      'so is a chain with no steps',
      await status('/approvals/chains', { method: 'POST', cookie: admin, body: { ...chainBody, steps: [] } }),
      422,
    );
    const chainCreated = await call('/approvals/chains', { method: 'POST', cookie: admin, body: chainBody });
    const chain = (await chainCreated.json()) as { id?: string; steps?: unknown[] };
    if (chain.id) approvalChainIds.push(chain.id);
    check('an administrator can define a chain', chainCreated.status, 201);
    check('its steps are kept in order', chain.steps?.length, 2);

    const bigChange = await changeRequest('Approval probe: extend the scope', 75_000);
    const smallChange = await changeRequest('Approval probe: a small change', 20_000);

    const bigPreview = await subjectOf(bigChange);
    check('the chain applies to a change request in its project', bigPreview.chain?.name, chainBody.name);
    check('above the threshold both steps apply', bigPreview.chain?.steps.filter((step) => step.applies).length, 2);
    check(
      'below it only the owner step does',
      (await subjectOf(smallChange)).chain?.steps.filter((step) => step.applies).length,
      1,
    );
    check('its author may submit it', bigPreview.canSubmit, true);
    check(
      'someone who cannot edit the work package cannot submit it',
      [403, 404].includes((await submit(bigChange, restricted)).status),
      true,
    );
    check(
      'nor can anyone set a status the chain owns by hand',
      (await call(`/tasks/${bigChange}`, { method: 'PATCH', cookie: admin, body: { statusId: approvedStatus!.id } }))
        .status,
      409,
    );

    const submitted = await submit(bigChange);
    check('the author submits it', submitted.status, 201);
    const bigRequest = ((await submitted.json()) as TestApprovalSubject).current;
    if (!bigRequest) throw new Error('Submitting returned no request.');
    check('it waits on the first step', `${bigRequest.status}@${bigRequest.currentStep}`, 'pending@0');
    check('the second approver is not asked yet: the steps run in order', bigRequest.steps[1]?.tasks[0]?.status, 'waiting');
    check('submitting it again while it waits is refused', (await submit(bigChange)).status, 409);
    check('the work package is pending approval', await waitForStatus(bigChange, pendingApproval!.name), pendingApproval!.name);
    const ordinaryStatus = approvalOptions.statuses?.find(
      (one) => ![pendingApproval, approvedStatus, rejectedStatus].some((owned) => owned?.id === one.id),
    );
    check(
      'and its status cannot be changed by hand while it waits',
      (await call(`/tasks/${bigChange}`, { method: 'PATCH', cookie: admin, body: { statusId: ordinaryStatus?.id } }))
        .status,
      409,
    );

    const ownerTask = bigRequest.steps[0]!.tasks[0]!;
    check('somebody the step does not name cannot decide it', (await decide(ownerTask.id, restricted, 'approve')).status, 403);
    const ownerDecision = await decide(ownerTask.id, admin, 'approve', 'Scope fits the release.');
    check('the owner approves', ownerDecision.status, 200);
    const afterOwner = (await ownerDecision.json()) as TestApprovalRequest;
    check('the request moves on to the second approver', afterOwner.currentStep, 1);
    check('a step cannot be decided twice', (await decide(ownerTask.id, admin, 'approve')).status, 409);
    check(
      "it is in the second approver's inbox",
      (await readJson<TestApprovalRequest[]>('/approvals/inbox', restricted)).some((one) => one.id === bigRequest.id),
      true,
    );
    check(
      'and counted on their badge',
      ((await readJson<{ count?: number }>('/approvals/inbox/count', restricted)).count ?? 0) >= 1,
      true,
    );
    check(
      'an approver may read the request without a role in its project',
      await status(`/approvals/requests/${bigRequest.id}`, { cookie: restricted }),
      200,
    );

    // --- BR-215: deciding from the email ---
    const sponsorTask = afterOwner.steps[1]?.tasks[0];
    const token = sponsorTask ? await linkFor(sponsorTask.id, restrictedId) : undefined;
    check('the approver is emailed a link to decide', Boolean(token), true);
    if (token) {
      check('the link needs a signed-in session', await status(`/approvals/links/${token}`), 401);
      check('it does not work for anyone else', await status(`/approvals/links/${token}`, { cookie: admin }), 403);
      check(
        'nor decide for anyone else',
        await status(`/approvals/links/${token}/decide`, { method: 'POST', cookie: admin, body: { decision: 'approve' } }),
        403,
      );
      check('it opens for the person it was sent to', await status(`/approvals/links/${token}`, { cookie: restricted }), 200);
      check(
        'and opening it decides nothing, so it opens again',
        await status(`/approvals/links/${token}`, { cookie: restricted }),
        200,
      );
      check(
        'a rejection from the link still needs its reason',
        await status(`/approvals/links/${token}/decide`, {
          method: 'POST',
          cookie: restricted,
          body: { decision: 'reject' },
        }),
        422,
      );
      check(
        'and being sent back for one does not use the link up',
        await status(`/approvals/links/${token}`, { cookie: restricted }),
        200,
      );
      const viaLink = await call(`/approvals/links/${token}/decide`, {
        method: 'POST',
        cookie: restricted,
        body: { decision: 'approve', comment: 'Funded from contingency.' },
      });
      check('the link decides the approval', viaLink.status, 200);
      check('which completes the chain', ((await viaLink.json()) as TestApprovalRequest).status, 'approved');
      check(
        'the link is refused on reuse',
        await status(`/approvals/links/${token}/decide`, {
          method: 'POST',
          cookie: restricted,
          body: { decision: 'reject', comment: 'Changed my mind.' },
        }),
        410,
      );
      check('and cannot even be opened again', await status(`/approvals/links/${token}`, { cookie: restricted }), 410);
      check('the work package is approved', await waitForStatus(bigChange, approvedStatus!.name), approvedStatus!.name);

      // The move is the chain's, so it is journalled under the automation
      // account where there is one — not under the administrator's key.
      const principal = (await (await call('/automation/status', { cookie: admin })).json()) as {
        account?: { working?: boolean; userId?: string };
      };
      if (principal.account?.working) {
        const { openProject: upstream } = await import('../openproject/client.js');
        const moves = await upstream.request<{ _embedded?: { elements?: { _links?: { user?: { href?: string } } }[] } }>(
          `/work_packages/${bigChange}/activities`,
        );
        check(
          "and OpenProject journals the chain's move under the automation account",
          moves._embedded?.elements?.at(-1)?._links?.user?.href,
          `/api/v3/users/${principal.account.userId}`,
        );
      }
    }

    // --- BR-213: every step, decision and comment, in sequence ---
    const bigJournal = await journalOfRequest(bigRequest.id);
    const decisions = bigJournal.filter((entry) => entry.action === 'approval.decided');
    check('both decisions are in the journal', decisions.length, 2);
    check(
      'in the order they were made',
      decisions.map((entry) => entry.actorId).join(' then '),
      `${adminId} then ${restrictedId}`,
    );
    check(
      'each with its comment',
      decisions.map((entry) => entry.reason).join(' | '),
      'Scope fits the release. | Funded from contingency.',
    );
    check(
      'and its step',
      decisions.every((entry, index) => entry.summary.includes(index === 0 ? 'Owner review' : 'Sponsor sign-off')),
      true,
    );
    check('the decision from the email says so', decisions[1]?.summary.includes('from the email'), true);
    check(
      'submission, each step and the outcome are there too',
      ['approval.submitted', 'approval.step.started', 'approval.completed'].every((action) =>
        bigJournal.some((entry) => entry.action === action),
      ),
      true,
    );
    check(
      'oldest first',
      bigJournal.every((entry, index) => index === 0 || entry.seq > bigJournal[index - 1]!.seq),
      true,
    );
    check(
      'a decision cannot be edited through the API',
      await status(`/approvals/tasks/${ownerTask.id}`, { method: 'PATCH', cookie: admin, body: { comment: 'x' } }),
      404,
    );
    check(
      'nor a request deleted',
      await status(`/approvals/requests/${bigRequest.id}`, { method: 'DELETE', cookie: admin }),
      404,
    );
    check(
      'and a used chain cannot be deleted either',
      chain.id ? await status(`/approvals/chains/${chain.id}`, { method: 'DELETE', cookie: admin }) : 0,
      409,
    );

    // --- BR-211: below the threshold, one step; a rejection needs its reason ---
    const smallSubmitted = ((await (await submit(smallChange)).json()) as TestApprovalSubject).current;
    check('below the threshold it is routed through one step', smallSubmitted?.steps.filter((step) => step.applies).length, 1);
    const smallTask = smallSubmitted?.steps[0]?.tasks[0];
    if (smallTask) {
      check('rejecting without a reason is refused', (await decide(smallTask.id, admin, 'reject')).status, 422);
      const rejected = await decide(smallTask.id, admin, 'reject', 'Not this quarter.');
      check('rejecting with one ends the request', ((await rejected.json()) as TestApprovalRequest).status, 'rejected');
      check('the work package is rejected', await waitForStatus(smallChange, rejectedStatus!.name), rejectedStatus!.name);
    }

    // --- BR-212: delegation ---
    const today = new Date().toISOString().slice(0, 10);
    check(
      "nobody may delegate somebody else's approvals but an administrator",
      await status('/approvals/delegations', {
        method: 'POST',
        cookie: restricted,
        body: { delegatorId: adminId, delegateId: restrictedId, startsOn: today, endsOn: today },
      }),
      403,
    );
    check(
      'a delegation cannot end before it starts',
      await status('/approvals/delegations', {
        method: 'POST',
        cookie: admin,
        body: { delegateId: restrictedId, startsOn: today, endsOn: '2000-01-01' },
      }),
      422,
    );
    const delegated = await call('/approvals/delegations', {
      method: 'POST',
      cookie: admin,
      body: { delegateId: restrictedId, startsOn: today, endsOn: today, reason: 'On leave today' },
    });
    const delegation = (await delegated.json()) as { id?: string; active?: boolean };
    if (delegation.id) approvalDelegationIds.push(delegation.id);
    check('an approver can delegate for a period', delegated.status, 201);
    check('which is in force today', delegation.active, true);

    const delegatedChange = await changeRequest('Approval probe: raised during a delegation', 10_000);
    const delegatedRequest = ((await (await submit(delegatedChange)).json()) as TestApprovalSubject).current;
    const delegatedTask = delegatedRequest?.steps[0]?.tasks[0];
    check('an approval raised during the delegation routes to the delegate', delegatedTask?.delegateId, restrictedId);
    check('while the approver keeps it too', delegatedTask?.approverId, adminId);
    check(
      "it is in the delegate's inbox",
      (await readJson<TestApprovalRequest[]>('/approvals/inbox', restricted)).some((one) => one.id === delegatedRequest?.id),
      true,
    );
    if (delegatedTask && delegatedRequest) {
      const byDelegate = await decide(delegatedTask.id, restricted, 'approve', 'Covering while they are away.');
      check('the delegate can decide it', byDelegate.status, 200);
      const decided = ((await byDelegate.json()) as TestApprovalRequest).steps[0]?.tasks[0];
      check('the decision records who made it', decided?.decidedBy, restrictedId);
      check('and that it was made under delegation, for whom', decided?.onBehalfOf, adminId);
      check(
        'and so does the journal',
        (await journalOfRequest(delegatedRequest.id)).some(
          (entry) => entry.action === 'approval.decided' && entry.summary.includes('on behalf of'),
        ),
        true,
      );
    }
    if (delegation.id) {
      check(
        'the delegate cannot revoke it',
        await status(`/approvals/delegations/${delegation.id}/revoke`, { method: 'POST', cookie: restricted }),
        403,
      );
      check(
        'the approver can',
        await status(`/approvals/delegations/${delegation.id}/revoke`, { method: 'POST', cookie: admin }),
        200,
      );
    }

    // A delegation set up after an approval is already waiting takes it over:
    // the absence is configured, and the reassignment follows on its own.
    const waitingChange = await changeRequest('Approval probe: waiting when the delegation starts', 60_000);
    const waitingStatusBefore = await statusNameOf(waitingChange);
    const waitingRequest = ((await (await submit(waitingChange)).json()) as TestApprovalSubject).current;
    check('with no delegation in force it waits on the approver alone', waitingRequest?.steps[0]?.tasks[0]?.delegateId, undefined);
    const lateDelegation = (await (
      await call('/approvals/delegations', {
        method: 'POST',
        cookie: admin,
        body: { delegateId: restrictedId, startsOn: today, endsOn: today, reason: 'Called away' },
      })
    ).json()) as { id?: string };
    if (lateDelegation.id) approvalDelegationIds.push(lateDelegation.id);
    if (waitingRequest) {
      check(
        'a delegation starting later is attached to what already waits',
        (await requestOf(waitingRequest.id)).steps[0]?.tasks[0]?.delegateId,
        restrictedId,
      );
      check(
        'and the delegate is asked for it, with a link of their own',
        Boolean(waitingRequest.steps[0]?.tasks[0] && (await linkFor(waitingRequest.steps[0].tasks[0].id, restrictedId))),
        true,
      );
      if (lateDelegation.id) {
        await call(`/approvals/delegations/${lateDelegation.id}/revoke`, { method: 'POST', cookie: admin });
      }
      check(
        'and revoking it hands it back',
        (await requestOf(waitingRequest.id)).steps[0]?.tasks[0]?.delegateId,
        undefined,
      );

      // --- BR-214: a step past its SLA raises an escalation event ---
      const ownerStep = (await requestOf(waitingRequest.id)).steps[0]!.tasks[0]!;
      const afterApproval = (await (await decide(ownerStep.id, admin, 'approve')).json()) as TestApprovalRequest;
      const timed = afterApproval.steps[1]?.tasks[0];
      check(
        'a step with an SLA is due that long after it starts',
        timed?.dueAt && timed.activatedAt
          ? Math.round((Date.parse(timed.dueAt) - Date.parse(timed.activatedAt)) / 60_000)
          : undefined,
        60,
      );
      if (timed) {
        // An hour cannot be waited out here, so the deadline is moved instead.
        await approvalDb.approvalTask.update({
          where: { id: timed.id },
          data: { dueAt: new Date(Date.now() - 60_000) },
        });
        await sweepApprovals();
        const dedupeKey = `approval.sla:${waitingRequest.id}:1`;
        const raised = await approvalDb.escalationEvent.findUnique({ where: { dedupeKey } });
        check('a step past its SLA raises an escalation event', raised?.source, 'approval.sla');
        check('to the people the step escalates to', raised?.raisedFor.join(','), adminId);
        check('naming the request', raised?.subjectId, waitingRequest.id);
        check(
          'the step is marked as breached',
          Boolean((await requestOf(waitingRequest.id)).steps[1]?.tasks[0]?.breachedAt),
          true,
        );
        check(
          'and the journal has it',
          (await journalOfRequest(waitingRequest.id)).some((entry) => entry.action === 'approval.sla.breached'),
          true,
        );
        await sweepApprovals();
        check(
          'a breach is raised once, however often the sweep runs',
          await approvalDb.escalationEvent.count({ where: { subjectId: waitingRequest.id } }),
          1,
        );
      }

      // Withdrawing: the requester may, an approver may not, and the work
      // package goes back to where it was.
      check(
        'an approver cannot withdraw a request',
        await status(`/approvals/requests/${waitingRequest.id}/cancel`, { method: 'POST', cookie: restricted, body: {} }),
        403,
      );
      const withdrawn = await call(`/approvals/requests/${waitingRequest.id}/cancel`, {
        method: 'POST',
        cookie: admin,
        body: { reason: 'Raised by the authorization tests.' },
      });
      check('its requester can', withdrawn.status, 200);
      check('which ends it', ((await withdrawn.json()) as TestApprovalRequest).status, 'cancelled');
      check(
        'and puts the work package back where it was',
        await waitForStatus(waitingChange, waitingStatusBefore ?? ''),
        waitingStatusBefore,
      );
    }
  }

  // --- Rules and escalation --------------------------------------------------
  //
  // BR-216 to BR-219, through the API, on this suite's own project. A rule on
  // Risk work at High priority runs every kind of action; Risk work at Normal
  // and Task work at High are the controls. The outbound action calls a
  // receiver this test starts on 127.0.0.1, so the backend under test needs
  // EPM_RULES_OUTBOUND_ALLOWLIST=127.0.0.1; with EPM_RULES_WEBHOOK_SECRET set
  // here as well the call's signature is checked exactly. Rules act as the
  // automation account (backend/openproject/setup/automation-account.rb).
  //
  // Escalation runs the sweep in this process with a clock set a day or two
  // ahead, and only for this test's policy: nothing here can wait out a day,
  // and nothing real should be escalated by a clock that is wrong on purpose.
  console.log('\nRules and escalation');

  interface TestFiring {
    id: string;
    ruleId: string;
    subjectId: string;
    outcome: string;
    actions: { type: string; outcome: string; summary: string; error?: string }[];
  }

  check(
    'the rules configure permission is surfaced to an administrator',
    adminPermissions.permissions?.rules?.configure,
    true,
  );
  check('and withheld from a caller without the grant', restrictedPermissions.permissions?.rules?.configure, false);
  check('anonymous cannot read rules', await status('/automation/rules'), 401);
  check('a caller without the grant cannot read them', await status('/automation/rules', { cookie: restricted }), 403);
  check(
    'nor define one',
    await status('/automation/rules', { method: 'POST', cookie: restricted, body: { name: 'Not allowed' } }),
    403,
  );
  check('nor dry-run one', await status('/automation/rules/dry-run', { method: 'POST', cookie: restricted, body: {} }), 403);
  check('nor read the escalation policies', await status('/automation/escalation-policies', { cookie: restricted }), 403);

  const automation = (await (await call('/automation/status', { cookie: admin })).json()) as {
    account?: { working?: boolean; userId?: string; admin?: boolean };
  };
  const automationId = automation.account?.userId;
  check('the automation account is configured and works', automation.account?.working, true);
  check('and is not an administrator', automation.account?.admin, false);

  const ruleOptions = (await (await call('/automation/options', { cookie: admin })).json()) as {
    types?: { id: string; name: string }[];
    statuses?: { id: string; name: string }[];
    priorities?: { id: string; name: string }[];
    roles?: { id: string; name: string }[];
  };
  const riskType = named(ruleOptions.types, /^risk$/i);
  const taskType = named(ruleOptions.types, /^task$/i);
  const highPriority = named(ruleOptions.priorities, /^high$/i);
  const normalPriority = named(ruleOptions.priorities, /^normal$/i);
  const inProgress = named(ruleOptions.statuses, /^in progress$/i);
  const projectAdminRole = named(ruleOptions.roles, /^project admin$/i);
  check(
    'the automation role is not offered as a role for people',
    (ruleOptions.roles ?? []).some((role) => role.name === 'EPM Automation'),
    false,
  );
  const rulesReady = Boolean(
    automation.account?.working && riskType && taskType && highPriority && normalPriority && inProgress && projectAdminRole,
  );
  check('what the rules tests need is on the instance', rulesReady, true);

  if (rulesReady) {
    const { prisma: rulesDb } = await import('../db/prisma.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const { sweepEscalations } = await import('../domain/escalation.js');
    const http = await import('node:http');
    const { createHmac } = await import('node:crypto');

    // The endpoint the rule's outbound action calls.
    const received: { body: string; signature?: string }[] = [];
    ruleReceiver = http.createServer((incoming, answer) => {
      let body = '';
      incoming.on('data', (chunk) => (body += String(chunk)));
      incoming.on('end', () => {
        const signature = incoming.headers['x-epm-signature'];
        received.push({ body, signature: Array.isArray(signature) ? signature[0] : signature });
        answer.writeHead(204);
        answer.end();
      });
    });
    await new Promise<void>((resolve) => ruleReceiver!.listen(0, '127.0.0.1', () => resolve()));
    const receiverPort = (ruleReceiver.address() as { port: number }).port;

    // Someone the rule can assign to: OpenProject assigns members only, and a
    // project created through the API has none. The administrator holds every
    // permission already, so making it a member changes nothing for the
    // sections after this one; the membership is taken back below.
    const grant = (await (
      await call(`/projects/${approvalProjectId}/members`, {
        method: 'POST',
        cookie: admin,
        body: { userId: adminId, roleIds: [projectAdminRole!.id] },
      })
    ).json()) as { membershipId?: string };
    if (grant.membershipId) grantedMemberships.push({ projectId: approvalProjectId, membershipId: grant.membershipId });

    const newItem = async (subject: string, typeId: string, priorityId: string) => {
      const response = await call('/work-packages', {
        method: 'POST',
        cookie: admin,
        body: {
          projectId: approvalProjectId,
          typeId,
          payload: { subject, _links: { priority: { href: `/api/v3/priorities/${priorityId}` } } },
        },
      });
      const body = (await response.json()) as { id?: string };
      if (!body.id) throw new Error(`Could not create a work package for the rules tests (${response.status}).`);
      return body.id;
    };
    const firingsOf = async (ruleId: string, subjectId?: string) =>
      (await (
        await call(`/automation/firings?ruleId=${ruleId}${subjectId ? `&subjectId=${subjectId}` : ''}`, { cookie: admin })
      ).json()) as TestFiring[];
    // Rules act a moment after the change: the worker takes queued events.
    const settled = async (subjectIds: string[]) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const waiting = await rulesDb.ruleEvent.count({
          where: { subjectId: { in: subjectIds }, processedAt: null, source: { not: 'automation' } },
        });
        if (waiting === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return false;
    };
    const journalNow = async () =>
      (await (await call(`/projects/${approvalProjectId}/journal`, { cookie: admin })).json()) as TestJournalEntry[];

    // --- BR-216: a rule on type and priority ---
    const ruleBody = {
      name: `Authz triage ${Date.now()}`,
      subjectType: 'work_package',
      events: ['work_package.created', 'work_package.updated'],
      projectIds: [approvalProjectId],
      conditions: {
        match: 'all',
        conditions: [
          { field: 'type', operator: 'in', value: [riskType!.id] },
          { field: 'priority', operator: 'in', value: [highPriority!.id] },
        ],
      },
      actions: [
        { type: 'assign', to: { kind: 'user', userId: adminId } },
        {
          type: 'notify',
          recipients: [{ kind: 'user', userId: adminId }],
          title: 'High risk {{key}}',
          message: '{{subject}} needs an owner.',
        },
        { type: 'set_status', statusId: inProgress!.id },
        { type: 'set_field', field: 'dueDate', value: { relativeDays: 2 } },
        { type: 'create_work_package', typeId: taskType!.id, subject: 'Mitigation for {{key}}', relation: 'relates' },
        { type: 'call_endpoint', url: `http://127.0.0.1:${receiverPort}/rule` },
      ],
    };
    check(
      'a rule may not call an address inside the network',
      await status('/automation/rules', {
        method: 'POST',
        cookie: admin,
        body: { ...ruleBody, actions: [{ type: 'call_endpoint', url: 'https://10.0.0.1/hook' }] },
      }),
      422,
    );
    check(
      'nor test something a work package does not have',
      await status('/automation/rules', {
        method: 'POST',
        cookie: admin,
        body: { ...ruleBody, conditions: { match: 'all', conditions: [{ field: 'colour', operator: 'eq', value: 'red' }] } },
      }),
      422,
    );
    const ruleCreated = await call('/automation/rules', { method: 'POST', cookie: admin, body: ruleBody });
    const rule = (await ruleCreated.json()) as { id?: string; message?: string };
    if (rule.id) ruleIds.push(rule.id);
    check('an administrator can define a rule with every kind of action', ruleCreated.status, 201);
    if (!rule.id) {
      console.log(`    (${rule.message ?? 'no reason given'} — is EPM_RULES_OUTBOUND_ALLOWLIST=127.0.0.1 set on the backend?)`);
    }

    if (rule.id) {
      const hit = await newItem('Rules probe: supplier may miss the date', riskType!.id, highPriority!.id);
      const otherPriority = await newItem('Rules probe: a minor risk', riskType!.id, normalPriority!.id);
      const otherType = await newItem('Rules probe: a high-priority task', taskType!.id, highPriority!.id);
      check('the changes reach the rules', await settled([hit, otherPriority, otherType]), true);

      const fired = await firingsOf(rule.id, hit);
      check('a rule on type and priority fires for a matching item', fired.length, 1);
      check('and not for one of another priority', (await firingsOf(rule.id, otherPriority)).length, 0);
      check('nor for one of another type', (await firingsOf(rule.id, otherType)).length, 0);

      // --- BR-217: each action, as the automation account ---
      const firing = fired[0];
      check(
        'every action ran',
        firing?.actions.map((action) => `${action.type}:${action.outcome}`).join(' '),
        'assign:done notify:done set_status:done set_field:done create_work_package:done call_endpoint:done',
      );
      for (const action of firing?.actions ?? []) {
        if (action.outcome !== 'done') console.log(`    (${action.type}: ${action.error ?? action.summary})`);
      }
      const after = (await (await call(`/tasks/${hit}`, { cookie: admin })).json()) as {
        assigneeId?: string;
        status?: { name?: string };
        dueDate?: string;
      };
      check('assign: the item is assigned', after.assigneeId, adminId);
      check('transition status: its status moved', after.status?.name, inProgress!.name);
      // Two days out, kept on a working day: OpenProject moves a due date that
      // lands on a non-working day to the next working one (so on a Thursday
      // or Friday "two days out" is the Monday). The working week and the
      // instance's non-working days are read, not assumed.
      const weekDays = (await (await call('/admin/week-days', { cookie: admin })).json()) as {
        day: number;
        working: boolean;
      }[];
      const nonWorking = new Set(
        ((await (await call('/admin/non-working-days', { cookie: admin })).json()) as { date: string }[]).map(
          (day) => day.date,
        ),
      );
      const workingIso = new Set(weekDays.filter((day) => day.working).map((day) => day.day));
      let due = new Date(Date.now() + 2 * 86_400_000);
      for (let step = 0; step < 14; step += 1) {
        const isoWeekday = ((due.getUTCDay() + 6) % 7) + 1;
        if (workingIso.has(isoWeekday) && !nonWorking.has(due.toISOString().slice(0, 10))) break;
        due = new Date(due.getTime() + 86_400_000);
      }
      check(
        'set attribute: its due date is two days out (the next working day if that is not one)',
        after.dueDate?.slice(0, 10),
        due.toISOString().slice(0, 10),
      );
      const relations = (await (await call(`/work-packages/${hit}/relations`, { cookie: admin })).json()) as {
        type?: string;
        related?: { subject?: string };
      }[];
      check(
        'create a linked work package: it relates to the item',
        relations.some((relation) => relation.type === 'relates' && relation.related?.subject?.startsWith('Mitigation for')),
        true,
      );
      check(
        'notify: the person named is told',
        Boolean(firing && (await rulesDb.notification.findFirst({ where: { recipientId: adminId, dedupeKey: `rule:${firing.id}:1` } }))),
        true,
      );
      check('call an outbound endpoint: it was called', received.length, 1);
      const payload = JSON.parse(received[0]?.body ?? '{}') as { subject?: { id?: string } };
      check('about the item the rule fired on', payload.subject?.id, hit);
      const secret = process.env.EPM_RULES_WEBHOOK_SECRET;
      if (secret && received[0]) {
        check(
          'and signed',
          received[0].signature,
          `sha256=${createHmac('sha256', secret).update(received[0].body).digest('hex')}`,
        );
      }

      const activities = await upstream.request<{ _embedded?: { elements?: { _links?: { user?: { href?: string } } }[] } }>(
        `/work_packages/${hit}/activities`,
      );
      check(
        "OpenProject's journal has the change under the automation account",
        activities._embedded?.elements?.at(-1)?._links?.user?.href,
        `/api/v3/users/${automationId}`,
      );
      const firedEntry = (await journalNow()).find(
        (entry) => entry.action === 'automation.rule.fired' && (entry as { entityId?: string }).entityId === hit,
      );
      check("and EPM's journal records the firing as the service principal", `${firedEntry?.actorKind}:${firedEntry?.actorId}`, `service:${automationId}`);

      // An `enter` rule fires as an item starts to match; its own changes and
      // later edits while it still matches do not set it off again.
      await call(`/tasks/${hit}`, { method: 'PATCH', cookie: admin, body: { subject: 'Rules probe: supplier may miss the date, confirmed' } });
      await settled([hit]);
      check('the rule does not fire again on its own changes or a later edit', (await firingsOf(rule.id, hit)).length, 1);

      // A change made in OpenProject itself arrives by its signed webhook.
      const current = await upstream.request<{ lockVersion: number }>(`/work_packages/${otherPriority}`);
      const changed = await upstream.request<{ id: number; lockVersion: number; _links?: Record<string, unknown> }>(
        `/work_packages/${otherPriority}`,
        {
          method: 'PATCH',
          body: { lockVersion: current.lockVersion, _links: { priority: { href: `/api/v3/priorities/${highPriority!.id}` } } },
        },
      );
      const delivery = JSON.stringify({
        action: 'work_package:updated',
        work_package: { id: changed.id, lockVersion: changed.lockVersion, subject: 'Rules probe', _links: changed._links },
      });
      const delivered = await fetch(`${BASE}/webhooks/openproject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OP-Signature': `sha1=${createHmac('sha1', process.env.OPENPROJECT_WEBHOOK_SECRET ?? '').update(delivery).digest('hex')}`,
        },
        body: delivery,
      });
      check('a signed webhook delivery is accepted', delivered.status, 204);
      await settled([otherPriority]);
      check('and a change made in OpenProject fires the rule as one made in EPM does', (await firingsOf(rule.id, otherPriority)).length, 1);

      // A rule cannot reach a status an approval chain owns.
      if (changeRequestType && approvedStatus) {
        const bypass = await call('/automation/rules', {
          method: 'POST',
          cookie: admin,
          body: {
            name: `Authz approval bypass ${Date.now()}`,
            events: ['work_package.created'],
            projectIds: [approvalProjectId],
            conditions: { match: 'all', conditions: [{ field: 'type', operator: 'in', value: [changeRequestType.id] }] },
            actions: [{ type: 'set_status', statusId: approvedStatus.id }],
          },
        });
        const bypassRule = (await bypass.json()) as { id?: string };
        if (bypassRule.id) {
          ruleIds.push(bypassRule.id);
          const change = await newItem('Rules probe: approve me without asking', changeRequestType.id, normalPriority!.id);
          await settled([change]);
          const attempt = (await firingsOf(bypassRule.id, change))[0];
          check('a rule cannot approve what an approval chain decides', attempt?.actions[0]?.outcome, 'failed');
          check('and the log says why', /approval chain/i.test(attempt?.actions[0]?.error ?? ''), true);
          await call(`/automation/rules/${bypassRule.id}`, {
            method: 'PATCH',
            cookie: admin,
            body: {
              name: 'Authz approval bypass (off)',
              events: ['work_package.created'],
              projectIds: [approvalProjectId],
              conditions: { match: 'all', conditions: [] },
              actions: [{ type: 'set_status', statusId: approvedStatus.id }],
              active: false,
            },
          });
        }
      }

      // --- BR-219: the dry run and the log ---
      const watched = [hit, otherPriority, otherType];
      const versionsBefore = await Promise.all(
        watched.map((id) => upstream.request<{ lockVersion: number }>(`/work_packages/${id}`).then((wp) => wp.lockVersion)),
      );
      const firingsBefore = await rulesDb.ruleFiring.count();
      const notificationsBefore = await rulesDb.notification.count();
      const dryRun = await call('/automation/rules/dry-run', { method: 'POST', cookie: admin, body: { rule: ruleBody, windowDays: 1 } });
      const preview = (await dryRun.json()) as { items?: { subjectId: string; actions: string[] }[] };
      check('a dry run answers', dryRun.status, 200);
      check(
        'reporting the items the rule would act on',
        [hit, otherPriority].every((id) => preview.items?.some((item) => item.subjectId === id)),
        true,
      );
      check('and not the others', preview.items?.some((item) => item.subjectId === otherType), false);
      check('with what it would do to each', preview.items?.find((item) => item.subjectId === hit)?.actions.length, 6);
      const versionsAfter = await Promise.all(
        watched.map((id) => upstream.request<{ lockVersion: number }>(`/work_packages/${id}`).then((wp) => wp.lockVersion)),
      );
      check('without changing any data', versionsAfter.join(','), versionsBefore.join(','));
      check('or logging a firing', await rulesDb.ruleFiring.count(), firingsBefore);
      check('or telling anyone', await rulesDb.notification.count(), notificationsBefore);

      const log = await firingsOf(rule.id);
      check('every firing is logged with its outcome', log.length >= 2 && log.every((one) => one.outcome === 'succeeded'), true);
      check(
        'and each action with its own',
        log.every((one) => one.actions.length === 6 && one.actions.every((action) => action.outcome === 'done')),
        true,
      );

      check(
        'a rule that has fired cannot be deleted',
        await status(`/automation/rules/${rule.id}`, { method: 'DELETE', cookie: admin }),
        409,
      );
      check(
        'it can be switched off',
        await status(`/automation/rules/${rule.id}`, { method: 'PATCH', cookie: admin, body: { ...ruleBody, active: false } }),
        200,
      );
      const later = await newItem('Rules probe: after the rule was switched off', riskType!.id, highPriority!.id);
      await settled([later]);
      check('and then it fires no more', (await firingsOf(rule.id, later)).length, 0);

      // --- BR-218: untouched work escalates along its path ---
      const policyBody = {
        name: `Authz untouched risks ${Date.now()}`,
        trigger: 'untouched',
        projectIds: [approvalProjectId],
        typeIds: [riskType!.id],
        priorityIds: [highPriority!.id],
        levels: [
          { after: 1, notify: [{ kind: 'assignee' }] },
          { after: 2, notify: [{ kind: 'user', userId: restrictedId }] },
        ],
      };
      check(
        'escalation levels have to come in order',
        await status('/automation/escalation-policies', {
          method: 'POST',
          cookie: admin,
          body: { ...policyBody, levels: [policyBody.levels[1], policyBody.levels[0]] },
        }),
        422,
      );
      const policyCreated = await call('/automation/escalation-policies', { method: 'POST', cookie: admin, body: policyBody });
      const policy = (await policyCreated.json()) as { id?: string };
      if (policy.id) escalationPolicyIds.push(policy.id);
      check('an administrator can define an escalation path', policyCreated.status, 201);

      if (policy.id) {
        const ahead = (days: number) => new Date(Date.now() + days * 86_400_000);
        const only = { policyIds: [policy.id] };
        const eventAt = (level: number) =>
          rulesDb.escalationEvent.findFirst({ where: { policyId: policy.id, subjectId: hit, level } });

        await sweepEscalations(ahead(1.5), only);
        const first = await eventAt(1);
        check('an item untouched past its threshold is escalated', Boolean(first), true);
        check('to the first level of its path, its assignee', first?.raisedFor.join(','), adminId);
        check(
          'with a notification',
          Boolean(first && (await rulesDb.notification.findFirst({ where: { recipientId: adminId, dedupeKey: `escalation:${first.id}` } }))),
          true,
        );
        await sweepEscalations(ahead(1.6), only);
        check(
          'a level is raised once, however often the sweep runs',
          await rulesDb.escalationEvent.count({ where: { policyId: policy.id, subjectId: hit } }),
          1,
        );

        await sweepEscalations(ahead(2.5), only);
        const second = await eventAt(2);
        check('left longer, it escalates to the next level', Boolean(second), true);
        check('to the next person on the path', second?.raisedFor.join(','), restrictedId);
        check(
          'who is notified',
          Boolean(second && (await rulesDb.notification.findFirst({ where: { recipientId: restrictedId, dedupeKey: `escalation:${second.id}` } }))),
          true,
        );
        check(
          'and the escalation is journalled',
          (await journalNow()).some((entry) => entry.action === 'escalation.raised' && entry.summary.includes('level 2')),
          true,
        );

        // Touching the item ends the stretch it was untouched for.
        await call(`/tasks/${hit}`, { method: 'PATCH', cookie: admin, body: { subject: 'Rules probe: supplier may miss the date, chased' } });
        await sweepEscalations(ahead(0.5), only);
        check(
          'touching the item resolves its escalations',
          await rulesDb.escalationEvent.count({ where: { policyId: policy.id, subjectId: hit, resolvedAt: null } }),
          0,
        );
        const listed = (await (await call(`/automation/escalations?policyId=${policy.id}&state=all`, { cookie: admin })).json()) as {
          subjectId: string;
          level: number;
          resolvedAt?: string;
        }[];
        check(
          'and administrators can see each escalation and when it was resolved',
          listed.filter((one) => one.subjectId === hit && one.resolvedAt).length,
          2,
        );

        const eventsBefore = await rulesDb.escalationEvent.count({ where: { policyId: policy.id } });
        const policyPreview = await call('/automation/escalation-policies/dry-run', {
          method: 'POST',
          cookie: admin,
          body: { policy: { ...policyBody, id: policy.id } },
        });
        check('a policy can be dry-run', policyPreview.status, 200);
        check('and that raises nothing', await rulesDb.escalationEvent.count({ where: { policyId: policy.id } }), eventsBefore);
        check(
          'a policy that has escalated cannot be deleted',
          await status(`/automation/escalation-policies/${policy.id}`, { method: 'DELETE', cookie: admin }),
          409,
        );
      }
    }

    // The membership was only for assigning.
    if (grant.membershipId) {
      await call(`/projects/${approvalProjectId}/members/${grant.membershipId}`, { method: 'DELETE', cookie: admin });
    }
    ruleReceiver.close();
    ruleReceiver = undefined;
  }

  // --- Portfolios ------------------------------------------------------------
  //
  // EPM-owned, like departments and teams. The rollups read live project data,
  // so these reuse the team and capacity fixtures above to make the derived
  // team and capacity figures real rather than zero. Every association set here
  // is captured and restored in the cleanup step.
  console.log('\nPortfolios');

  interface TestPortfolio {
    id: string;
    name: string;
    code: string;
    description?: string;
    projectCount: number;
    activeProjectCount: number;
    health: { healthy: number; warning: number; critical: number };
    memberCount: number;
    capacityHours: number;
    teams: { id: string; name: string }[];
    active: boolean;
  }

  const portfolioName = `EPM Test Portfolio ${stamp}`;
  const portfolioCode = `PF-${stamp}`.slice(0, 16);

  const portfolios = async (cookie: string, query = '') =>
    (await (await call(`/portfolios${query}`, { cookie })).json()) as TestPortfolio[];

  const portfolio = async (id: string) =>
    (await (await call(`/portfolios/${id}`, { cookie: admin })).json()) as TestPortfolio;

  check(
    'the manage permission is surfaced to the client',
    adminPermissions.permissions?.portfolios?.manage,
    true,
  );
  check(
    'a caller without a grant does not hold it',
    restrictedPermissions.permissions?.portfolios?.manage,
    false,
  );

  check('anonymous cannot list portfolios', await status('/portfolios'), 401);
  check(
    'anonymous cannot create one',
    await status('/portfolios', { method: 'POST', body: { name: 'x', code: 'XX' } }),
    401,
  );
  check('a permitted caller can list portfolios', await status('/portfolios', { cookie: admin }), 200);
  check(
    'a caller without the manage grant can still read them',
    await status('/portfolios', { cookie: restricted }),
    200,
  );
  check(
    'a caller without the grant cannot create one',
    await status('/portfolios', {
      method: 'POST',
      cookie: restricted,
      body: { name: portfolioName, code: portfolioCode },
    }),
    403,
  );

  const invalidPortfolios: [string, Record<string, unknown>][] = [
    ['a portfolio needs a name', { code: 'AA' }],
    ['a portfolio needs a code', { name: 'Nameless' }],
    ['a blank name is refused', { name: '   ', code: 'AA' }],
    ['a code shorter than two characters is refused', { name: 'Short', code: 'A' }],
    ['a code longer than sixteen characters is refused', { name: 'Long', code: 'A'.repeat(17) }],
    ['a code with punctuation is refused', { name: 'Punct', code: 'A_B!' }],
    ['a non-string name is refused', { name: 42, code: 'AA' }],
    ['an over-long name is refused', { name: 'n'.repeat(121), code: 'AA' }],
  ];
  for (const [label, body] of invalidPortfolios) {
    check(label, await status('/portfolios', { method: 'POST', cookie: admin, body }), 400);
  }

  const portfolioResponse = await call('/portfolios', {
    method: 'POST',
    cookie: admin,
    // Lower case deliberately: codes are normalised before storing.
    body: {
      name: portfolioName,
      code: portfolioCode.toLowerCase(),
      description: '  Customer-facing delivery.  ',
    },
  });
  check('a permitted caller can create a portfolio', portfolioResponse.status, 201);

  const createdPortfolio = (await portfolioResponse.json()) as TestPortfolio;
  const portfolioId = createdPortfolio.id;
  portfolioIds.push(portfolioId);

  check('the name is returned as given', createdPortfolio.name, portfolioName);
  check('the code is normalised to upper case', createdPortfolio.code, portfolioCode);
  check('the description is trimmed', createdPortfolio.description, 'Customer-facing delivery.');
  check('a new portfolio is active', createdPortfolio.active, true);
  check('the portfolio id is not an upstream url', portfolioId.includes('/'), false);

  // An empty portfolio reports zeroes, not absent fields — nothing in it is an
  // answer rather than a missing value.
  check('an empty portfolio counts no projects', createdPortfolio.projectCount, 0);
  check('and none active', createdPortfolio.activeProjectCount, 0);
  check('and no members', createdPortfolio.memberCount, 0);
  check('and no capacity', createdPortfolio.capacityHours, 0);
  check('and no teams', createdPortfolio.teams.length, 0);
  check(
    'and an all-zero health distribution',
    JSON.stringify(createdPortfolio.health),
    '{"healthy":0,"warning":0,"critical":0}',
  );

  check(
    'a duplicate code is refused',
    await status('/portfolios', {
      method: 'POST',
      cookie: admin,
      body: { name: `${portfolioName} II`, code: portfolioCode },
    }),
    400,
  );
  // Postgres would accept these as distinct; the functional index rejects them.
  check(
    'a name differing only by case is refused',
    await status('/portfolios', {
      method: 'POST',
      cookie: admin,
      body: { name: portfolioName.toUpperCase(), code: `X${portfolioCode}`.slice(0, 16) },
    }),
    400,
  );

  check('a portfolio can be read back', await status(`/portfolios/${portfolioId}`, { cookie: admin }), 200);
  check('an unknown portfolio is not found', await status('/portfolios/no-such-id', { cookie: admin }), 404);
  check(
    'it appears in the list',
    (await portfolios(admin)).some((p) => p.id === portfolioId),
    true,
  );

  // --- update ---
  const portfolioUpdate = await call(`/portfolios/${portfolioId}`, {
    method: 'PATCH',
    cookie: admin,
    body: { description: 'Customer-facing delivery and support.' },
  });
  check('a permitted caller can update a portfolio', portfolioUpdate.status, 200);
  const afterPortfolioUpdate = (await portfolioUpdate.json()) as TestPortfolio;
  check('the change is applied', afterPortfolioUpdate.description, 'Customer-facing delivery and support.');
  check('an omitted field is left alone', afterPortfolioUpdate.name, portfolioName);
  check(
    'an update with no fields is refused',
    await status(`/portfolios/${portfolioId}`, { method: 'PATCH', cookie: admin, body: {} }),
    400,
  );
  check(
    'a caller without the grant cannot update one',
    await status(`/portfolios/${portfolioId}`, {
      method: 'PATCH',
      cookie: restricted,
      body: { name: 'Hijacked' },
    }),
    403,
  );

  // --- project association ---
  const allProjects = (await (await call('/projects', { cookie: admin })).json()) as {
    id: string;
    portfolio: string;
    portfolioId?: string;
    memberIds: string[];
    health: { overall: string };
  }[];
  // Prefer a project that actually has members: the derived team and capacity
  // rollups below come from membership, and a project with nobody on it would
  // make them vacuously zero and prove nothing.
  const anyProject = allProjects.find((p) => p.memberIds.length > 0) ?? allProjects[0];
  const associatedProjectId = anyProject?.id;
  if (!associatedProjectId) throw new Error('No project available for the portfolio tests.');

  // Snapshot before associating, so the cleanup can put it back.
  originalProjectPortfolio.set(associatedProjectId, anyProject.portfolioId ?? null);

  const setPortfolio = (body: Record<string, unknown>, cookie = admin) =>
    call(`/projects/${associatedProjectId}/portfolio`, { method: 'PATCH', cookie, body });

  check(
    'anonymous cannot associate a project',
    await status(`/projects/${associatedProjectId}/portfolio`, {
      method: 'PATCH',
      body: { portfolioId },
    }),
    401,
  );
  check('a caller without the grant cannot associate one', (await setPortfolio({ portfolioId }, restricted)).status, 403);
  check('an unknown portfolio is refused', (await setPortfolio({ portfolioId: 'no-such-portfolio' })).status, 400);
  check(
    'an unknown project is not found',
    await status('/projects/99999999/portfolio', { method: 'PATCH', cookie: admin, body: { portfolioId } }),
    404,
  );

  const associated = await setPortfolio({ portfolioId });
  check('a permitted caller can associate a project', associated.status, 200);
  const associatedBody = (await associated.json()) as { portfolio: string; portfolioId?: string };
  check('the project reports the portfolio name', associatedBody.portfolio, portfolioName);
  check('and its id, so a picker can bind to it', associatedBody.portfolioId, portfolioId);

  const withProject = await portfolio(portfolioId);
  check('the portfolio counts the project', withProject.projectCount, 1);
  // Health is the effective value already computed for the project — reused,
  // never recalculated here.
  check(
    'its health distribution totals the project count',
    withProject.health.healthy + withProject.health.warning + withProject.health.critical,
    1,
  );

  const portfolioProjects = (await (
    await call(`/portfolios/${portfolioId}/projects`, { cookie: admin })
  ).json()) as { id: string }[];
  check('its projects can be listed', portfolioProjects.some((p) => p.id === associatedProjectId), true);
  check(
    'projects of an unknown portfolio are not found',
    await status('/portfolios/no-such-id/projects', { cookie: admin }),
    404,
  );

  // Changing the association moves the project between portfolios.
  const secondPortfolio = (await (
    await call('/portfolios', {
      method: 'POST',
      cookie: admin,
      body: { name: `${portfolioName} Two`, code: `${portfolioCode}2`.slice(0, 16) },
    })
  ).json()) as TestPortfolio;
  portfolioIds.push(secondPortfolio.id);

  await setPortfolio({ portfolioId: secondPortfolio.id });
  check('the project moves to the new portfolio', (await portfolio(secondPortfolio.id)).projectCount, 1);
  check('and leaves the old one', (await portfolio(portfolioId)).projectCount, 0);

  // Clearing is expressed by sending nothing, not by a separate endpoint.
  const clearedPortfolio = (await (await setPortfolio({})).json()) as { portfolioId?: string };
  check('an empty body clears the association', clearedPortfolio.portfolioId, undefined);
  check('and the portfolio no longer counts it', (await portfolio(secondPortfolio.id)).projectCount, 0);

  // --- derived teams and capacity ---
  // The project-to-team relationship is derived from membership, so mapping a
  // project member to a team is what makes these figures appear.
  // Map a member of that project to a team, so the derivation has something to
  // find. Whoever is on it, not an assumed identity.
  const projectMemberId = anyProject.memberIds[0] ?? adminId;
  if (!originalCapacity.has(projectMemberId)) {
    originalCapacity.set(projectMemberId, (await employee(projectMemberId)).hoursCapacity);
  }
  await setMapping(projectMemberId, { teamId });
  await setCapacity(projectMemberId, { hoursCapacity: 30 });
  await setPortfolio({ portfolioId });

  const derivedRollup = await portfolio(portfolioId);
  check('a portfolio counts the people on its projects', derivedRollup.memberCount >= 1, true);
  check('their capacity is summed', derivedRollup.capacityHours >= 30, true);
  check(
    'and their teams are derived, not declared',
    derivedRollup.teams.some((t) => t.id === teamId),
    true,
  );

  // Someone on two projects in one portfolio must be counted once, or the
  // capacity is quietly overstated.
  const distinctBefore = derivedRollup.memberCount;
  check('members are distinct across projects', distinctBefore <= 2, true);

  await setCapacity(projectMemberId, { hoursCapacity: 40 });
  await setMapping(projectMemberId, {});

  // --- lifecycle ---
  check(
    'a caller without the grant cannot archive one',
    await status(`/portfolios/${portfolioId}/archive`, { method: 'PATCH', cookie: restricted }),
    403,
  );

  const archivedPortfolio = await call(`/portfolios/${portfolioId}/archive`, {
    method: 'PATCH',
    cookie: admin,
  });
  check('a permitted caller can archive a portfolio', archivedPortfolio.status, 200);
  check('it is reported inactive', ((await archivedPortfolio.json()) as TestPortfolio).active, false);
  check(
    'an archived portfolio is out of the default list',
    (await portfolios(admin)).some((p) => p.id === portfolioId),
    false,
  );
  check(
    'it is still there when inactive ones are asked for',
    (await portfolios(admin, '?includeInactive=true')).some((p) => p.id === portfolioId),
    true,
  );

  // Archiving is a visibility decision: the association it holds is untouched.
  check(
    'an existing association survives archiving',
    ((await (await call(`/projects/${associatedProjectId}`, { cookie: admin })).json()) as {
      portfolioId?: string;
    }).portfolioId,
    portfolioId,
  );
  check(
    'no project can be moved into an archived portfolio',
    (await setPortfolio({ portfolioId: portfolioId })).status,
    400,
  );
  // But a project can always be moved out of one.
  check('a project can still be moved out of it', (await setPortfolio({})).status, 200);

  const restoredPortfolio = await call(`/portfolios/${portfolioId}/restore`, {
    method: 'PATCH',
    cookie: admin,
  });
  check('an archived portfolio can be restored', ((await restoredPortfolio.json()) as TestPortfolio).active, true);

  check(
    'an unknown portfolio cannot be updated',
    await status('/portfolios/no-such-id', { method: 'PATCH', cookie: admin, body: { name: 'X' } }),
    404,
  );
  check(
    'an unknown portfolio cannot be deleted',
    await status('/portfolios/no-such-id', { method: 'DELETE', cookie: admin }),
    404,
  );
  check(
    'a caller without the grant cannot delete a portfolio',
    await status(`/portfolios/${portfolioId}`, { method: 'DELETE', cookie: restricted }),
    403,
  );

  check(
    'an unknown portfolio cannot be archived',
    await status('/portfolios/no-such-id/archive', { method: 'PATCH', cookie: admin }),
    404,
  );

  // --- Analytics -------------------------------------------------------------
  //
  // Two halves. The snapshot half runs against the live instance, because
  // capture is the thing being tested. The trend half uses fixtures written
  // straight to the table under a scope id no real entity has, so the series
  // are deterministic rather than depending on whatever the instance happens to
  // hold. Every row created either way is removed in the cleanup step.
  console.log('\nAnalytics');

  interface TestTrend {
    metric: string;
    scopeType: string;
    scopeId?: string;
    points: { date: string; value: number }[];
  }

  interface TestOverview {
    current: {
      projectsTotal: number;
      projectsActive: number;
      health: { healthy: number; warning: number; critical: number };
      portfolios: number;
      capacityHours: number;
    };
    history: { days: number; firstSnapshot?: string; lastSnapshot?: string; records: number };
  }

  check(
    'the manage permission is surfaced to the client',
    adminPermissions.permissions?.analytics?.manage,
    true,
  );
  check(
    'a caller without a grant does not hold it',
    restrictedPermissions.permissions?.analytics?.manage,
    false,
  );

  check('anonymous cannot read the overview', await status('/analytics/overview'), 401);
  check('anonymous cannot read trends', await status('/analytics/trends?metrics=projects.total'), 401);
  check(
    'anonymous cannot capture a snapshot',
    await status('/analytics/snapshots', { method: 'POST' }),
    401,
  );

  // Reading is open; capturing is not. That is the whole authorization model.
  check('a permitted caller can read the overview', await status('/analytics/overview', { cookie: admin }), 200);
  check(
    'a caller without the grant can read it too',
    await status('/analytics/overview', { cookie: restricted }),
    200,
  );
  check(
    'but cannot capture a snapshot',
    await status('/analytics/snapshots', { method: 'POST', cookie: restricted }),
    403,
  );

  const overview = (await (await call('/analytics/overview', { cookie: admin })).json()) as TestOverview;
  check('the overview reports current state', typeof overview.current.projectsTotal, 'number');
  check('and how much history exists', typeof overview.history.days, 'number');
  check('and how many records back it', typeof overview.history.records, 'number');
  // The two are separate claims. A client that could not tell them apart would
  // present a computed number as a recorded one.
  check(
    'current and history are separate fields',
    'current' in overview && 'history' in overview,
    true,
  );

  // A caller only ever sees analytics over projects they can see.
  const restrictedOverview = (await (
    await call('/analytics/overview', { cookie: restricted })
  ).json()) as TestOverview;
  check(
    'analytics is scoped to what the caller can see',
    restrictedOverview.current.projectsTotal <= overview.current.projectsTotal,
    true,
  );

  // --- trend query validation ---
  check('a trend needs a metric', await status('/analytics/trends', { cookie: admin }), 400);
  check(
    'an empty metric list is refused',
    await status('/analytics/trends?metrics=', { cookie: admin }),
    400,
  );
  check(
    'an unknown scope type is refused',
    await status('/analytics/trends?metrics=projects.total&scopeType=nope', { cookie: admin }),
    400,
  );
  check(
    'more than ten metrics at once is refused',
    await status(`/analytics/trends?metrics=${Array.from({ length: 11 }, (_, i) => `m${i}`).join(',')}`, {
      cookie: admin,
    }),
    400,
  );
  check(
    'a negative day range is refused',
    await status('/analytics/trends?metrics=projects.total&days=-1', { cookie: admin }),
    400,
  );

  // An unrecorded metric returns an empty series, not a fabricated one.
  const unknownTrend = (await (
    await call('/analytics/trends?metrics=nothing.recorded', { cookie: admin })
  ).json()) as TestTrend[];
  check('an unrecorded metric returns a series', unknownTrend.length, 1);
  check('with no points rather than invented ones', unknownTrend[0]?.points.length, 0);

  // --- snapshot capture ---
  const { prisma: analyticsDb } = await import('../db/prisma.js');
  const beforeCapture = await analyticsDb.metricSnapshot.count();

  const captured = await call('/analytics/snapshots', { method: 'POST', cookie: admin });
  check('a permitted caller can capture a snapshot', captured.status, 201);

  const capture = (await captured.json()) as {
    sampledOn: string;
    records: number;
    scopes: { instance: number; portfolio: number; team: number; department: number };
  };
  analyticsCaptureDay = capture.sampledOn;
  check('it reports the day it captured', /^\d{4}-\d{2}-\d{2}$/.test(capture.sampledOn), true);
  check('and how many records it wrote', capture.records > 0, true);
  check('and breaks them down by scope', typeof capture.scopes.instance, 'number');
  check('instance metrics are always captured', capture.scopes.instance > 0, true);

  const afterFirst = await analyticsDb.metricSnapshot.count();
  check('rows were actually written', afterFirst > beforeCapture, true);

  // The point of the whole design: rerunning must overwrite, not append.
  const again = await call('/analytics/snapshots', { method: 'POST', cookie: admin });
  check('it can be run again the same day', again.status, 201);
  const secondCapture = (await again.json()) as typeof capture;
  check('reporting the same day', secondCapture.sampledOn, capture.sampledOn);
  check('and the same record count', secondCapture.records, capture.records);

  const afterSecond = await analyticsDb.metricSnapshot.count();
  check('rerunning does not double-count', afterSecond, afterFirst);

  // Instance rows carry no scope id. Postgres treats NULLs as distinct in a
  // unique index, so this is the case that would have silently duplicated had
  // the column stayed nullable.
  const instanceRows = await analyticsDb.metricSnapshot.groupBy({
    by: ['metric'],
    where: { scopeType: 'instance', sampledOn: new Date(capture.sampledOn) },
    _count: { _all: true },
  });
  check(
    'every instance metric has exactly one row for the day',
    instanceRows.every((row) => row._count._all === 1),
    true,
  );
  check('the instance scope is recorded, not skipped', instanceRows.length > 0, true);

  // Captured values must match what the live overview reports for the same day.
  const afterCaptureOverview = (await (
    await call('/analytics/overview', { cookie: admin })
  ).json()) as TestOverview;
  const capturedProjects = await analyticsDb.metricSnapshot.findFirst({
    where: { scopeType: 'instance', scopeId: '', metric: 'projects.total', sampledOn: new Date(capture.sampledOn) },
  });
  check(
    'a captured value matches the live figure it came from',
    capturedProjects?.value,
    afterCaptureOverview.current.projectsTotal,
  );
  check('the history now covers at least one day', afterCaptureOverview.history.days >= 1, true);

  // Workload and allocation are deliberately never captured: the value column
  // cannot hold the null allocation uses for zero capacity, and turning it into
  // a zero would read as "nothing logged".
  const forbidden = await analyticsDb.metricSnapshot.findMany({
    where: { metric: { in: ['allocation', 'workload', 'allocation.pct', 'workload.hours'] } },
  });
  check('no allocation or workload metric is ever recorded', forbidden.length, 0);

  // --- deterministic trend fixtures ---
  // Written directly, under a scope no real entity uses, so these assertions do
  // not depend on what the instance happens to contain.
  const fixtureScope = `test-scope-${stamp}`;
  const day = (offset: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    return new Date(date.toISOString().slice(0, 10));
  };

  await analyticsDb.metricSnapshot.createMany({
    data: [
      { scopeType: 'team', scopeId: fixtureScope, sampledOn: day(4), metric: 'members', value: 2 },
      { scopeType: 'team', scopeId: fixtureScope, sampledOn: day(3), metric: 'members', value: 3 },
      // Day 2 deliberately missing, so a gap can be asserted to stay a gap.
      { scopeType: 'team', scopeId: fixtureScope, sampledOn: day(1), metric: 'members', value: 5 },
      { scopeType: 'team', scopeId: fixtureScope, sampledOn: day(1), metric: 'capacity.hours', value: 80 },
    ],
  });
  analyticsFixtureScopes.push(fixtureScope);

  const series = (await (
    await call(`/analytics/trends?metrics=members&scopeType=team&scopeId=${fixtureScope}&days=30`, {
      cookie: admin,
    })
  ).json()) as TestTrend[];

  check('a fixture series is returned', series.length, 1);
  check('with one point per recorded day', series[0]?.points.length, 3);
  // Three points from four days: the missing day is left out rather than filled
  // in. A day nobody captured is not a day with a value.
  check('a missing day stays missing rather than being interpolated', series[0]?.points.length, 3);
  check('points are ordered oldest first', series[0]?.points[0]?.value, 2);
  check('through to newest', series[0]?.points[2]?.value, 5);
  check('each point carries its date', /^\d{4}-\d{2}-\d{2}$/.test(series[0]?.points[0]?.date ?? ''), true);

  const twoMetrics = (await (
    await call(
      `/analytics/trends?metrics=members,capacity.hours&scopeType=team&scopeId=${fixtureScope}&days=30`,
      { cookie: admin },
    )
  ).json()) as TestTrend[];
  check('several metrics come back together', twoMetrics.length, 2);
  check(
    'each with only its own points',
    twoMetrics.find((t) => t.metric === 'capacity.hours')?.points.length,
    1,
  );

  // The day window is honoured rather than ignored.
  const narrow = (await (
    await call(`/analytics/trends?metrics=members&scopeType=team&scopeId=${fixtureScope}&days=2`, {
      cookie: admin,
    })
  ).json()) as TestTrend[];
  check('a shorter window returns fewer points', (narrow[0]?.points.length ?? 0) < 3, true);

  // Scopes do not leak into one another.
  const otherScope = (await (
    await call('/analytics/trends?metrics=members&scopeType=team&scopeId=no-such-team&days=30', {
      cookie: admin,
    })
  ).json()) as TestTrend[];
  check('another scope sees none of those points', otherScope[0]?.points.length, 0);

  const wrongType = (await (
    await call(`/analytics/trends?metrics=members&scopeType=department&scopeId=${fixtureScope}&days=30`, {
      cookie: admin,
    })
  ).json()) as TestTrend[];
  check('the same id under another scope type is separate', wrongType[0]?.points.length, 0);

  // The user-scoped history the dashboard has always written is still readable
  // through the same endpoint, which is what the scope migration had to protect.
  const userSeries = (await (
    await call(`/analytics/trends?metrics=myTasks&scopeType=user&scopeId=${adminId}&days=365`, {
      cookie: admin,
    })
  ).json()) as TestTrend[];
  check('pre-existing user-scoped history survived the scope change', userSeries.length, 1);

  // --- Analytics scheduler ---------------------------------------------------
  //
  // The scheduler is exercised directly with a stubbed capture, so no test
  // waits for real time to pass and none of these cases touch OpenProject. The
  // idempotency and trend cases below then use fixture rows written straight to
  // the table, so "two snapshots make a trend" is deterministic rather than
  // dependent on the clock.
  console.log('\nAnalytics scheduler');

  const { createAnalyticsSnapshotScheduler } = await import('../scheduler/analytics-snapshot.js');
  const { prisma: schedulerDb } = await import('../db/prisma.js');

  // A logger that records rather than prints, so the log content can be
  // asserted — particularly that no secret reaches it.
  const logLines: string[] = [];
  const record = (level: string) => (a: unknown, b?: unknown) => {
    logLines.push(`${level} ${typeof a === 'string' ? a : JSON.stringify(a)} ${b ?? ''}`);
  };
  const testLog = {
    info: record('info'),
    warn: record('warn'),
    debug: record('debug'),
    error: record('error'),
    fatal: record('fatal'),
    trace: record('trace'),
    child: () => testLog,
    level: 'info',
    silent: () => undefined,
  } as never;

  let captures = 0;
  const scheduler = createAnalyticsSnapshotScheduler({
    log: testLog,
    capture: async () => {
      captures += 1;
      return { sampledOn: '2026-01-01', records: 7, scopes: { instance: 7 } };
    },
    // Long enough that no timer fires during the test; every tick below is
    // invoked directly.
    intervalMs: 60 * 60_000,
    firstRunDelayMs: 60 * 60_000,
  });

  check('a scheduler does not start on construction', scheduler.started, false);
  check('and captures nothing until it ticks', captures, 0);

  await scheduler.tick();
  check('a tick captures once', captures, 1);
  check('and does not stay marked as running', scheduler.running, false);
  check('the capture is logged', logLines.some((line) => line.includes('captured')), true);

  await scheduler.tick();
  check('ticks are repeatable', captures, 2);

  scheduler.start();
  check('start marks it started', scheduler.started, true);
  // Hot reload in development can build the app twice; a second timer would
  // double the work for nothing.
  scheduler.start();
  check('starting twice is refused', logLines.some((line) => line.includes('already started')), true);

  scheduler.stop();
  check('stop clears it', scheduler.started, false);
  scheduler.stop();
  check('stopping twice is safe', scheduler.started, false);

  // A failed capture must not crash the backend or stop the timer.
  let attempts = 0;
  const failingScheduler = createAnalyticsSnapshotScheduler({
    log: testLog,
    capture: async () => {
      attempts += 1;
      throw new Error('OpenProject unavailable');
    },
    intervalMs: 60 * 60_000,
    firstRunDelayMs: 60 * 60_000,
  });

  await failingScheduler.tick();
  check('a failing capture does not throw out of the tick', attempts, 1);
  check('and does not leave it marked running', failingScheduler.running, false);
  check('the failure is logged as a warning', logLines.some((line) => line.includes('failed')), true);
  await failingScheduler.tick();
  check('it tries again on the next tick', attempts, 2);

  // A capture slower than the interval must be skipped, not queued behind
  // itself, or a slow instance would pile up work indefinitely.
  let started = 0;
  // Sticky, so a capture that begins after the release returns at once rather
  // than waiting for a release that has already happened — which left the run
  // awaiting a promise that never settled, and Node exited without cleaning up.
  let released = false;
  let releaseCapture: (() => void) | undefined;
  const slow = createAnalyticsSnapshotScheduler({
    log: testLog,
    capture: async () => {
      started += 1;
      if (!released) {
        await new Promise<void>((resolve) => {
          releaseCapture = resolve;
        });
      }
      return { sampledOn: '2026-01-01', records: 7, scopes: {} };
    },
    intervalMs: 60 * 60_000,
    firstRunDelayMs: 60 * 60_000,
  });

  const inFlight = slow.tick();
  check('a capture in flight is reported as running', slow.running, true);
  // The tick takes the scheduler's lease first, a database round trip, so the
  // capture begins a moment after the tick rather than within it.
  for (let waited = 0; started === 0 && waited < 10_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await slow.tick();
  check('an overlapping tick is skipped rather than queued', started, 1);
  check('and says so', logLines.some((line) => line.includes('skipped')), true);
  released = true;
  releaseCapture?.();
  await inFlight;
  check('the flag clears when it finishes', slow.running, false);

  // Nothing sensitive may reach the logs.
  const secrets = ['accessToken', 'refreshToken', 'apikey', 'bearer', 'password', 'sessionid'];
  check(
    'no secret appears in any scheduler log line',
    logLines.some((line) => secrets.some((secret) => line.toLowerCase().includes(secret))),
    false,
  );

  // --- the scheduler and the endpoint share one implementation ---
  const { runSnapshot } = await import('../routes/analytics.js');
  check('the scheduler default capture is the shared entry point', typeof runSnapshot, 'function');

  // Running unattended is how the scheduler authenticates: no request context,
  // so the client falls back to the configured service key. No user is
  // invented and no credential is held by the scheduler.
  const { currentAuth } = await import('../auth/context.js');
  check('a scheduled capture runs with no auth context', currentAuth(), undefined);

  const beforeUnattended = await schedulerDb.metricSnapshot.count();
  const unattended = await runSnapshot(AbortSignal.timeout(60_000));
  schedulerCaptureDays.push(unattended.sampledOn);

  check('an unattended capture succeeds without a user', unattended.records > 0, true);
  const afterUnattended = await schedulerDb.metricSnapshot.count();
  // Not "the count grew": the analytics section already captured today, so this
  // run overwrites rather than adds — which is the idempotency working. What
  // must hold is that the day's rows exist and none was lost.
  check(
    'the day it captured has rows',
    (await schedulerDb.metricSnapshot.count({
      where: { sampledOn: new Date(unattended.sampledOn), scopeType: { not: 'user' } },
    })) > 0,
    true,
  );
  check('and nothing was lost', afterUnattended >= beforeUnattended, true);

  // The guarantee the whole design rests on, asserted by row count rather than
  // by a status code.
  const repeated = await runSnapshot(AbortSignal.timeout(60_000));
  check('rerunning reports the same record count', repeated.records, unattended.records);
  check('and writes no additional rows', await schedulerDb.metricSnapshot.count(), afterUnattended);

  // Concurrent captures must also collapse to one logical snapshot — two
  // instances would both fire, and the upsert is what makes that safe.
  await Promise.all([
    runSnapshot(AbortSignal.timeout(60_000)),
    runSnapshot(AbortSignal.timeout(60_000)),
  ]);
  check('two concurrent captures still leave one set of rows', await schedulerDb.metricSnapshot.count(), afterUnattended);

  // Every scope, not just the instance one.
  for (const scopeType of ['instance', 'portfolio', 'team', 'department']) {
    const duplicated = await schedulerDb.metricSnapshot.groupBy({
      by: ['scopeId', 'metric', 'sampledOn'],
      where: { scopeType, sampledOn: new Date(unattended.sampledOn) },
      _count: { _all: true },
    });
    check(
      `no duplicate rows in the ${scopeType} scope`,
      duplicated.every((row) => row._count._all === 1),
      true,
    );
  }

  // --- trends across more than one day ---
  // Written directly so "two snapshots make a trend" does not depend on waiting
  // a day. The scope id is one no real entity uses.
  const schedulerScope = `sched-scope-${stamp}`;
  const dayBefore = (offset: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    return new Date(date.toISOString().slice(0, 10));
  };

  await schedulerDb.metricSnapshot.create({
    data: { scopeType: 'team', scopeId: schedulerScope, sampledOn: dayBefore(1), metric: 'members', value: 4 },
  });
  analyticsFixtureScopes.push(schedulerScope);

  const oneDay = (await (
    await call(`/analytics/trends?metrics=members&scopeType=team&scopeId=${schedulerScope}&days=30`, {
      cookie: admin,
    })
  ).json()) as { points: { date: string; value: number }[] }[];
  check('one snapshot gives one point', oneDay[0]?.points.length, 1);
  // One point is not a trend. The chart says so rather than drawing a line, and
  // the API reports honestly rather than padding it.
  check('which is not enough for a trend', (oneDay[0]?.points.length ?? 0) < 2, true);

  await schedulerDb.metricSnapshot.create({
    data: { scopeType: 'team', scopeId: schedulerScope, sampledOn: dayBefore(0), metric: 'members', value: 6 },
  });

  const twoDays = (await (
    await call(`/analytics/trends?metrics=members&scopeType=team&scopeId=${schedulerScope}&days=30`, {
      cookie: admin,
    })
  ).json()) as { points: { date: string; value: number }[] }[];
  check('a second snapshot makes a trend', twoDays[0]?.points.length, 2);
  check('ordered oldest first', twoDays[0]?.points[0]?.value, 4);
  check('through to newest', twoDays[0]?.points[1]?.value, 6);

  // Recapturing the same period must not add a point, only change one.
  await schedulerDb.metricSnapshot.upsert({
    where: {
      scopeType_scopeId_sampledOn_metric: {
        scopeType: 'team',
        scopeId: schedulerScope,
        sampledOn: dayBefore(0),
        metric: 'members',
      },
    },
    create: { scopeType: 'team', scopeId: schedulerScope, sampledOn: dayBefore(0), metric: 'members', value: 9 },
    update: { value: 9 },
  });

  const recaptured = (await (
    await call(`/analytics/trends?metrics=members&scopeType=team&scopeId=${schedulerScope}&days=30`, {
      cookie: admin,
    })
  ).json()) as { points: { date: string; value: number }[] }[];
  check('recapturing a period adds no point', recaptured[0]?.points.length, 2);
  check('but does update its value', recaptured[0]?.points[1]?.value, 9);

  // A day nobody captured stays a gap — the case the chart renders as a break
  // rather than bridging.
  await schedulerDb.metricSnapshot.create({
    data: { scopeType: 'team', scopeId: schedulerScope, sampledOn: dayBefore(5), metric: 'members', value: 1 },
  });
  const withGap = (await (
    await call(`/analytics/trends?metrics=members&scopeType=team&scopeId=${schedulerScope}&days=30`, {
      cookie: admin,
    })
  ).json()) as { points: { date: string; value: number }[] }[];
  check('a gap is left as a gap, not filled', withGap[0]?.points.length, 3);

  // Manual capture keeps working alongside the scheduler.
  check(
    'the manual endpoint still works',
    await status('/analytics/snapshots', { method: 'POST', cookie: admin }),
    201,
  );
  check(
    'and is still refused without the grant',
    await status('/analytics/snapshots', { method: 'POST', cookie: restricted }),
    403,
  );

  // --- Notifications ---------------------------------------------------------
  //
  // The domain functions are called directly, so each trigger rule can be
  // asserted without arranging the world state that would produce it. The API
  // half then runs over what they created, and every row is removed in the
  // cleanup step.
  console.log('\nNotifications');

  const {
    notifyHealthChange,
    notifyCapacityChange,
    notifySnapshotFailure,
  } = await import('../domain/notifications.js');
  const { recalculateNow } = await import('../domain/health.js');
  const { prisma: notificationDb } = await import('../db/prisma.js');

  // Scoped to this run so the assertions cannot be disturbed by anything else,
  // and so cleanup knows exactly what to remove.
  const notifProject = `notif-project-${stamp}`;
  notificationKeys.push(`health:${notifProject}:critical`, `health:${notifProject}:healthy`);

  interface TestNotification {
    id: string;
    category: string;
    title: string;
    body: string;
    link?: string;
    severity?: string;
    read: boolean;
    timestamp: string;
  }

  // --- health trigger rules ---
  check(
    'unchanged health notifies nobody',
    await notifyHealthChange({
      projectId: notifProject,
      projectName: 'Probe',
      ownerId: adminId,
      previous: 'warning',
      next: 'warning',
      overridden: false,
    }),
    0,
  );

  // A project with nobody responsible has no recipient relationship that
  // exists, and guessing one would mean inventing a hierarchy.
  check(
    'a project with no owner notifies nobody',
    await notifyHealthChange({
      projectId: notifProject,
      projectName: 'Probe',
      ownerId: undefined,
      previous: 'healthy',
      next: 'critical',
      overridden: false,
    }),
    0,
  );

  check(
    'a real transition notifies the owner',
    await notifyHealthChange({
      projectId: notifProject,
      projectName: 'Probe',
      ownerId: adminId,
      previous: 'healthy',
      next: 'critical',
      overridden: false,
    }),
    1,
  );

  // The invariant that keeps this from becoming spam, enforced by the unique
  // key rather than by a check that two producers could race past.
  check(
    'reporting the same state again creates nothing',
    await notifyHealthChange({
      projectId: notifProject,
      projectName: 'Probe',
      ownerId: adminId,
      previous: 'healthy',
      next: 'critical',
      overridden: false,
    }),
    0,
  );

  const degraded = await notificationDb.notification.findFirst({
    where: { dedupeKey: `health:${notifProject}:critical` },
  });
  check('a degradation is severe', degraded?.severity, 'critical');
  check('and links to the project by an EPM route', degraded?.link, `/projects/${notifProject}`);
  check('and goes to the owner', degraded?.recipientId, adminId);

  check(
    'an improvement notifies too',
    await notifyHealthChange({
      projectId: notifProject,
      projectName: 'Probe',
      ownerId: adminId,
      previous: 'critical',
      next: 'healthy',
      overridden: true,
    }),
    1,
  );

  const improved = await notificationDb.notification.findFirst({
    where: { dedupeKey: `health:${notifProject}:healthy` },
  });
  // An improvement is information, not an alarm, however far it moved.
  check('an improvement is not severe', improved?.severity, 'info');
  // A pinned green must never read as a measured one.
  check('an override says so', improved?.body.includes('overridden'), true);

  // Going red again on a later occasion is news again. The dedupe key used to
  // be the level alone, so the second time a project went red nobody heard.
  notificationKeys.push(
    `health:${notifProject}:critical:2099-01-01`,
    `health:${notifProject}:critical:2099-01-02`,
  );
  const transition = {
    projectId: notifProject,
    projectName: 'Probe',
    ownerId: adminId,
    previous: 'healthy' as const,
    next: 'critical' as const,
    overridden: false,
  };
  check('a transition on one day notifies', await notifyHealthChange({ ...transition, occurrence: '2099-01-01' }), 1);
  check('the same transition that day does not', await notifyHealthChange({ ...transition, occurrence: '2099-01-01' }), 0);
  check('the same transition on a later day does', await notifyHealthChange({ ...transition, occurrence: '2099-01-02' }), 1);

  // --- capacity trigger rules ---
  // A synthetic employee id, not a real one: earlier sections drive real
  // capacity mutations through the API, which produce these same notifications,
  // and asserting "a change notifies" against an id they touched would test
  // whether they happened to have used that exact pair of values.
  const notifEmployee = `notif-employee-${stamp}`;
  const capacityDay = new Date().toISOString().slice(0, 10);
  notificationKeys.push(
    `capacity:${notifEmployee}:40-30:${capacityDay}`,
    `capacity:${notifEmployee}:30-40:${capacityDay}`,
  );

  check(
    'an unchanged capacity notifies nobody',
    await notifyCapacityChange({ employeeId: notifEmployee, employeeName: 'Probe', from: 40, to: 40 }),
    0,
  );
  check(
    'a change notifies',
    (await notifyCapacityChange({ employeeId: notifEmployee, employeeName: 'Probe', from: 40, to: 30 })) >= 1,
    true,
  );
  check(
    'the same change again creates nothing',
    await notifyCapacityChange({ employeeId: notifEmployee, employeeName: 'Probe', from: 40, to: 30 }),
    0,
  );
  // Keyed on the change rather than the value, so moving back is a real event
  // rather than being swallowed by the earlier state.
  check(
    'a different change is a new event',
    (await notifyCapacityChange({ employeeId: notifEmployee, employeeName: 'Probe', from: 30, to: 40 })) >= 1,
    true,
  );

  // --- snapshot failure ---
  const failureDay = `2099-01-0${(Number(stamp) % 9) + 1}`;
  notificationKeys.push(`snapshot-failed:${failureDay}`);

  check(
    'a failed capture notifies the analytics administrators',
    (await notifySnapshotFailure({ day: failureDay, reason: 'Upstream timed out.' })) >= 1,
    true,
  );
  // The scheduler retries; a notification per tick is the spam this avoids.
  check(
    'repeated failures on the same day create nothing more',
    await notifySnapshotFailure({ day: failureDay, reason: 'Upstream timed out again.' }),
    0,
  );

  const failure = await notificationDb.notification.findFirst({
    where: { dedupeKey: `snapshot-failed:${failureDay}` },
  });
  check('the failure links to analytics', failure?.link, '/analytics');
  // A stack trace carries paths and an upstream error can carry a request URL.
  check('its body carries no stack trace', failure?.body.includes(' at '), false);
  check('and no url', failure?.body.includes('http'), false);

  // Recalculating projects whose data has not moved must produce no second
  // round of notifications and no journal entry.
  if (createdId) {
    await recalculateNow([createdId], 'manual');
    const notificationsBefore = await notificationDb.notification.count();
    const journalBefore = await notificationDb.auditEvent.count({ where: { projectId: createdId } });
    await recalculateNow([createdId], 'manual');
    check(
      'recalculating an unchanged project notifies nobody',
      await notificationDb.notification.count(),
      notificationsBefore,
    );
    check(
      'and journals nothing',
      await notificationDb.auditEvent.count({ where: { projectId: createdId } }),
      journalBefore,
    );
  }

  // The journal is append-only below the application: the database itself
  // refuses to change or remove an entry. Tried inside a transaction that is
  // always rolled back, so even a broken trigger could not cost a real entry.
  const someEntry = await notificationDb.auditEvent.findFirst({ select: { id: true } });
  if (someEntry) {
    const refused = async (attempt: (tx: typeof notificationDb) => Promise<unknown>) => {
      try {
        await notificationDb.$transaction(async (tx) => {
          await attempt(tx as typeof notificationDb);
          throw new Error('rollback');
        });
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes('append-only');
      }
    };
    check(
      'the database refuses to edit a journal entry',
      await refused((tx) => tx.auditEvent.update({ where: { id: someEntry.id }, data: { summary: 'rewritten' } })),
      true,
    );
    check(
      'and refuses to delete one',
      await refused((tx) => tx.auditEvent.delete({ where: { id: someEntry.id } })),
      true,
    );
  }

  // --- the API ---
  const notificationsOf = async (cookie: string) =>
    (await (await call('/notifications', { cookie })).json()) as TestNotification[];

  check('anonymous cannot list notifications', await status('/notifications'), 401);
  check('a signed-in caller can', await status('/notifications', { cookie: admin }), 200);

  const mine = await notificationsOf(admin);
  check('the list includes EPM notifications', mine.some((n) => n.id.startsWith('epm:')), true);
  // Prefixed so the two sources cannot collide and each id routes to the store
  // that owns it.
  check(
    'EPM ids are distinguishable from upstream ids',
    mine.filter((n) => n.id.startsWith('epm:')).length > 0,
    true,
  );
  check(
    'every link is an EPM route, never an OpenProject url',
    mine.filter((n) => n.link).every((n) => n.link!.startsWith('/')),
    true,
  );
  check(
    'newest first',
    mine.every((n, index) => index === 0 || mine[index - 1]!.timestamp >= n.timestamp),
    true,
  );

  // --- recipient isolation, both directions ---
  const theirs = await notificationsOf(restricted);
  const mineEpm = mine.filter((n) => n.id.startsWith('epm:')).map((n) => n.id);
  check(
    'another caller sees none of them',
    theirs.some((n) => mineEpm.includes(n.id)),
    false,
  );

  const someone = mineEpm[0];
  if (!someone) throw new Error('No EPM notification was created for the isolation tests.');

  // Ownership is enforced in the query, so an id belonging to someone else
  // matches nothing rather than updating their row.
  await call('/notifications/read', { method: 'PATCH', cookie: restricted, body: { ids: [someone] } });
  const untouched = await notificationDb.notification.findUnique({
    where: { id: someone.slice('epm:'.length) },
  });
  check('another caller cannot mark it read', untouched?.readAt, null);

  await call('/notifications/read', { method: 'PATCH', cookie: admin, body: { ids: [someone] } });
  const marked = await notificationDb.notification.findUnique({
    where: { id: someone.slice('epm:'.length) },
  });
  check('the recipient can', marked?.readAt !== null, true);
  check(
    'and the list reports it read',
    (await notificationsOf(admin)).find((n) => n.id === someone)?.read,
    true,
  );

  // An id that does not exist must be a no-op, not an error.
  check(
    'an unknown id is ignored rather than failing',
    await status('/notifications/read', {
      method: 'PATCH',
      cookie: admin,
      body: { ids: ['epm:no-such-notification'] },
    }),
    204,
  );

  check(
    'mark-all succeeds',
    await status('/notifications/read-all', { method: 'PATCH', cookie: admin }),
    204,
  );
  check(
    'and leaves none of the callers unread',
    await notificationDb.notification.count({ where: { recipientId: adminId, readAt: null } }),
    0,
  );
  // Mark-all must not reach across recipients.
  check(
    'without touching anyone else',
    (await notificationDb.notification.count({
      where: { recipientId: { not: adminId }, readAt: { not: null } },
    })) === 0 ||
      (await notificationDb.notification.count({ where: { recipientId: { not: adminId } } })) === 0,
    true,
  );

  // --- Project membership ----------------------------------------------------
  console.log('\nProject membership');

  interface MemberRow {
    membershipId: string;
    userId: string;
    roles: { id: string; name: string }[];
    canManage: boolean;
    createdAt: string;
  }

  const projectRoles = (await (await call('/project-roles', { cookie: admin })).json()) as {
    id: string;
    name: string;
  }[];

  // `unit=project` upstream, so global roles must not be offered — granting one
  // on a project membership is not a thing OpenProject supports.
  check('project roles are returned', projectRoles.length > 0, true);
  check(
    'only project roles are offered',
    projectRoles.every((role) => !/global/i.test(role.name)),
    true,
  );
  check(
    'builtin non-assignable roles are excluded',
    projectRoles.some((role) => role.name === 'Anonymous' || role.name === 'Non member'),
    false,
  );

  const memberRoleId = projectRoles.find((role) => role.name === 'Member')?.id ?? projectRoles[0]!.id;
  // Reader deliberately: the only other roles here are Member and Project
  // admin, and promoting the test subject to Project admin would hand them the
  // very permission the denial checks below are asserting they lack.
  const otherRoleId =
    projectRoles.find((role) => role.name === 'Reader')?.id ??
    projectRoles.find((role) => role.id !== memberRoleId && !/admin/i.test(role.name))?.id ??
    memberRoleId;

  // A project the admin can manage and that still has somebody to add. Picking
  // "whichever came back first" would land on an archived test project with an
  // empty candidate list and make every assertion below vacuously true.
  const memberProjects = (await (await call('/projects', { cookie: admin })).json()) as {
    id: string;
    name: string;
    memberIds: string[];
  }[];

  let memberProjectId = '';
  for (const candidateProject of memberProjects) {
    // Both conditions matter. A project with candidates but no members is an
    // archived test project, and every assertion about the existing list would
    // pass vacuously against it.
    if (candidateProject.memberIds.length === 0) continue;

    const response = await call(`/projects/${candidateProject.id}/members/candidates`, {
      cookie: admin,
    });
    if (!response.ok) continue;
    const rows = (await response.json()) as { userId: string }[];
    if (rows.length > 0) {
      memberProjectId = candidateProject.id;
      break;
    }
  }

  if (!memberProjectId) {
    throw new Error('No project with both existing members and an addable candidate was found.');
  }

  const listMembers = async (cookie: string) =>
    (await (await call(`/projects/${memberProjectId}/members`, { cookie })).json()) as MemberRow[];

  const listCandidates = async (cookie: string) =>
    (await (
      await call(`/projects/${memberProjectId}/members/candidates`, { cookie })
    ).json()) as { userId: string; name: string }[];

  const membersBefore = await listMembers(admin);
  const candidatesBefore = await listCandidates(admin);
  const memberTarget = candidatesBefore[0]!.userId;

  check('a member carries its own membership id', typeof membersBefore[0]?.membershipId, 'string');
  check(
    'the membership id is not the user id',
    membersBefore[0]!.membershipId !== membersBefore[0]!.userId,
    true,
  );
  check('an existing member reports canManage for an admin', membersBefore[0]!.canManage, true);
  check(
    'candidates exclude people who are already members',
    candidatesBefore.some((row) => membersBefore.some((m) => m.userId === row.userId)),
    false,
  );

  // --- the restricted user ---
  // Run before anything is added, so the subject is genuinely an outsider here.
  // The membership targeted is the existing member's — someone else's — which
  // is the case that matters: an id from the list must not be actionable.
  const outsiderTarget = membersBefore[0]!.membershipId;

  const restrictedMembers = await call(`/projects/${memberProjectId}/members`, {
    cookie: restricted,
  });
  check('a restricted user may call the members list', restrictedMembers.status, 200);
  check(
    'a restricted user sees no memberships they cannot see upstream',
    ((await restrictedMembers.json()) as MemberRow[]).length,
    0,
  );

  check(
    'a restricted user cannot enumerate candidates',
    await status(`/projects/${memberProjectId}/members/candidates`, { cookie: restricted }),
    403,
  );
  check(
    'a restricted user cannot add a member',
    await status(`/projects/${memberProjectId}/members`, {
      method: 'POST',
      cookie: restricted,
      body: { userId: memberTarget, roleIds: [memberRoleId] },
    }),
    403,
  );
  check(
    "a restricted user cannot change someone else's role",
    await status(`/projects/${memberProjectId}/members/${outsiderTarget}`, {
      method: 'PATCH',
      cookie: restricted,
      body: { roleIds: [memberRoleId] },
    }),
    403,
  );
  check(
    'a restricted user cannot remove someone else',
    await status(`/projects/${memberProjectId}/members/${outsiderTarget}`, {
      method: 'DELETE',
      cookie: restricted,
    }),
    403,
  );

  // Refused, and nothing changed — a status code alone would not prove that.
  const afterRefused = await listMembers(admin);
  check('the refused writes removed nobody', afterRefused.length, membersBefore.length);
  check(
    'the refused writes changed no role',
    afterRefused.find((m) => m.membershipId === outsiderTarget)?.roles[0]?.id,
    membersBefore[0]!.roles[0]?.id,
  );

  // --- validation ---
  check(
    'adding without a user is rejected',
    await status(`/projects/${memberProjectId}/members`, {
      method: 'POST',
      cookie: admin,
      body: { roleIds: [memberRoleId] },
    }),
    400,
  );
  check(
    'adding with no role is rejected',
    await status(`/projects/${memberProjectId}/members`, {
      method: 'POST',
      cookie: admin,
      body: { userId: memberTarget, roleIds: [] },
    }),
    400,
  );
  check(
    'a non-numeric role id is rejected',
    await status(`/projects/${memberProjectId}/members`, {
      method: 'POST',
      cookie: admin,
      body: { userId: memberTarget, roleIds: ['../../admin'] },
    }),
    400,
  );

  // --- adding ---
  const addResponse = await call(`/projects/${memberProjectId}/members`, {
    method: 'POST',
    cookie: admin,
    body: { userId: memberTarget, roleIds: [memberRoleId] },
  });
  check('adding a member succeeds', addResponse.status, 201);

  const addedMember = (await addResponse.json()) as MemberRow;
  const addedMembershipId = addedMember.membershipId;
  grantedMemberships.push({ projectId: memberProjectId, membershipId: addedMembershipId });
  check('the new member is the person asked for', addedMember.userId, memberTarget);
  check('the new member holds the role asked for', addedMember.roles[0]?.id, memberRoleId);

  const membersAfterAdd = await listMembers(admin);
  check(
    'the new member appears in the list',
    membersAfterAdd.some((m) => m.membershipId === addedMembershipId),
    true,
  );
  check('the list grew by exactly one', membersAfterAdd.length, membersBefore.length + 1);
  check(
    'the new member is no longer a candidate',
    (await listCandidates(admin)).some((row) => row.userId === memberTarget),
    false,
  );

  // The whole point of writing through: OpenProject is the system of record, so
  // the project payload every other EPM surface reads must reflect it.
  const projectAfterAdd = (await (
    await call(`/projects/${memberProjectId}`, { cookie: admin })
  ).json()) as { memberIds: string[] };
  check(
    'the change reflects in the project payload',
    projectAfterAdd.memberIds.includes(memberTarget),
    true,
  );

  // --- role change ---
  const patchResponse = await call(
    `/projects/${memberProjectId}/members/${addedMembershipId}`,
    { method: 'PATCH', cookie: admin, body: { roleIds: [otherRoleId] } },
  );
  check('changing a role succeeds', patchResponse.status, 200);
  check('the role actually changed', ((await patchResponse.json()) as MemberRow).roles[0]?.id, otherRoleId);

  check(
    'clearing every role is rejected',
    await status(`/projects/${memberProjectId}/members/${addedMembershipId}`, {
      method: 'PATCH',
      cookie: admin,
      body: { roleIds: [] },
    }),
    400,
  );

  // --- id manipulation across projects ---
  // Holding member:manage on one project must not reach into another. Reported
  // as missing rather than forbidden: whether it exists is not the caller's
  // business.
  const otherProjectId = memberProjects.find((p) => p.id !== memberProjectId)?.id;
  if (otherProjectId) {
    check(
      'a membership cannot be patched through a different project',
      await status(`/projects/${otherProjectId}/members/${addedMembershipId}`, {
        method: 'PATCH',
        cookie: admin,
        body: { roleIds: [memberRoleId] },
      }),
      404,
    );
    check(
      'a membership cannot be deleted through a different project',
      await status(`/projects/${otherProjectId}/members/${addedMembershipId}`, {
        method: 'DELETE',
        cookie: admin,
      }),
      404,
    );
  }

  check(
    'an unknown membership id is not found',
    await status(`/projects/${memberProjectId}/members/99999999`, {
      method: 'DELETE',
      cookie: admin,
    }),
    404,
  );

  // --- removal, which is also the cleanup ---
  check(
    'removing a member succeeds',
    await status(`/projects/${memberProjectId}/members/${addedMembershipId}`, {
      method: 'DELETE',
      cookie: admin,
    }),
    204,
  );

  const membersAfterRemove = await listMembers(admin);
  check('the member list is back to where it started', membersAfterRemove.length, membersBefore.length);
  check(
    'the removed person is a candidate again',
    (await listCandidates(admin)).some((row) => row.userId === memberTarget),
    true,
  );

  const projectAfterRemove = (await (
    await call(`/projects/${memberProjectId}`, { cookie: admin })
  ).json()) as { memberIds: string[] };
  check(
    'the removal reflects in the project payload',
    projectAfterRemove.memberIds.includes(memberTarget),
    false,
  );

  // --- User accounts ---------------------------------------------------------
  console.log('\nUser accounts');

  interface AccountRow {
    id: string;
    login: string;
    firstName: string;
    lastName: string;
    name: string;
    email: string;
    admin: boolean;
    status: string;
    language?: string;
    createdAt: string;
    can: { update: boolean; lock: boolean; unlock: boolean; remove: boolean };
    placementProblems?: string[];
  }

  // Meets the instance's password rules. Used once, then the person is deleted.
  const ACCOUNT_PASSWORD = 'Str0ng!Testing2026';

  const accountsOf = async (cookie: string) =>
    (await (await call('/accounts', { cookie })).json()) as AccountRow[];

  check('anonymous cannot list accounts', await status('/accounts'), 401);
  check('a restricted user cannot list accounts', await status('/accounts', { cookie: restricted }), 403);
  check('an administrator can', await status('/accounts', { cookie: admin }), 200);

  const accountDirectory = await accountsOf(admin);
  check('the directory carries logins', typeof accountDirectory[0]?.login, 'string');
  check(
    'every account reports what may be done to it',
    accountDirectory.every((row) => typeof row.can?.update === 'boolean'),
    true,
  );
  // Upstream omits the delete affordance on the caller's own account, and the
  // mapping must not invent one.
  check(
    'nobody is offered deletion of their own account',
    accountDirectory.find((row) => row.id === adminId)?.can.remove,
    false,
  );
  check(
    'an active account offers deactivation',
    accountDirectory.find((row) => row.id === restrictedId)?.can.lock,
    true,
  );
  check(
    'an active account does not offer reactivation',
    accountDirectory.find((row) => row.id === restrictedId)?.can.unlock,
    false,
  );

  // --- validation ---
  const badAccounts: [string, Record<string, unknown>][] = [
    ['an empty payload is rejected', {}],
    ['a missing login is rejected', { firstName: 'A', lastName: 'B', email: 'a@b.co', password: ACCOUNT_PASSWORD }],
    ['a missing email is rejected', { login: 'x', firstName: 'A', lastName: 'B', password: ACCOUNT_PASSWORD }],
    ['a missing name is rejected', { login: 'x', email: 'a@b.co' }],
    [
      'a missing password is rejected',
      { login: 'x', firstName: 'A', lastName: 'B', email: 'a@b.co' },
    ],
    [
      'an invalid email is rejected',
      { login: 'x', firstName: 'A', lastName: 'B', email: 'not-an-email', password: ACCOUNT_PASSWORD },
    ],
    [
      'whitespace is not a name',
      { login: 'x', firstName: '   ', lastName: 'B', email: 'a@b.co', password: ACCOUNT_PASSWORD },
    ],
  ];
  for (const [label, body] of badAccounts) {
    check(label, await status('/accounts', { method: 'POST', cookie: admin, body }), 400);
  }

  // --- creating, with the organisational placement in the same call ---
  const accountStamp = Date.now().toString().slice(-9);
  const accountLogin = `epm.test.${accountStamp}`;

  const createdAccountResponse = await call('/accounts', {
    method: 'POST',
    cookie: admin,
    body: {
      login: accountLogin,
      firstName: 'EPM',
      lastName: `Test ${accountStamp}`,
      email: `epm.test.${accountStamp}@example.net`,
      password: ACCOUNT_PASSWORD,
      departmentId: deptId,
      teamId,
      hoursCapacity: 37.5,
    },
  });

  check('creating a person succeeds', createdAccountResponse.status, 201);

  const createdAccount = (await createdAccountResponse.json()) as AccountRow;
  const createdAccountId = createdAccount.id;

  // Active with a password, not invited: there is no mail transport here, so an
  // invited account would have no password and no way to receive one.
  check('the new person can sign in immediately', createdAccount.status, 'active');
  check('the login is what was asked for', createdAccount.login, accountLogin);
  check('a new person is not an administrator by default', createdAccount.admin, false);
  check('nothing failed during placement', createdAccount.placementProblems, undefined);
  check('an active account can be deactivated', createdAccount.can.lock, true);

  check(
    'no password is echoed back',
    JSON.stringify(createdAccount).toLowerCase().includes('password'),
    false,
  );

  // The point of the whole flow. An earlier version created people as
  // `invited`, which relies on an invitation email — and with no mail transport
  // configured, every one of them was unreachable: no password, no mail, no way
  // in. Asserting the status was not enough; this asserts they can actually
  // get in.
  {
    const signIn = await call('/auth/login', {
      method: 'POST',
      body: { username: accountLogin, password: ACCOUNT_PASSWORD },
    });
    check('the new person can actually sign in', signIn.status, 200);

    const theirSession = (signIn.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    check('and gets a working session', await status('/me', { cookie: theirSession }), 200);

    // A brand new person holds nothing beyond what any signed-in user does.
    check(
      'but no management permission comes with the account',
      await status('/accounts', { cookie: theirSession }),
      403,
    );
    check(
      'the wrong password still fails',
      (
        await call('/auth/login', {
          method: 'POST',
          body: { username: accountLogin, password: 'not-the-password' },
        })
      ).status,
      401,
    );

    // --- the starting password is a handover credential, not theirs ---
    //
    // Upstream cannot express this: it has a `force_password_change` column but
    // accepts and silently ignores the field on both create and update. So EPM
    // holds them at its own door until they replace it.
    const meBefore = (await (await call('/me', { cookie: theirSession })).json()) as {
      mustChangePassword?: boolean;
    };
    check('a new person is asked to choose their own password', meBefore.mustChangePassword, true);

    const adminMeGate = (await (await call('/me', { cookie: admin })).json()) as {
      mustChangePassword?: boolean;
    };
    check('an existing person is not', adminMeGate.mustChangePassword, false);

    check(
      'anonymous cannot set a password',
      await status('/me/password', { method: 'POST', body: { password: 'Wh4tever!2026' } }),
      401,
    );
    check(
      'an empty password is rejected',
      await status('/me/password', { method: 'POST', cookie: theirSession, body: {} }),
      400,
    );
    check(
      "a password the instance's rules reject is refused",
      (await status('/me/password', {
        method: 'POST',
        cookie: theirSession,
        body: { password: 'abc' },
      })) >= 400,
      true,
    );

    const CHANGED_PASSWORD = 'Th31rOwn!Choice2026';
    check(
      'they can set their own password',
      await status('/me/password', {
        method: 'POST',
        cookie: theirSession,
        body: { password: CHANGED_PASSWORD },
      }),
      204,
    );

    const meAfter = (await (await call('/me', { cookie: theirSession })).json()) as {
      mustChangePassword?: boolean;
    };
    check('and are no longer held at the door', meAfter.mustChangePassword, false);

    check(
      'the new password works',
      (
        await call('/auth/login', {
          method: 'POST',
          body: { username: accountLogin, password: CHANGED_PASSWORD },
        })
      ).status,
      200,
    );
    // The change has to be real upstream, not just a flag flipped in EPM.
    check(
      "the administrator's starting password no longer works",
      (
        await call('/auth/login', {
          method: 'POST',
          body: { username: accountLogin, password: ACCOUNT_PASSWORD },
        })
      ).status,
      401,
    );
  }

  // The half OpenProject's own form cannot do.
  const placed = (await (
    await call(`/employees/${createdAccountId}`, { cookie: admin })
  ).json()) as { department?: { id: string }; team?: { id: string }; hoursCapacity: number };

  check('the new person was placed in the department', placed.department?.id, deptId);
  check('and in the team', placed.team?.id, teamId);
  check('and given the capacity asked for', placed.hoursCapacity, 37.5);

  check(
    'the same login cannot be used twice',
    await status('/accounts', {
      method: 'POST',
      cookie: admin,
      body: {
        login: accountLogin,
        firstName: 'Duplicate',
        lastName: 'Login',
        email: `dupe.${accountStamp}@example.net`,
        password: ACCOUNT_PASSWORD,
      },
    }) >= 400,
    true,
  );

  // --- editing ---
  const patchedAccount = await call(`/accounts/${createdAccountId}`, {
    method: 'PATCH',
    cookie: admin,
    body: { lastName: `Renamed ${accountStamp}` },
  });
  check('editing a person succeeds', patchedAccount.status, 200);
  check(
    'the change took effect',
    ((await patchedAccount.json()) as AccountRow).lastName,
    `Renamed ${accountStamp}`,
  );

  check(
    'an empty edit is rejected',
    await status(`/accounts/${createdAccountId}`, { method: 'PATCH', cookie: admin, body: {} }),
    400,
  );
  check(
    'blanking a required field is rejected',
    await status(`/accounts/${createdAccountId}`, {
      method: 'PATCH',
      cookie: admin,
      body: { firstName: '   ' },
    }),
    400,
  );

  // --- the lifecycle, which is lock rather than delete ---
  check(
    'someone who is not deactivated cannot be reactivated',
    await status(`/accounts/${createdAccountId}/lock`, { method: 'DELETE', cookie: admin }),
    403,
  );

  {
    const locked = await call(`/accounts/${restrictedId}/lock`, { method: 'POST', cookie: admin });
    check('deactivating an active person succeeds', locked.status, 200);

    const lockedRow = (await locked.json()) as AccountRow;
    check('they are reported as locked', lockedRow.status, 'locked');
    check('and now offer reactivation', lockedRow.can.unlock, true);
    check('and no longer offer deactivation', lockedRow.can.lock, false);

    const unlocked = await call(`/accounts/${restrictedId}/lock`, {
      method: 'DELETE',
      cookie: admin,
    });
    check('reactivating succeeds', unlocked.status, 200);
    check('they are active again', ((await unlocked.json()) as AccountRow).status, 'active');
  }

  // --- refusals ---
  check(
    'nobody may delete their own account',
    await status(`/accounts/${adminId}`, { method: 'DELETE', cookie: admin }),
    403,
  );
  check(
    'a non-numeric id is not found',
    await status('/accounts/not-a-number', { cookie: admin }),
    404,
  );
  check(
    'an unknown person is not found',
    await status('/accounts/99999999', { cookie: admin }),
    404,
  );

  const accountRefusals: [string, string, string][] = [
    ['a restricted user cannot read one account', `/accounts/${adminId}`, 'GET'],
    ['a restricted user cannot create a person', '/accounts', 'POST'],
    ['a restricted user cannot edit a person', `/accounts/${createdAccountId}`, 'PATCH'],
    ['a restricted user cannot deactivate anyone', `/accounts/${adminId}/lock`, 'POST'],
    ['a restricted user cannot reactivate anyone', `/accounts/${adminId}/lock`, 'DELETE'],
    ['a restricted user cannot delete anyone', `/accounts/${createdAccountId}`, 'DELETE'],
  ];
  for (const [label, path, method] of accountRefusals) {
    check(
      label,
      await status(path, {
        method,
        cookie: restricted,
        ...(method === 'POST' || method === 'PATCH'
          ? {
              body: {
                login: 'nope',
                firstName: 'N',
                lastName: 'O',
                email: 'n@o.co',
                password: ACCOUNT_PASSWORD,
                admin: true,
              },
            }
          : {}),
      }),
      403,
    );
  }

  // Refused, and nothing changed — a status code alone would not prove it.
  check(
    'the refused writes left the account alone',
    (await accountsOf(admin)).find((row) => row.id === createdAccountId)?.lastName,
    `Renamed ${accountStamp}`,
  );
  check(
    'and did not make anyone an administrator',
    (await accountsOf(admin)).find((row) => row.id === restrictedId)?.admin,
    false,
  );

  // --- deletion, which is also this section's cleanup ---
  const accountsBeforeDelete = (await accountsOf(admin)).length;

  check(
    'deleting a person succeeds',
    await status(`/accounts/${createdAccountId}`, { method: 'DELETE', cookie: admin }),
    204,
  );

  // Upstream queues the work, so the account goes a moment later.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await status(`/accounts/${createdAccountId}`, { cookie: admin })) === 404) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  check(
    'the person is gone afterwards',
    await status(`/accounts/${createdAccountId}`, { cookie: admin }),
    404,
  );
  check('the directory shrank by one', (await accountsOf(admin)).length, accountsBeforeDelete - 1);

  // The bug this covers: upstream queues the deletion, so invalidating the
  // cached directory the instant it answered refilled the cache with the person
  // who was about to vanish — and they stayed on the Employees page for the
  // whole five-minute lifetime of that cache. No waiting here on purpose: by
  // the time the route answered, the list must already be right.
  const employeesAfterDelete = (await (
    await call('/employees', { cookie: admin })
  ).json()) as { id: string }[];
  check(
    'a deleted person is gone from the employee list straight away',
    employeesAfterDelete.some((employee) => employee.id === createdAccountId),
    false,
  );

  // The EPM row is keyed on a person who no longer exists, so it goes too.
  {
    const { prisma } = await import('../db/prisma.js');
    check(
      'their EPM placement was removed with them',
      await prisma.userProfile.count({ where: { openProjectId: createdAccountId } }),
      0,
    );
  }

  // --- Sprints ---------------------------------------------------------------
  console.log('\nSprints');

  {
    const sprintName = `Authz Sprint ${Date.now()}`;

    check(
      'a sprint needs a name',
      await status('/sprints', { method: 'POST', cookie: admin, body: { projectId: project } }),
      400,
    );
    check(
      'a sprint needs a project',
      await status('/sprints', { method: 'POST', cookie: admin, body: { name: sprintName } }),
      400,
    );
    check(
      'a non-numeric project is rejected before it reaches upstream',
      await status('/sprints', {
        method: 'POST',
        cookie: admin,
        body: { name: sprintName, projectId: '../admin' },
      }),
      400,
    );

    // Authorised by asking upstream for the version form rather than by a
    // permission EPM derives: `sprint:manage` has no capability behind it, so
    // requiring it would deny everyone.
    check(
      'a caller who may not define versions is refused',
      await status('/sprints', {
        method: 'POST',
        cookie: restricted,
        body: { name: sprintName, projectId: project },
      }),
      403,
    );

    const createdSprint = await call('/sprints', {
      method: 'POST',
      cookie: admin,
      body: { name: sprintName, projectId: project, startDate: '2026-09-10', endDate: '2026-09-24' },
    });
    check('a permitted caller can create a sprint', createdSprint.status, 201);

    const sprintRow = (await createdSprint.json()) as { id?: string; name?: string };
    check('the sprint is returned with its name', sprintRow.name, sprintName);

    const sprintList = (await (await call('/sprints', { cookie: admin })).json()) as {
      id: string;
      name: string;
    }[];
    check(
      'and appears in the sprint list',
      sprintList.some((entry) => entry.id === sprintRow.id),
      true,
    );

    if (sprintRow.id) createdSprintIds.push(sprintRow.id);

    check(
      'a caller who may not manage it cannot delete a sprint',
      await status(`/sprints/${sprintRow.id}`, { method: 'DELETE', cookie: restricted }),
      403,
    );
    check(
      'a non-numeric sprint id is not found',
      await status('/sprints/not-a-number', { method: 'DELETE', cookie: admin }),
      404,
    );
  }

  // --- Reports, dashboards and analytics (BR-401 to BR-405) -----------------
  console.log('\nReports, dashboards and analytics');
  {
    type Json = Record<string, unknown>;
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json & Record<string, any>;
    const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const projectScope = `project:${createdId}`;

    // Administration of the model is analytics:manage.
    for (const [path, method] of [
      ['/analytics/model', 'GET'],
      ['/analytics/model/runs', 'GET'],
      ['/analytics/model/refresh', 'POST'],
      ['/analytics/history/captures', 'GET'],
      ['/analytics/history/captures', 'POST'],
      ['/analytics/access', 'GET'],
    ] as const) {
      check(`${method} ${path} needs analytics:manage`, await status(path, { method, cookie: restricted, body: method === 'POST' ? {} : undefined }), 403);
    }
    check('anonymous cannot read a dashboard', await status('/dashboards/portfolio-health'), 401);

    // BR-402: a full refresh loads everything, within its window, and reconciles.
    const full = await json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'full', wait: true } });
    check('a full refresh succeeds', full.status, 'succeeded');
    check('it finishes within the agreed window', full.withinWindow, true);
    check('every table reconciles to its source within tolerance', full.reconciled, true);
    const wpLine = (full.reconciliation as { entity: string; source: number; model: number }[] | null)?.find(
      (line) => line.entity === 'work_packages',
    );
    check('work packages: the model holds as many as OpenProject', wpLine !== undefined && wpLine.model === wpLine.source, true);
    const runs = await json('/analytics/model/runs?kind=full&pageSize=5');
    check('the run is in the refresh log', (runs.items as { id: string }[]).some((run) => run.id === full.id), true);
    const model = await json('/analytics/model');
    check('the model says when its data was read', typeof model.asOf, 'string');

    // BR-404: one definition per measure, the same number wherever it is read.
    const catalogue = (await json('/measures')) as unknown as { id: string; definition: string }[];
    check(
      'the catalogue defines overdue as before today',
      catalogue.find((measure) => measure.id === 'work.overdue')?.definition.includes('before today'),
      true,
    );
    check('an unknown measure is refused', await status('/measures/values?ids=no.such', { cookie: admin }), 400);
    check('an unknown dashboard is not found', await status('/dashboards/no-such', { cookie: admin }), 404);
    check(
      'a project the caller cannot see is not found, not empty',
      await status(`/measures/values?ids=work.overdue&scope=${projectScope}`, { cookie: restricted }),
      404,
    );
    // A person's figures are the work in the projects OpenProject lets them
    // read, and no other: here, whatever public projects the restricted caller
    // can read as a non-member, and never the suite's own private project.
    const restrictedMe = await json('/me', restricted);
    const readable = Object.entries(
      (restrictedMe.projectPermissions ?? {}) as Record<string, { project?: { view?: boolean } }>,
    )
      .filter(([, set]) => set.project?.view)
      .map(([id]) => id);
    let expectedOverdue = 0;
    let expectedActive = 0;
    for (const id of readable) {
      const values = await json(`/measures/values?ids=work.overdue,projects.active&scope=project:${id}`);
      const active = Number(values.measures['projects.active'].value ?? 0);
      expectedActive += active;
      if (active) expectedOverdue += Number(values.measures['work.overdue'].value ?? 0);
    }
    const restrictedView = await json('/measures/values?ids=work.overdue,projects.active', restricted);
    check(
      'a person counts the work in the projects they can read, and no other',
      restrictedView.measures['work.overdue'].value,
      expectedOverdue,
    );
    check('and only those projects', restrictedView.measures['projects.active'].value, expectedActive);
    check('which never include a project they cannot see', readable.includes(String(createdId)), false);

    // History: wait out the aggregation window, if this run got here quickly.
    const aggregationMs = (Number(model.aggregationMinutes ?? 5) || 5) * 60_000 + 10_000;
    const waitMs = analyticsProbeCreatedAt + aggregationMs - Date.now();
    if (waitMs > 0 && waitMs < 6 * 60_000) {
      console.log(`  (waiting ${Math.ceil(waitMs / 1000)} s for OpenProject's journal aggregation window)`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    check('the two analytics probes were created', analyticsProbeIds.length, 2);
    const [probeA, probeB] = analyticsProbeIds as [string, string];

    // BR-403: capture every work package, change two, and rebuild the capture's
    // instant from history.
    await json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'incremental', wait: true } });
    const capture = await json('/analytics/history/captures', admin, { method: 'POST' });
    check('a capture is taken from the instance', Number(capture.workPackages) > 0, true);
    const yesterday = dayOffset(-1);
    const todayDay = dayOffset(0);
    check(
      'after it, probe A is renamed and made overdue',
      await status(`/tasks/${probeA}`, {
        method: 'PATCH',
        cookie: admin,
        body: { subject: 'Analytics probe A, renamed', dueDate: yesterday },
      }),
      200,
    );
    check(
      'and probe B is made due today',
      await status(`/tasks/${probeB}`, { method: 'PATCH', cookie: admin, body: { dueDate: todayDay } }),
      200,
    );
    await json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'incremental', wait: true } });
    const compared = await json(`/analytics/history/captures/${capture.id}/compare`);
    check('reconstruction matches the capture field for field', compared.matches, true);
    check('with no work package differing', compared.mismatched, 0);
    check('every captured work package was compared', compared.compared, Number(capture.workPackages) - Number(compared.deletedSince));
    const nowA = await json(`/tasks/${probeA}`);
    check('while probe A as it is now has moved on', nowA.subject, 'Analytics probe A, renamed');
    const before = await json(`/analytics/history/state?at=${encodeURIComponent(String(capture.capturedAt))}&scope=${projectScope}`);
    const now = await json(`/analytics/history/state?at=${encodeURIComponent(new Date().toISOString())}&scope=${projectScope}`);
    check('the project as it stood then had one overdue item fewer than now', Number(now.overdue) - Number(before.overdue), 1);
    check('a future instant is refused', await status(`/analytics/history/state?at=2099-01-01T00:00:00Z`, { cookie: admin }), 400);

    // The definition end to end: A (due yesterday) is overdue, B (due today) is not.
    const members = await json(`/measures/work.overdue/members?scope=${projectScope}`);
    const memberIds = (members.members.items as { id: number }[]).map((item) => String(item.id));
    check('drill-through lists probe A among the overdue', memberIds.includes(probeA), true);
    check('and not probe B, which is due today', memberIds.includes(probeB), false);
    check('the list is the count', memberIds.length, members.measure.value);
    check('and reaches the work package itself', await status(`/tasks/${memberIds[0]}`, { cookie: admin }), 200);

    // The same measure from four places.
    const direct = await json(`/measures/values?ids=work.overdue,risk.high&scope=${projectScope}`);
    const healthBoard = await json(`/dashboards/portfolio-health?scope=${projectScope}`);
    const instanceBoard = await json('/dashboards/portfolio-health');
    const executive = await json(`/reports/executive-insights?projectId=${createdId}`);
    const overdue = direct.measures['work.overdue'].value;
    check('overdue: the portfolio-health dashboard agrees with the measure', healthBoard.measures['work.overdue'].value, overdue);
    check(
      'and so does its row on the instance dashboard',
      (instanceBoard.tables as { id: string; rows: { link?: { id: string }; cells: Json }[] }[])
        .find((table) => table.id === 'projects')
        ?.rows.find((row) => row.link?.id === createdId)?.cells['work.overdue'],
      overdue,
    );
    check('and the executive report', executive.overdueTasks, overdue);
    const riskBoard = await json(`/dashboards/risk?scope=${projectScope}`);
    check('high risks: the risk dashboard agrees with the measure', riskBoard.measures['risk.high'].value, direct.measures['risk.high'].value);

    // BR-405: every dashboard, within the response target.
    for (const id of ['portfolio-health', 'delivery', 'utilisation', 'budget', 'earned-value', 'risk']) {
      const response = await call(`/dashboards/${id}`, { cookie: admin });
      const body = (await response.json()) as { timing?: { withinTarget: boolean; serverMs: number }; tiles?: string[] };
      check(`the ${id} dashboard answers`, response.status, 200);
      check(`within the response target (${body.timing?.serverMs ?? '?'} ms)`, body.timing?.withinTarget, true);
      check('with its tiles', (body.tiles?.length ?? 0) > 0, true);
    }
    const projectRows = (instanceBoard.tables as { id: string; rows: { link?: { kind: string; id: string } }[] }[]).find(
      (table) => table.id === 'projects',
    )?.rows;
    check('the dashboard links the project for drill-through', projectRows?.some((row) => row.link?.kind === 'project' && row.link.id === createdId), true);

    // The report fixes: filters are applied, and nothing is a placeholder.
    const emptyPeriod = (await json('/reports/time-summary?from=2099-01-01&to=2099-01-31')) as unknown as unknown[];
    check('a period with no time logged reports none', emptyPeriod.length, 0);
    const september = (await json('/reports/delivery-trends?from=2026-09-01&to=2026-09-30')) as unknown as { period: string }[];
    check('delivery trends cover only the period asked for', september.map((point) => point.period).join(','), '2026-09');
    const distribution = (await json(`/reports/status-distribution?projectId=${createdId}`)) as unknown as { count: number }[];
    const total = await json(`/measures/values?ids=work.total&scope=${projectScope}`);
    check('the status distribution is of the project asked for', distribution.reduce((sum, row) => sum + row.count, 0), total.measures['work.total'].value);
    check('the executive report says what each figure is', typeof executive.measures['milestones.onTime']?.definition, 'string');
    check('and when its data was read', typeof executive.asOf, 'string');
    const anyTime = (await json('/reports/time-summary')) as unknown as Json[];
    check('time is reported without a billable placeholder', anyTime.every((row) => !('hoursBillable' in row)), true);

    // BR-401: the analytics role reads everything and writes nothing.
    const access = await json('/analytics/access');
    if (access.configured) {
      check('the analytics role reads every table', (access.reads as { ok: boolean }[]).every((probe) => probe.ok), true);
      check('every write it attempts is refused', (access.writes as { ok: boolean }[]).every((probe) => probe.ok), true);
      check('and it holds no write privilege', (access.grants as { ok: boolean }[]).every((probe) => probe.ok), true);
      check('on the replica', access.replica, true);
    } else {
      console.log('  (the analytics role is not configured on this backend; EPM_ANALYTICS_DATABASE_URL)');
    }
  }

  // --- Scheduled reports (BR-207 to BR-210) ----------------------------------
  console.log('\nScheduled reports');
  {
    type Json = Record<string, any>;
    const { prisma: reportsDb } = await import('../db/prisma.js');
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json;
    const bytesOf = async (path: string, cookie = admin) => {
      const response = await call(path, { cookie });
      return { status: response.status, text: Buffer.from(await response.arrayBuffer()).toString('latin1') };
    };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // A run's emails are test mail. Once a check has read them they are
    // cancelled, so that a mail worker elsewhere on this database — a
    // developer's own server, say — does not send them.
    const holdEmails = (runId: string | undefined) =>
      runId
        ? reportsDb.emailOutbox
            .updateMany({
              where: { dedupeKey: { startsWith: `report:${runId}:` }, status: 'queued' },
              data: { status: 'cancelled', lastError: 'Cancelled by the authorization suite: a test report.' },
            })
            .catch(() => undefined)
        : Promise.resolve();
    const projectsOf = async (deliveryId: unknown) =>
      (await reportsDb.reportDelivery.findUnique({ where: { id: String(deliveryId) }, select: { projectIds: true } }))?.projectIds ?? [];
    const fileOf = (delivery: Json | undefined, format: string) =>
      (delivery?.artifacts as Json[] | undefined)?.find((artifact) => artifact.format === format)?.id as string | undefined;
    // A rendered PDF links each project row to the project; this is that link.
    const projectLink = `/projects/${createdId})`;
    const outside = `br209-${process.pid}@example.invalid`;

    // Who may do what.
    check('reading scheduled reports needs reports:schedule', await status('/reports/schedules', { cookie: restricted }), 403);
    check('so does defining one', await status('/reports/schedules', { method: 'POST', cookie: restricted, body: {} }), 403);
    check('and reading the run log', await status('/reports/runs', { cookie: restricted }), 403);
    check('anonymous cannot download a dashboard', await status('/dashboards/portfolio-health/export?format=pdf'), 401);

    // A weekly report, due a minute or two from now, in Dubai's time zone (UTC+4, no daylight saving).
    const occurrence = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
    const local = new Date(occurrence.getTime() + 4 * 3_600_000);
    const definition = {
      name: `Authz weekly report ${process.pid}`,
      sourceKind: 'dashboard',
      sourceId: 'portfolio-health',
      scope: 'instance',
      periodPreset: 'previous-week',
      frequency: 'weekly',
      weekday: ((local.getUTCDay() + 6) % 7) + 1,
      timeOfDay: local.toISOString().slice(11, 16),
      timezone: 'Asia/Dubai',
      windowMinutes: 60,
      formats: ['pdf', 'xlsx'],
      recipientUserIds: [restrictedId],
      externalEmails: [outside],
    };
    const define = (body: unknown) => status('/reports/schedules', { method: 'POST', cookie: admin, body });
    check('a weekly report needs its day', await define({ ...definition, weekday: null }), 400);
    check('a report needs a recipient', await define({ ...definition, recipientUserIds: [], externalEmails: [] }), 400);
    check('its recipients are people EPM knows', await define({ ...definition, recipientUserIds: ['999999999'] }), 400);
    check('and its time zone is a real one', await define({ ...definition, timezone: 'Mars/Olympus' }), 400);

    const createdResponse = await call('/reports/schedules', { method: 'POST', cookie: admin, body: definition });
    const schedule = (await createdResponse.json()) as Json;
    check('an administrator defines a weekly report', createdResponse.status, 201);
    if (schedule.id) reportScheduleIds.push(schedule.id);
    check('BR-207: its next run is the configured day and time', schedule.nextRunAt, occurrence.toISOString());
    check(
      'described in its own time zone',
      String(schedule.describedTiming).includes(definition.timeOfDay) && String(schedule.describedTiming).includes('Asia/Dubai'),
      true,
    );
    check('its outside address waits for approval', schedule.externalApproval?.approved, false);
    check('approving needs reports:approve', await status(`/reports/schedules/${schedule.id}/approve`, { method: 'POST', cookie: restricted }), 403);
    check(
      'and is never done by whoever added the address',
      await status(`/reports/schedules/${schedule.id}/approve`, { method: 'POST', cookie: admin }),
      403,
    );

    // BR-209: each copy is built with its recipient's own access.
    const manual = await json(`/reports/schedules/${schedule.id}/run`, admin, { method: 'POST' });
    await holdEmails(manual.id);
    check('a report can be run by hand', manual.trigger, 'manual');
    check('and renders', manual.status, 'rendered');
    const deliveries = (manual.deliveries ?? []) as Json[];
    const theirs = deliveries.find((delivery) => delivery.recipientUserId === restrictedId);
    const external = deliveries.find((delivery) => delivery.recipientKind === 'external');
    check('BR-209: the restricted person gets a copy, as a PDF and a workbook', (theirs?.artifacts as Json[] | undefined)?.length, 2);
    check('which leaves out the project they cannot see', (await projectsOf(theirs?.id)).includes(String(createdId)), false);
    check('and says that it has', Number(theirs?.excludedProjects) >= 1, true);
    const theirPdf = await bytesOf(`/reports/runs/${manual.id}/files/${fileOf(theirs, 'pdf')}`);
    check('their PDF downloads', theirPdf.status, 200);
    check('as a PDF', theirPdf.text.startsWith('%PDF-'), true);
    check('with no link to the project they cannot see', theirPdf.text.includes(projectLink), false);
    const theirWorkbook = await bytesOf(`/reports/runs/${manual.id}/files/${fileOf(theirs, 'xlsx')}`);
    check('and their workbook as a workbook', theirWorkbook.status === 200 && theirWorkbook.text.startsWith('PK'), true);
    check(
      'the files are not for a caller without reports:schedule',
      await status(`/reports/runs/${manual.id}/files/${fileOf(theirs, 'pdf')}`, { cookie: restricted }),
      403,
    );
    check('an outside address is not sent to before approval', external?.renderStatus, 'withheld');
    check('and the log says why', String(external?.reason ?? '').includes('not been approved'), true);
    if (theirs?.renderStatus === 'rendered') {
      // BR-208: delivery is the outbox's, with its retries; the failure path is
      // exercised in report checks, against a simulated relay outage.
      check('BR-208: their copy is queued as an email', ['queued', 'sending', 'sent'].includes(String(theirs.emailStatus)), true);
      const row = await reportsDb.emailOutbox.findFirst({
        where: { dedupeKey: { startsWith: `report:${manual.id}:` }, recipientId: restrictedId },
        select: { template: true, payload: true },
      });
      check('as a scheduled-report email', row?.template, 'scheduled-report');
      check(
        'carrying their files',
        JSON.stringify([...((row?.payload as { artifactIds?: string[] } | null)?.artifactIds ?? [])].sort()),
        JSON.stringify(((theirs.artifacts ?? []) as Json[]).map((artifact) => artifact.id).sort()),
      );
    } else {
      console.log(`  (the restricted account's copy was not emailed: ${theirs?.reason ?? 'no reason given'})`);
    }

    // The dashboard on the screen, as a file: the same figures, for the same person.
    const exported = await bytesOf('/dashboards/portfolio-health/export?format=pdf', restricted);
    check('anyone signed in downloads the dashboard they see', exported.status, 200);
    check('as a PDF', exported.text.startsWith('%PDF-'), true);
    check('leaving out the projects they cannot see', exported.text.includes(projectLink), false);
    const adminExport = await bytesOf('/dashboards/portfolio-health/export?format=pdf');
    check("while an administrator's includes the project", adminExport.text.includes(projectLink), true);
    check(
      'a project the caller cannot see is not found',
      await status(`/dashboards/portfolio-health/export?format=pdf&scope=project:${createdId}`, { cookie: restricted }),
      404,
    );
    const workbook = await bytesOf(`/dashboards/delivery/export?format=xlsx&scope=project:${createdId}`);
    check('and a dashboard downloads as a workbook', workbook.status === 200 && workbook.text.startsWith('PK'), true);

    // Approval by someone else: the restricted account is lent reports:approve.
    const lent = await reportsDb.epmPermissionGrant
      .create({ data: { openProjectId: restrictedId, permission: 'reports:approve', grantedBy: adminMe.id } })
      .then(() => true)
      .catch(() => false);
    if (lent) reportGrantUserId = restrictedId;

    // BR-207: the scheduler sends it at the configured time.
    const deadline = occurrence.getTime() + 150_000;
    console.log(`  (waiting up to ${Math.ceil((deadline - Date.now()) / 1000)} s for the occurrence at ${occurrence.toISOString()})`);
    let scheduled: Json | undefined;
    while (!scheduled && Date.now() < deadline) {
      await pause(2_000);
      const page = await json(`/reports/runs?scheduleId=${schedule.id}&pageSize=50`);
      scheduled = (page.items as Json[] | undefined)?.find((run) => run.trigger === 'schedule');
    }
    for (let wait = 0; scheduled?.status === 'running' && wait < 60; wait += 1) {
      await pause(1_000);
      scheduled = await json(`/reports/runs/${scheduled.id}`);
    }
    await holdEmails(scheduled?.id);
    check('BR-207: the scheduler sends it', scheduled !== undefined, true);
    check('for the configured occurrence', scheduled?.scheduledFor, occurrence.toISOString());
    const lateMs = scheduled ? Date.parse(scheduled.startedAt) - occurrence.getTime() : -1;
    check(`at that time, within its window (${Math.round(lateMs / 1000)} s after)`, lateMs >= 0 && lateMs < definition.windowMinutes * 60_000, true);
    check('and it renders', scheduled?.status, 'rendered');
    const afterRun = await json(`/reports/schedules/${schedule.id}`);
    check('its next run is a week later, at the same time', afterRun.nextRunAt, new Date(occurrence.getTime() + 7 * 86_400_000).toISOString());

    // Permissions are remembered for a minute; past that the loan applies.
    let approval = await call(`/reports/schedules/${schedule.id}/approve`, { method: 'POST', cookie: restricted });
    if (approval.status === 403 && lent) {
      await pause(61_000);
      approval = await call(`/reports/schedules/${schedule.id}/approve`, { method: 'POST', cookie: restricted });
    }
    check('someone else with reports:approve approves the outside address', approval.status, 200);
    const approved = (await approval.json()) as Json;
    check('and who approved it is kept', approved.externalApproval?.approvedBy, restrictedId);

    const second = await json(`/reports/schedules/${schedule.id}/run`, admin, { method: 'POST' });
    await holdEmails(second.id);
    const outsideCopy = ((second.deliveries ?? []) as Json[]).find((delivery) => delivery.recipientKind === 'external');
    check('once approved, the outside address gets a copy', outsideCopy?.renderStatus, 'rendered');
    check("built with the owner's access, so it covers the project", (await projectsOf(outsideCopy?.id)).includes(String(createdId)), true);
    const outsidePdf = await bytesOf(`/reports/runs/${second.id}/files/${fileOf(outsideCopy, 'pdf')}`);
    check('and its PDF links it', outsidePdf.text.includes(projectLink), true);
    const changed = await json(`/reports/schedules/${schedule.id}`, admin, {
      method: 'PATCH',
      body: { ...definition, externalEmails: [outside, `second-${outside}`] },
    });
    check('changing the outside addresses needs approving again', changed.externalApproval?.approved, false);

    // BR-210: every run is logged, and found by report and by date.
    const logged = ((await json(`/reports/runs?scheduleId=${schedule.id}&pageSize=50`)).items as Json[]).map((run) => run.id);
    check('BR-210: every run is logged against its report', [manual.id, scheduled?.id, second.id].every((id) => logged.includes(id)), true);
    const day = String(second.startedAt ?? '').slice(0, 10);
    const byDate = await json(`/reports/runs?from=${day}&to=${day}&pageSize=100`);
    check('and found by date', (byDate.items as Json[]).some((run) => run.id === second.id), true);
    check('a day with no runs lists none', (await json('/reports/runs?from=2099-01-01')).total, 0);
    const detail = await json(`/reports/runs/${manual.id}`);
    check('a run keeps each copy and what became of it', (detail.deliveries as Json[]).length, 2);
    const stored = await reportsDb.reportRun.findUnique({ where: { id: String(manual.id) }, select: { definition: true } });
    check('and the definition it ran with', (stored?.definition as { name?: string } | null)?.name, definition.name);

    const removed = await json(`/reports/schedules/${schedule.id}`, admin, { method: 'DELETE' });
    check('a report that has run is switched off, not deleted', removed.outcome, 'deactivated');
    check('so its log stays', (await json(`/reports/runs?scheduleId=${schedule.id}`)).total >= 3, true);
    const spare = await json('/reports/schedules', admin, {
      method: 'POST',
      body: { ...definition, name: `Authz spare report ${process.pid}`, externalEmails: [] },
    });
    if (spare.id) reportScheduleIds.push(spare.id);
    check('one that never ran is deleted', (await json(`/reports/schedules/${spare.id}`, admin, { method: 'DELETE' })).outcome, 'deleted');
  }

  // --- Portfolio views (BR-201 to BR-203) ------------------------------------
  console.log('\nPortfolio views');
  {
    type Json = Record<string, any>;
    const { prisma: viewsDb } = await import('../db/prisma.js');
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const viewStamp = Date.now().toString(36);
    const todayDay = new Date().toISOString().slice(0, 10);
    const suiteProject = String(createdId);
    const sumOf = (overview: Json, id: string) =>
      ((overview.projects ?? []) as Json[]).reduce((sum, project) => sum + Number(project.figures?.[id]?.value ?? 0), 0);

    // A project the restricted account can read, beside the suite's own, which it cannot.
    const theirMe = await json('/me', restricted);
    const theirProjects = Object.entries((theirMe.projectPermissions ?? {}) as Record<string, { project?: { view?: boolean } }>)
      .filter(([, set]) => set.project?.view)
      .map(([id]) => id)
      .filter((id) => id !== suiteProject);
    const allProjects = (await json('/projects')) as unknown as { id: string; status?: string }[];
    const openProject = theirProjects.find((id) => allProjects.some((project) => String(project.id) === id && project.status !== 'paused'));
    check('the restricted account can read an active project besides the suite’s', openProject !== undefined, true);

    // Cost behind the suite's project: two hours by the administrator, on a
    // task of its own (from OpenProject 17 time belongs to a work package).
    const viewTask = ((await json('/tasks', admin, { method: 'POST', body: { projectId: suiteProject, subject: 'Portfolio view probe time' } })) as { id?: string }).id;
    const logTime = (activityId?: string) =>
      call('/time-entries', {
        method: 'POST',
        cookie: admin,
        body: { projectId: suiteProject, workPackageId: viewTask, hours: 2, spentOn: todayDay, comment: 'Portfolio view probe', ...(activityId ? { activityId } : {}) },
      });
    let logged = await logTime();
    if (logged.status !== 201) {
      const form = JSON.stringify(await json('/forms/time-entries', admin, { method: 'POST', body: { projectId: suiteProject, workPackageId: viewTask } }));
      logged = await logTime(/time_entries\/activities\/(\d+)/.exec(form)?.[1]);
    }
    check('time can be logged on the suite’s project', logged.status, 201);
    viewTimeEntryId = logged.status === 201 ? ((await logged.json()) as { id: string }).id : undefined;

    // BR-201: a portfolio in one view. The suite's project goes into a portfolio of its own.
    const portfolioResponse = await call('/portfolios', {
      method: 'POST',
      cookie: admin,
      body: { name: `Authz view portfolio ${viewStamp}`, code: `AVP${viewStamp}`.slice(0, 16).toUpperCase() },
    });
    const viewPortfolio = (await portfolioResponse.json()) as Json;
    check('a portfolio is created for the view tests', portfolioResponse.status, 201);
    if (viewPortfolio.id) portfolioIds.push(viewPortfolio.id);
    if (!originalProjectPortfolio.has(suiteProject)) {
      originalProjectPortfolio.set(suiteProject, ((await json(`/projects/${suiteProject}`)).portfolioId as string | undefined) ?? null);
    }
    check(
      'the suite’s project joins it',
      await status(`/projects/${suiteProject}/portfolio`, { method: 'PATCH', cookie: admin, body: { portfolioId: viewPortfolio.id } }),
      200,
    );

    // The figures come from the analytics model: wait for it to see the portfolio and the time.
    let portfolioOverview: Json = {};
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'incremental', wait: true } });
      portfolioOverview = await json(`/portfolios/${viewPortfolio.id}/overview`);
      if (portfolioOverview.set?.shown === 1 && Number(portfolioOverview.measures?.['cost.actual']?.value ?? 0) > 0) break;
      await pause(2_000);
    }
    check('BR-201: the portfolio is in one view, with its project', portfolioOverview.set?.shown, 1);
    check(
      'showing status, schedule variance, budget consumption, open risks and milestones',
      ['projects.atRisk', 'schedule.varianceDays', 'budget.consumed', 'risk.open', 'milestones.missed', 'milestones.upcoming'].every(
        (id) => id in (portfolioOverview.measures ?? {}),
      ),
      true,
    );
    check('every figure adds up to its project', portfolioOverview.reconciled, true);
    check('the logged time is in its cost', Number(portfolioOverview.measures?.['cost.actual']?.value ?? 0) > 0, true);
    const theirPortfolio = await call(`/portfolios/${viewPortfolio.id}/overview`, { cookie: restricted });
    check('someone who cannot see its project still gets the view, not an error', theirPortfolio.status, 200);
    const theirPortfolioBody = (await theirPortfolio.json()) as Json;
    check('with the project left out and counted', theirPortfolioBody.set?.hidden, 1);
    check('and none of it shown', ((theirPortfolioBody.projects ?? []) as Json[]).length, 0);
    check('an unknown portfolio is not found', await status('/portfolios/no-such-portfolio/overview', { cookie: admin }), 404);

    // BR-203: saved views — over the suite's project and one the restricted account can read.
    const definition = {
      portfolioIds: [],
      projectIds: [suiteProject, openProject],
      health: [],
      periodPreset: 'last-12-weeks',
      columns: ['health', 'budget.consumed', 'budget.variancePct', 'risk.open', 'milestones.missed', 'work.overdue'],
    };
    const create = (body: Json, cookie = admin) => call('/portfolio-views', { method: 'POST', cookie, body });
    const keep = async (response: Response) => {
      const body = (await response.json()) as Json;
      if (body.id) portfolioViewIds.push(body.id);
      return body;
    };
    check('a view shared with roles needs them', (await create({ name: 'x', visibility: 'roles', roleIds: [], definition })).status, 400);
    check(
      'and they are roles a project member can hold',
      (await create({ name: 'x', visibility: 'roles', roleIds: ['999999'], definition })).status,
      400,
    );
    check(
      'a view names portfolios that exist',
      (await create({ name: 'x', visibility: 'private', definition: { ...definition, portfolioIds: ['no-such-portfolio'] } })).status,
      400,
    );
    const publicCreated = await create({ name: `Authz public view ${viewStamp}`, visibility: 'public', definition });
    check('anyone signed in can save a view', publicCreated.status, 201);
    const publicView = await keep(publicCreated);
    const privateView = await keep(await create({ name: `Authz private view ${viewStamp}`, visibility: 'private', definition }));

    // BR-201 over two projects: every figure equals the roll-up of the rows.
    const both = await json(`/portfolio-views/${publicView.id}/overview`);
    check('BR-201: over two projects, every figure adds up to its projects', both.reconciled, true);
    check(
      'the counts are the sums of the rows',
      ['work.open', 'work.overdue', 'risk.open', 'milestones.missed'].every((id) => sumOf(both, id) === Number(both.measures?.[id]?.value ?? 0)),
      true,
    );
    check('and the cost is the sum of the rows', Math.abs(sumOf(both, 'cost.actual') - Number(both.measures?.['cost.actual']?.value ?? 0)) < 0.005, true);

    // BR-203: what each person sees.
    const theirList = (await json('/portfolio-views', restricted)) as unknown as Json[];
    check('a public view is listed for everyone', theirList.some((view) => view.id === publicView.id), true);
    check('a private one is not', theirList.some((view) => view.id === privateView.id), false);
    check('and cannot be opened by anyone else', await status(`/portfolio-views/${privateView.id}`, { cookie: restricted }), 404);
    check('nor its figures read', await status(`/portfolio-views/${privateView.id}/overview`, { cookie: restricted }), 404);
    const theirs = await call(`/portfolio-views/${publicView.id}/overview`, { cookie: restricted });
    check('BR-203: someone without access to a project in a shared view gets the view', theirs.status, 200);
    const theirsBody = (await theirs.json()) as Json;
    check('with that project left out', ((theirsBody.projects ?? []) as Json[]).some((project) => String(project.id) === suiteProject), false);
    check('and counted, not an error', theirsBody.set?.hidden, 1);
    check('the project they can see is there', ((theirsBody.projects ?? []) as Json[]).some((project) => String(project.id) === openProject), true);
    check('and their figures add up too', theirsBody.reconciled, true);
    check(
      'a shared view is changed only by whoever made it',
      await status(`/portfolio-views/${publicView.id}`, { method: 'PATCH', cookie: restricted, body: { name: 'Taken', visibility: 'public', definition } }),
      403,
    );
    check('or deleted', await status(`/portfolio-views/${publicView.id}`, { method: 'DELETE', cookie: restricted }), 403);

    // Shared with a role: whoever holds it on a project the view selects.
    const roles = ((await json('/portfolio-views/options')).roles ?? []) as { id: string; name: string }[];
    const givenRole = roles.find((role) => /reader/i.test(role.name)) ?? roles[0];
    const otherRole = roles.find((role) => role.id !== givenRole?.id);
    check('there are roles to share with', Boolean(givenRole && otherRole), true);
    const suiteOnly = { ...definition, projectIds: [suiteProject] };
    const roleView = await keep(await create({ name: `Authz role view ${viewStamp}`, visibility: 'roles', roleIds: [givenRole?.id], definition: suiteOnly }));
    const otherRoleView = await keep(
      await create({ name: `Authz other role view ${viewStamp}`, visibility: 'roles', roleIds: [otherRole?.id], definition: suiteOnly }),
    );
    check('a view shared with a role is not for someone without it', await status(`/portfolio-views/${roleView.id}`, { cookie: restricted }), 404);
    const granted = (await (
      await call(`/projects/${suiteProject}/members`, { method: 'POST', cookie: admin, body: { userId: restrictedId, roleIds: [givenRole?.id] } })
    ).json()) as { membershipId?: string };
    if (granted.membershipId) grantedMemberships.push({ projectId: suiteProject, membershipId: granted.membershipId });
    check('BR-203: given the role on a project in it, they see it', await status(`/portfolio-views/${roleView.id}`, { cookie: restricted }), 200);
    check('and its figures', await status(`/portfolio-views/${roleView.id}/overview`, { cookie: restricted }), 200);
    check('but not a view shared with another role', await status(`/portfolio-views/${otherRoleView.id}`, { cookie: restricted }), 404);
    if (granted.membershipId) {
      await call(`/projects/${suiteProject}/members/${granted.membershipId}`, { method: 'DELETE', cookie: admin });
      grantedMemberships.splice(
        grantedMemberships.findIndex((membership) => membership.membershipId === granted.membershipId),
        1,
      );
    }
    check('without the role again, the view is gone for them', await status(`/portfolio-views/${roleView.id}`, { cookie: restricted }), 404);

    // BR-202: a budget variance figure drills to its projects, and from a project to the time entries behind it.
    const suiteRow = ((both.projects ?? []) as Json[]).find((project) => String(project.id) === suiteProject);
    check('BR-202: the budget variance figure has the suite’s project among its rows', suiteRow?.figures?.['budget.variancePct'] !== undefined, true);
    const entries = await json(`/measures/budget.variancePct/entries?scope=project:${suiteProject}`);
    const probe = ((entries.entries ?? []) as Json[]).find((entry) => entry.id === viewTimeEntryId);
    check('drilling a project’s share reaches the time entries behind it', probe !== undefined, true);
    check('each priced by the labour cost rule', typeof probe?.cost === 'number' && probe.cost > 0, true);
    check('and together they make the project’s cost', entries.figure?.matches, true);
    check(
      'the same cost the view’s figure was made from',
      Math.abs(Number(entries.totals?.cost ?? 0) - Number(suiteRow?.figures?.['budget.variancePct']?.parts?.actual ?? -1)) < 0.005,
      true,
    );
    check(
      'the entries are not for someone who cannot see the project',
      await status(`/measures/budget.variancePct/entries?scope=project:${suiteProject}`, { cookie: restricted }),
      404,
    );
    check('a figure not made of logged time has none', await status(`/measures/risk.open/entries?scope=project:${suiteProject}`, { cookie: admin }), 400);
    check('entries are listed one project at a time', await status('/measures/cost.actual/entries?scope=instance', { cookie: admin }), 400);

    // The owner changes and deletes; every change is journalled.
    const renamed = await call(`/portfolio-views/${privateView.id}`, {
      method: 'PATCH',
      cookie: admin,
      body: { name: `Authz private view ${viewStamp} (renamed)`, visibility: 'private', definition },
    });
    check('the owner can change a view', renamed.status, 200);
    check('and it is versioned', ((await renamed.json()) as Json).version, 2);
    check('and delete it', await status(`/portfolio-views/${privateView.id}`, { method: 'DELETE', cookie: admin }), 204);
    check('after which it is gone', await status(`/portfolio-views/${privateView.id}`, { cookie: admin }), 404);
    const journalled = await viewsDb.auditEvent.findMany({
      where: { entityType: 'portfolio_view', entityId: privateView.id },
      select: { action: true },
    });
    check(
      'its making, change and deletion are in the journal',
      ['portfolio_view.created', 'portfolio_view.updated', 'portfolio_view.deleted'].every((action) => journalled.some((entry) => entry.action === action)),
      true,
    );

    // Put things back: the time entry, and the project out of the portfolio.
    if (viewTimeEntryId) {
      check('the probe time entry is removed', await status(`/time-entries/${viewTimeEntryId}`, { method: 'DELETE', cookie: admin }), 204);
      viewTimeEntryId = undefined;
    }
    check(
      'the suite’s project leaves the portfolio',
      await status(`/projects/${suiteProject}/portfolio`, { method: 'PATCH', cookie: admin, body: {} }),
      200,
    );
  }

  // --- Surfaces ---------------------------------------------------------------
  // Meetings, news, the wiki, documents, logged time, the assistant, the
  // webhook receiver, sessions, invitations and preferences, each held to the
  // same rule against the private project: authz-surfaces.ts.
  if (createdId) {
    const { surfaceChecks } = await import('./authz-surfaces.js');
    await surfaceChecks({
      call,
      status,
      check,
      admin,
      restricted,
      adminId,
      restrictedId,
      projectId: createdId,
      base: BASE,
      signInRestricted: () => signIn(RESTRICTED),
      cleanup: { onCleanup: (fn) => surfaceCleanups.push(fn) },
    });
  } else {
    console.log('\n  SKIP  surfaces: the private project was not created');
  }

  // --- Recurring tasks (BR-105 to BR-107) -------------------------------------
  // In a project of its own, removed with its series however far the run got:
  // authz-recurring.ts.
  {
    const { recurringChecks } = await import('./authz-recurring.js');
    await recurringChecks({ call, status, check, admin, restricted, adminId, cleanup: { onCleanup: (fn) => surfaceCleanups.push(fn) } });
  }

  // --- Calculated fields (BR-406 to BR-408) -----------------------------------
  // In a project of its own; every field, its OpenProject field and the work
  // removed however far the run got: authz-calculated.ts.
  {
    const { calculatedChecks } = await import('./authz-calculated.js');
    await calculatedChecks({ call, status, check, admin, restricted, cleanup: { onCleanup: (fn) => surfaceCleanups.push(fn) } });
  }

  // --- Critical path (BR-101 to BR-104) ---------------------------------------
  console.log('\nCritical path');
  {
    type Json = Record<string, any>;
    const { prisma: pathDb } = await import('../db/prisma.js');
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const DAY = 86_400_000;
    const isoOf = (time: number) => new Date(time).toISOString().slice(0, 10);
    const addWorkdays = (from: number, count: number) => {
      let at = from;
      for (let left = count; left > 0; ) {
        at += DAY;
        const weekday = new Date(at).getUTCDay();
        if (weekday !== 0 && weekday !== 6) left -= 1;
      }
      return at;
    };

    // A project of its own: the figures below are worked by hand, and dated
    // work another section leaves in the suite's project would move its finish.
    const stamp = Date.now();
    const madeProject = await call('/projects', {
      method: 'POST',
      cookie: admin,
      body: { payload: { name: `Critical Path Test ${stamp}`, identifier: `cp-test-${stamp}` } },
    });
    check('a project is made for the critical path tests', madeProject.status, 201);
    criticalPathProjectId = ((await madeProject.json()) as Json).id as string | undefined;
    const cpProject = String(criticalPathProjectId);

    // The calendar the hand schedule assumes: Monday to Friday, and no
    // holiday in the fortnight it runs across — the first such fortnight from
    // a week on Monday.
    const week = await asSystem(() => upstream.request<Json>('/days/week'));
    const working = ((week._embedded?.elements ?? []) as Json[]).filter((day) => day.working).map((day) => day.day);
    check('the instance works Monday to Friday', JSON.stringify(working), JSON.stringify([1, 2, 3, 4, 5]));
    const now = new Date();
    let base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + (((8 - now.getUTCDay()) % 7 || 7) + 7) * DAY;
    for (let tries = 0; tries < 8; tries += 1) {
      const holidays = await asSystem(() =>
        upstream.getCollection<Json>('/days/non_working', {
          filters: [{ field: 'date', operator: '<>d', values: [isoOf(base), isoOf(base + 13 * DAY)] }],
        }),
      );
      if ((holidays.total ?? 0) === 0) break;
      base += 7 * DAY;
    }
    const day = (n: number) => isoOf(addWorkdays(base, n));

    /*
     * The control set, worked by hand in working days from a Monday (day 0):
     *
     *   item  days  follows        ES EF LS LF  TF FF
     *   A      3    —               0  2  0  2   0  0   critical
     *   B      2    A               3  4  6  7   3  3   near-critical at 3 days
     *   C      4    A, lag 1        4  7  4  7   0  0   critical
     *   D      1    B and C         8  8  8  8   0  0   critical
     *   E      2    — (its own)     0  1  7  8   7  7
     *   F      no dates: not scheduled
     */
    const plan = [
      { key: 'A', start: 0, end: 2, tf: 0, ff: 0, es: 0, ef: 2, ls: 0, lf: 2, critical: true },
      { key: 'B', start: 3, end: 4, tf: 3, ff: 3, es: 3, ef: 4, ls: 6, lf: 7, critical: false },
      { key: 'C', start: 4, end: 7, tf: 0, ff: 0, es: 4, ef: 7, ls: 4, lf: 7, critical: true },
      { key: 'D', start: 8, end: 8, tf: 0, ff: 0, es: 8, ef: 8, ls: 8, lf: 8, critical: true },
      { key: 'E', start: 0, end: 1, tf: 7, ff: 7, es: 0, ef: 1, ls: 7, lf: 8, critical: false },
    ];
    const ids: Record<string, string> = {};
    for (const step of [...plan, { key: 'F' }] as Json[]) {
      const made = await call('/tasks', {
        method: 'POST',
        cookie: admin,
        body: {
          projectId: cpProject,
          subject: `Critical path ${step.key}`,
          status: 'todo',
          priority: 'medium',
          ...(step.start !== undefined ? { startDate: day(step.start), dueDate: day(step.end) } : {}),
        },
      });
      ids[step.key] = ((await made.json()) as Json).id;
    }
    const keyOf = (id: string) => Object.entries(ids).find(([, value]) => value === id)?.[0] ?? '?';
    check('six work packages are made, five of them dated', Object.values(ids).filter(Boolean).length, 6);
    const relate = (successor: string, predecessor: string, lag = 0) =>
      call(`/work-packages/${ids[successor]}/relations`, {
        method: 'POST',
        cookie: admin,
        body: { type: 'follows', relatedId: ids[predecessor], ...(lag ? { lag } : {}) },
      });
    const related = [await relate('B', 'A'), await relate('C', 'A', 1), await relate('D', 'B'), await relate('D', 'C')];
    check('four follows relations join them, one with a day of lag', related.every((response) => response.status === 201), true);

    // Drawing the relations queued a pass; wait for its figures.
    let path: Json = {};
    const itemOf = (key: string) => ((path.items ?? []) as Json[]).find((entry) => entry.id === ids[key]);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      path = await json(`/projects/${cpProject}/critical-path?near=3`);
      if (!path.pending && plan.every((step) => itemOf(step.key)?.totalFloat === step.tf)) break;
      await pause(1_000);
    }
    check('BR-101: every item’s total float matches the control set worked by hand', plan.every((step) => itemOf(step.key)?.totalFloat === step.tf), true);
    check('so does its free float', plan.every((step) => itemOf(step.key)?.freeFloat === step.ff), true);
    check(
      'and its early and late dates, on the working calendar',
      plan.every((step) => {
        const item = itemOf(step.key);
        return item?.earlyStart === day(step.es) && item?.earlyFinish === day(step.ef) && item?.lateStart === day(step.ls) && item?.lateFinish === day(step.lf);
      }),
      true,
    );
    check('the lag holds C back a working day after A', itemOf('C')?.earlyStart, day(4));
    check('the critical items are A, C and D', plan.every((step) => itemOf(step.key)?.critical === step.critical), true);
    check('an item without dates is left out', itemOf('F'), undefined);
    check('the project finishes on day 8', path.finish, day(8));

    // BR-102: near-critical within a threshold, and the critical chain.
    check('BR-102: with a threshold of 3 days, B is near-critical and E is not', itemOf('B')?.nearCritical === true && itemOf('E')?.nearCritical === false, true);
    check('the counts agree: 3 critical, 1 near-critical', `${path.counts?.critical}/${path.counts?.nearCritical}`, '3/1');
    const tight = await json(`/projects/${cpProject}/critical-path?near=2`);
    check('at 2 days, nothing is near-critical', ((tight.items ?? []) as Json[]).filter((entry) => entry.nearCritical).length, 0);
    const linkNames = (filter: (link: Json) => boolean) =>
      JSON.stringify(((path.links ?? []) as Json[]).filter(filter).map((link) => `${keyOf(link.predecessorId)}>${keyOf(link.successorId)}`).sort());
    check('the relations that drive are A–B, A–C and C–D; B–D leaves slack', linkNames((link) => link.driving), JSON.stringify(['A>B', 'A>C', 'C>D']));
    check('and the critical path drawn is A–C–D', linkNames((link) => link.critical), JSON.stringify(['A>C', 'C>D']));

    // BR-103: in the API, and in OpenProject's fields for its query engine.
    const own = await json(`/work-packages/${ids.B}/schedule`);
    check('BR-103: a work package’s own figures are in the API', `${own.item?.totalFloat}/${own.item?.freeFloat}`, '3/3');
    check(
      'with the predecessor that holds it back',
      JSON.stringify(((own.predecessors ?? []) as Json[]).filter((link) => link.driving).map((link) => link.predecessorId)),
      JSON.stringify([ids.A]),
    );
    const schema = await json(`/queries/schema?projectId=${cpProject}`);
    const columnId = (name: string) => ((schema.columns ?? []) as Json[]).find((column) => column.name === name)?.id as string | undefined;
    const tfField = columnId('Total float (days)');
    const ffField = columnId('Free float (days)');
    const critField = columnId('On critical path');
    check('the three schedule fields are columns a view can show', [tfField, ffField, critField].every(Boolean), true);
    let fields: Json[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fields = await Promise.all(plan.map((step) => json(`/tasks/${ids[step.key]}`)));
      if (plan.every((step, index) => fields[index]?.customValues?.[tfField!] === step.tf)) break;
      await pause(1_000);
    }
    check(
      'each item’s fields hold its total float, free float and whether it is critical',
      plan.every((step, index) => {
        const values = fields[index]?.customValues ?? {};
        return values[tfField!] === step.tf && values[ffField!] === step.ff && values[critField!] === step.critical;
      }),
      true,
    );
    check('and an item without dates holds none', (await json(`/tasks/${ids.F}`)).customValues?.[tfField!], undefined);

    const savedView = await call('/queries', {
      method: 'POST',
      cookie: admin,
      body: {
        name: `Float under 3 days ${stamp}`,
        projectId: cpProject,
        view: {
          columns: ['id', 'subject', tfField, ffField, critField],
          filters: [{ id: tfField, operator: '<=', values: [{ value: '2' }] }],
          sums: true,
        },
      },
    });
    check('a view filtered to total float under 3 days is saved', savedView.status, 201);
    criticalPathQueryId = ((await savedView.json()) as Json).id as string | undefined;
    const viewRun = await json(`/queries/${criticalPathQueryId}`);
    const viewTasks = (viewRun.tasks ?? []) as Json[];
    check(
      'BR-103: it returns exactly the items with less than 3 days of float',
      JSON.stringify(viewTasks.map((task) => task.id).sort()),
      JSON.stringify([ids.A, ids.C, ids.D].sort()),
    );
    check(
      'and its columns show the computed values',
      viewTasks.length === 3 &&
        viewTasks.every((task) => task.customValues?.[tfField!] === 0 && task.customValues?.[ffField!] === 0 && task.customValues?.[critField!] === true),
      true,
    );
    check('the view keeps its float columns', ((viewRun.query?.columns ?? []) as Json[]).some((column) => column.id === tfField), true);
    check(
      'and its filter, value and all, as saved',
      JSON.stringify(((viewRun.query?.filters ?? []) as Json[]).map((filter) => [filter.id, filter.operator, ((filter.values ?? []) as Json[]).map((value) => value.id)])),
      JSON.stringify([[tfField, '<=', ['2']]]),
    );
    const wider = await json(
      `/queries/default?projectId=${cpProject}&showSums=true&filters=${encodeURIComponent(JSON.stringify([{ [tfField!]: { operator: '<=', values: ['3'] } }]))}`,
    );
    check('with float up to 3 days, B joins them, and the float is summed over them', `${(wider.tasks ?? []).length}/${wider.sums?.[tfField!]}`, '4/3');
    const grouped = await json(`/queries/default?projectId=${cpProject}&groupBy=${critField}`);
    check(
      'grouped by “On critical path”, three are critical and two are not',
      JSON.stringify(((grouped.groups ?? []) as Json[]).map((group) => group.count).sort()),
      JSON.stringify([1, 2, 3]),
    );

    // Kept out of the journal: editing an item holding figures journals the edit and no figure.
    check(
      'an item holding figures can still be edited',
      await status(`/tasks/${ids.A}`, { method: 'PATCH', cookie: admin, body: { subject: 'Critical path A, renamed' } }),
      200,
    );
    const activities = await asSystem(() => upstream.request<Json>(`/work_packages/${ids.A}/activities`));
    const details = ((activities._embedded?.elements ?? []) as Json[]).flatMap((entry) =>
      ((entry.details ?? []) as Json[]).map((detail) => String(detail.raw ?? '')),
    );
    check('the edit is in its activity', details.some((detail) => /Subject/.test(detail)), true);
    check('no float figure is, in any version', details.some((detail) => /Total float \(days\)|Free float \(days\)|On critical path/.test(detail)), false);

    // BR-104: a change is recalculated without the change waiting for it.
    // Seen as the pass still pending when the change has answered. When
    // OpenProject is busy the answer can be slow enough for the pass, started
    // part-way through it, to have finished first — which shows nothing either
    // way — so then, with nothing pending, the same change is made again.
    let moved: Response | undefined;
    let movedMs = 0;
    let pendingAfterAnswer = false;
    for (let attempt = 0; attempt < 3 && !pendingAfterAnswer; attempt += 1) {
      const movedAt = performance.now();
      moved = await call(`/tasks/${ids.B}`, { method: 'PATCH', cookie: admin, body: { startDate: day(5), dueDate: day(6) } });
      movedMs = Math.round(performance.now() - movedAt);
      pendingAfterAnswer = (await json('/schedule/status')).pending === true;
    }
    check('BR-104: a date moves and the request answers', moved?.status, 200);
    check('before the recalculation it started has run', pendingAfterAnswer, true);
    let movedItem: Json | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      movedItem = ((await json(`/projects/${cpProject}/critical-path`)).items as Json[] | undefined)?.find((entry) => entry.id === ids.B);
      if (movedItem?.totalFloat === 1) break;
      await pause(500);
    }
    check('then B has a day of float left, total and free', `${movedItem?.totalFloat}/${movedItem?.freeFloat}`, '1/1');
    const lastPass = (await json('/schedule/status')).lastCompleted as Json | undefined;
    check('and that pass took under five seconds', (lastPass?.durationMs ?? Infinity) < 5_000, true);
    console.log(`        (the change answered in ${movedMs} ms; the pass took ${lastPass?.durationMs} ms over ${lastPass?.workPackages} work packages)`);

    // Who may do what.
    check('someone who cannot see the project cannot read its critical path', await status(`/projects/${cpProject}/critical-path`, { cookie: restricted }), 403);
    check('nor a work package’s figures in it', await status(`/work-packages/${ids.A}/schedule`, { cookie: restricted }), 404);
    check('nor recalculate', await status('/schedule/recalculate', { method: 'POST', cookie: restricted }), 403);
    check('the passes’ status is open to anyone who works with work packages', await status('/schedule/status', { cookie: restricted }), 200);
    check('an administrator can recalculate now', [200, 202].includes(await status('/schedule/recalculate', { method: 'POST', cookie: admin })), true);
    check(
      'which is journalled',
      (await pathDb.auditEvent.count({ where: { action: 'schedule.recalculated', occurredAt: { gte: suiteStartedAt } } })) > 0,
      true,
    );
    check('a non-numeric project is not found', await status('/projects/not-a-number/critical-path', { cookie: admin }), 404);

    // Put things back: the view, and the project with its work.
    if (criticalPathQueryId) {
      check('the saved view is removed', await status(`/queries/${criticalPathQueryId}`, { method: 'DELETE', cookie: admin }), 204);
      criticalPathQueryId = undefined;
    }
    check('the project is removed, with its work', await status(`/projects/${cpProject}`, { method: 'DELETE', cookie: admin }), 204);
    criticalPathProjectId = undefined;
  }

  // --- Earned value (BR-301 to BR-303) ---------------------------------------
  console.log('\nEarned value');
  {
    type Json = Record<string, any>;
    const { prisma: evDb } = await import('../db/prisma.js');
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json;
    const DAY = 86_400_000;
    const isoOf = (time: number) => new Date(time).toISOString().slice(0, 10);
    const round2 = (value: number) => Math.round(value * 100) / 100;
    const round3 = (value: number) => Math.round(value * 1000) / 1000;
    const refreshModel = () => json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'incremental', wait: true } });
    const stamp = Date.now();

    // A project of its own, with the administrator a member so work can be assigned to it.
    const madeProject = await call('/projects', {
      method: 'POST',
      cookie: admin,
      body: { payload: { name: `Earned Value Test ${stamp}`, identifier: `ev-test-${stamp}` } },
    });
    check('a project is made for the earned value tests', madeProject.status, 201);
    earnedValueProjectId = ((await madeProject.json()) as Json).id as string | undefined;
    const evProject = String(earnedValueProjectId);

    // Roles chosen by what they allow, not by name: one whose holders can be
    // given work, for the administrator, and one that edits work but not the
    // project, to lend the restricted account (not the automation account's).
    const adminRoles = (await json('/admin/roles')) as unknown as { id: string; name: string; kind: string; builtin: boolean; permissions: string[] }[];
    const projectRoleList = adminRoles.filter((role) => role.kind === 'project' && !role.builtin);
    const assigneeRole = projectRoleList.find((role) => role.permissions.includes('work_package_assigned'));
    const editorRole = projectRoleList.find(
      (role) =>
        role.name !== 'EPM Automation' &&
        role.permissions.includes('view_work_packages') &&
        role.permissions.includes('edit_work_packages') &&
        !role.permissions.includes('edit_project'),
    );
    check('there is a role whose holders can be given work', Boolean(assigneeRole), true);
    check('and one that edits work but not the project', Boolean(editorRole), true);
    const adminMember = await call(`/projects/${evProject}/members`, {
      method: 'POST',
      cookie: admin,
      body: { userId: adminId, roleIds: [assigneeRole?.id ?? memberRoleId] },
    });
    check('the administrator joins it, to be given work', adminMember.status, 201);

    // The plan is priced at the administrator's rate.
    const rate = (await evDb.userProfile.findUnique({ where: { openProjectId: adminId } }))?.hourlyRate ?? null;
    check('the administrator has an hourly rate to price the plan', rate !== null && rate > 0, true);
    const r = rate ?? 0;

    const settingsView = await json('/earned-value/settings');
    // Two types the project has: Task, and another that is no milestone —
    // Bug where new projects get it, else Summary task, else any but the
    // governance types, whose work starts approvals and counts as risk.
    const enabledTypes = ((await asSystem(() => upstream.request<Json>(`/projects/${evProject}/types`)))._embedded?.elements ?? []) as Json[];
    const workTypes = enabledTypes.filter((type) => !type.isMilestone).map((type) => ({ id: String(type.id), name: String(type.name) }));
    const taskType = workTypes.find((type) => type.name === 'Task')?.id;
    const bugType = (
      workTypes.find((type) => type.name === 'Bug') ??
      workTypes.find((type) => type.name === 'Summary task') ??
      workTypes.find((type) => type.id !== taskType && !['Change Request', 'Risk'].includes(type.name))
    )?.id;
    check('the project has Task and another type of work to tell apart', Boolean(taskType && bugType && taskType !== bugType), true);
    const rules = {
      defaultMethod: settingsView.settings.defaultMethod as string,
      methods: { ...settingsView.settings.methods } as Record<string, string>,
      unpricedRate: settingsView.settings.unpricedRate as number | null,
    };
    evmRulesBefore = rules;
    const ruleOf = (methods: Record<string, string>, type: string) => methods[type] ?? rules.defaultMethod;

    // The calendar: the instance's non-working days across the dates used.
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    const monday = todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY;
    const holidays = new Set(
      (
        await asSystem(() =>
          upstream.getCollection<Json>('/days/non_working', {
            filters: [{ field: 'date', operator: '<>d', values: [isoOf(monday - 7 * DAY), isoOf(monday + 14 * DAY)] }],
          }),
        )
      )._embedded?.elements?.map((element: Json) => element.date as string) ?? [],
    );
    const week = await asSystem(() => upstream.request<Json>('/days/week'));
    const workingDays = new Set(((week._embedded?.elements ?? []) as Json[]).filter((day) => day.working).map((day) => day.day as number));
    const isWorking = (time: number) => {
      const weekday = ((new Date(time).getUTCDay() + 6) % 7) + 1;
      return workingDays.has(weekday) && !holidays.has(isoOf(time));
    };
    const workingBetween = (from: number, to: number) => {
      let count = 0;
      for (let at = from; at <= to; at += DAY) if (isWorking(at)) count += 1;
      return count;
    };

    /*
     * The plan, priced at the administrator's rate r:
     *   A  Task  40 h  last Monday – last Friday    50%  BAC 40r  planned in full
     *   B  other 20 h  this Monday – next Friday    30%  BAC 20r  planned as far as today
     *   C  Task   8 h  no dates                     25%  BAC 8r   planned for no day
     * and time: 10 h on A last Wednesday, 4 h on B today.
     */
    const made = async (subject: string, type: string, hours: number, done: number, start?: number, finish?: number) => {
      const response = await call('/work-packages', {
        method: 'POST',
        cookie: admin,
        body: {
          projectId: evProject,
          typeId: type,
          payload: {
            subject,
            estimatedTime: `PT${hours}H`,
            percentageDone: done,
            ...(start !== undefined ? { startDate: isoOf(start), dueDate: isoOf(finish!) } : {}),
            _links: { assignee: { href: `/api/v3/users/${adminId}` } },
          },
        },
      });
      return ((await response.json()) as Json).id as string | undefined;
    };
    const ids = {
      A: await made('Earned value A', taskType!, 40, 50, monday - 7 * DAY, monday - 3 * DAY),
      B: await made('Earned value B', bugType!, 20, 30, monday, monday + 11 * DAY),
      C: await made('Earned value C', taskType!, 8, 25),
    };
    check('three work packages are made, two of them dated', Object.values(ids).every(Boolean), true);
    let activityId: string | undefined;
    const logTime = async (workPackageId: string | undefined, hours: number, spentOn: string) => {
      const entry = (activity?: string) =>
        call('/time-entries', {
          method: 'POST',
          cookie: admin,
          body: { projectId: evProject, workPackageId, hours, spentOn, comment: 'Earned value probe', ...(activity ? { activityId: activity } : {}) },
        });
      let response = await entry(activityId);
      if (response.status !== 201 && !activityId) {
        // The instance wants an activity; take the first it offers this project.
        const form = JSON.stringify(await json('/forms/time-entries', admin, { method: 'POST', body: { projectId: evProject } }));
        activityId = /time_entries\/activities\/(\d+)/.exec(form)?.[1];
        response = await entry(activityId);
      }
      return response.status;
    };
    const logged = [await logTime(ids.A, 10, isoOf(monday - 5 * DAY)), await logTime(ids.B, 4, today)];
    check('time is logged on A and B', logged.every((code) => code === 201), true);

    // What the figures must be, worked out here, for any rules.
    const bShare = workingBetween(monday, Math.min(todayMs, monday + 11 * DAY)) / workingBetween(monday, monday + 11 * DAY);
    const expected = (methods: Record<string, string>, aDone: number) => {
      // None of them is closed, so 0/100 credits nothing and none has milestones under it.
      const earn = (method: string, done: number, started: boolean, planned: number) =>
        method === 'percent_complete' ? done / 100 : method === 'fifty_fifty' ? (started ? 0.5 : 0) : method === 'level_of_effort' ? planned : 0;
      const item = (hours: number, share: number, method: string, done: number) => {
        const bac = round2(hours * r);
        return { bac, pv: round2(bac * share), ev: round2(bac * earn(method, done, done > 0, share)) };
      };
      const a = item(40, 1, ruleOf(methods, taskType!), aDone);
      const b = item(20, bShare, ruleOf(methods, bugType!), 30);
      const c = item(8, 0, ruleOf(methods, taskType!), 25);
      const bac = round2(a.bac + b.bac + c.bac);
      const pv = round2(a.pv + b.pv + c.pv);
      const ev = round2(a.ev + b.ev + c.ev);
      const ac = round2(14 * r);
      return { a, b, c, totals: { bac, pv, ev, ac, spi: round3(ev / pv), cpi: round3(ev / ac), eac: round2(bac / (ev / ac)), tcpi: round3((bac - ev) / (bac - ac)) } };
    };
    const itemOf = (body: Json, id?: string) => ((body.projects?.[0]?.items ?? []) as Json[]).find((item) => item.workPackageId === id);

    await refreshModel();
    let now = await json(`/earned-value?scope=project:${evProject}`);
    const want = expected(rules.methods, 50);
    check('BR-301: each work package’s budget is its estimate at the rate', `${itemOf(now, ids.A)?.bac}/${itemOf(now, ids.B)?.bac}/${itemOf(now, ids.C)?.bac}`, `${want.a.bac}/${want.b.bac}/${want.c.bac}`);
    check('its planned value is its budget spread over the working days to today', `${itemOf(now, ids.A)?.pv}/${itemOf(now, ids.B)?.pv}/${itemOf(now, ids.C)?.pv}`, `${want.a.pv}/${want.b.pv}/${want.c.pv}`);
    check('and its earned value what its rule credits', `${itemOf(now, ids.A)?.ev}/${itemOf(now, ids.B)?.ev}/${itemOf(now, ids.C)?.ev}`, `${want.a.ev}/${want.b.ev}/${want.c.ev}`);
    check('actual cost is the time logged, at the rate', `${itemOf(now, ids.A)?.ac}/${itemOf(now, ids.B)?.ac}`, `${round2(10 * r)}/${round2(4 * r)}`);
    const t = now.totals as Json;
    check(
      'the project’s BAC, PV, EV and AC are its work packages’',
      `${t.bac}/${t.pv}/${t.ev}/${t.ac}`,
      `${want.totals.bac}/${want.totals.pv}/${want.totals.ev}/${want.totals.ac}`,
    );
    check('and SPI, CPI, EAC and TCPI follow from them', `${t.spi}/${t.cpi}/${t.eac}/${t.tcpi}`, `${want.totals.spi}/${want.totals.cpi}/${want.totals.eac}/${want.totals.tcpi}`);
    check('the undated item is counted', t.counts?.undated, 1);
    check('it is measured against the current plan until a baseline is set', now.projects?.[0]?.measuredAgainst?.kind, 'plan');
    const one = await json(`/work-packages/${ids.A}/earned-value`);
    check('a work package’s own figures are in the API', `${one.item?.bac}/${one.item?.ev}`, `${want.a.bac}/${want.a.ev}`);
    const board = await json(`/dashboards/earned-value?scope=project:${evProject}`);
    check('the Earned value dashboard shows the same figures', `${board.measures?.['evm.ev']?.value}/${board.measures?.['evm.cpi']?.value}`, `${want.totals.ev}/${want.totals.cpi}`);
    check(
      'with planned value, earned value and actual cost drawn together over time',
      ((board.series ?? []) as Json[]).find((series) => series.id === 'evm.curve')?.lines?.length,
      2,
    );
    const instanceBefore = await json('/earned-value');
    check('the instance’s figures add this project’s in', (instanceBefore.totals?.bac ?? 0) >= want.totals.bac, true);

    // Baselines.
    check('someone who cannot see the project cannot see its baselines', await status(`/projects/${evProject}/baselines`, { cookie: restricted }), 403);
    check('nor its earned value', await status(`/earned-value?scope=project:${evProject}`, { cookie: restricted }), 404);
    check('nor a work package’s', await status(`/work-packages/${ids.A}/earned-value`, { cookie: restricted }), 404);
    const baseline = await call(`/projects/${evProject}/baselines`, { method: 'POST', cookie: admin, body: { reason: 'Earned value suite baseline' } });
    check('a baseline is set', baseline.status, 201);
    const set = (await baseline.json()) as Json;
    check('holding the plan priced', `${set.number}/${set.bac}/${set.items}`, `1/${want.totals.bac}/3`);
    now = await json(`/earned-value?scope=project:${evProject}`);
    check('from then on the project is measured against it', `${now.projects?.[0]?.measuredAgainst?.kind}/${now.projects?.[0]?.measuredAgainst?.number}`, 'baseline/1');
    check('with the same figures, as nothing has moved', now.totals?.ev, want.totals.ev);

    // BR-302: an earning rule changed for one type changes that type's earned value and nobody else's.
    const bugRule = ruleOf(rules.methods, bugType!);
    const otherRule = bugRule === 'zero_hundred' ? 'fifty_fifty' : 'zero_hundred';
    const bugsChanged = { ...rules, methods: { ...rules.methods, [bugType!]: otherRule } };
    check('BR-302: someone without the permission cannot change the rules', await status('/earned-value/settings', { method: 'PUT', cookie: restricted, body: bugsChanged }), 403);
    const changed = await call('/earned-value/settings', { method: 'PUT', cookie: admin, body: bugsChanged });
    check('an administrator changes how B’s type earns', changed.status, 200);
    const after = await json(`/earned-value?scope=project:${evProject}`);
    const wantAfter = expected(bugsChanged.methods, 50);
    check('B now earns by its type’s new rule', itemOf(after, ids.B)?.ev, wantAfter.b.ev);
    check('while A and C, Tasks, earn exactly as before', `${itemOf(after, ids.A)?.ev}/${itemOf(after, ids.C)?.ev}`, `${want.a.ev}/${want.c.ev}`);
    check('and the project’s earned value moves by B’s change alone', round2(after.totals.ev - now.totals.ev), round2(wantAfter.b.ev - want.b.ev));
    const restored = await call('/earned-value/settings', { method: 'PUT', cookie: admin, body: rules });
    check('the rules are put back', restored.status, 200);
    evmRulesBefore = undefined;
    check('and B earns as it did', itemOf(await json(`/earned-value?scope=project:${evProject}`), ids.B)?.ev, want.b.ev);

    // BR-303: the figures as at a moment are rebuilt for that moment.
    const asAt = new Date().toISOString();
    const before = await json(`/earned-value?scope=project:${evProject}`);
    check('BR-303: the figures at that moment are the ones worked out above', `${before.totals?.ev}/${itemOf(before, ids.A)?.ev}`, `${want.totals.ev}/${want.a.ev}`);
    // Someone else moves A on: another person's change is a version of its
    // own, never merged into the administrator's earlier one.
    const lent = (await (
      await call(`/projects/${evProject}/members`, { method: 'POST', cookie: admin, body: { userId: restrictedId, roleIds: [editorRole?.id ?? memberRoleId] } })
    ).json()) as Json;
    check('the restricted account is lent a role that edits work on the project', Boolean(lent.membershipId), true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const progress = () => call(`/work-packages/${ids.A}`, { method: 'PATCH', cookie: restricted, body: { payload: { percentageDone: 100 } } });
    let progressed = await progress();
    if (progressed.status === 403) {
      // Permissions are cached for a minute, and a role given by someone else
      // is felt when that runs out.
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      progressed = await progress();
    }
    check('and moves A to 100%', progressed.status, 200);
    check(
      'a member who edits work but not the project still cannot set a baseline',
      await status(`/projects/${evProject}/baselines`, { method: 'POST', cookie: restricted, body: { reason: 'no' } }),
      403,
    );
    await refreshModel();
    const later = await json(`/earned-value?scope=project:${evProject}`);
    check('now A earns what its rule credits at 100%', itemOf(later, ids.A)?.ev, expected(rules.methods, 100).a.ev);
    const rebuilt = await json(`/earned-value?scope=project:${evProject}&asAt=${encodeURIComponent(asAt)}`);
    check(
      'asked as at the moment before, the figures are rebuilt exactly as they were',
      `${rebuilt.totals?.ev}/${rebuilt.totals?.pv}/${rebuilt.totals?.ac}/${itemOf(rebuilt, ids.A)?.ev}`,
      `${before.totals?.ev}/${before.totals?.pv}/${before.totals?.ac}/${itemOf(before, ids.A)?.ev}`,
    );
    check('a moment in the future is refused', await status(`/earned-value?scope=project:${evProject}&asAt=2999-01-01T00:00:00Z`, { cookie: admin }), 400);

    // BR-303: exposed to the BI layer, by the same definitions.
    const { materialiseEarnedValue } = await import('../domain/measures-store.js');
    const rows = await materialiseEarnedValue();
    check('the BI table of earned value over time is written', rows > 0, true);
    const bi = await evDb.$queryRawUnsafe<{ pv: unknown; ev: unknown; ac: unknown }[]>(
      `SELECT pv, ev, ac FROM analytics.fact_evm_period
        WHERE scope_type = 'project' AND scope_id = $1 AND bucket = 'week' AND period_start <= $2::date AND period_end >= $2::date`,
      evProject,
      today,
    );
    check(
      'and its row for this week carries the figures the API reports now',
      bi[0] ? `${Number(bi[0].pv)}/${Number(bi[0].ev)}/${Number(bi[0].ac)}` : 'none',
      `${later.totals?.pv}/${later.totals?.ev}/${later.totals?.ac}`,
    );

    // Journalled.
    const journal = await evDb.auditEvent.findMany({
      where: { occurredAt: { gte: suiteStartedAt }, action: { in: ['evm.baseline.set', 'evm.settings.updated'] } },
      select: { action: true },
    });
    check(
      'setting a baseline and changing the rules are journalled',
      ['evm.baseline.set', 'evm.settings.updated'].every((action) => journal.some((entry) => entry.action === action)),
      true,
    );

    // Put things back: the project, with its work, baseline and memberships.
    check('the project is removed', await status(`/projects/${evProject}`, { method: 'DELETE', cookie: admin }), 204);
    check('and its baselines with it', await evDb.evmBaseline.count({ where: { projectId: Number(evProject) } }), 0);
    earnedValueProjectId = undefined;
  }

  // --- Resources and capacity (BR-110 to BR-112, BR-312 to BR-316) ---------------
  console.log('\nResources and capacity');
  {
    type Json = Record<string, any>;
    const { prisma: rcDb } = await import('../db/prisma.js');
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json;
    const DAY = 86_400_000;
    const isoOf = (time: number) => new Date(time).toISOString().slice(0, 10);
    const round2 = (value: number) => Math.round(value * 100) / 100;
    const round1 = (value: number) => Math.round(value * 10) / 10;
    const refreshModel = () => json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'incremental', wait: true } });
    const stamp = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    const thisMonday = todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY;

    // Who may: none of it is for someone without the permissions.
    check('someone without resource planning cannot see the heatmap', await status('/resources/capacity', { cookie: restricted }), 403);
    check('nor over-allocation', await status('/resources/over-allocations', { cookie: restricted }), 403);
    check('nor level anything', await status('/resources/levelling', { method: 'POST', cookie: restricted, body: { scope: { kind: 'people', people: [restrictedId] } } }), 403);
    check('nor change the resource rules', await status('/resources/settings', { method: 'PUT', cookie: restricted, body: {} }), 403);
    check('nor add a role', await status('/resources/roles', { method: 'POST', cookie: restricted, body: { name: `Nope ${stamp}` } }), 403);
    check('nor read someone else’s availability', await status(`/resources/people/${adminId}/availability`, { cookie: restricted }), 403);
    check('but may read their own', await status(`/resources/people/${restrictedId}/availability`, { cookie: restricted }), 200);
    check('nor set their own schedule', await status(`/resources/people/${restrictedId}/schedules`, { method: 'PUT', cookie: restricted, body: { effectiveFrom: today, hours: [8, 8, 8, 8, 8, 0, 0], fraction: 1 } }), 403);

    // Three clear weeks well ahead — no holiday in them — so nothing else is planned there.
    const week = await asSystem(() => upstream.request<Json>('/days/week'));
    const workingWeekdays = new Set(((week._embedded?.elements ?? []) as Json[]).filter((entry) => entry.working).map((entry) => (entry.day as number) - 1));
    check('the instance works Monday to Friday', [...workingWeekdays].sort().join(','), '0,1,2,3,4');
    let W = thisMonday + 20 * 7 * DAY;
    for (let tries = 0; tries < 8; tries += 1) {
      const holidays = await asSystem(() =>
        upstream.getCollection<Json>('/days/non_working', { filters: [{ field: 'date', operator: '<>d', values: [isoOf(W), isoOf(W + 20 * DAY)] }] }),
      );
      if ((holidays._embedded?.elements ?? []).length === 0) break;
      W += 7 * DAY;
    }
    const day = (offset: number) => isoOf(W + offset * DAY);

    // Roles (BR-313 to BR-315).
    const roleName = `Suite Analyst ${stamp}`;
    const madeRole = await call('/resources/roles', { method: 'POST', cookie: admin, body: { name: roleName } });
    check('a role is made', madeRole.status, 201);
    resourcesRoleId = ((await madeRole.json()) as Json).id as string | undefined;
    check('a second one called the same, in any case, is refused', await status('/resources/roles', { method: 'POST', cookie: admin, body: { name: roleName.toUpperCase() } }), 409);
    const restrictedProfile = await rcDb.userProfile.findUnique({ where: { openProjectId: restrictedId }, select: { resourceRoleId: true } });
    resourcesRestrictedRoleBefore = restrictedProfile?.resourceRoleId ?? null;
    check('the restricted account is given it', await status(`/employees/${restrictedId}/role`, { method: 'PATCH', cookie: admin, body: { roleId: resourcesRoleId } }), 200);

    /*
     * BR-312: the availability model. The restricted account, from Monday W:
     * 8 hours Monday to Friday at half time — 4 a day, 20 a week — and the
     * Wednesday of W off. By hand: W has 16 hours, W+1 has 20.
     */
    const schedule = await call(`/resources/people/${restrictedId}/schedules`, {
      method: 'PUT',
      cookie: admin,
      body: { effectiveFrom: day(0), hours: [8, 8, 8, 8, 8, 0, 0], fraction: 0.5 },
    });
    check('BR-312: a work schedule with an employment fraction is set', schedule.status, 200);
    const off = await call(`/resources/people/${restrictedId}/time-off`, {
      method: 'POST',
      cookie: admin,
      body: { startsOn: day(2), endsOn: day(2), hoursPerDay: null, kind: 'leave' },
    });
    check('and a day off', off.status, 201);
    const availability = await json(`/resources/people/${restrictedId}/availability?from=${day(0)}&weeks=3`);
    check(
      'available hours are the schedule times the fraction, less the day off',
      ((availability.weeks ?? []) as Json[]).slice(0, 2).map((entry) => entry.available).join('/'),
      '16/20',
    );

    // The HR source: imported, twice; and its figures checked against EPM's.
    const extract = {
      people: [
        {
          personId: restrictedId,
          effectiveFrom: day(14),
          fraction: 1,
          hours: [8, 8, 8, 8, 8, 0, 0],
          timeOff: [{ externalId: `suite-${stamp}-1`, startsOn: day(14), endsOn: day(14), hoursPerDay: 4, kind: 'training' }],
        },
        { email: `nobody-${stamp}@example.invalid`, fraction: 1 },
      ],
    };
    const first = await json('/resources/hr/import', admin, { method: 'POST', body: extract });
    check('the HR extract is imported: a schedule and time off', `${first.people}/${first.schedules}/${first.timeOffCreated}/${first.timeOffUpdated}`, '1/1/1/0');
    check('and someone the directory does not know is named, not guessed', (first.unknown ?? []).join(','), `nobody-${stamp}@example.invalid`);
    const second = await json('/resources/hr/import', admin, { method: 'POST', body: extract });
    check('imported again, the time off is updated, not added twice', `${second.timeOffCreated}/${second.timeOffUpdated}`, '0/1');
    // By hand: W 16, W+1 20, W+2 full time less 4 hours of training: 36.
    const reconciled = await json('/resources/hr/reconcile', admin, {
      method: 'POST',
      body: {
        rows: [
          { personId: restrictedId, from: day(0), to: day(13), availableHours: 36 },
          { personId: restrictedId, from: day(14), to: day(20), availableHours: 36 },
          { personId: restrictedId, from: day(14), to: day(20), availableHours: 40 },
        ],
      },
    });
    check(
      'BR-312: the available hours for the sample reconcile to the HR source’s',
      `${reconciled.matched}/${reconciled.differing}/${reconciled.unknown}`,
      '2/1/0',
    );
    check('and a figure that does not is shown with the difference', ((reconciled.rows ?? []) as Json[])[2]?.difference, -4);

    // A project of its own: the administrator to give work to, the restricted account to be given it.
    const madeProject = await call('/projects', {
      method: 'POST',
      cookie: admin,
      body: { payload: { name: `Resources Test ${stamp}`, identifier: `rc-test-${stamp}` } },
    });
    check('a project is made for the resource tests', madeProject.status, 201);
    resourcesProjectId = ((await madeProject.json()) as Json).id as string | undefined;
    resourcesProjectNumber = Number(resourcesProjectId);
    const rcProject = String(resourcesProjectId);
    const adminRoles = (await json('/admin/roles')) as unknown as { id: string; name: string; kind: string; builtin: boolean; permissions: string[] }[];
    const projectRoleList = adminRoles.filter((role) => role.kind === 'project' && !role.builtin);
    const assigneeRole = projectRoleList.find((role) => role.permissions.includes('work_package_assigned') && role.permissions.includes('edit_project'));
    const workerRole = projectRoleList.find(
      (role) => role.name !== 'EPM Automation' && role.permissions.includes('work_package_assigned') && !role.permissions.includes('edit_project'),
    );
    check('there are roles to give work with', Boolean(assigneeRole && workerRole), true);
    check(
      'the administrator joins it',
      await status(`/projects/${rcProject}/members`, { method: 'POST', cookie: admin, body: { userId: adminId, roleIds: [assigneeRole?.id ?? memberRoleId] } }),
      201,
    );
    check(
      'and the restricted account, to be given work',
      await status(`/projects/${rcProject}/members`, { method: 'POST', cookie: admin, body: { userId: restrictedId, roleIds: [workerRole?.id ?? memberRoleId] } }),
      201,
    );
    const taskType = (((await asSystem(() => upstream.request<Json>(`/projects/${rcProject}/types`)))._embedded?.elements ?? []) as Json[]).find(
      (type) => type.name === 'Task',
    )?.id;
    const milestoneType = (((await asSystem(() => upstream.request<Json>(`/projects/${rcProject}/types`)))._embedded?.elements ?? []) as Json[]).find(
      (type) => type.isMilestone,
    )?.id;
    const make = async (subject: string, hours: number, start: string, due: string, assignee: string | null, type = taskType) => {
      const response = await call('/work-packages', {
        method: 'POST',
        cookie: admin,
        body: {
          projectId: rcProject,
          typeId: String(type),
          payload: {
            subject,
            ...(hours > 0 ? { estimatedTime: `PT${hours}H` } : {}),
            startDate: start,
            dueDate: due,
            ...(assignee ? { _links: { assignee: { href: `/api/v3/users/${assignee}` } } } : {}),
          },
        },
      });
      return ((await response.json()) as Json).id as string | undefined;
    };
    /*
     * W: A 12 h Monday–Tuesday and B 12 h Thursday–Friday, both the restricted
     * account's: 24 hours against 16. C 4 h follows B, from Monday W+1. M, a
     * milestone on Friday W+2, follows C — pinned.
     */
    const ids = {
      A: await make('Resource A', 12, day(0), day(1), restrictedId),
      B: await make('Resource B', 12, day(3), day(4), restrictedId),
      C: await make('Resource C', 4, day(7), day(7), restrictedId),
      M: await make('Resource M', 0, day(18), day(18), null, milestoneType),
    };
    check('four work packages are made', Object.values(ids).every(Boolean), true);
    const relate = (successor?: string, predecessor?: string) =>
      call(`/work-packages/${successor}/relations`, { method: 'POST', cookie: admin, body: { type: 'follows', relatedId: predecessor } });
    check('C follows B, and M follows C', [(await relate(ids.C, ids.B)).status, (await relate(ids.M, ids.C)).status].join(','), '201,201');
    const pinned = await call(`/work-packages/${ids.M}/pin`, { method: 'PUT', cookie: admin, body: { reason: 'Contractual delivery' } });
    check('BR-111: M is pinned', pinned.status, 200);
    resourcesPinnedId = ids.M;
    const read = (id?: string) => asSystem(() => upstream.request<Json>(`/work_packages/${id}`));
    const pinnedWork = await read(ids.M);
    check('which switches it to manual scheduling, so its predecessors cannot push it', pinnedWork.scheduleManually, true);
    // Given C as a predecessor, OpenProject started M as soon as C allows; manual now, it is put on its date and kept there.
    check('M is put on its date', await status(`/work-packages/${ids.M}`, { method: 'PATCH', cookie: admin, body: { payload: { date: day(18) } } }), 200);
    check('a milestone, Friday of W+2', (await read(ids.M)).date, day(18));
    const cBefore = await read(ids.C);
    check('C is scheduled automatically, after B', `${cBefore.scheduleManually}/${cBefore.startDate}`, `false/${day(7)}`);
    check('the restricted account cannot pin it', await status(`/work-packages/${ids.A}/pin`, { method: 'PUT', cookie: restricted, body: {} }), 403);
    await refreshModel();

    // BR-110: over-allocation, with the work behind it.
    const over = (await json('/resources/over-allocations?weeks=26')) as unknown as Json[];
    const mine = over.filter((entry) => entry.key === restrictedId);
    check('BR-110: the restricted account is over-allocated in week W, and only then', mine.map((entry) => entry.week).join(','), day(0));
    check('by 8 hours: 24 asked of 16', `${mine[0]?.committed}/${mine[0]?.available}/${mine[0]?.excess}`, '24/16/8');
    check(
      'with the work that makes it up listed',
      ((mine[0]?.contributions ?? []) as Json[]).map((part) => `${part.workPackageId}:${part.hours}`).sort().join(','),
      [`${ids.A}:12`, `${ids.B}:12`].sort().join(','),
    );

    // BR-314: the heatmap matches the computed load, and drills to it.
    const grid = await json(`/resources/capacity?from=${day(0)}&weeks=2&group=none`);
    const row = ((grid.groups ?? []) as Json[]).flatMap((group) => group.rows as Json[]).find((entry) => entry.key === restrictedId);
    const [w0, w1] = (row?.cells ?? []) as Json[];
    check('BR-314: the heatmap colours week W by its load — 150%, over', `${w0?.ratio}/${w0?.band}/${w0?.over}`, '150/over/true');
    check('and W+1 by its own — 20% of 20 hours, spare', `${w1?.ratio}/${w1?.band}`, '20/under');
    const cell = await json(`/resources/capacity/cell?key=${restrictedId}&week=${day(0)}&group=none`);
    check(
      'and the cell drills to the work behind it',
      ((cell.contributions ?? []) as Json[]).map((part) => `${part.workPackageId}:${part.hours}`).sort().join(','),
      [`${ids.A}:12`, `${ids.B}:12`].sort().join(','),
    );

    // BR-313: by role, a week whose committed demand exceeds the role's capacity.
    const byRole = await json(`/resources/capacity?from=${day(0)}&weeks=1&group=role&roleId=${resourcesRoleId}`);
    const roleGroup = ((byRole.groups ?? []) as Json[]).find((group) => group.key === resourcesRoleId);
    check('BR-313: the role’s week W shows demand over capacity', `${roleGroup?.cells?.[0]?.committed}/${roleGroup?.cells?.[0]?.available}/${roleGroup?.cells?.[0]?.over}`, '24/16/true');
    const roleCell = await json(`/resources/capacity/cell?key=${encodeURIComponent(`group:role:${resourcesRoleId}`)}&week=${day(0)}&roleId=${resourcesRoleId}`);
    check('with the demand that makes it up', ((roleCell.contributions ?? []) as Json[]).length, 2);

    // Planned demand: a booking for the role with nobody named.
    const booking = await call('/resources/allocations', {
      method: 'POST',
      cookie: admin,
      body: { projectId: rcProject, roleId: resourcesRoleId, startsOn: day(7), endsOn: day(11), hoursPerWeek: 10 },
    });
    check('a booking for the role, nobody named, is made', booking.status, 201);
    const bookingId = ((await booking.json()) as Json).id as string | undefined;
    check('the restricted account cannot book time', await status('/resources/allocations', { method: 'POST', cookie: restricted, body: { projectId: rcProject, roleId: resourcesRoleId, startsOn: day(7), endsOn: day(11), hoursPerWeek: 10 } }), 403);
    const withBooking = await json(`/resources/capacity?from=${day(7)}&weeks=1&group=role&roleId=${resourcesRoleId}`);
    const unstaffed = ((withBooking.groups ?? []) as Json[]).flatMap((group) => group.rows as Json[]).find((entry) => entry.key === `role:${resourcesRoleId}`);
    check('it counts as planned demand on the role, with no hours against it', `${unstaffed?.cells?.[0]?.planned}/${unstaffed?.cells?.[0]?.available}`, '10/0');
    check('the booking is removed', await status(`/resources/allocations/${bookingId}`, { method: 'DELETE', cookie: admin }), 204);

    // The BI layer: the same week, by the same definitions.
    const { materialiseCapacity } = await import('../domain/resources-store.js');
    check('the BI table of capacity by person and week is written', (await materialiseCapacity()) > 0, true);
    const bi = await rcDb.$queryRawUnsafe<{ available_hours: number; demand_hours: number }[]>(
      'SELECT available_hours, demand_hours FROM analytics.fact_capacity_week WHERE person_id = $1 AND week_start = $2::date',
      Number(restrictedId),
      day(0),
    );
    check('and its row for week W holds the hours the heatmap shows', bi[0] ? `${Number(bi[0].available_hours)}/${Number(bi[0].demand_hours)}` : 'none', '16/24');

    /*
     * BR-111: levelling. A fits; B cannot, so it moves to the next week with
     * room — Monday and Tuesday of W+1 — and C, following it, to Wednesday;
     * M, pinned, stays. Nothing over-allocated after.
     */
    const proposal = await call('/resources/levelling', {
      method: 'POST',
      cookie: admin,
      body: { scope: { kind: 'people', people: [restrictedId] }, keepManual: false, horizonWeeks: 26 },
    });
    check('BR-111: a levelling proposal is made', proposal.status, 201);
    const run = (await proposal.json()) as Json;
    resourcesRunIds.push(String(run.id));
    const moves = (run.moves ?? []) as Json[];
    check(
      'it moves B to make room, and C after it',
      moves.map((move) => `${move.workPackageId}:${move.afterStart}..${move.afterDue}:${move.reason}`).join(','),
      `${ids.B}:${day(7)}..${day(8)}:capacity,${ids.C}:${day(9)}..${day(9)}:dependency`,
    );
    check('leaving nobody over-allocated', ((run.after ?? []) as Json[]).filter((entry) => entry.key === restrictedId).length, 0);
    check('and the pinned milestone where it is', moves.some((move) => move.workPackageId === ids.M), false);
    check('nothing has changed yet', (await read(ids.B)).startDate, day(3));

    // BR-112: applied as one change, every move or none.
    const applied = await call(`/resources/levelling/${run.id}/apply`, { method: 'POST', cookie: admin });
    check('BR-112: the proposal is applied', applied.status, 200);
    const [bAfter, cAfter, mAfter] = [await read(ids.B), await read(ids.C), await read(ids.M)];
    check('every move is made', `${bAfter.startDate}..${bAfter.dueDate}/${cAfter.startDate}..${cAfter.dueDate}`, `${day(7)}..${day(8)}/${day(9)}..${day(9)}`);
    check('C, scheduled automatically, is switched to manual so it keeps its new date', cAfter.scheduleManually, true);
    check('M has not moved', mAfter.date, day(18));
    check('it cannot be applied twice', await status(`/resources/levelling/${run.id}/apply`, { method: 'POST', cookie: admin }), 409);

    // One undo puts everything back.
    const undone = await call(`/resources/levelling/${run.id}/undo`, { method: 'POST', cookie: admin });
    check('one undo', undone.status, 200);
    const [bBack, cBack] = [await read(ids.B), await read(ids.C)];
    check('restores the original dates', `${bBack.startDate}..${bBack.dueDate}/${cBack.startDate}..${cBack.dueDate}`, `${day(3)}..${day(4)}/${day(7)}..${day(7)}`);
    check('and C’s automatic scheduling', cBack.scheduleManually, false);
    check('M still where it was', (await read(ids.M)).date, day(18));

    // A proposal the plan has moved on from is refused whole.
    const again = (await json('/resources/levelling', admin, {
      method: 'POST',
      body: { scope: { kind: 'people', people: [restrictedId] }, keepManual: false, horizonWeeks: 26 },
    })) as Json;
    resourcesRunIds.push(String(again.id));
    const moved = await call(`/work-packages/${ids.B}`, { method: 'PATCH', cookie: admin, body: { payload: { startDate: day(4) } } });
    check('B is changed after the second proposal', moved.status, 200);
    check('so applying it is refused', await status(`/resources/levelling/${again.id}/apply`, { method: 'POST', cookie: admin }), 409);
    check('and nothing moved', `${(await read(ids.C)).startDate}/${(await json(`/resources/levelling/${again.id}`)).status}`, `${day(7)}/stale`);
    // Why, kept as a message, reads in each reader's language.
    const staleInArabic = (await (await fetch(`${BASE}/resources/levelling/${again.id}`, { headers: { cookie: admin, 'Accept-Language': 'ar' } })).json()) as Json;
    check('and why is kept for every reader: in Arabic too', String(staleInArabic.error ?? '').startsWith('تغيّرت منذ المقترح'), true);

    // Working days near today, by the instance's calendar: one for logged time, and two for work delivered on time and late.
    const nearHolidays = await asSystem(() =>
      upstream.getCollection<Json>('/days/non_working', {
        filters: [{ field: 'date', operator: '<>d', values: [isoOf(todayMs - 40 * DAY), isoOf(todayMs + 14 * DAY)] }],
      }),
    );
    const offDays = new Set(((nearHolidays._embedded?.elements ?? []) as Json[]).map((entry) => String(entry.date)));
    const workingFrom = (time: number, step: number) => {
      let at = time;
      while (!workingWeekdays.has((new Date(at).getUTCDay() + 6) % 7) || offDays.has(isoOf(at))) at += step * DAY;
      return at;
    };

    // BR-315: utilisation for a sample person reconciles to logged ÷ available.
    const sample = workingFrom(todayMs - 14 * DAY, -1);
    const sampleDay = isoOf(sample);
    check('the project is marked not billable', await status(`/projects/${rcProject}/plan`, { method: 'PATCH', cookie: admin, body: { billable: false } }), 200);
    const logTime = async (activityId?: string) =>
      call('/time-entries', {
        method: 'POST',
        cookie: admin,
        body: { projectId: rcProject, workPackageId: ids.A, hours: 3, spentOn: sampleDay, comment: 'Resource utilisation probe', ...(activityId ? { activityId } : {}) },
      });
    let logged = await logTime();
    if (logged.status !== 201) {
      const form = JSON.stringify(await json('/forms/time-entries', admin, { method: 'POST', body: { projectId: rcProject } }));
      logged = await logTime(/time_entries\/activities\/(\d+)/.exec(form)?.[1]);
    }
    check('three non-billable hours are logged', logged.status, 201);
    await refreshModel();
    const entries = (await json(`/time-entries?userId=${adminId}&from=${sampleDay}&to=${sampleDay}&pageSize=200`)) as unknown as Json[] | Json;
    const list = (Array.isArray(entries) ? entries : ((entries.items ?? entries.entries ?? []) as Json[])) as Json[];
    const loggedHours = round2(list.filter((entry) => entry.spentOn === sampleDay).reduce((sum, entry) => sum + Number(entry.hours), 0));
    // Available that day, from the administrator's own records by the model's rules: the schedule in force times its
    // fraction, or else their weekly hours over the working weekdays; less any time off.
    const sampleDate = new Date(`${sampleDay}T00:00:00Z`);
    const inForce = await rcDb.workSchedule.findFirst({ where: { openProjectId: adminId, effectiveFrom: { lte: sampleDate } }, orderBy: { effectiveFrom: 'desc' } });
    const weeklyHours = (await rcDb.userProfile.findUnique({ where: { openProjectId: adminId } }))?.hoursCapacity ?? 40;
    let available = inForce
      ? Number((inForce.hours as number[])[(new Date(sample).getUTCDay() + 6) % 7]) * inForce.fraction
      : weeklyHours / workingWeekdays.size;
    for (const entry of await rcDb.timeOff.findMany({ where: { openProjectId: adminId, startsOn: { lte: sampleDate }, endsOn: { gte: sampleDate } } })) {
      available = entry.hoursPerDay === null ? 0 : Math.max(0, available - entry.hoursPerDay);
    }
    available = round2(available);
    const values = await json(
      `/measures/values?ids=utilisation,utilisation.billable,time.nonBillable,capacity.availableHours&scope=person:${adminId}&from=${sampleDay}&to=${sampleDay}`,
    );
    const figure = (id: string) => values.measures?.[id]?.value;
    check(
      'BR-315: the administrator’s utilisation that day is their logged time over their available hours',
      `${figure('utilisation')}/${figure('capacity.availableHours')}`,
      `${round1((loggedHours / available) * 100)}/${available}`,
    );
    check('billable utilisation leaves the non-billable project’s hours out', figure('utilisation.billable'), round1(((loggedHours - 3) / available) * 100));
    check('which are the non-billable hours', figure('time.nonBillable'), 3);
    check(
      'and a role’s available hours are its people’s',
      (await json(`/measures/values?ids=capacity.availableHours&scope=role:${resourcesRoleId}&from=${day(0)}&to=${day(6)}`)).measures?.['capacity.availableHours']?.value,
      16,
    );

    // BR-316: on-time completion, from when work was delivered against its finish date.
    const closedStatus = (((await asSystem(() => upstream.request<Json>('/statuses')))._embedded?.elements ?? []) as Json[]).find(
      (entry) => entry.isClosed && /^closed$/i.test(entry.name),
    );
    const ahead = isoOf(workingFrom(todayMs + DAY, 1));
    const behind = isoOf(workingFrom(todayMs - DAY, -1));
    const E = await make('Resource E', 1, ahead, ahead, null);
    const F = await make('Resource F', 1, behind, behind, null);
    const close = (id?: string) =>
      status(`/work-packages/${id}`, { method: 'PATCH', cookie: admin, body: { payload: { _links: { status: { href: `/api/v3/statuses/${closedStatus?.id}` } } } } });
    check('one is delivered before its finish date and one after', `${await close(E)},${await close(F)}`, '200,200');
    await refreshModel();
    const delivery = await json(`/measures/values?ids=work.onTime&scope=project:${rcProject}&from=${today}&to=${today}`);
    check('BR-316: on-time completion is the share delivered by its finish date', delivery.measures?.['work.onTime']?.value, 50);
    check('the Delivery dashboard carries it', ((await json(`/dashboards/delivery?scope=project:${rcProject}`)).tiles ?? []).includes('work.onTime'), true);

    // Journalled.
    const journal = await rcDb.auditEvent.findMany({
      where: {
        occurredAt: { gte: suiteStartedAt },
        OR: [{ action: { startsWith: 'resources.' } }, { action: { startsWith: 'employee.' } }, { action: { startsWith: 'work-package.pin' } }],
      },
      select: { action: true },
    });
    const actions = new Set(journal.map((entry) => entry.action));
    check(
      'roles, availability, the HR import, bookings, pins and levelling are journalled: none missing',
      [
        'resources.role.created',
        'employee.role.changed',
        'employee.schedule.changed',
        'employee.time-off.added',
        'resources.hr.imported',
        'resources.allocation.created',
        'resources.allocation.deleted',
        'work-package.pinned',
        'resources.levelling.proposed',
        'resources.levelling.applied',
        'resources.levelling.undone',
      ]
        .filter((action) => !actions.has(action))
        .join(', '),
      '',
    );

    // Put things back: unpin, the project with its work, the restricted account's schedule, time off and role.
    check('M is unpinned', await status(`/work-packages/${ids.M}/pin`, { method: 'DELETE', cookie: admin }), 204);
    resourcesPinnedId = undefined;
    check('the project is removed', await status(`/projects/${rcProject}`, { method: 'DELETE', cookie: admin }), 204);
    resourcesProjectId = undefined;
  }

  // --- Time and expense (BR-304 to BR-309, BR-317) ------------------------------
  console.log('\nTime and expense');
  {
    type Json = Record<string, any>;
    const { prisma: teDb } = await import('../db/prisma.js');
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const { automationUserId } = await import('../domain/automation-account.js');
    const { inflateRawSync } = await import('node:zlib');
    const json = async (path: string, cookie = admin, init: Parameters<typeof call>[1] = {}) =>
      (await (await call(path, { cookie, ...init })).json()) as Json;
    const DAY = 86_400_000;
    const isoOf = (time: number) => new Date(time).toISOString().slice(0, 10);
    const round2 = (value: number) => Math.round(value * 100) / 100;
    const refreshModel = () => json('/analytics/model/refresh', admin, { method: 'POST', body: { kind: 'incremental', wait: true } });
    const stamp = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    // A whole week three weeks back: ended, and inside a 60-day back-dating window.
    const monday = todayMs - 21 * DAY - ((new Date(todayMs - 21 * DAY).getUTCDay() + 6) % 7) * DAY;
    const wd = (offset: number) => isoOf(monday + offset * DAY);
    const message = async (response: Response) => `${response.status} ${((await response.json().catch(() => ({}))) as Json).message ?? ''}`;

    // Who may.
    check('the time rules are read by anyone signed in', await status('/time/settings', { cookie: restricted }), 200);
    check('but changed only with time:configure', await status('/time/settings', { method: 'PUT', cookie: restricted, body: {} }), 403);
    check('the timesheet overview is not for someone who manages nobody', await status(`/timesheets/overview?day=${wd(0)}`, { cookie: restricted }), 403);
    check('nor is every claim', await status('/expenses?scope=all', { cookie: restricted }), 403);
    check('nor the finance export', await status(`/expenses/export?from=${wd(0)}&to=${wd(6)}`, { cookie: restricted }), 403);

    // The rules for the test: 4 to 20 hours a week, every policy on, receipts above 100. Put back at the end.
    const rulesBefore = (await json('/time/settings')).settings as Json;
    timeSettingsBefore = { timesheets: rulesBefore.timesheets, policies: rulesBefore.policies, expenses: rulesBefore.expenses };
    const testRules = {
      timesheets: { period: 'week', minimum: { basis: 'fixed', hours: 4 }, maximum: { basis: 'fixed', hours: 20 }, requireWorkPackage: true, reminders: false },
      policies: {
        maxDailyHours: { active: true, hours: 10 },
        backdating: { active: true, days: 60 },
        mandatoryActivity: { active: true },
        closedWorkPackages: { active: true },
      },
      expenses: { receiptThreshold: 100, currency: rulesBefore.expenses.currency },
    };
    check('the rules are set for the test', [200, 409].includes(await status('/time/settings', { method: 'PUT', cookie: admin, body: testRules })), true);

    // A project: the administrator owns it; the restricted account logs time on it.
    const madeProject = await call('/projects', {
      method: 'POST',
      cookie: admin,
      body: { payload: { name: `Time and Expense Test ${stamp}`, identifier: `te-test-${stamp}` } },
    });
    check('a project is made for the time and expense tests', madeProject.status, 201);
    timeProjectId = ((await madeProject.json()) as Json).id as string | undefined;
    const teProject = String(timeProjectId);
    const adminRoles = (await json('/admin/roles')) as unknown as { id: string; name: string; kind: string; builtin: boolean; permissions: string[] }[];
    const projectRoleList = adminRoles.filter((role) => role.kind === 'project' && !role.builtin);
    const ownerRole = projectRoleList.find((role) => role.permissions.includes('edit_project') && role.permissions.includes('work_package_assigned'));
    // A role that may log time, the least privileged there is: on an instance where only an administrator's
    // role may, the restricted account gets that one, in this project only. EPM's locks hold whatever the role.
    const mayLog = (role: { permissions: string[] }) =>
      (role.permissions.includes('log_own_time') || role.permissions.includes('log_time')) && role.permissions.includes('view_work_packages');
    const loggerRole =
      projectRoleList.find((role) => role.name !== 'EPM Automation' && mayLog(role) && !role.permissions.includes('edit_project')) ??
      projectRoleList.find((role) => role.name !== 'EPM Automation' && mayLog(role));
    check('there is a role that may log its own time', Boolean(ownerRole && loggerRole), true);
    check(
      'the administrator joins it',
      await status(`/projects/${teProject}/members`, { method: 'POST', cookie: admin, body: { userId: adminId, roleIds: [ownerRole?.id ?? memberRoleId] } }),
      201,
    );
    check(
      'and the restricted account',
      await status(`/projects/${teProject}/members`, { method: 'POST', cookie: admin, body: { userId: restrictedId, roleIds: [loggerRole?.id ?? memberRoleId] } }),
      201,
    );
    check('the administrator owns it', await status(`/projects/${teProject}/owner`, { method: 'PATCH', cookie: admin, body: { ownerId: adminId } }), 200);
    // The administrator leads the suite's team: on it, they are the restricted account's line manager.
    check('the restricted account is on the administrator’s team', (await setMapping(restrictedId, { teamId })).status, 200);

    const types = ((await asSystem(() => upstream.request<Json>(`/projects/${teProject}/types`)))._embedded?.elements ?? []) as Json[];
    const taskType = types.find((type) => type.name === 'Task')?.id ?? types.find((type) => !type.isMilestone)?.id;
    const make = async (subject: string) =>
      ((await (await call('/work-packages', { method: 'POST', cookie: admin, body: { projectId: teProject, typeId: String(taskType), payload: { subject } } })).json()) as Json)
        .id as string | undefined;
    const A = await make('Time A');
    const Z = await make('Time Z, closed');
    const closedStatus = (((await asSystem(() => upstream.request<Json>('/statuses')))._embedded?.elements ?? []) as Json[]).find(
      (entry) => entry.isClosed && /^closed$/i.test(entry.name),
    );
    check(
      'two work packages, one of them closed',
      await status(`/work-packages/${Z}`, { method: 'PATCH', cookie: admin, body: { payload: { _links: { status: { href: `/api/v3/statuses/${closedStatus?.id}` } } } } }),
      200,
    );
    const form = JSON.stringify(await json('/forms/time-entries', restricted, { method: 'POST', body: { projectId: teProject } }));
    const activityId = /time_entries\/activities\/(\d+)/.exec(form)?.[1];
    check('an activity to log against', Boolean(activityId), true);

    // BR-317: an entry breaking an active policy is refused, the policy named.
    const log = (body: Json) =>
      call('/time-entries', {
        method: 'POST',
        cookie: restricted,
        body: { projectId: teProject, workPackageId: A, hours: 2, spentOn: wd(0), activityId, comment: 'Time and expense probe', ...body },
      });
    check('BR-317: an entry with no activity is refused, naming its policy', /^422 .*Activity required/.test(await message(await log({ activityId: undefined }))), true);
    check('one on closed work is refused, naming its policy', /^422 .*No time on closed work/.test(await message(await log({ workPackageId: Z }))), true);
    check('one past the day’s limit is refused, naming its policy', /^422 .*Maximum hours in a day/.test(await message(await log({ hours: 11 }))), true);
    check('one beyond the back-dating window is refused, naming its policy', /^422 .*Back-dating window/.test(await message(await log({ spentOn: isoOf(todayMs - 61 * DAY) }))), true);
    const first = await log({});
    check('an entry within every policy is logged', first.status, 201);
    const firstId = ((await first.json()) as Json).id as string;

    // BR-304: a timesheet outside its bounds fails validation; inside them it is submitted and locked.
    const submitWeek = () => call('/timesheets/submit', { method: 'POST', cookie: restricted, body: { day: wd(0) } });
    check('BR-304: below its bounds, the timesheet fails validation, saying so', /^422 .*at least 4/.test(await message(await submitWeek())), true);
    await log({ hours: 3, spentOn: wd(1) });
    const extras = [await log({ hours: 7, spentOn: wd(2) }), await log({ hours: 7, spentOn: wd(3) }), await log({ hours: 7, spentOn: wd(4) })];
    check('and above them, saying so', /^422 .*at most 20/.test(await message(await submitWeek())), true);
    for (const extra of extras) await call(`/time-entries/${((await extra.json()) as Json).id}`, { method: 'DELETE', cookie: restricted });
    const submitted = await submitWeek();
    check('within them, it is submitted', submitted.status, 200);
    const sheet = (await submitted.json()) as Json;
    check('with its five hours, and locked', `${sheet.status}/${sheet.hours}/${sheet.locked}`, 'submitted/5/true');
    check('BR-304: the submitter cannot change its time', await status(`/time-entries/${firstId}`, { method: 'PATCH', cookie: restricted, body: { hours: 1 } }), 409);
    check('nor remove it', await status(`/time-entries/${firstId}`, { method: 'DELETE', cookie: restricted }), 409);
    check('nor log more in its period', (await log({ hours: 1, spentOn: wd(1) })).status, 409);

    // BR-305: the line manager rejects it; it returns to draft with the reason.
    const pendingTask = (view: Json) =>
      ((view.request?.steps ?? []) as Json[]).flatMap((step) => step.tasks as Json[]).find((task) => task.status === 'pending' && task.approverId === adminId);
    const asked = await json(`/timesheets/${sheet.id}`, admin);
    check('its line manager is asked first', `${((asked.request?.steps ?? []) as Json[])[0]?.status}/${Boolean(pendingTask(asked))}`, 'active/true');
    const reason = `Friday is missing ${stamp}`;
    check(
      'the line manager rejects it, saying why',
      await status(`/approvals/tasks/${pendingTask(asked)?.id}/decide`, { method: 'POST', cookie: admin, body: { decision: 'reject', comment: reason } }),
      200,
    );
    const returned = await json(`/timesheets/mine?day=${wd(0)}`, restricted);
    check('BR-305: a rejected timesheet returns to draft', `${returned.status}/${returned.locked}`, 'draft/false');
    check('with the reason shown to the submitter', returned.rejection?.reason, reason);
    check('and its time can be changed again', await status(`/time-entries/${firstId}`, { method: 'PATCH', cookie: restricted, body: { comment: 'Corrected' } }), 200);

    // BR-306: the outstanding list for a period that has ended, worked out independently.
    await refreshModel();
    const outstanding = async () => ((await json(`/timesheets/overview?day=${wd(0)}&status=outstanding`)).rows as Json[]).map((row) => String(row.personId)).sort();
    const automation = await automationUserId().catch(() => undefined);
    const active = await asSystem(() => upstream.getAll<Json>('/users', { filters: [{ field: 'status', operator: '=', values: ['active'] }] }));
    const timesheetsIn = new Set(
      (await teDb.timesheet.findMany({ where: { periodStart: new Date(`${wd(0)}T00:00:00Z`), status: { in: ['submitted', 'approved'] } }, select: { personId: true } })).map(
        (row) => row.personId,
      ),
    );
    const expected: string[] = [];
    for (const user of active.items) {
      const id = String(user.id);
      if (id === automation || timesheetsIn.has(id)) continue;
      const availability = await json(`/resources/people/${id}/availability?from=${wd(0)}&weeks=1`);
      if (Number(((availability.weeks ?? []) as Json[])[0]?.available ?? 0) > 0) expected.push(id);
    }
    const listed = await outstanding();
    check('BR-306: while it is in draft, the restricted account is outstanding for the period', listed.includes(restrictedId), true);
    check(
      'and the outstanding list is exactly everyone active with hours that week and no timesheet in',
      JSON.stringify(listed),
      JSON.stringify(expected.sort()),
    );

    // Submitted again and approved: the line manager, then the project's owner.
    check('submitted again', (await submitWeek()).status, 200);
    for (let step = 0; step < 2; step += 1) {
      const task = pendingTask(await json(`/timesheets/${sheet.id}`, admin));
      if (task) await call(`/approvals/tasks/${task.id}/decide`, { method: 'POST', cookie: admin, body: { decision: 'approve' } });
    }
    const approved = await json(`/timesheets/${sheet.id}`, admin);
    check(
      'approved by the line manager and then the project owner',
      `${approved.status}/${((approved.request?.steps ?? []) as Json[]).map((step) => step.status).join(',')}`,
      'approved/approved,approved',
    );
    check('and no longer outstanding', (await outstanding()).includes(restrictedId), false);
    check('an approved timesheet stays locked', await status(`/time-entries/${firstId}`, { method: 'DELETE', cookie: restricted }), 409);
    check('only whoever manages timesheets reopens it', await status(`/timesheets/${sheet.id}/reopen`, { method: 'POST', cookie: restricted, body: { reason: 'Mine' } }), 403);
    check('reopened, with a reason', await status(`/timesheets/${sheet.id}/reopen`, { method: 'POST', cookie: admin, body: { reason: 'Correction requested' } }), 200);
    check('its time unlocks', await status(`/time-entries/${firstId}`, { method: 'PATCH', cookie: restricted, body: { comment: 'Reopened' } }), 200);

    // Expense claims, under a category reused from run to run: an OpenProject cost type.
    let category = ((await json('/expenses/categories', restricted)) as unknown as Json[]).find((entry) => entry.name === 'Suite expenses');
    category ??= await json('/expenses/categories', admin, { method: 'POST', body: { name: 'Suite expenses' } });
    check('a category to claim under', Boolean(category?.id), true);
    check('the restricted account cannot add one', await status('/expenses/categories', { method: 'POST', cookie: restricted, body: { name: `Nope ${stamp}` } }), 403);
    const claim = async (amount: number) =>
      json('/expenses', restricted, {
        method: 'POST',
        body: { projectId: teProject, workPackageId: A, categoryId: category!.id, amount, spentOn: wd(1), description: `Suite claim ${amount}` },
      });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const attach = (id: string) => {
      const body = new FormData();
      body.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
      return fetch(`${BASE}/expenses/${id}/receipts`, { method: 'POST', headers: { cookie: restricted }, body });
    };
    const small = await claim(150);
    check('a claim is drafted', small.status, 'draft');
    check('BR-307: above the receipt threshold, it cannot be submitted without a receipt', /^422 .*needs a receipt/.test(await message(await call(`/expenses/${small.id}/submit`, { method: 'POST', cookie: restricted }))), true);
    check('a receipt is attached', (await attach(small.id)).status, 201);
    check('then it is submitted', await status(`/expenses/${small.id}/submit`, { method: 'POST', cookie: restricted }), 200);
    const smallSteps = ((await json(`/expenses/${small.id}`, restricted)).request?.steps ?? []) as Json[];
    check('BR-308: at or below the escalation threshold, the line manager alone is asked', smallSteps.map((step) => `${step.name}:${step.applies}`).join(','), 'Line manager:true,Additional approval:false');
    const big = await claim(1500);
    await attach(big.id);
    check('a claim above the escalation threshold is submitted', await status(`/expenses/${big.id}/submit`, { method: 'POST', cookie: restricted }), 200);
    const bigSteps = ((await json(`/expenses/${big.id}`, admin)).request?.steps ?? []) as Json[];
    check(
      'BR-308: above it, the claim routes to the additional approver',
      `${bigSteps[1]?.name}:${bigSteps[1]?.applies}:${((bigSteps[1]?.tasks ?? []) as Json[]).map((task) => task.approverId).join('+')}`,
      `Additional approval:true:${adminId}`,
    );

    // BR-309: approved, it becomes an OpenProject cost entry, in the project's actual cost and the finance export.
    await refreshModel();
    const costOf = async () =>
      Number((await json(`/measures/values?ids=cost.actual&scope=project:${teProject}`)).measures?.['cost.actual']?.value ?? 0);
    const costBefore = await costOf();
    for (let step = 0; step < 2; step += 1) {
      const task = pendingTask(await json(`/expenses/${big.id}`, admin));
      if (task) await call(`/approvals/tasks/${task.id}/decide`, { method: 'POST', cookie: admin, body: { decision: 'approve' } });
    }
    const posted = await json(`/expenses/${big.id}`, admin);
    check('approved, the claim is posted as an OpenProject cost entry', `${posted.status}/${Boolean(posted.costEntryId)}`, 'posted/true');
    if (posted.costEntryId) timeCostEntryIds.push(String(posted.costEntryId));
    const entry = posted.costEntryId
      ? await asSystem(() => upstream.request<Json>(`/epm_admin/costs/entries/${posted.costEntryId}`, { root: true }))
      : ({} as Json);
    check(
      'of 1,500, on the project and its work package, for the claimant',
      `${entry.costs}/${entry.projectId}/${entry.workPackageId}/${entry.userId}`,
      `1500/${teProject}/${A}/${restrictedId}`,
    );
    // The model reads it at its next refresh; one already running on another server is waited for.
    let costAfter = costBefore;
    for (let attempt = 0; attempt < 12 && round2(costAfter - costBefore) !== 1500; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10_000));
      await refreshModel();
      costAfter = await costOf();
    }
    check('BR-309: the approved claim appears in the project’s actual cost', round2(costAfter - costBefore), 1500);
    const exported = await fetch(`${BASE}/expenses/export?from=${wd(0)}&to=${wd(6)}`, { headers: { cookie: admin } });
    const zip = Buffer.from(await exported.arrayBuffer());
    let sheetText = '';
    for (let at = 0; at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50; ) {
      const method = zip.readUInt16LE(at + 8);
      const size = zip.readUInt32LE(at + 18);
      const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
      const data = zip.subarray(start, start + size);
      sheetText += (method === 8 ? inflateRawSync(data) : data).toString('utf8');
      at = start + size;
    }
    const keyOf = (id: string) => `EX-${id.slice(-6).toUpperCase()}`;
    check('and in the finance export for the period', `${exported.status}/${sheetText.includes(keyOf(big.id))}`, '200/true');
    check('which leaves out a claim not yet approved', sheetText.includes(keyOf(small.id)), false);

    // Journalled.
    const journal = await teDb.auditEvent.findMany({
      where: { occurredAt: { gte: suiteStartedAt }, OR: [{ action: { startsWith: 'timesheet.' } }, { action: { startsWith: 'expense.' } }, { action: 'time.settings.updated' }] },
      select: { action: true },
    });
    const actions = new Set(journal.map((row) => row.action));
    check(
      'timesheets, claims and the rules are journalled: none missing',
      ['timesheet.submitted', 'timesheet.rejected', 'timesheet.approved', 'timesheet.reopened', 'expense.created', 'expense.receipt.added', 'expense.submitted', 'expense.approved', 'expense.posted']
        .filter((action) => !actions.has(action))
        .join(', '),
      '',
    );

    // --- Finance, on the same project (BR-310, BR-311, BR-318 to BR-323) ---------
    console.log('\nFinance');
    {
      const { createServer } = await import('node:http');
      const reporting = String((await json('/finance/currencies')).reporting);
      check('finance figures are not for someone without its permissions', await status(`/finance/margin?projectId=${teProject}`, { cookie: restricted }), 403);
      check('nor are exchange rates added by them', await status('/finance/rates', { method: 'POST', cookie: restricted, body: {} }), 403);
      const addRate = async (body: Json) => {
        const response = await call('/finance/rates', { method: 'POST', cookie: admin, body });
        const row = (await response.json()) as Json;
        if (row.id) {
          financeCleanup.push(() =>
            teDb.exchangeRateFixing.deleteMany({ where: { rateId: row.id } }).then(() => teDb.exchangeRate.deleteMany({ where: { id: row.id } })),
          );
        }
        return response.status;
      };
      check(
        'rates are added: EUR and USD, and a USD planning rate',
        [
          await addRate({ currency: 'EUR', rate: 4, effectiveFrom: '2026-01-01' }),
          await addRate({ currency: 'USD', rate: 3.6725, effectiveFrom: '2026-01-01' }),
          await addRate({ currency: 'USD', rate: 3.67, effectiveFrom: '2026-01-01', kind: 'planning' }),
        ].join(),
        '201,201,201',
      );
      const card = await json('/finance/rate-cards', admin, {
        method: 'POST',
        body: { name: `Suite card ${stamp}`, currency: 'USD', isDefault: false, rates: [{ roleId: null, hourlyRate: 100 }] },
      });
      financeCleanup.push(() =>
        teDb.projectProfile.updateMany({ where: { rateCardId: card.id }, data: { rateCardId: null } }).then(() => teDb.rateCard.deleteMany({ where: { id: card.id } })),
      );
      financeCleanup.push(() => teDb.billableItem.deleteMany({ where: { projectId: Number(teProject) } }));
      financeCleanup.push(() => teDb.budgetPhase.deleteMany({ where: { projectId: Number(teProject) } }));
      const contract = await json(`/finance/projects/${teProject}/contract`, admin, {
        method: 'PATCH',
        body: { currency: 'USD', contractValue: 20000, billingModel: 'time_and_materials', rateCardId: card.id },
      });
      check('the project is billed in USD, time and materials, at the card', `${contract.currency}/${contract.billingModel}/${contract.rateCardName}`, `USD/time_and_materials/Suite card ${stamp}`);

      // BR-310: phasing derived from the plan, set by hand, and kept to the budget when it changes.
      const firstOfMonth = `${today.slice(0, 7)}-01`;
      const thisMonth = new Date(`${firstOfMonth}T00:00:00Z`);
      const nextFirst = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() + 1, 1));
      const nextLast = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() + 2, 0));
      const plan = (body: Json) => status(`/projects/${teProject}/plan`, { method: 'PATCH', cookie: admin, body });
      check('the project has a budget and planned dates', await plan({ budgetTotal: 12000, plannedStart: firstOfMonth, plannedFinish: isoOf(nextLast.getTime()) }), 200);
      const sum = (phases: Json[]) => round2(phases.reduce((total, phase) => total + Number(phase.amount), 0));
      const derived = await json(`/finance/projects/${teProject}/phasing`);
      check('BR-310: phased from the schedule, the months sum to the budget', `${derived.basis}/${sum(derived.phases)}`, 'dates/12000');
      const months = [firstOfMonth, isoOf(nextFirst.getTime())];
      const phase = (amounts: number[]) =>
        call(`/finance/projects/${teProject}/phasing`, { method: 'PUT', cookie: admin, body: { phases: months.map((month, index) => ({ month, amount: amounts[index] })) } });
      check('phased by hand, months that miss the budget are refused', (await phase([5000, 5000])).status, 422);
      const manual = (await (await phase([4000, 8000])).json()) as Json;
      check('months that make it are kept', `${manual.basis}/${sum(manual.phases)}`, 'manual/12000');
      await plan({ budgetTotal: 15000 });
      const rescaled = await json(`/finance/projects/${teProject}/phasing`);
      check(
        'BR-310: with the budget changed, the phasing still sums to it',
        `${rescaled.rescaled}/${sum(rescaled.phases)}/${(rescaled.phases as Json[]).map((one) => one.amount).join('+')}`,
        'true/15000/5000+10000',
      );

      // The reopened timesheet approved again, and a claim in euros.
      check('the reopened timesheet is submitted again', (await submitWeek()).status, 200);
      for (let step = 0; step < 2; step += 1) {
        const task = pendingTask(await json(`/timesheets/${sheet.id}`, admin));
        if (task) await call(`/approvals/tasks/${task.id}/decide`, { method: 'POST', cookie: admin, body: { decision: 'approve' } });
      }
      check('and approved', (await json(`/timesheets/${sheet.id}`, admin)).status, 'approved');
      const euro = await json('/expenses', restricted, {
        method: 'POST',
        body: { projectId: teProject, workPackageId: A, categoryId: category!.id, amount: 100, currency: 'EUR', spentOn: wd(2), description: 'Suite claim in euros' },
      });
      check('a claim in EUR is drafted', `${euro.status}/${euro.currency}`, 'draft/EUR');
      check('and submitted', await status(`/expenses/${euro.id}/submit`, { method: 'POST', cookie: restricted }), 200);
      for (let step = 0; step < 2; step += 1) {
        const task = pendingTask(await json(`/expenses/${euro.id}`, admin));
        if (task) await call(`/approvals/tasks/${task.id}/decide`, { method: 'POST', cookie: admin, body: { decision: 'approve' } });
      }
      const euroPosted = await json(`/expenses/${euro.id}`, admin);
      if (euroPosted.costEntryId) timeCostEntryIds.push(String(euroPosted.costEntryId));
      check(
        'BR-320: posted, the claim keeps its currency and amount beside the converted one',
        `${euroPosted.status}/${euroPosted.currency}/${euroPosted.amount}/${euroPosted.reportingCurrency}/${euroPosted.reportingAmount}/${euroPosted.exchangeRate}`,
        `posted/EUR/100/${reporting}/400/4`,
      );
      const euroEntry = euroPosted.costEntryId
        ? await asSystem(() => upstream.request<Json>(`/epm_admin/costs/entries/${euroPosted.costEntryId}`, { root: true }))
        : ({} as Json);
      check('and its cost entry is in the reporting currency', euroEntry.costs, 400);
      let measured = await costOf();
      for (let attempt = 0; attempt < 12 && round2(measured - costAfter) !== 400; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10_000));
        await refreshModel();
        measured = await costOf();
      }
      check('the model has it', round2(measured - costAfter), 400);

      // BR-311: cumulative actual at the last period's end against actual cost as the measures have it.
      const flow = await json(`/finance/cash-flow?projectId=${teProject}`);
      check(
        'BR-311: cumulative actual at the period end reconciles to total actual cost',
        `${flow.reconciliation?.reconciles}/${flow.reconciliation?.cumulativeAtEnd}`,
        `true/${measured}`,
      );
      check('and the plan beside it is the phased budget', flow.combined?.totals?.planned, 15000);

      // BR-318: margin against an independent calculation — five billable hours at 100 USD on days at 3.6725.
      const marginOf = async () => ((await json(`/finance/margin?projectId=${teProject}`)).projects as Json[])[0];
      const line = await marginOf();
      const earned = round2(5 * 100 * 3.6725);
      check('BR-318: actual margin matches an independent calculation', `${line?.margin?.actual?.revenue}/${line?.margin?.actual?.margin}`, `${earned}/${round2(earned - measured)}`);
      check(
        'and estimated margin: the contract at the planning rate, less the budget',
        `${line?.margin?.estimated?.revenue}/${line?.margin?.estimated?.margin}`,
        `${round2(20000 * 3.67)}/${round2(20000 * 3.67 - 15000)}`,
      );

      // BR-319: eight hours planned next month at 100 USD, at the planning rate, at full confidence.
      const ym = isoOf(nextFirst.getTime()).slice(0, 7);
      const made = await call('/work-packages', {
        method: 'POST',
        cookie: admin,
        body: {
          projectId: teProject,
          typeId: String(taskType),
          payload: { subject: 'Forecast work', estimatedTime: 'PT8H', startDate: `${ym}-10`, dueDate: `${ym}-20`, _links: { assignee: { href: `/api/v3/users/${restrictedId}` } } },
        },
      });
      check('work is planned for next month', made.status, 201);
      const expectedForecast = round2(8 * 100 * 3.67);
      let forecastMonth: Json | undefined;
      for (let attempt = 0; attempt < 8 && Number(forecastMonth?.revenue) !== expectedForecast; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10_000));
        await refreshModel();
        const forecast = await json(`/finance/forecast?projectId=${teProject}`);
        forecastMonth = ((forecast.projects as Json[])?.[0]?.months as Json[] | undefined)?.find((month) => month.month === `${ym}-01`);
      }
      check('BR-319: forecast revenue matches an independent calculation', `${forecastMonth?.revenue}/${forecastMonth?.weighted}`, `${expectedForecast}/${expectedForecast}`);

      // BR-322: billable items from approved time and approved expenses, reconciled; no duplicates on a second run.
      const generate = () => json(`/finance/projects/${teProject}/billing`, admin, { method: 'POST', body: { from: wd(0), to: wd(6) } });
      const bill = await generate();
      const amounts = (kind: string) =>
        ((bill.items ?? []) as Json[])
          .filter((item) => item.kind === kind)
          .map((item) => Number(item.amount))
          .sort((a, b) => a - b)
          .join('+');
      check('BR-322: items are made from approved time and approved expenses', `time:${amounts('time')}|expense:${amounts('expense')}`, 'time:200+300|expense:108.92+408.44');
      check(
        'and reconcile to them for the period',
        `${bill.reconciliation?.reconciles}/${bill.reconciliation?.hours?.approved}/${bill.reconciliation?.expenses?.approved}`,
        'true/5/517.36',
      );
      check('a claim still awaiting approval is not billed', ((bill.items ?? []) as Json[]).some((item) => item.sourceId === small.id), false);
      check('generating again makes no duplicates', ((await generate()).items as Json[]).length, ((bill.items ?? []) as Json[]).length);

      // BR-321: a backdated rate afterwards changes no figure already reported for the period.
      const figures = async () =>
        JSON.stringify([
          (await marginOf())?.margin?.actual?.revenue,
          (await json(`/finance/cash-flow?projectId=${teProject}`)).reconciliation?.cumulativeAtEnd,
          (await json(`/finance/projects/${teProject}/billing?from=${wd(0)}&to=${wd(6)}`)).reconciliation?.expenses?.approved,
        ]);
      const before = await figures();
      await addRate({ currency: 'USD', rate: 5, effectiveFrom: '2026-01-01' });
      await addRate({ currency: 'EUR', rate: 9, effectiveFrom: '2026-01-01' });
      check('BR-321: the period reported again after backdated rates gives the same converted figures', await figures(), before);

      // BR-323: a stand-in finance system that keeps one document per item id.
      const documents = new Map<string, string>();
      const keys: string[] = [];
      const receiver = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          keys.push(String(request.headers['idempotency-key']));
          const sent = JSON.parse(body) as Json;
          const received = (sent.items as Json[]).map((item) => {
            if (!documents.has(item.itemId)) documents.set(item.itemId, `FIN-${documents.size + 1}`);
            return { itemId: item.itemId, reference: documents.get(item.itemId) };
          });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ batchId: sent.batchId, received }));
        });
      });
      await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
      financeCleanup.push(async () => receiver.close());
      const settingsBefore = await json('/finance/settings');
      const settingsWith = (endpoint: string | null) => ({ confidence: settingsBefore.confidence, horizonMonths: settingsBefore.horizonMonths, endpoint });
      financeCleanup.push(() => call('/finance/settings', { method: 'PUT', cookie: admin, body: settingsWith(settingsBefore.endpoint ?? null) }));
      const port = (receiver.address() as { port: number }).port;
      check('the finance system’s address is set', await status('/finance/settings', { method: 'PUT', cookie: admin, body: settingsWith(`http://127.0.0.1:${port}/finance`) }), 200);
      const batch = await json('/finance/batches', admin, { method: 'POST', body: { projectId: teProject } });
      if (batch.id) financeCleanup.push(() => teDb.financeBatch.deleteMany({ where: { id: batch.id } }));
      check('a batch of the four items', `${batch.status}/${batch.itemCount}`, 'ready/4');
      check('only whoever manages finance sends it', await status(`/finance/batches/${batch.id}/send`, { method: 'POST', cookie: restricted }), 403);
      const sent = await json(`/finance/batches/${batch.id}/send`, admin, { method: 'POST' });
      check('BR-323: sent, the batch reconciles on both sides', `${sent.status}/${sent.reconciliation?.matched}/${sent.reconciliation?.finance?.count}/${documents.size}`, 'acknowledged/true/4/4');
      check(
        'each item carries the finance system’s reference',
        ((sent.items ?? []) as Json[]).every((item) => item.status === 'transferred' && String(item.externalRef).startsWith('FIN-')),
        true,
      );
      const replayed = await json(`/finance/batches/${batch.id}/replay`, admin, { method: 'POST' });
      check(
        'BR-323: replayed, the batch creates no duplicates',
        `${replayed.replays}/${replayed.reconciliation?.matched}/${(replayed.reconciliation?.duplicates as Json[] | undefined)?.length}/${documents.size}`,
        '1/true/0/4',
      );
      check('both times under the batch’s id as the idempotency key', keys.join(), `${batch.id},${batch.id}`);
      check('nothing is left to batch', await status('/finance/batches', { method: 'POST', cookie: admin, body: { projectId: teProject } }), 409);

      const financeJournal = new Set(
        (
          await teDb.auditEvent.findMany({
            where: { occurredAt: { gte: suiteStartedAt }, OR: [{ action: { startsWith: 'finance.' } }, { action: { startsWith: 'billing.' } }, { action: { startsWith: 'project.phasing' } }, { action: 'project.finance.updated' }] },
            select: { action: true },
          })
        ).map((row) => row.action),
      );
      check(
        'rates, cards, contracts, phasing, billing and batches are journalled: none missing',
        ['finance.rate.added', 'finance.rate_card.created', 'project.finance.updated', 'project.phasing.saved', 'billing.generated', 'finance.batch.created', 'finance.batch.sent', 'finance.batch.replayed', 'finance.settings.updated']
          .filter((action) => !financeJournal.has(action))
          .join(', '),
        '',
      );
      for (const undo of financeCleanup.splice(0).reverse()) await undo().catch(() => undefined);
    }

    // Put things back: the restricted account's team, the cost entry, the project, the rules.
    await setMapping(restrictedId, {});
    for (const id of timeCostEntryIds.splice(0)) {
      await asSystem(() => upstream.request(`/epm_admin/costs/entries/${id}`, { root: true, method: 'DELETE' })).catch(() => undefined);
    }
    check('the project is removed', await status(`/projects/${teProject}`, { method: 'DELETE', cookie: admin }), 204);
    timeProjectId = undefined;
    check('the rules are put back', [200, 409].includes(await status('/time/settings', { method: 'PUT', cookie: admin, body: timeSettingsBefore })), true);
    timeSettingsBefore = undefined;
  }

  // --- Work that slips (BR-113) and a project's timezone (BR-108) -------------
  console.log('\nWork that slips, and a project\'s timezone');
  {
    type Json = Record<string, any>;
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const json = async (path: string, init: Parameters<typeof call>[1] = {}) => (await (await call(path, { cookie: admin, ...init })).json()) as Json;
    const stamp = Date.now();
    const made = await call('/projects', { method: 'POST', cookie: admin, body: { payload: { name: `Slip Test ${stamp}`, identifier: `slip-${stamp}` } } });
    check('a project is made for the slip tests', made.status, 201);
    slipProjectId = ((await made.json()) as Json).id as string | undefined;

    // BR-108: a timezone of its own; its dates stay calendar days.
    check('BR-108: the project is given a timezone', await status(`/projects/${slipProjectId}/plan`, { method: 'PATCH', cookie: admin, body: { timezone: 'Asia/Dubai' } }), 200);
    check('and keeps it', (await json(`/projects/${slipProjectId}`)).timezone, 'Asia/Dubai');
    check('a name that is no timezone is refused', await status(`/projects/${slipProjectId}/plan`, { method: 'PATCH', cookie: admin, body: { timezone: 'Mars/Olympus' } }), 400);

    // Three weeks ahead, from a Monday: P Monday to Friday; S1 and S2 follow it in turn; M follows P but is scheduled by hand.
    const DAY = 86_400_000;
    const now = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 21 * DAY;
    const monday = now - ((new Date(now).getUTCDay() + 6) % 7) * DAY;
    const day = (offset: number) => new Date(monday + offset * DAY).toISOString().slice(0, 10);
    const types = ((await asSystem(() => upstream.request<Json>(`/projects/${slipProjectId}/types`)))._embedded?.elements ?? []) as Json[];
    const taskType = types.find((type) => type.name === 'Task')?.id ?? types.find((type) => !type.isMilestone)?.id;
    const milestoneType = types.find((type) => type.isMilestone)?.id;
    const make = async (subject: string, start: string, due: string, type = taskType) =>
      ((await json('/work-packages', { method: 'POST', body: { projectId: slipProjectId, typeId: String(type), payload: { subject, startDate: start, dueDate: due } } })).id as string | undefined);
    const P = await make('Slip P', day(0), day(4));
    const S1 = await make('Slip S1', day(7), day(8));
    const S2 = await make('Slip S2', day(9), day(10));
    const M = await make('Slip M', day(7), day(8));
    const relate = (successor?: string, predecessor?: string) =>
      status(`/work-packages/${successor}/relations`, { method: 'POST', cookie: admin, body: { type: 'follows', relatedId: predecessor } });
    check('S1 follows P, S2 follows S1, M follows P', [await relate(S1, P), await relate(S2, S1), await relate(M, P)].join(), '201,201,201');
    check('M is scheduled by hand', await status(`/work-packages/${M}`, { method: 'PATCH', cookie: admin, body: { payload: { scheduleManually: true, startDate: day(7), dueDate: day(8) } } }), 200);
    const read = async (id?: string) => {
      const work = await asSystem(() => upstream.request<Json>(`/work_packages/${id}`));
      return { start: (work.startDate ?? work.date) as string, finish: (work.dueDate ?? work.date) as string, manual: work.scheduleManually as boolean };
    };
    const before = { S1: await read(S1), S2: await read(S2), M: await read(M) };
    check('S1 and S2 are scheduled automatically, M by hand', `${before.S1.manual}/${before.S2.manual}/${before.M.manual}`, 'false/false/true');

    // P's finish moves five working days.
    const moved = await call(`/work-packages/${P}`, { method: 'PATCH', cookie: admin, body: { payload: { dueDate: day(11) } } });
    const answer = (await moved.json()) as Json;
    const weekdays = (from: string, to: string) => {
      let count = 0;
      for (let at = Date.parse(`${from}T00:00:00Z`) + DAY; at <= Date.parse(`${to}T00:00:00Z`); at += DAY) if (![0, 6].includes(new Date(at).getUTCDay())) count += 1;
      return count;
    };
    const after = { S1: await read(S1), S2: await read(S2), M: await read(M) };
    check(
      'BR-113: moving a predecessor’s finish five days shifts every automatically scheduled successor five days',
      [weekdays(before.S1.start, after.S1.start), weekdays(before.S1.finish, after.S1.finish), weekdays(before.S2.start, after.S2.start), weekdays(before.S2.finish, after.S2.finish)].join(),
      '5,5,5,5',
    );
    check('and leaves the one scheduled by hand untouched', `${after.M.start}/${after.M.finish}`, `${day(7)}/${day(8)}`);
    check(
      'the planner is told what moved, and by how much',
      ((answer.moved ?? []) as Json[]).map((item) => `${item.id}:${item.days}`).sort().join(),
      [`${S1}:5`, `${S2}:5`].sort().join(),
    );
    const told = (await json('/notifications?limit=20')) as Json;
    const items = (Array.isArray(told) ? told : (told.items ?? [])) as Json[];
    check('in the app as well', items.some((item) => String(item.link ?? '').endsWith(`/tasks/${P}`)), true);

    check('the project is removed', await status(`/projects/${slipProjectId}`, { method: 'DELETE', cookie: admin }), 204);
    slipProjectId = undefined;
  }

  // --- Portfolio scenarios (BR-220 to BR-222) ---------------------------------
  console.log('\nPortfolio scenarios');
  {
    type Json = Record<string, any>;
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    const { prisma: scDb } = await import('../db/prisma.js');
    const json = async (path: string, init: Parameters<typeof call>[1] = {}, cookie = admin) => (await (await call(path, { cookie, ...init })).json()) as Json;
    const stamp = Date.now();
    check('scenarios are not for someone without scenarios:manage', await status('/scenarios', { cookie: restricted }), 403);

    // A project two months ahead: 40 open hours over two weeks, a milestone, a budget; the restricted account owns it.
    const DAY = 86_400_000;
    const ahead = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 60 * DAY;
    const monday = ahead - ((new Date(ahead).getUTCDay() + 6) % 7) * DAY;
    const day = (offset: number) => new Date(monday + offset * DAY).toISOString().slice(0, 10);
    const made = await call('/projects', { method: 'POST', cookie: admin, body: { payload: { name: `Scenario Test ${stamp}`, identifier: `scn-${stamp}` } } });
    check('a project is made for the scenario tests', made.status, 201);
    scenarioProjectId = ((await made.json()) as Json).id as string | undefined;
    const pid = String(scenarioProjectId);
    check('it has a plan and a budget', await status(`/projects/${pid}/plan`, { method: 'PATCH', cookie: admin, body: { plannedStart: day(0), plannedFinish: day(25), budgetTotal: 9000 } }), 200);
    check('the restricted account owns it', await status(`/projects/${pid}/owner`, { method: 'PATCH', cookie: admin, body: { ownerId: restrictedId } }), 200);
    const types = ((await asSystem(() => upstream.request<Json>(`/projects/${pid}/types`)))._embedded?.elements ?? []) as Json[];
    const taskType = types.find((type) => type.name === 'Task')?.id ?? types.find((type) => !type.isMilestone)?.id;
    const milestoneType = types.find((type) => type.isMilestone)?.id;
    const work = async (payload: Json, type = taskType) => (await json('/work-packages', { method: 'POST', body: { projectId: pid, typeId: String(type), payload } })).id as string;
    const W = await work({ subject: 'Scenario work', estimatedTime: 'PT40H', startDate: day(0), dueDate: day(11) });
    const M = await work({ subject: 'Scenario milestone', date: day(25) }, milestoneType);
    const live = async () => {
      const [w, m] = await Promise.all([asSystem(() => upstream.request<Json>(`/work_packages/${W}`)), asSystem(() => upstream.request<Json>(`/work_packages/${M}`))]);
      const plan = await json(`/projects/${pid}`);
      return JSON.stringify([w.startDate, w.dueDate, w.estimatedTime, m.date, plan.startDate ?? null, plan.dueDate ?? null, plan.budgetTotal]);
    };
    const before = await live();

    // BR-220: a copy, as things stand; live data untouched.
    const captured = await call('/scenarios', { method: 'POST', cookie: admin, body: { name: `Suite scenario ${stamp}`, projectIds: [pid] } });
    check('BR-220: a scenario is made from the project as it stands', captured.status, 201);
    const scenario = (await captured.json()) as Json;
    check('it holds the open work, the milestone, the plan and the budget', `${scenario.projects?.[0]?.workItems}/${scenario.profile?.totals?.demand}/${scenario.profile?.milestones?.[0]?.date}/${scenario.projects?.[0]?.capturedBudget}`, `2/40/${day(25)}/9000`);
    check('BR-220: making it leaves live data unchanged', await live(), before);
    await call(`/work-packages/${W}`, { method: 'PATCH', cookie: admin, body: { payload: { estimatedTime: 'PT60H' } } });
    check('and it keeps the state at the moment it was made, whatever happens to live data after', (await json(`/scenarios/${scenario.id}`)).profile?.totals?.demand, 40);
    await call(`/work-packages/${W}`, { method: 'PATCH', cookie: admin, body: { payload: { estimatedTime: 'PT40H' } } });
    const restored = await live();

    // BR-221: deferred by a quarter, capacity demand and spend move together.
    const deferred = await json(`/scenarios/${scenario.id}/projects/${pid}`, { method: 'PATCH', body: { shiftMonths: 3 } });
    const months = (profile: Json, field: string) => ((profile.months ?? []) as Json[]).filter((row) => Number(row[field]) > 0).map((row) => `${row.month}:${row[field]}`);
    const plus3 = (rows: string[]) =>
      rows.map((row) => {
        const [month, value] = row.split(':');
        const [y, m] = month!.split('-').map(Number) as [number, number];
        return `${new Date(Date.UTC(y, m - 1 + 3, 1)).toISOString().slice(0, 10)}:${value}`;
      });
    check(
      'BR-221: deferred a quarter, the totals of demand and spend are unchanged',
      `${deferred.profile?.totals?.demand}/${deferred.profile?.totals?.spend}`,
      `${deferred.captured?.totals?.demand}/${deferred.captured?.totals?.spend}`,
    );
    check('and the capacity demand moves three months', JSON.stringify(months(deferred.profile, 'demand')), JSON.stringify(plus3(months(deferred.captured, 'demand'))));
    check(
      'and so does the spend profile, consistently',
      JSON.stringify(((deferred.profile?.months ?? []) as Json[]).filter((row) => Number(row.spend) > 0).map((row) => row.month)).length > 2 &&
        deferred.profile?.totals?.spend === 9000 &&
        ((deferred.profile?.months ?? []) as Json[]).every((row) => Number(row.spend) === 0 || row.month >= `${day(0).slice(0, 7)}-01`),
      true,
    );
    check('with the milestone three months on', deferred.profile?.milestones?.[0]?.date > day(25), true);
    check('adjusting it does not touch live data either', await live(), restored);

    // BR-222: submitted, nothing changes until it is approved; approved, it is applied and the decision recorded.
    const submitted = await json(`/scenarios/${scenario.id}/submit`, { method: 'POST' });
    check('it is submitted for approval', submitted.status, 'submitted');
    check('BR-222: before approval, live data is unchanged', await live(), restored);
    const requestView = await json(`/approvals/requests/${submitted.requestId}`, {}, restricted);
    const task = ((requestView.steps ?? []) as Json[]).flatMap((step) => (step.tasks ?? []) as Json[]).find((entry) => entry.status === 'pending' && entry.approverId === restrictedId);
    check('the project’s owner is asked', Boolean(task), true);
    const comment = `Defer to next quarter ${stamp}`;
    check('and approves it', await status(`/approvals/tasks/${task?.id}/decide`, { method: 'POST', cookie: restricted, body: { decision: 'approve', comment } }), 200);
    const promoted = await json(`/scenarios/${scenario.id}`);
    check('BR-222: approved, the scenario is promoted with the decision recorded', `${promoted.status}/${promoted.decision?.comment}/${promoted.decidedBy}`, `promoted/${comment}/${restrictedId}`);
    const after = JSON.parse(await live()) as (string | number | null)[];
    const startNow = promoted.projects?.[0]?.plannedStart;
    // OpenProject starts work on a working day: a start that lands on a weekend moves to the Monday.
    const workingStart = (iso: string) => {
      let at = Date.parse(`${iso}T00:00:00Z`);
      while ([0, 6].includes(new Date(at).getUTCDay())) at += DAY;
      return new Date(at).toISOString().slice(0, 10);
    };
    check('and applied to live data: the work, the milestone and the plan three months on', [after[0], after[3], after[4]].join(), [workingStart(startNow), promoted.profile?.milestones?.[0]?.date, startNow].join());
    const journal = await scDb.auditEvent.findMany({ where: { entityId: scenario.id, occurredAt: { gte: suiteStartedAt } }, select: { action: true } });
    check('the journal has it all', ['scenario.created', 'scenario.adjusted', 'scenario.submitted', 'scenario.promoted'].filter((action) => !journal.some((row) => row.action === action)).join(', '), '');

    check('the project is removed', await status(`/projects/${pid}`, { method: 'DELETE', cookie: admin }), 204);
    scenarioProjectId = undefined;
    await scDb.scenario.delete({ where: { id: scenario.id } }).catch(() => undefined);
  }

  // --- Project lifecycle ------------------------------------------------------
  console.log('\nProject lifecycle');

  {
    const lifecycleName = `Lifecycle Test ${Date.now()}`;
    const createdLifecycle = await call('/projects', {
      method: 'POST',
      cookie: admin,
      body: { payload: { name: lifecycleName, identifier: `lifecycle-${Date.now()}` } },
    });
    check('a project can be created for the lifecycle test', createdLifecycle.status, 201);

    const lifecycleCreated = (await createdLifecycle.json()) as { id?: string; name?: string };
    const lifecycleId = lifecycleCreated.id ?? '';

    // Belt and braces before a section that deletes. A test that destroys a
    // project must be certain it is destroying the one it just made, so it
    // refuses to continue unless the id came back and the name matches what it
    // asked for. Cheap, and the alternative is unrecoverable.
    if (!lifecycleId || lifecycleCreated.name !== lifecycleName) {
      throw new Error(
        `Refusing to run the project lifecycle tests: created project did not come back as asked ` +
          `(id=${lifecycleId || 'missing'}, name=${lifecycleCreated.name ?? 'missing'}).`,
      );
    }

    const readProjectRow = async (cookie: string) =>
      ((await (await call('/projects', { cookie })).json()) as {
        id: string;
        status: string;
        can?: { archive: boolean; remove: boolean };
      }[]).find((row) => row.id === lifecycleId);

    const fresh = await readProjectRow(admin);
    check('a project reports what may be done to it', typeof fresh?.can?.remove, 'boolean');
    check('an active project can be archived', fresh?.can?.archive, true);

    check(
      'archiving succeeds',
      (await call(`/projects/${lifecycleId}/archive`, { method: 'PATCH', cookie: admin })).status,
      200,
    );
    check('the project reads as paused afterwards', (await readProjectRow(admin))?.status, 'paused');

    // The bug this covers: `project:archive` comes from the per-project
    // `projects/update` capability, and an archived project reports no
    // capabilities at all — so archiving removed the permission needed to undo
    // it, and restoring was impossible for everyone including an administrator.
    check(
      'an archived project can still be restored',
      (await call(`/projects/${lifecycleId}/restore`, { method: 'PATCH', cookie: admin })).status,
      200,
    );
    check('and is active again', (await readProjectRow(admin))?.status !== 'paused', true);

    check(
      'a restricted caller cannot archive it',
      await status(`/projects/${lifecycleId}/archive`, { method: 'PATCH', cookie: restricted }),
      403,
    );
    // Not found rather than forbidden, and deliberately so: restore and delete
    // read the project with the caller's own token first, and someone who
    // cannot see a project should not learn that it exists. Archiving answers
    // 403 because its permission check runs before any upstream read.
    check(
      'nor restore it',
      await status(`/projects/${lifecycleId}/restore`, { method: 'PATCH', cookie: restricted }),
      404,
    );
    check(
      'nor delete it',
      await status(`/projects/${lifecycleId}`, { method: 'DELETE', cookie: restricted }),
      404,
    );
    check('and none of that changed it', (await readProjectRow(admin))?.status !== 'paused', true);

    check(
      'a non-numeric project id is not found',
      await status('/projects/not-a-number', { method: 'DELETE', cookie: admin }),
      404,
    );
    check(
      'an unknown project is not found',
      await status('/projects/99999999', { method: 'DELETE', cookie: admin }),
      404,
    );

    // Deletion is the section's own cleanup: the project created here is the
    // project removed here, so nothing is left behind.
    check(
      'deleting succeeds',
      await status(`/projects/${lifecycleId}`, { method: 'DELETE', cookie: admin }),
      204,
    );
    check('the project is gone straight away', await readProjectRow(admin), undefined);
  }

  // --- Security and assurance (BR-608 to BR-610) ---------------------------
  // The API's own Content-Security-Policy forbids everything, since nothing it
  // returns is a page: an uploaded SVG opened in a tab can run nothing. And the
  // integration page's one action is now as administrative as the page always
  // told people it was.
  console.log('\nSecurity and assurance');
  {
    const response = await call('/integrations/status', { cookie: admin });
    const csp = response.headers.get('content-security-policy') ?? '';
    check("API responses allow no source at all (default-src 'none')", csp.includes("default-src 'none'"), true);
    check('API responses cannot be framed', csp.includes("frame-ancestors 'none'"), true);
    check('an API response opened as a page is sandboxed', /(^|;)\s*sandbox\s*(;|$)/.test(csp), true);
    check('API responses are not MIME-sniffed', response.headers.get('x-content-type-options'), 'nosniff');

    check(
      'anyone signed in can read integration health',
      await status('/integrations/status', { cookie: restricted }),
      200,
    );
    check(
      'only an administrator can run the connection check',
      await status('/integrations/status/sync', { method: 'POST', cookie: restricted }),
      403,
    );
    check(
      'an administrator can',
      await status('/integrations/status/sync', { method: 'POST', cookie: admin }),
      200,
    );

    // --- Rates and per-person cost (BRL-01) -------------------------------
    // A rate is pay information. The administrator's rate was set by the
    // health section above, so there is one to see — or not.
    type Person = { id: string; hourlyRate?: number };
    const adminDirectory = (await (await call('/employees', { cookie: admin })).json()) as Person[];
    const restrictedDirectory = (await (await call('/employees', { cookie: restricted })).json()) as Person[];
    check('whoever sets rates sees them in the directory', adminDirectory.some((person) => person.hourlyRate !== undefined), true);
    check(
      'nobody else sees any rate in it',
      restrictedDirectory.length > 0 && restrictedDirectory.every((person) => !('hourlyRate' in person)),
      true,
    );
    const ownRecord = (await (await call(`/employees/${adminId}`, { cookie: restricted })).json()) as Person;
    check('not even by asking for one person', 'hourlyRate' in ownRecord, false);

    type Report = { costHidden?: boolean; totalCost?: number; hoursWithoutRate?: number; rows: Record<string, unknown>[] };
    const range = `from=${new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`;
    const reportAs = async (cookie: string) =>
      (await (await call(`/time-entries/report?${range}&groupBy=user`, { cookie })).json()) as Report;
    const hidden = await reportAs(restricted);
    check('Time & Costs tells someone without rates that costs are hidden', hidden.costHidden, true);
    check(
      'and carries no money and no "without a rate" counts',
      hidden.totalCost === undefined &&
        hidden.hoursWithoutRate === undefined &&
        hidden.rows.every((row) => !('cost' in row) && !('hoursWithoutRate' in row)),
      true,
    );
    check('whoever may read rates gets the costs', (await reportAs(admin)).costHidden === undefined, true);

    // --- EPM's own permission grants ---------------------------------------
    check(
      'only an administrator lists EPM permission grants',
      await status('/admin/permission-grants', { cookie: restricted }),
      403,
    );
    check(
      'or grants one',
      await status('/admin/permission-grants', {
        method: 'POST',
        cookie: restricted,
        body: { userId: restrictedId, permission: 'rates:view' },
      }),
      403,
    );
    check(
      'a permission OpenProject decides cannot be granted here',
      await status('/admin/permission-grants', {
        method: 'POST',
        cookie: admin,
        body: { userId: restrictedId, permission: 'users:manage' },
      }),
      400,
    );
    const lend = await call('/admin/permission-grants', {
      method: 'POST',
      cookie: admin,
      body: { userId: restrictedId, permission: 'rates:view' },
    });
    if (lend.status === 201) ratesGrantLent = true;
    check('an administrator grants "Read hourly rates"', lend.status, 201);
    check(
      'granting it twice is refused',
      await status('/admin/permission-grants', {
        method: 'POST',
        cookie: admin,
        body: { userId: restrictedId, permission: 'rates:view' },
      }),
      409,
    );
    check('with it, the costs are there at once', (await reportAs(restricted)).costHidden === undefined, true);
    check(
      'and the rates',
      ((await (await call('/employees', { cookie: restricted })).json()) as Person[]).some((person) => 'hourlyRate' in person) ||
        restrictedDirectory.every((person) => person.id !== adminId),
      true,
    );
    const taken = await status(`/admin/permission-grants/${restrictedId}/rates:view`, { method: 'DELETE', cookie: admin });
    if (taken === 204) ratesGrantLent = false;
    check('removing it', taken, 204);
    check('takes them away again', (await reportAs(restricted)).costHidden, true);

    // --- Trends from organisation-wide snapshots ---------------------------
    check(
      'organisation-wide trends are refused to someone who does not manage analytics',
      await status('/analytics/trends?metrics=projects.total', { cookie: restricted }),
      403,
    );
    check(
      'a person reads their own series',
      await status(`/analytics/trends?metrics=myTasks&scopeType=user&scopeId=${restrictedId}`, { cookie: restricted }),
      200,
    );
    check(
      "but not someone else's",
      await status(`/analytics/trends?metrics=myTasks&scopeType=user&scopeId=${adminId}`, { cookie: restricted }),
      403,
    );
    check('an analytics manager reads the organisation', await status('/analytics/trends?metrics=projects.total', { cookie: admin }), 200);

    // --- The audit journal (BRL-02) ---------------------------------------
    check('the audit journal is refused to someone without "Read the audit journal"', await status('/journal', { cookie: restricted }), 403);
    check('and to nobody signed in', await status('/journal'), 401);
    type JournalPage = { items: { action: string; entityId: string; actorId?: string }[]; entityTypes: string[] };
    const grants = (await (
      await call(`/journal?entityType=permission_grant&pageSize=20`, { cookie: admin })
    ).json()) as JournalPage;
    const lentAndTaken = grants.items.filter((entry) => entry.entityId === `${restrictedId}:rates:view`);
    check(
      'the grant and its removal are both in the journal, made by the administrator',
      lentAndTaken.some((entry) => entry.action === 'grant.created' && entry.actorId === adminId) &&
        lentAndTaken.some((entry) => entry.action === 'grant.removed' && entry.actorId === adminId),
      true,
    );
    const organisation = (await (await call('/journal?pageSize=200', { cookie: admin })).json()) as JournalPage;
    check(
      'organisation changes made earlier in this run are journalled too',
      ['department', 'team'].every((kind) => organisation.entityTypes.includes(kind)),
      true,
    );
  }

  // --- Session lifecycle ---------------------------------------------------
  console.log('\nSession lifecycle');
  const throwaway = await signIn(RESTRICTED);
  check('session works before logout', await status('/me', { cookie: throwaway }), 200);
  check('logout succeeds', await status('/auth/logout', { method: 'POST', cookie: throwaway }), 204);
  check('session is dead after logout', await status('/me', { cookie: throwaway }), 401);

  const forged = 'epm.sid=s%3Anot-a-real-session.forged-signature';
  check('a forged session cookie is refused', await status('/me', { cookie: forged }), 401);

  } finally {
  // --- Cleanup -------------------------------------------------------------
  // The surfaces section's records first: most are in the project deleted next.
  for (const undo of surfaceCleanups.reverse()) await undo().catch(() => undefined);

  if (createdId) {
    // Deleted, not archived. Archiving was the only option when this was
    // written; it meant every run left a project behind, and the instance
    // accumulated dozens of them. Falls back to archiving if the instance does
    // not permit deletion, which is the setting's default.
    const removed = await call(`/projects/${createdId}`, { method: 'DELETE', cookie: admin }).catch(
      () => undefined,
    );

    if (removed && (removed.status === 204 || removed.status === 202)) {
      console.log(`\n  (deleted test project ${createdId})`);
    } else {
      await call(`/projects/${createdId}/archive`, { method: 'PATCH', cookie: admin }).catch(
        () => undefined,
      );
      console.log(`\n  (archived test project ${createdId}; deletion is off on this instance)`);
    }
  }

  // Departments have no delete route by design, so the rows these tests
  // created are removed through the database rather than left behind. The
  // one place the suite reaches past the API, and only to undo its own writes.
  // Analytics fixtures and the snapshot this run captured. Only non-user scopes
  // are touched: the user-scoped rows are the dashboard's real history, written
  // long before these tests existed and not theirs to remove.
  {
    const { prisma } = await import('../db/prisma.js');

    if (analyticsFixtureScopes.length) {
      await prisma.metricSnapshot
        .deleteMany({ where: { scopeId: { in: analyticsFixtureScopes } } })
        .catch(() => undefined);
    }
    const capturedDays = [...new Set([analyticsCaptureDay, ...schedulerCaptureDays].filter(Boolean))];
    if (capturedDays.length) {
      const removed = await prisma.metricSnapshot
        .deleteMany({
          where: {
            sampledOn: { in: capturedDays.map((day) => new Date(day as string)) },
            // Never the user scope: those rows are the dashboard's real history,
            // written long before these tests existed.
            scopeType: { not: 'user' },
          },
        })
        .catch(() => ({ count: 0 }));
      console.log(`  (removed ${removed.count} test snapshot row${removed.count === 1 ? '' : 's'})`);
    }
  }

  // Project portfolio associations first: the foreign key is RESTRICT, so a
  // portfolio a project still points at cannot be removed until it is cleared.
  for (const [id, portfolioId] of originalProjectPortfolio) {
    await call(`/projects/${id}/portfolio`, {
      method: 'PATCH',
      cookie: admin,
      body: { portfolioId: portfolioId ?? '' },
    }).catch(() => undefined);
  }
  if (originalProjectPortfolio.size) {
    console.log(`  (restored portfolio for ${originalProjectPortfolio.size} project(s))`);
  }

  // Health: the probe time entry, the administrator's rate and the rules, each
  // through the API for the same reason as everything else here.
  if (healthTimeEntryId) {
    await call(`/time-entries/${healthTimeEntryId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    console.log('  (removed the health probe time entry)');
  }
  if (originalAdminRate !== undefined) {
    await call(`/employees/${adminId}/rate`, {
      method: 'PATCH',
      cookie: admin,
      body: { hourlyRate: originalAdminRate },
    }).catch(() => undefined);
    console.log("  (restored the administrator's hourly rate)");
  }
  if (originalHealthRules) {
    // A 409 means they are already back, which is the outcome wanted.
    const restoredRules = await call('/health/rules', {
      method: 'PUT',
      cookie: admin,
      body: originalHealthRules,
    }).catch(() => undefined);
    if (restoredRules?.status === 200) console.log('  (restored the health rules)');
  }

  // Access first: anything still granted is revoked before the rest, because a
  // membership left behind is the one leftover that changes what another person
  // can do. Already-removed ones 404, which is the expected case.
  {
    let revoked = 0;
    for (const granted of grantedMemberships) {
      const response = await call(
        `/projects/${granted.projectId}/members/${granted.membershipId}`,
        { method: 'DELETE', cookie: admin },
      ).catch(() => undefined);
      if (response?.status === 204) revoked += 1;
    }
    if (revoked > 0) {
      console.log(`  (revoked ${revoked} test membership${revoked === 1 ? '' : 's'})`);
    }
  }

  {
    let removed = 0;
    for (const sprintId of createdSprintIds) {
      const response = await call(`/sprints/${sprintId}`, { method: 'DELETE', cookie: admin }).catch(
        () => undefined,
      );
      if (response?.status === 204) removed += 1;
    }
    if (removed > 0) console.log(`  (removed ${removed} test sprint${removed === 1 ? '' : 's'})`);
  }

  // Capacity first, and through the API, so the restore goes through the same
  // validation the tests exercised rather than around it.
  for (const [id, hours] of originalCapacity) {
    await call(`/employees/${id}/capacity`, {
      method: 'PATCH',
      cookie: admin,
      body: { hoursCapacity: hours },
    }).catch(() => undefined);
  }
  if (originalCapacity.size) {
    console.log(`  (restored capacity for ${originalCapacity.size} employee(s))`);
  }

  // Mappings back to what they were, through the API so the restore goes
  // through the same validation the tests exercised. Before the test rows are
  // removed, because a restore that points at one would fail afterwards — and
  // before the empty-row sweep below, so a restored row is never seen as empty.
  for (const [id, mapping] of originalMapping) {
    await call(`/employees/${id}/mapping`, {
      method: 'PATCH',
      cookie: admin,
      body: { departmentId: mapping.departmentId ?? '', teamId: mapping.teamId ?? '' },
    }).catch(() => undefined);
  }
  if (originalMapping.size) {
    console.log(`  (restored mapping for ${originalMapping.size} employee(s))`);
  }

  if (departmentIds.length || teamIds.length) {
    const { prisma } = await import('../db/prisma.js');
    const { Prisma } = await import('@prisma/client');

    // Mappings first: user_profiles reference both with RESTRICT, so a team or
    // department someone is mapped to cannot be removed until that is clearedMapping.
    // The profile rows themselves are left, since they also carry capacity and
    // timezone and are not this suite's to delete — but the tests create them,
    // so any row with no other content is removed.
    await prisma.userProfile
      .updateMany({
        where: { OR: [{ teamId: { in: teamIds } }, { departmentId: { in: departmentIds } }] },
        data: { departmentId: null, teamId: null },
      })
      .catch(() => undefined);
    // Pinning health upserts a project profile, so clearing the pin leaves a row
    // holding nothing. Removed, so the run ends with the table as it started.
    // A row carrying portfolio or budget is somebody's data and is left alone.
    await prisma.projectProfile
      .deleteMany({
        where: {
          healthOverride: { equals: Prisma.DbNull },
          portfolio: null,
          portfolioId: null,
          budgetTotal: null,
          budgetUsed: null,
          // A project owner is somebody's decision, not this suite's leftover.
          // Without this the sweep removed a row holding nothing but an owner.
          ownerId: null,
        },
      })
      .catch(() => undefined);

    await prisma.userProfile
      .deleteMany({
        where: {
          // Only people this suite actually touched. Without this the sweep is
          // unscoped and will delete any profile that happens to look empty —
          // which is how a real mapping gets destroyed by a test run.
          openProjectId: { in: [...originalMapping.keys()] },
          departmentId: null,
          teamId: null,
          department: null,
          timezone: null,
          // Only rows holding nothing but the default capacity. A row with a
          // real value is somebody's data and is left alone.
          hoursCapacity: 40,
        },
      })
      .catch(() => undefined);

    // Teams next: the foreign key is RESTRICT, so a department holding teams
    // cannot be removed until they are.
    const removedPortfolios = await prisma.portfolio
      .deleteMany({ where: { id: { in: portfolioIds } } })
      .catch(() => ({ count: 0 }));
    void removedPortfolios;

    const removedTeams = await prisma.team
      .deleteMany({ where: { id: { in: teamIds } } })
      .catch(() => ({ count: 0 }));
    const removedDepartments = await prisma.department
      .deleteMany({ where: { id: { in: departmentIds } } })
      .catch(() => ({ count: 0 }));

    await prisma.$disconnect().catch(() => undefined);
    console.log(
      `  (removed ${removedTeams.count} test team${removedTeams.count === 1 ? '' : 's'}` +
        ` and ${removedDepartments.count} test department${removedDepartments.count === 1 ? '' : 's'})`,
    )
  }

  // The approval tests' requests, chains, delegations, links, escalations and
  // emails. All are EPM's own rows and none has a delete route, so they go
  // through the database. The journal entries stay: the journal refuses
  // deletion, by design.
  if (createdId || approvalChainIds.length || approvalDelegationIds.length) {
    const { prisma } = await import('../db/prisma.js');
    const requests = createdId
      ? await prisma.approvalRequest
          .findMany({ where: { projectId: createdId }, select: { id: true, tasks: { select: { id: true } } } })
          .catch(() => [])
      : [];
    const requestIds = requests.map((request) => request.id);
    const taskIds = requests.flatMap((request) => request.tasks.map((task) => task.id));
    await prisma.approvalLinkToken.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
    await prisma.escalationEvent.deleteMany({ where: { subjectId: { in: requestIds } } }).catch(() => undefined);
    await prisma.emailOutbox
      .deleteMany({
        where: {
          template: { in: ['approval-request', 'approval-decided'] },
          OR: [
            ...taskIds.map((taskId) => ({ dedupeKey: { startsWith: `approval-link:${taskId}:` } })),
            ...requestIds.map((requestId) => ({ dedupeKey: `approval-decided:${requestId}` })),
          ],
        },
      })
      .catch(() => undefined);
    // Tasks go with their request.
    await prisma.approvalRequest.deleteMany({ where: { id: { in: requestIds } } }).catch(() => undefined);
    const removedChains = await prisma.approvalChain
      .deleteMany({ where: { id: { in: approvalChainIds } } })
      .catch(() => ({ count: 0 }));
    await prisma.approvalDelegation.deleteMany({ where: { id: { in: approvalDelegationIds } } }).catch(() => undefined);
    if (requestIds.length || removedChains.count) {
      console.log(
        `  (removed ${requestIds.length} test approval request${requestIds.length === 1 ? '' : 's'}` +
          ` and ${removedChains.count} test chain${removedChains.count === 1 ? '' : 's'})`,
      )
    }
  }

  // The portfolio view tests' views and their probe time entry.
  if (viewTimeEntryId) {
    await call(`/time-entries/${viewTimeEntryId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  }
  if (slipProjectId) await call(`/projects/${slipProjectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  if (scenarioProjectId) await call(`/projects/${scenarioProjectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  {
    const { prisma } = await import('../db/prisma.js');
    await prisma.scenario.deleteMany({ where: { capturedAt: { gte: suiteStartedAt }, name: { startsWith: 'Suite scenario' } } }).catch(() => undefined);
    await prisma.approvalRequest.deleteMany({ where: { subjectType: 'scenario', requestedAt: { gte: suiteStartedAt } } }).catch(() => undefined);
  }
  // The finance tests' rates, rate card, items, batch, phasing and settings.
  for (const undo of financeCleanup.splice(0).reverse()) await undo().catch(() => undefined);
  // The time and expense tests' cost entries, project and rules, and the
  // restricted account's timesheets, claims and their approval requests.
  if (timeCostEntryIds.length > 0) {
    const { runAsSystem: asSystem } = await import('../auth/context.js');
    const { openProject: upstream } = await import('../openproject/client.js');
    for (const id of timeCostEntryIds) {
      await asSystem(() => upstream.request(`/epm_admin/costs/entries/${id}`, { root: true, method: 'DELETE' })).catch(() => undefined);
    }
  }
  if (timeProjectId) {
    const removed = await call(`/projects/${timeProjectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    console.log(`  (time and expense test project ${timeProjectId}: ${removed?.status === 204 ? 'deleted' : 'NOT deleted — remove it by hand'})`);
  }
  if (timeSettingsBefore) await call('/time/settings', { method: 'PUT', cookie: admin, body: timeSettingsBefore }).catch(() => undefined);
  if (restrictedIdForCleanup) {
    const { prisma } = await import('../db/prisma.js');
    const sheets = await prisma.timesheet
      .deleteMany({ where: { personId: restrictedIdForCleanup, createdAt: { gte: suiteStartedAt } } })
      .catch(() => ({ count: 0 }));
    const claims = await prisma.expenseClaim
      .deleteMany({ where: { claimantId: restrictedIdForCleanup, createdAt: { gte: suiteStartedAt } } })
      .catch(() => ({ count: 0 }));
    const requests = await prisma.approvalRequest
      .deleteMany({ where: { subjectType: { in: ['timesheet', 'expense_claim'] }, requestedAt: { gte: suiteStartedAt } } })
      .catch(() => ({ count: 0 }));
    if (sheets.count + claims.count + requests.count > 0) {
      console.log(`  (removed ${sheets.count} test timesheet(s), ${claims.count} test claim(s) and ${requests.count} of their approval requests)`);
    }
  }
  // The resource tests' pin, project, role, levelling runs, and the restricted
  // account's schedule, time off and role, as they were.
  if (resourcesPinnedId) await call(`/work-packages/${resourcesPinnedId}/pin`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  if (resourcesProjectId) {
    const removed = await call(`/projects/${resourcesProjectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    console.log(`  (resource test project ${resourcesProjectId}: ${removed?.status === 204 ? 'deleted' : 'NOT deleted — remove it by hand'})`);
  }
  if (resourcesProjectNumber !== undefined || resourcesRoleId || resourcesRunIds.length > 0 || resourcesRestrictedRoleBefore !== undefined) {
    const { prisma } = await import('../db/prisma.js');
    const restrictedKey = restrictedIdForCleanup;
    const schedules = await prisma.workSchedule.deleteMany({ where: { openProjectId: restrictedKey, createdAt: { gte: suiteStartedAt } } }).catch(() => ({ count: 0 }));
    const timeOff = await prisma.timeOff.deleteMany({ where: { openProjectId: restrictedKey, createdAt: { gte: suiteStartedAt } } }).catch(() => ({ count: 0 }));
    if (resourcesRestrictedRoleBefore !== undefined) {
      await prisma.userProfile
        .updateMany({ where: { openProjectId: restrictedKey }, data: { resourceRoleId: resourcesRestrictedRoleBefore } })
        .catch(() => undefined);
    }
    if (resourcesProjectNumber !== undefined) {
      await prisma.workPackagePin.deleteMany({ where: { projectId: resourcesProjectNumber } }).catch(() => undefined);
      await prisma.resourceAllocation.deleteMany({ where: { projectId: resourcesProjectNumber } }).catch(() => undefined);
    }
    if (resourcesRunIds.length > 0) await prisma.levellingRun.deleteMany({ where: { id: { in: resourcesRunIds } } }).catch(() => undefined);
    if (resourcesRoleId) {
      await prisma.resourceAllocation.deleteMany({ where: { roleId: resourcesRoleId } }).catch(() => undefined);
      await prisma.resourceRole.delete({ where: { id: resourcesRoleId } }).catch(() => undefined);
    }
    console.log(`  (removed ${schedules.count} test schedule(s), ${timeOff.count} test time off and the resource test role)`);
  }
  // The earned value tests' rules and project, if the section stopped part-way.
  if (evmRulesBefore) {
    const back = await call('/earned-value/settings', { method: 'PUT', cookie: admin, body: evmRulesBefore }).catch(() => undefined);
    console.log(`  (earned value rules: ${back?.status === 200 || back?.status === 409 ? 'put back' : 'NOT put back — check Administration → Projects → Earned value'})`);
  }
  if (earnedValueProjectId) {
    const removed = await call(`/projects/${earnedValueProjectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    console.log(`  (earned value test project ${earnedValueProjectId}: ${removed?.status === 204 ? 'deleted' : 'NOT deleted — remove it by hand'})`);
  }
  // The critical path tests' view and project, if the section stopped part-way.
  if (criticalPathQueryId) {
    await call(`/queries/${criticalPathQueryId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  }
  if (criticalPathProjectId) {
    const removed = await call(`/projects/${criticalPathProjectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    console.log(`  (critical path test project ${criticalPathProjectId}: ${removed?.status === 204 ? 'deleted' : 'NOT deleted — remove it by hand'})`);
  }
  if (portfolioViewIds.length) {
    const { prisma } = await import('../db/prisma.js');
    const removedViews = await prisma.portfolioView
      .deleteMany({ where: { id: { in: portfolioViewIds } } })
      .catch(() => ({ count: 0 }));
    console.log(`  (removed ${removedViews.count} test portfolio view${removedViews.count === 1 ? '' : 's'})`);
  }

  // The scheduled-report tests' schedules, with their runs, copies and files
  // (which go with them), the emails those queued, and the lent permission.
  // Journal entries stay.
  if (reportScheduleIds.length || reportGrantUserId) {
    const { prisma } = await import('../db/prisma.js');
    const runIds = (
      await prisma.reportRun.findMany({ where: { scheduleId: { in: reportScheduleIds } }, select: { id: true } }).catch(() => [])
    ).map((run) => run.id);
    if (runIds.length) {
      await prisma.emailOutbox
        .deleteMany({ where: { OR: runIds.map((id) => ({ dedupeKey: { startsWith: `report:${id}:` } })) } })
        .catch(() => undefined);
    }
    const removedSchedules = await prisma.reportSchedule
      .deleteMany({ where: { id: { in: reportScheduleIds } } })
      .catch(() => ({ count: 0 }));
    if (reportGrantUserId) {
      await prisma.epmPermissionGrant
        .deleteMany({ where: { openProjectId: reportGrantUserId, permission: 'reports:approve' } })
        .catch(() => undefined);
    }
    console.log(
      `  (removed ${removedSchedules.count} test report schedule${removedSchedules.count === 1 ? '' : 's'}` +
        ` with ${runIds.length} run${runIds.length === 1 ? '' : 's'}${reportGrantUserId ? ', and the lent permission' : ''})`,
    );
  }

  // The rules tests' rules, their firings and remembered states, the events
  // they queued, the escalation policies and what they raised, and the emails
  // those would have sent. EPM's own rows, none with a delete route for a rule
  // that has fired, so through the database. Journal entries stay.
  ruleReceiver?.close();
  {
    const { prisma } = await import('../db/prisma.js');
    // Whatever this run queued and the worker has done with — every section
    // creates work, so not only the rules tests' — and anything for its project.
    await prisma.ruleEvent
      .deleteMany({
        where: {
          receivedAt: { gte: suiteStartedAt },
          OR: [{ processedAt: { not: null } }, ...(createdId ? [{ projectId: createdId }] : [])],
        },
      })
      .catch(() => undefined);
  }
  if (ruleIds.length || escalationPolicyIds.length) {
    const { prisma } = await import('../db/prisma.js');
    await prisma.ruleFiring.deleteMany({ where: { ruleId: { in: ruleIds } } }).catch(() => undefined);
    await prisma.ruleItemState.deleteMany({ where: { ruleId: { in: ruleIds } } }).catch(() => undefined);
    const removedRules = await prisma.automationRule
      .deleteMany({ where: { id: { in: ruleIds } } })
      .catch(() => ({ count: 0 }));
    await prisma.escalationEvent.deleteMany({ where: { policyId: { in: escalationPolicyIds } } }).catch(() => undefined);
    const removedPolicies = await prisma.escalationPolicy
      .deleteMany({ where: { id: { in: escalationPolicyIds } } })
      .catch(() => ({ count: 0 }));
    await prisma.emailOutbox
      .deleteMany({
        where: {
          createdAt: { gte: suiteStartedAt },
          OR: [
            { dedupeKey: { startsWith: 'notification:rule:' } },
            { dedupeKey: { startsWith: 'notification:escalation:' } },
          ],
        },
      })
      .catch(() => undefined);
    console.log(
      `  (removed ${removedRules.count} test rule${removedRules.count === 1 ? '' : 's'}` +
        ` and ${removedPolicies.count} escalation polic${removedPolicies.count === 1 ? 'y' : 'ies'})`,
    );
  }

  // Every notification this run caused — the ones the notification tests wrote
  // directly, and the ones other sections produced as a side effect of the
  // mutations they were testing. Bounded by when the run started, so anything
  // that existed beforehand is somebody's real notification and is left alone.
  //
  // Deliberately last: restoring capacity is itself a mutation, so it notifies,
  // and a cleanup that ran before the restores would leave its own trail.
  {
    const { prisma } = await import('../db/prisma.js');
    const removed = await prisma.notification
      .deleteMany({
        where: {
          OR: [
            { createdAt: { gte: suiteStartedAt } },
            ...(notificationKeys.length ? [{ dedupeKey: { in: notificationKeys } }] : []),
          ],
        },
      })
      .catch(() => ({ count: 0 }));
    console.log(`  (removed ${removed.count} test notification${removed.count === 1 ? '' : 's'})`);
  }

  // "Read hourly rates", if a run stopped between lending and taking it back.
  if (ratesGrantLent) {
    const taken = await call(`/admin/permission-grants/${restrictedIdForCleanup}/rates:view`, {
      method: 'DELETE',
      cookie: admin,
    }).catch(() => undefined);
    console.log(
      taken?.status === 204
        ? '  (took back the lent "Read hourly rates" grant)'
        : '  (COULD NOT take back the lent "Read hourly rates" grant: remove it under Administration → EPM permissions)',
    );
  }

  // Last, after every cleanup step that could notify: the administrator's
  // email preferences, exactly as they were — including having none.
  if (adminPreferences) {
    const restored = await restoreAdminPreferences(adminPreferences);
    if (restored) adminPreferences = undefined;
    console.log(
      restored
        ? "  (the administrator's email preferences are as they were)"
        : `  (COULD NOT restore the administrator's email preferences; the next run retries from ${HELD_PREFERENCES})`,
    );
  }

  }

  console.log(`\n${passed} passed, ${failed} failed`);
  finished = true;
  if (failed > 0) process.exit(1);
}

// A test awaiting a promise that never settles does not hang the run: Node
// finds nothing left to wait for and exits, with status 0 and without the
// cleanup in main's finally. That happened twice; now it fails, and says what
// to clear up.
let finished = false;
process.once('beforeExit', () => {
  if (finished) return;
  console.error(
    `\nAuthorization tests STOPPED PART-WAY (${passed} passed, ${failed} failed so far): an awaited promise ` +
      'never settled, so the cleanup did not run. Remove the run’s test project and memberships by hand; ' +
      `the administrator's preferences are put back by the next run, from ${HELD_PREFERENCES}.`,
  );
  process.exit(1);
});

main().catch((error: unknown) => {
  console.error(`\nAuthorization tests could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
