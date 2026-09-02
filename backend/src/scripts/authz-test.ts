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
 */

const BASE = process.env.AUTHZ_BASE_URL ?? 'http://localhost:8000/api';

const ADMIN = {
  username: process.env.AUTHZ_ADMIN_USER ?? 'admin',
  password: process.env.AUTHZ_ADMIN_PASSWORD ?? 'admin12345',
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

  // --- Authentication ------------------------------------------------------
  console.log('Authentication');
  check('anonymous GET /me is refused', await status('/me'), 401);
  check('anonymous POST /projects is refused', await status('/projects', {
    method: 'POST',
    body: { payload: { name: 'x', identifier: 'x' } },
  }), 401);

  const badCredentials = await call('/auth/login', {
    method: 'POST',
    body: { username: ADMIN.username, password: 'definitely-not-the-password' },
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

  const admin = await signIn(ADMIN);
  const restricted = await signIn(RESTRICTED);
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
  const createdId = created.ok ? ((await created.json()) as { id: string }).id : undefined;

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

  // --- Session lifecycle ---------------------------------------------------
  console.log('\nSession lifecycle');
  const throwaway = await signIn(RESTRICTED);
  check('session works before logout', await status('/me', { cookie: throwaway }), 200);
  check('logout succeeds', await status('/auth/logout', { method: 'POST', cookie: throwaway }), 204);
  check('session is dead after logout', await status('/me', { cookie: throwaway }), 401);

  const forged = 'epm.sid=s%3Anot-a-real-session.forged-signature';
  check('a forged session cookie is refused', await status('/me', { cookie: forged }), 401);

  // --- Cleanup -------------------------------------------------------------
  if (createdId) {
    await call(`/projects/${createdId}/archive`, { method: 'PATCH', cookie: admin }).catch(
      () => undefined,
    );
    console.log(`\n  (archived test project ${createdId})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\nAuthorization tests could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
