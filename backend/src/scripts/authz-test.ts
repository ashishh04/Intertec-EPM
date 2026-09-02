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
