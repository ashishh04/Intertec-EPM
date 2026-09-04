import type { ProjectHealth } from '../types/epm.js';
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
  const restrictedId = restrictedMe.id;
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

  const adminId = adminMe.id;

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

  const other = relatable[0]?.id;
  if (!other) throw new Error('No second work package available to relate to.');

  const searched = (await (
    await call(`/work-packages/${target}/relatable?q=${encodeURIComponent(relatable[0]!.subject.slice(0, 12))}`, {
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
  // Health pins are real management state. Whatever these tests set is put
  // back, including "there was no pin", which is a value too.
  const originalHealthOverride = new Map<string, Record<string, string> | null>();
  const portfolioIds: string[] = [];
  // A project's portfolio is real organisational state; whatever these tests
  // set is put back, including "it was in none".
  const originalProjectPortfolio = new Map<string, string | null>();
  // Snapshot rows these tests write. The user-scoped history the dashboard
  // has been recording since before this feature is left alone.
  const analyticsFixtureScopes: string[] = [];
  let analyticsCaptureDay: string | undefined;
  const schedulerCaptureDays: string[] = [];
  // Dedupe keys the notification tests create directly. Not the whole story:
  // the capacity, employee and portfolio sections mutate capacity through the
  // API, and each of those now produces a notification too. The timestamp below
  // is what catches those, since they cannot all be enumerated ahead of time.
  const notificationKeys: string[] = [];
  const suiteStartedAt = new Date();

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
      health?: { manage?: boolean };
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

  // Deletion is deliberately absent: teams and employee mappings will reference
  // departments, so removing one would orphan them.
  check(
    'there is no route for deleting a department',
    await status(`/departments/${deptId}`, { method: 'DELETE', cookie: admin }),
    404,
  );

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

  check(
    'there is no route for deleting a team',
    await status(`/teams/${teamId}`, { method: 'DELETE', cookie: admin }),
    404,
  );
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
  // The calculation is a pure function, so its boundaries are exercised
  // directly rather than through a project whose numbers cannot be arranged.
  // The override path goes through the API, and any pin these tests set is
  // captured and restored in the cleanup step.
  console.log('\nHealth');

  const {
    computeHealth,
    effectiveHealth,
    parseHealthOverride,
    HEALTH_THRESHOLDS,
  } = await import('../mapping/projects.js');

  const today = '2026-09-03';
  const at = (
    total: number,
    completed: number,
    overdue: number,
    dueDate?: string,
  ): ProjectHealth => computeHealth({ total, completed, overdue, dueDate, today }).health;

  // --- boundaries, on both sides of every threshold ---
  const t = HEALTH_THRESHOLDS;
  check('thresholds are named, not inline', typeof t.scheduleWarning, 'number');

  // Schedule turns on the share of work already overdue: 10% and 25%.
  check('schedule is healthy just below its warning', at(100, 0, 9).schedule, 'healthy');
  check('schedule warns exactly at its threshold', at(100, 0, 10).schedule, 'warning');
  check('schedule stays warning just below critical', at(100, 0, 24).schedule, 'warning');
  check('schedule is critical exactly at its threshold', at(100, 0, 25).schedule, 'critical');

  // Resources reads the same ratio at 15% and 35%.
  check('resources is healthy just below its warning', at(100, 0, 14).resources, 'healthy');
  check('resources warns exactly at its threshold', at(100, 0, 15).resources, 'warning');
  check('resources stays warning just below critical', at(100, 0, 34).resources, 'warning');
  check('resources is critical exactly at its threshold', at(100, 0, 35).resources, 'critical');

  // Scope reads the share still open: 60% and 85%.
  check('scope is healthy just below its warning', at(100, 41, 0).scope, 'healthy');
  check('scope warns exactly at its threshold', at(100, 40, 0).scope, 'warning');
  check('scope stays warning just below critical', at(100, 16, 0).scope, 'warning');
  check('scope is critical exactly at its threshold', at(100, 15, 0).scope, 'critical');

  // Past the due date, any meaningful amount of open work is critical.
  check('a past due date with 20% open is critical', at(100, 80, 0, '2026-01-01').scope, 'critical');
  check('a past due date with 5% open is not', at(100, 95, 0, '2026-01-01').scope, 'healthy');
  check('a future due date does not escalate', at(100, 80, 0, '2027-01-01').scope, 'healthy');

  // --- the three headline conditions ---
  check('a healthy project reports healthy overall', at(100, 90, 0).overall, 'healthy');
  check('a warning condition reports warning overall', at(100, 90, 12).overall, 'warning');
  check('a critical condition reports critical overall', at(100, 90, 40).overall, 'critical');
  check('overall is the worst dimension, not an average', at(100, 90, 40).schedule, 'critical');

  // --- missing and degenerate data ---
  // A project with no work packages is reported healthy rather than alarming,
  // and its reason says so rather than implying a clean bill of health.
  const empty = computeHealth({ total: 0, completed: 0, overdue: 0, today });
  check('a project with no work packages is healthy', empty.health.overall, 'healthy');
  check('and says why rather than implying a clean result', empty.reasons.overall.includes('no work packages'), true);
  check('no overdue work is healthy on schedule', at(50, 25, 0).schedule, 'healthy');
  check('all work overdue is critical', at(50, 0, 50).schedule, 'critical');
  check('all work complete is healthy on scope', at(50, 50, 0).scope, 'healthy');

  // Every dimension must be one of the three levels, whatever the inputs.
  let invalidLevels = 0;
  for (let total = 0; total <= 20; total += 1) {
    for (let completed = 0; completed <= total; completed += 1) {
      for (let overdue = 0; overdue <= total; overdue += 1) {
        const health = at(total, completed, overdue);
        for (const level of Object.values(health)) {
          if (!['healthy', 'warning', 'critical'].includes(level)) invalidLevels += 1;
        }
      }
    }
  }
  check('no input produces a level outside the three', invalidLevels, 0);

  // --- determinism ---
  const once = JSON.stringify(computeHealth({ total: 37, completed: 11, overdue: 9, dueDate: '2026-08-01', today }));
  check(
    'the same inputs give the same output every time',
    Array.from({ length: 50 }, () =>
      JSON.stringify(computeHealth({ total: 37, completed: 11, overdue: 9, dueDate: '2026-08-01', today })),
    ).every((result) => result === once),
    true,
  );

  // --- override resolution ---
  const failing: ProjectHealth = at(100, 0, 50);
  check('an undefined override changes nothing', effectiveHealth(failing, undefined).overall, 'critical');
  check('an empty override changes nothing', effectiveHealth(failing, {}).overall, 'critical');
  check('a pinned dimension is replaced', effectiveHealth(failing, { schedule: 'healthy' }).schedule, 'healthy');
  check(
    'other dimensions are untouched by it',
    effectiveHealth(failing, { schedule: 'healthy' }).scope,
    'critical',
  );
  // Overall follows the effective values, so pinning moves the headline.
  check(
    'pinning every dimension moves overall',
    effectiveHealth(failing, {
      scope: 'healthy',
      schedule: 'healthy',
      resources: 'healthy',
      budget: 'healthy',
    }).overall,
    'healthy',
  );
  // And overall can be pinned on its own, which takes precedence.
  check('overall can be pinned directly', effectiveHealth(failing, { overall: 'healthy' }).overall, 'healthy');
  check(
    'pinning overall leaves the dimensions showing the truth',
    effectiveHealth(failing, { overall: 'healthy' }).schedule,
    'critical',
  );

  // --- reading a stored override ---
  check('a null column is no override', parseHealthOverride(null), undefined);
  check('an empty object is no override', parseHealthOverride({}), undefined);
  check('an array is not an override', parseHealthOverride(['healthy']), undefined);
  check('a string is not an override', parseHealthOverride('healthy'), undefined);
  check(
    'a valid pin is read back',
    JSON.stringify(parseHealthOverride({ schedule: 'critical' })),
    '{"schedule":"critical"}',
  );
  // A malformed row must not take a project page down, so bad keys are dropped
  // rather than thrown on. The write path rejects them, so this is defence.
  check(
    'an unknown dimension is dropped rather than thrown on',
    JSON.stringify(parseHealthOverride({ nope: 'healthy', schedule: 'warning' })),
    '{"schedule":"warning"}',
  );
  check(
    'an unknown level is dropped too',
    parseHealthOverride({ schedule: 'purple' }),
    undefined,
  );

  // --- through the API ---
  const healthProject = (await (await call('/projects', { cookie: admin })).json()) as {
    id: string;
    health: ProjectHealth;
    healthCalculated: ProjectHealth;
    healthOverride?: Record<string, string>;
    healthReasons: Record<string, string>;
  }[];

  const projectId = healthProject[0]?.id;
  if (!projectId) throw new Error('No project available for the health tests.');

  // Snapshot before anything is pinned, so the cleanup can put it back.
  originalHealthOverride.set(projectId, healthProject[0]?.healthOverride ?? null);

  const readProject = async (cookie: string) =>
    ((await (await call('/projects', { cookie })).json()) as typeof healthProject).find(
      (p) => p.id === projectId,
    );

  const initial = await readProject(admin);
  check('a project carries its effective health', typeof initial?.health.overall, 'string');
  check('and the calculated value alongside it', typeof initial?.healthCalculated.overall, 'string');
  check('and a reason per dimension', typeof initial?.healthReasons.schedule, 'string');

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

  const setHealth = (body: Record<string, unknown>, cookie = admin) =>
    call(`/projects/${projectId}/health`, { method: 'PATCH', cookie, body });

  check('anonymous cannot pin health', await status(`/projects/${projectId}/health`, { method: 'PATCH', body: { overall: 'critical' } }), 401);
  check('a caller without the grant cannot pin health', (await setHealth({ overall: 'critical' }, restricted)).status, 403);
  check(
    'the health is unchanged after the refused write',
    (await readProject(admin))?.healthOverride,
    undefined,
  );

  check('an unknown dimension is refused', (await setHealth({ nope: 'healthy' })).status, 400);
  check('an unknown level is refused', (await setHealth({ overall: 'purple' })).status, 400);
  check('a non-string level is refused', (await setHealth({ overall: 3 })).status, 400);
  check(
    'an unknown project is not found',
    (await setHealth({ overall: 'critical' }) && (await call('/projects/99999999/health', { method: 'PATCH', cookie: admin, body: { overall: 'critical' } })).status),
    404,
  );

  const pinned = await setHealth({ schedule: 'critical' });
  check('a permitted caller can pin a dimension', pinned.status, 200);
  const pinnedBody = (await pinned.json()) as (typeof healthProject)[number];
  check('the effective value takes the pin', pinnedBody.health.schedule, 'critical');
  check('overall follows it', pinnedBody.health.overall, 'critical');
  // The calculated value stays visible: a pin that hides the signal underneath
  // it is a way to lose information rather than to manage it.
  check('the calculated value is still reported', pinnedBody.healthCalculated.schedule, 'healthy');
  check('the override is reported', JSON.stringify(pinnedBody.healthOverride), '{"schedule":"critical"}');

  const changed = (await (await setHealth({ schedule: 'warning' })).json()) as (typeof healthProject)[number];
  check('a pin can be changed', JSON.stringify(changed.healthOverride), '{"schedule":"warning"}');
  check('and the effective value follows', changed.health.schedule, 'warning');

  const clearedHealth = (await (await setHealth({})).json()) as (typeof healthProject)[number];
  check('an empty body clears every pin', clearedHealth.healthOverride, undefined);
  check('and health returns to calculated', clearedHealth.health.overall, clearedHealth.healthCalculated.overall);

  // A summary must not contradict the project page it summarises.
  const readAtRisk = async () =>
    ((await (await call('/dashboard/metrics', { cookie: admin })).json()) as {
      projectsAtRisk: number;
    }).projectsAtRisk;

  const atRiskBefore = await readAtRisk();
  await setHealth({ overall: 'critical' });
  const atRiskPinned = await readAtRisk();
  await setHealth({ overall: 'healthy' });
  const atRiskHealthy = await readAtRisk();
  await setHealth({});

  // The count has to move with the pin in both directions, or a summary could
  // still be reporting what the rules said while the project page shows a pin.
  check('pinning a project critical raises the at-risk count', atRiskPinned > atRiskHealthy, true);
  check('pinning it healthy removes it from the count', atRiskHealthy <= atRiskBefore, true);

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
    'there is no route for deleting a portfolio',
    await status(`/portfolios/${portfolioId}`, { method: 'DELETE', cookie: admin }),
    404,
  );
  check(
    'an unknown portfolio cannot be updated',
    await status('/portfolios/no-such-id', { method: 'PATCH', cookie: admin, body: { name: 'X' } }),
    404,
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
  let releaseCapture: (() => void) | undefined;
  const slow = createAnalyticsSnapshotScheduler({
    log: testLog,
    capture: async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      return { sampledOn: '2026-01-01', records: 7, scopes: {} };
    },
    intervalMs: 60 * 60_000,
    firstRunDelayMs: 60 * 60_000,
  });

  const inFlight = slow.tick();
  await new Promise((resolve) => setImmediate(resolve));
  check('a capture in flight is reported as running', slow.running, true);
  await slow.tick();
  check('an overlapping tick is skipped rather than queued', started, 1);
  check('and says so', logLines.some((line) => line.includes('skipped')), true);
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
    evaluateHealthTransitions,
  } = await import('../domain/notifications.js');
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

  // Evaluating the same live projects twice must not produce a second round.
  const liveProjects = (await (await call('/projects', { cookie: admin })).json()) as {
    id: string;
    name: string;
    ownerId: string;
    status: string;
    health: { overall: string };
  }[];
  await evaluateHealthTransitions(liveProjects as never);
  const afterFirstPass = await notificationDb.notification.count();
  await evaluateHealthTransitions(liveProjects as never);
  check(
    're-evaluating unchanged projects creates nothing',
    await notificationDb.notification.count(),
    afterFirstPass,
  );

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

    const lifecycleId = ((await createdLifecycle.json()) as { id: string }).id;

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

  // Health pins first, through the API for the same reason.
  for (const [id, override] of originalHealthOverride) {
    await call(`/projects/${id}/health`, {
      method: 'PATCH',
      cookie: admin,
      body: override ?? {},
    }).catch(() => undefined);
  }
  if (originalHealthOverride.size) {
    console.log(`  (restored health overrides for ${originalHealthOverride.size} project(s))`);
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
          budgetTotal: null,
          budgetUsed: null,
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\nAuthorization tests could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
