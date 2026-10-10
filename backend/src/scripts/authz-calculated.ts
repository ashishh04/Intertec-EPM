/**
 * Calculated fields (BR-406 to BR-408), for the authorisation suite.
 *
 * Run from authz-test.ts with the suite's own helpers and sessions, like
 * authz-surfaces.ts. In a project of its own, with work packages of its own:
 *
 *   - only `fields:configure` may define, change, recalculate or delete a
 *     calculated field; the account with no project role is refused each;
 *   - BR-406: a small set of fields gives the values worked by hand on every
 *     work package, a missing input included (with the reason) and a roll-up
 *     over a three-level tree;
 *   - BR-407: a view filtered on a calculated field, through EPM's task query
 *     API, returns exactly the expected work packages, and sums the field;
 *   - BR-408: a circular reference and a formula over the size limit are
 *     refused when they are defined, and nothing is made for either;
 *   - nobody can type over a calculated value.
 *
 * Every field, OpenProject custom field (deleted with its field) and work
 * package it makes is registered for removal the moment it exists, so a run
 * stopped part-way still takes them away.
 */

/** The options the suite's `call` takes. */
type CallOptions = { method?: string; cookie?: string; body?: unknown };

export interface CalculatedContext {
  call: (path: string, options?: CallOptions) => Promise<Response>;
  status: (path: string, options?: CallOptions) => Promise<number>;
  check: (name: string, actual: unknown, expected: unknown) => void;
  admin: string;
  restricted: string;
  /** Registers a removal, run in the suite's cleanup however far the run got. */
  cleanup: { onCleanup(fn: () => Promise<void>): void };
}

type Json = Record<string, any>;

export async function calculatedChecks(ctx: CalculatedContext): Promise<void> {
  const { call, status, check, admin, restricted, cleanup } = ctx;
  const json = async (response: Response): Promise<Json> => ((await response.json().catch(() => ({}))) ?? {}) as Json;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const stamp = Date.now();
  const suffix = stamp.toString(36);
  const key = (name: string) => `${name}_${suffix}`;
  const DAY = 86_400_000;
  const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

  console.log('\nCalculated fields');

  // --- A project of its own -------------------------------------------------
  const made = await call('/projects', {
    method: 'POST',
    cookie: admin,
    body: { payload: { name: `Calculated Fields Test ${stamp}`, identifier: `calc-test-${stamp}` } },
  });
  check('a project is made for the calculated field tests', made.status, 201);
  const projectId = (await json(made)).id as string | undefined;
  if (!projectId) return;
  cleanup.onCleanup(async () => {
    await call(`/projects/${projectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
  });

  const task = async (subject: string, extra: Json = {}) => {
    const response = await call('/tasks', {
      method: 'POST',
      cookie: admin,
      body: { projectId, subject, status: 'todo', priority: 'medium', ...extra },
    });
    return (await json(response)).id as string;
  };
  /*
   * Worked by hand:
   *   Phase  P  est 2          parent of A, B, C       total 2 + 8 + 0 + 6 = 16
   *   Design A  est 8                                   total 8
   *   Build  B  no estimate                             total 0, variance none
   *   Test   C  est 4          parent of D             total 4 + 2 = 6
   *   Data   D  est 2                                   total 2
   *   Late   E  on its own, due a week ago              late yes
   *   Idea   F  on its own, no dates                    late none
   */
  const ids: Record<string, string> = {};
  ids.P = await task(`Phase ${suffix}`, { estimatedHours: 2 });
  ids.A = await task(`Design ${suffix}`, { parentId: ids.P, estimatedHours: 8 });
  ids.B = await task(`Build ${suffix}`, { parentId: ids.P });
  ids.C = await task(`Test ${suffix}`, { parentId: ids.P, estimatedHours: 4 });
  ids.D = await task(`Data ${suffix}`, { parentId: ids.C, estimatedHours: 2 });
  ids.E = await task(`Late ${suffix}`, { startDate: iso(Date.now() - 14 * DAY), dueDate: iso(Date.now() - 7 * DAY) });
  ids.F = await task(`Idea ${suffix}`);
  check('seven work packages are made, four of them in a three-level tree', Object.values(ids).every(Boolean), true);
  const nameOf = new Map(Object.entries(ids).map(([name, id]) => [id, name]));

  // --- Who may define --------------------------------------------------------
  const definition = (name: string, label: string, resultType: string, expression: string) => ({
    key: key(name),
    name: `${label} ${suffix}`,
    resultType,
    expression,
    projectIds: [projectId],
  });
  check(
    'someone without fields:configure cannot define a calculated field',
    await status('/calculated-fields', { method: 'POST', cookie: restricted, body: definition('nope', 'Nope', 'number', '1') }),
    403,
  );
  check(
    'nor try a formula',
    await status('/calculated-fields/validate', { method: 'POST', cookie: restricted, body: { resultType: 'number', expression: '1' } }),
    403,
  );
  check('nor recalculate', await status('/calculated-fields/recalculate', { method: 'POST', cookie: restricted }), 403);

  const fields: Record<string, Json> = {};
  const define = async (name: string, label: string, resultType: string, expression: string) => {
    const response = await call('/calculated-fields', { method: 'POST', cookie: admin, body: definition(name, label, resultType, expression) });
    const body = await json(response);
    if (response.status === 201) {
      fields[name] = body;
      cleanup.onCleanup(async () => {
        await call(`/calculated-fields/${body.id}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
      });
    }
    return response.status;
  };
  check(
    'an administrator defines a roll-up over the whole tree',
    await define('total', 'Total work', 'number', `COALESCE(estimatedHours, 0) + COALESCE(SUM_CHILDREN(${key('total')}), 0)`),
    201,
  );
  check('a difference, empty where its input is', await define('variance', 'Variance', 'number', 'estimatedHours - 1'), 201);
  check('and a condition on a date', await define('late', 'Late', 'boolean', 'dueDate < TODAY()'), 201);
  if (!fields.total || !fields.variance || !fields.late) return;
  check('each has an OpenProject field, a column views use', [fields.total, fields.variance, fields.late].every((field) => /^customField\d+$/.test(field.column ?? '')), true);
  check(
    'someone without fields:configure cannot change one',
    await status(`/calculated-fields/${fields.total.id}`, { method: 'PATCH', cookie: restricted, body: { expression: '1' } }),
    403,
  );
  check('nor switch one off', await status(`/calculated-fields/${fields.total.id}/deactivate`, { method: 'POST', cookie: restricted }), 403);
  check('nor delete one', await status(`/calculated-fields/${fields.total.id}`, { method: 'DELETE', cookie: restricted }), 403);

  // --- BR-406: the values ------------------------------------------------------
  const valuesOf = async () => {
    const all: Record<string, Record<string, Json>> = {};
    for (const [name, id] of Object.entries(ids)) {
      const list = (await (await call(`/work-packages/${id}/calculated-values`, { cookie: admin })).json().catch(() => [])) as Json[];
      all[name] = Object.fromEntries((Array.isArray(list) ? list : []).map((value) => [value.key, value]));
    }
    return all;
  };
  // Every work package here is in all three fields' scope, so each holds a row
  // for each — with a value or the reason it has none — once a pass has run
  // over all three.
  let values: Record<string, Record<string, Json>> = {};
  const complete = () =>
    Object.keys(ids).every((name) => ['total', 'variance', 'late'].every((field) => values[name]?.[key(field)] !== undefined)) &&
    values.P?.[key('total')]?.value === 16;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    values = await valuesOf();
    if (complete()) break;
    await pause(1_000);
  }
  const of = (field: string, items: string[]) =>
    JSON.stringify(Object.fromEntries(items.map((item) => [item, values[item]?.[key(field)]?.value ?? null])));
  check(
    'BR-406: the roll-up is worked by hand on every work package of the tree',
    of('total', ['P', 'A', 'B', 'C', 'D']),
    JSON.stringify({ P: 16, A: 8, B: 0, C: 6, D: 2 }),
  );
  check('a difference is computed where its input is there', of('variance', ['P', 'A', 'C', 'D']), JSON.stringify({ P: 1, A: 7, C: 3, D: 1 }));
  check('and empty where it is not', values.B?.[key('variance')]?.value ?? null, null);
  check('saying why', values.B?.[key('variance')]?.reason, 'estimatedHours has no value.');
  check('a work package a week overdue is late', values.E?.[key('late')]?.value, true);
  check('one with no finish date has no value for it', values.F?.[key('late')]?.value ?? null, null);
  check(
    'someone who cannot see the project cannot read a work package’s values',
    await status(`/work-packages/${ids.A}/calculated-values`, { cookie: restricted }),
    404,
  );

  // --- BR-407: in views ----------------------------------------------------------
  const column = fields.total.column as string;
  let view: Json = {};
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const filters = encodeURIComponent(JSON.stringify([{ [column]: { operator: '>=', values: ['6'] } }]));
    view = await json(await call(`/queries/default?projectId=${projectId}&filters=${filters}&showSums=true`, { cookie: admin }));
    if (((view.tasks ?? []) as Json[]).length === 3) break;
    await pause(1_000);
  }
  check(
    'BR-407: a view filtered on Total work ≥ 6 returns exactly Phase, Design and Test',
    JSON.stringify(((view.tasks ?? []) as Json[]).map((one) => nameOf.get(String(one.id))).sort()),
    JSON.stringify(['A', 'C', 'P']),
  );
  check('and sums the field over them', view.sums?.[column], 30);
  const lateColumn = fields.late.column as string;
  const lateView = await json(
    await call(
      `/queries/default?projectId=${projectId}&filters=${encodeURIComponent(JSON.stringify([{ [lateColumn]: { operator: '=', values: ['t'] } }]))}`,
      { cookie: admin },
    ),
  );
  check(
    'a view filtered on Late = yes returns exactly the late one',
    JSON.stringify(((lateView.tasks ?? []) as Json[]).map((one) => nameOf.get(String(one.id)))),
    JSON.stringify(['E']),
  );

  // --- Read-only to people ---------------------------------------------------------
  check(
    'nobody can type over a calculated value',
    await status(`/work-packages/${ids.A}`, { method: 'PATCH', cookie: admin, body: { payload: { [column]: 99 } } }),
    422,
  );

  // --- BR-408: refused at definition -------------------------------------------------
  check('a field reading the difference is defined', await define('margin', 'Margin', 'number', `${key('variance')} * 2`), 201);
  const circle = await call(`/calculated-fields/${fields.variance.id}`, {
    method: 'PATCH',
    cookie: admin,
    body: { expression: `${key('margin')} + 1` },
  });
  const circleBody = await json(circle);
  check('BR-408: making the difference read it back is refused when it is defined', circle.status, 422);
  check('naming the circle', circleBody.message, `Circular reference: ${key('variance')} → ${key('margin')} → ${key('variance')}.`);
  const part = '(1 + 2) * (3 + 4) + (5 + 6) * (7 + 8)';
  const big = await call('/calculated-fields', {
    method: 'POST',
    cookie: admin,
    body: definition('big', 'Big', 'number', `MAX(${Array(14).fill(part).join(', ')})`),
  });
  check('a formula over the size limit is refused', [big.status, (await json(big)).message].join(' '), '422 The formula is too complex: 211 parts, at most 200.');
  const listed = (await json(await call('/calculated-fields', { cookie: admin }))) as unknown as Json[];
  check(
    'and nothing is made for either',
    (Array.isArray(listed) ? listed : []).filter((field) => String(field.key).endsWith(`_${suffix}`)).length,
    Object.keys(fields).length,
  );
}
