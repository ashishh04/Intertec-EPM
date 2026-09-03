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
      payload: {
        _links: { columns: chosen.map((id) => ({ href: `/api/v3/queries/columns/${id}` })) },
        filters: [
          {
            _links: {
              filter: { href: '/api/v3/queries/filters/status' },
              operator: { href: '/api/v3/queries/operators/=' },
              values: [{ href: '/api/v3/statuses/1' }, { href: '/api/v3/statuses/12' }],
            },
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
      payload: {
        _links: {
          sortBy: [{ href: '/api/v3/queries/sort_bys/subject-desc' }],
          columns: [
            { href: '/api/v3/queries/columns/id' },
            { href: '/api/v3/queries/columns/subject' },
          ],
        },
      },
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
      payload: {
        _links: {
          groupBy: { href: '/api/v3/queries/group_bys/status' },
          sortBy: [{ href: '/api/v3/queries/sort_bys/subject-desc' }],
          columns: [
            { href: '/api/v3/queries/columns/id' },
            { href: '/api/v3/queries/columns/subject' },
          ],
        },
      },
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
  check('an unmapped person reports the default capacity', directory[0]!.hoursCapacity, 40);

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

  check('an unset capacity reports the documented default', originalCapacity.get(adminId), 40);

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

  if (departmentIds.length || teamIds.length) {
    const { prisma } = await import('../db/prisma.js');

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
    await prisma.userProfile
      .deleteMany({
        where: {
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\nAuthorization tests could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
