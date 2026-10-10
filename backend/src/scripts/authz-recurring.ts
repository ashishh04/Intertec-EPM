/**
 * Recurring tasks (BRQ-02: BR-105 to BR-107), for the authorisation suite.
 *
 * Run from authz-test.ts with the suite's own helpers and sessions, as
 * authz-surfaces.ts is. In a project of its own, made here and removed however
 * far the run got — the project with every work package in it, and EPM's series
 * rows — so nothing another section counts is touched. The administrator is
 * made its only member, quietly, so it can be assignee and accountable; the
 * restricted account has no role in it.
 *
 * What it holds the API to:
 * - the restricted account cannot make, change, generate or read a series in a
 *   project it has no role in, and nobody signed in can do anything;
 * - BR-105: a weekly rule counted to ten makes exactly ten tasks, on the ten
 *   right dates, once each however often generation runs;
 * - BR-106: each task carries the template's type, priority, assignee,
 *   accountable, category, version, custom field values, estimate and
 *   checklist (unticked), starts on its occurrence and is due the series'
 *   duration later, is made by the automation account, relates to the template,
 *   and is made when its lead time comes — no sooner;
 * - BR-107: pause, resume and cancel; a cancelled series makes nothing however
 *   long after, every task it made remains and stays linked, the series reads
 *   as a set, and it cannot be changed or turned back on;
 * - every change is in the journal, generation under the automation account.
 */

/** The options the suite's `call` takes. */
type CallOptions = { method?: string; cookie?: string; body?: unknown };
type Json = Record<string, any>;

export interface RecurringContext {
  call: (path: string, options?: CallOptions) => Promise<Response>;
  status: (path: string, options?: CallOptions) => Promise<number>;
  check: (name: string, actual: unknown, expected: unknown) => void;
  admin: string;
  restricted: string;
  adminId: string;
  /** Registers a removal, run in the suite's cleanup however far the run got. */
  cleanup: { onCleanup(fn: () => Promise<void>): void };
}

const DAY = 86_400_000;
const todayIso = () => new Date().toISOString().slice(0, 10);
const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** The first `weekday` (1 Monday … 7 Sunday) after `day`. */
const nextWeekday = (day: string, weekday: number) => {
  const current = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return plus(day, ((weekday - current + 7) % 7) || 7);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function recurringChecks(ctx: RecurringContext): Promise<void> {
  const { call, status, check, admin, restricted, adminId, cleanup } = ctx;
  const { prisma } = await import('../db/prisma.js');
  const { runAsSystem } = await import('../auth/context.js');
  const { openProject } = await import('../openproject/client.js');
  const upstream = <T = Json>(path: string, init: Record<string, unknown> = {}) => runAsSystem(() => openProject.request<T>(path, init));
  const json = async (path: string, options: CallOptions = {}): Promise<Json> => {
    const response = await call(path, options);
    return Object.assign((await response.json().catch(() => ({}))) as Json, { __status: response.status });
  };
  const href = (wp: Json, key: string) => {
    const link = wp._links?.[key];
    return Array.isArray(link) ? link.map((one: Json) => one.href) : (link?.href ?? null);
  };
  const relatesTo = async (workPackageId: string | number, templateId: string) =>
    (((await upstream<Json>(`/work_packages/${workPackageId}/relations`))._embedded?.elements ?? []) as Json[]).some(
      (relation) => relation.type === 'relates' && [relation._links?.from?.href, relation._links?.to?.href].includes(`/api/v3/work_packages/${templateId}`),
    );

  console.log('\nRecurring tasks (BR-105 to BR-107)');
  const stamp = Date.now();

  // --- A project of its own -------------------------------------------------
  const made = await json('/projects', {
    method: 'POST',
    cookie: admin,
    body: { payload: { name: `Recurring Test ${stamp}`, identifier: `recurring-test-${stamp}` } },
  });
  check('a project is made for the recurring task tests', made.__status, 201);
  const projectId = made.id ? String(made.id) : '';
  if (!projectId) return;
  cleanup.onCleanup(async () => {
    await call(`/projects/${projectId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    // EPM's own rows for the project's series: the tasks went with the project.
    await prisma.taskSeries.deleteMany({ where: { projectId: Number(projectId) } }).catch(() => undefined);
  });

  // The administrator as its only member — quietly, nobody is told — so it can be
  // assignee and accountable. "Project admin" is the instance's own role.
  const roles = ((await upstream<Json>('/roles'))._embedded?.elements ?? []) as Json[];
  const projectAdmin = roles.find((role) => /^project admin$/i.test(role.name));
  await upstream('/memberships', {
    method: 'POST',
    body: {
      _links: {
        project: { href: `/api/v3/projects/${projectId}` },
        principal: { href: `/api/v3/users/${adminId}` },
        roles: [{ href: `/api/v3/roles/${projectAdmin?.id ?? 3}` }],
      },
      _meta: { sendNotifications: false },
    },
  }).catch(() => undefined);

  const automation = await json('/automation/status', { cookie: admin });
  const automationId = String(automation.account?.userId ?? '');
  const working = automation.account?.working === true;
  check('the automation account the tasks are made as works', working, true);

  // What the template carries: a version, a priority other than the default,
  // and a list custom field's value where the instance has one.
  const types = ((await upstream<Json>('/types'))._embedded?.elements ?? []) as Json[];
  const taskType = types.find((type) => /^task$/i.test(type.name)) ?? types.find((type) => !type.isMilestone);
  const priorities = ((await upstream<Json>('/priorities'))._embedded?.elements ?? []) as Json[];
  const priority = priorities.find((one) => !one.isDefault && /high/i.test(one.name)) ?? priorities.find((one) => !one.isDefault);
  const version = await json('/sprints', { method: 'POST', cookie: admin, body: { name: `Recurring version ${stamp}`, projectId, startDate: todayIso(), endDate: plus(todayIso(), 120) } });
  const form = await upstream<Json>(`/projects/${projectId}/work_packages/form`, {
    method: 'POST',
    body: { _links: { type: { href: `/api/v3/types/${taskType?.id}` } } },
  }).catch(() => ({}) as Json);
  const schema = (form._embedded?.schema ?? {}) as Json;
  const listField = Object.entries(schema).find(([key, spec]) => /^customField\d+$/.test(key) && (spec as Json)?.type === 'CustomOption')?.[0];
  const option = listField
    ? ((schema[listField]._embedded?.allowedValues ?? schema[listField]._links?.allowedValues ?? []) as Json[]).map((one) => one._links?.self?.href ?? one.href).find(Boolean)
    : undefined;

  const checklist = 'The weekly checks.\n\n- [ ] Backups verified\n- [x] Logs reviewed\n';
  const madeTemplate = await json('/work-packages', {
    method: 'POST',
    cookie: admin,
    body: {
      projectId,
      typeId: String(taskType?.id ?? ''),
      payload: {
        subject: `Weekly checks ${stamp}`,
        description: { format: 'markdown', raw: checklist },
        estimatedTime: 'PT2H',
        _links: {
          ...(priority ? { priority: { href: `/api/v3/priorities/${priority.id}` } } : {}),
          assignee: { href: `/api/v3/users/${adminId}` },
          responsible: { href: `/api/v3/users/${adminId}` },
          ...(version.id ? { version: { href: `/api/v3/versions/${version.id}` } } : {}),
          ...(listField && option ? { [listField]: { href: option } } : {}),
        },
      },
    },
  });
  check('a template task is made in it', madeTemplate.__status, 201);
  const templateId = String(madeTemplate.id ?? '');
  if (!templateId) return;
  const template = await upstream<Json>(`/work_packages/${templateId}`);

  // --- Who may ----------------------------------------------------------------
  const monday = nextWeekday(todayIso(), 1);
  const weeklyTen = { frequency: 'weekly', interval: 1, weekdays: [1], startDate: monday, count: 10 };
  check('nobody signed in cannot list a project’s series', await status(`/projects/${projectId}/task-series`), 401);
  check('the restricted account cannot list them in a project it has no role in', await status(`/projects/${projectId}/task-series`, { cookie: restricted }), 403);
  check(
    'nor make a task there recurring (the task is not visible to it)',
    await status(`/work-packages/${templateId}/series`, { method: 'POST', cookie: restricted, body: { rule: weeklyTen, leadDays: 90 } }),
    404,
  );
  check('nor ask what the task is to a series', await status(`/work-packages/${templateId}/series`, { cookie: restricted }), 404);
  check('nor make every series’ due tasks', await status('/task-series/generate', { method: 'POST', cookie: restricted }), 403);

  // --- BR-105 ---------------------------------------------------------------
  const preview = await json('/task-series/preview', { method: 'POST', cookie: admin, body: { rule: weeklyTen, limit: 12 } });
  check('a preview of the weekly rule counted to ten lists ten dates', preview.dates?.length, 10);
  check(
    'a rule with both an end date and a count is refused, in words',
    (await json('/task-series/preview', { method: 'POST', cookie: admin, body: { rule: { ...weeklyTen, endDate: plus(monday, 60) } } })).problem,
    'Choose an end date or a number of occurrences, not both.',
  );

  const series = await json(`/work-packages/${templateId}/series`, {
    method: 'POST',
    cookie: admin,
    body: { rule: weeklyTen, leadDays: 90, durationDays: 2 },
  });
  check('the administrator makes the template recurring', series.__status, 201);
  const seriesId = String(series.id ?? '');
  check('a second series on the same template is refused', await status(`/work-packages/${templateId}/series`, { method: 'POST', cookie: admin, body: { rule: weeklyTen, leadDays: 90 } }), 409);
  check('the restricted account cannot read the series', await status(`/task-series/${seriesId}`, { cookie: restricted }), 404);
  check('nor change it', await status(`/task-series/${seriesId}`, { method: 'PATCH', cookie: restricted, body: { rule: weeklyTen, leadDays: 1 } }), 404);
  for (const move of ['pause', 'resume', 'cancel', 'generate']) {
    check(`nor ${move} it`, await status(`/task-series/${seriesId}/${move}`, { method: 'POST', cookie: restricted }), 404);
  }

  if (!working) {
    console.log('  SKIP  BR-105 to BR-107 generation: no working automation account');
    return;
  }

  await call(`/task-series/${seriesId}/generate`, { method: 'POST', cookie: admin });
  let detail: Json = {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    detail = await json(`/task-series/${seriesId}`, { cookie: admin });
    if ((detail.instanceCount ?? 0) >= 10) break;
    await pause(1_500);
  }
  const expected = Array.from({ length: 10 }, (_, index) => plus(monday, index * 7));
  const occurrences = ((detail.instances ?? []) as Json[]).map((one) => one.occurrence).sort();
  check('BR-105: the weekly rule counted to ten makes exactly ten tasks', detail.instanceCount, 10);
  check('BR-105: on exactly the ten Mondays the rule names', same(occurrences, expected), true);
  const rows = await prisma.taskSeriesInstance.findMany({ where: { seriesId }, orderBy: { occurrence: 'asc' } });
  check('one record per occurrence, each with its work package', rows.length === 10 && rows.every((row) => row.workPackageId !== null), true);
  const again = await json(`/task-series/${seriesId}/generate`, { method: 'POST', cookie: admin });
  check('making the due tasks again makes none twice', `${again.generated}/${await prisma.taskSeriesInstance.count({ where: { seriesId } })}`, '0/10');

  // --- BR-106 ---------------------------------------------------------------
  const unticked = checklist.replace('- [x] Logs reviewed', '- [ ] Logs reviewed');
  const inherited = ['type', 'priority', 'assignee', 'responsible', 'category', 'version', ...(listField ? [listField] : [])];
  let matching = 0;
  for (const row of rows) {
    const instance = await upstream<Json>(`/work_packages/${row.workPackageId}`);
    const day = row.occurrence.toISOString().slice(0, 10);
    const differs = [
      ...inherited.filter((key) => !same(href(instance, key), href(template, key))),
      ...(instance.subject === `${template.subject} (${day})` ? [] : ['subject']),
      ...(instance.description?.raw === unticked ? [] : ['description']),
      ...(instance.estimatedTime === template.estimatedTime ? [] : ['estimate']),
      ...(instance.startDate === day ? [] : ['start']),
      ...(instance.dueDate === plus(day, 2) ? [] : ['due']),
      ...(href(instance, 'author') === `/api/v3/users/${automationId}` ? [] : ['author']),
      ...((await relatesTo(instance.id, templateId)) ? [] : ['relation']),
    ];
    if (differs.length === 0) matching += 1;
    else console.log(`        task ${instance.id} for ${day} differs in: ${differs.join(', ')}`);
  }
  check(
    'BR-106: every task carries the template’s type, priority, assignee, accountable, category, version, custom field, estimate and checklist, starts on its occurrence, is due two days later, is made by the automation account and relates to the template',
    matching,
    10,
  );

  // The lead time: a daily rule three days ahead has made today to three days on, and no further.
  const daily = await json('/work-packages', {
    method: 'POST',
    cookie: admin,
    body: { projectId, typeId: String(taskType?.id ?? ''), payload: { subject: `Daily notes ${stamp}` } },
  });
  const dailySeries = await json(`/work-packages/${daily.id}/series`, {
    method: 'POST',
    cookie: admin,
    body: { rule: { frequency: 'daily', startDate: todayIso() }, leadDays: 3 },
  });
  const dailyId = String(dailySeries.id ?? '');
  await call(`/task-series/${dailyId}/generate`, { method: 'POST', cookie: admin });
  let dailyDetail: Json = {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    dailyDetail = await json(`/task-series/${dailyId}`, { cookie: admin });
    if ((dailyDetail.instanceCount ?? 0) >= 4) break;
    await pause(1_000);
  }
  check(
    'BR-106: a task is made when its lead time comes — three days ahead makes today’s to three days on, and no further',
    same(((dailyDetail.instances ?? []) as Json[]).map((one) => one.occurrence).sort(), [0, 1, 2, 3].map((n) => plus(todayIso(), n))),
    true,
  );
  check('and the next is due to be made tomorrow', `${dailyDetail.nextOccurrence} ${dailyDetail.nextGenerationOn}`, `${plus(todayIso(), 4)} ${plus(todayIso(), 1)}`);

  // A changed rule is a new version; the tasks made stay as they were.
  const unchanged = await json(`/task-series/${seriesId}`, { method: 'PATCH', cookie: admin, body: { rule: weeklyTen, leadDays: 90, durationDays: 2 } });
  check('saving the same rule again is not a new version', unchanged.version, 1);
  const changed = await json(`/task-series/${seriesId}`, { method: 'PATCH', cookie: admin, body: { rule: { ...weeklyTen, weekdays: [1, 4] }, leadDays: 30, durationDays: 2 } });
  check('changing the rule makes version 2', changed.version, 2);
  check(
    'and leaves the ten tasks already made as they were',
    await prisma.taskSeriesInstance.count({ where: { seriesId, seriesVersion: 1, workPackageId: { not: null } } }),
    10,
  );

  // --- BR-107 ---------------------------------------------------------------
  const paused = await json(`/task-series/${dailyId}/pause`, { method: 'POST', cookie: admin });
  check('BR-107: the series pauses', paused.state, 'paused');
  check(
    'and a paused series makes nothing, saying why',
    (await json(`/task-series/${dailyId}/generate`, { method: 'POST', cookie: admin })).notes?.[0],
    'The series is paused, so nothing was made.',
  );
  check('it resumes', (await json(`/task-series/${dailyId}/resume`, { method: 'POST', cookie: admin })).state, 'active');
  const cancelled = await json(`/task-series/${dailyId}/cancel`, { method: 'POST', cookie: admin });
  check('it is cancelled, by the administrator', `${cancelled.state} ${cancelled.cancelledBy}`, `cancelled ${adminId}`);
  const afterCancel = await json(`/task-series/${dailyId}/generate`, { method: 'POST', cookie: admin });
  check('BR-107: a cancelled series makes nothing when asked', `${afterCancel.generated} ${afterCancel.notes?.[0]}`, '0 The series is cancelled, so nothing was made.');
  const { generateSeries } = await import('../domain/task-series.js');
  const later = await runAsSystem(() => generateSeries(dailyId, new Date(Date.now() + 10 * DAY)));
  check('BR-107: nor ten days on, with ten more occurrences due', later.generated.length, 0);
  await call('/task-series/generate', { method: 'POST', cookie: admin });
  check('nor in a run of every series', await prisma.taskSeriesInstance.count({ where: { seriesId: dailyId } }), 4);

  const dailyRows = await prisma.taskSeriesInstance.findMany({ where: { seriesId: dailyId } });
  let linked = 0;
  for (const row of dailyRows) {
    const task = await status(`/tasks/${row.workPackageId}`, { cookie: admin });
    const link = await json(`/work-packages/${row.workPackageId}/series`, { cookie: admin });
    if (task === 200 && link.role === 'instance' && link.series?.id === dailyId && (await relatesTo(String(row.workPackageId), String(daily.id)))) linked += 1;
  }
  check('BR-107: every task it made remains, and stays linked to the template', linked, 4);
  const set = await json(`/task-series/${dailyId}`, { cookie: admin });
  check(
    'the series reads as a set: its template and the four tasks it made',
    `${set.state} ${set.templateWorkPackageId === String(daily.id)} ${((set.instances ?? []) as Json[]).filter((one) => one.task?.id).length}`,
    'cancelled true 4',
  );
  check('a cancelled series cannot be changed', await status(`/task-series/${dailyId}`, { method: 'PATCH', cookie: admin, body: { rule: { frequency: 'daily', startDate: todayIso() }, leadDays: 1 } }), 409);
  check('nor resumed', await status(`/task-series/${dailyId}/resume`, { method: 'POST', cookie: admin }), 409);
  check(
    'and the database itself will not turn it back on',
    await prisma.taskSeries
      .update({ where: { id: dailyId }, data: { state: 'active' } })
      .then(() => 'changed', (error: unknown) => (/A cancelled series stays cancelled/.test(String(error)) ? 'refused' : String(error))),
    'refused',
  );

  // --- The project's view, and the journal -----------------------------------
  const list = (await (await call(`/projects/${projectId}/task-series`, { cookie: admin })).json()) as Json[];
  check('the project lists both series, the active one first', list.map((one) => one.state).join(','), 'active,cancelled');
  check('the template knows its series', (await json(`/work-packages/${templateId}/series`, { cookie: admin })).role, 'template');
  const journal = await json('/journal?entityType=task_series&pageSize=100', { cookie: admin });
  const entries = ((journal.items ?? []) as Json[]).filter((entry) => [seriesId, dailyId].includes(entry.entityId));
  check(
    'making, generating, changing, pausing, resuming and cancelling are all journalled',
    ['created', 'generated', 'changed', 'paused', 'resumed', 'cancelled'].every((action) => entries.some((entry) => entry.action === `task_series.${action}`)),
    true,
  );
  const generatedEntry = entries.find((entry) => entry.action === 'task_series.generated');
  check('generation is journalled under the automation account', `${generatedEntry?.actorId} ${generatedEntry?.actorKind}`, `${automationId} service`);
}
