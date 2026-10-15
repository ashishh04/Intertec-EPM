import type { TaskImport } from '@prisma/client';

import { runAsSystem, runWithAuth, type AuthContext } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { csvCell, parseCsv } from '../lib/csv-parse.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { contextConventions, contextLanguage, message, render, type Message } from '../lib/i18n.js';
import { getCatalog } from '../mapping/catalog.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { TaskImportProblem, TaskImportStatus, TaskImportView } from '../types/epm.js';
import { withAudit } from './audit.js';
import { requestCalculatedRecalc } from './calculated-fields.js';
import { requestHealthRecalc } from './health.js';
import { requestScheduleRecalc } from './schedule.js';

/**
 * Importing tasks from a CSV into a project.
 *
 * OpenProject 15.5.1 exports work packages but imports none, so this is EPM's.
 * A file is checked in full first — every row's type, dates, assignee, status,
 * parent and dependencies resolved against the project — and nothing is made
 * until it is clean. The import then runs in the background under the
 * importer's own account, so OpenProject applies their permissions to every
 * row: parents before children, a level at a time, several rows at once, and
 * dependencies ("follows") last. Progress is saved as it goes: a run stopped
 * part-way — cancelled, a sign-in expired, a server restarted — is resumed
 * from where it stopped, and no row is made twice.
 */

export const MAX_ROWS = 20_000;
const CONCURRENCY = 8;
const SAVE_EVERY = 50;
const STALE_MS = 2 * 60_000;

/* -------------------------------------------------------------------------- */
/* Columns                                                                    */
/* -------------------------------------------------------------------------- */

const COLUMNS = {
  key: ['id', 'key', 'ref', 'row id', 'task id'],
  parent: ['parent', 'parent id', 'parent key', 'parent ref'],
  type: ['type', 'work type', 'issue type', 'kind'],
  subject: ['subject', 'title', 'name', 'summary', 'task', 'task name'],
  description: ['description', 'details', 'notes'],
  start: ['start', 'start date', 'begin'],
  due: ['due', 'due date', 'end', 'end date', 'finish', 'finish date', 'date'],
  estimate: ['estimate', 'estimated hours', 'hours', 'estimated time', 'work', 'effort'],
  assignee: ['assignee', 'assigned to', 'owner', 'resource'],
  status: ['status', 'state'],
  priority: ['priority'],
  version: ['version', 'sprint', 'release'],
  predecessors: ['predecessors', 'depends on', 'dependencies', 'follows', 'after'],
} as const;
type Column = keyof typeof COLUMNS;

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

/** A calendar date: 2026-11-02, 2026/11/02, or day first — 02/11/2026, 02-11-2026, 02.11.2026. */
export function parseDay(raw: string): string | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  let year: number, month: number, day: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (match) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(value))) [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

/** Hours: 8, 8.5, "8h", "PT8H". */
export function parseHours(raw: string): number | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+)M)?$/i.exec(value);
  if (iso && (iso[1] || iso[2])) return Number(iso[1] ?? 0) + Number(iso[2] ?? 0) / 60;
  const plain = /^(\d+(?:[.,]\d+)?)\s*h?$/i.exec(value);
  if (!plain) return undefined;
  const hours = Number(plain[1]!.replace(',', '.'));
  return hours >= 0 && hours <= 100_000 ? hours : undefined;
}

/* -------------------------------------------------------------------------- */
/* Checking a file                                                            */
/* -------------------------------------------------------------------------- */

/** A row as it will be created. */
export interface PlannedRow {
  line: number;
  key: string;
  parentKey: string | null;
  /** An existing work package to go under: "#123" in the file. */
  parentId: string | null;
  depth: number;
  typeId: string;
  typeName: string;
  milestone: boolean;
  subject: string;
  description: string | null;
  start: string | null;
  due: string | null;
  estimate: number | null;
  assigneeId: string | null;
  statusId: string | null;
  priorityId: string | null;
  versionId: string | null;
  /** Keys in the file, or "#123" for existing work. */
  predecessors: string[];
}

interface StoredProblem {
  row: number;
  column?: string;
  message: Message;
}

interface ProjectContext {
  types: Map<string, { id: string; name: string; milestone: boolean }>;
  defaultType: { id: string; name: string; milestone: boolean };
  statuses: Map<string, string>;
  priorities: Map<string, string>;
  versions: Map<string, string>;
  /** Login, email and full name (lower case) → user id, for the project's members. */
  members: Map<string, string>;
}

interface OpNamed {
  id: number;
  name: string;
  isMilestone?: boolean;
}

async function projectContext(projectId: number): Promise<ProjectContext> {
  const [types, catalog, versions, memberships] = await Promise.all([
    openProject.getAll<OpNamed>(`/projects/${projectId}/types`, { pageSize: 200 }),
    getCatalog(),
    openProject.getAll<OpNamed>(`/projects/${projectId}/versions`, { pageSize: 200 }).catch(() => ({ items: [] as OpNamed[] })),
    runAsSystem(() =>
      openProject.getAll<{ _links: { principal?: { href?: string } } }>('/memberships', {
        filters: [{ field: 'project', operator: '=', values: [String(projectId)] }],
        pageSize: 500,
      }),
    ),
  ]);
  const memberIds = new Set(memberships.items.map((row) => idFromHref(row._links.principal?.href)).filter((id): id is string => Boolean(id)));
  const people = await runAsSystem(() => openProject.getAll<{ id: number; login?: string; email?: string; name?: string }>('/users', { pageSize: 1000 }));
  const members = new Map<string, string>();
  for (const person of people.items) {
    const id = String(person.id);
    if (!memberIds.has(id)) continue;
    for (const name of [person.login, person.email, person.name]) if (name) members.set(name.trim().toLowerCase(), id);
  }
  const typeMap = new Map(types.items.map((type) => [type.name.toLowerCase(), { id: String(type.id), name: type.name, milestone: Boolean(type.isMilestone) }]));
  const defaultType = typeMap.get('task') ?? [...typeMap.values()].find((type) => !type.milestone) ?? [...typeMap.values()][0];
  if (!defaultType) throw EpmError.validation('This project has no work package types to import into.');
  return {
    types: typeMap,
    defaultType,
    statuses: new Map([...catalog.statusById.values()].map((status) => [status.name.toLowerCase(), status.id])),
    priorities: new Map([...catalog.priorityById.values()].map((priority) => [priority.name.toLowerCase(), priority.id])),
    versions: new Map(versions.items.map((version) => [version.name.toLowerCase(), String(version.id)])),
    members,
  };
}

/** Reads and checks a file against the project. Nothing is created. */
export function checkRows(text: string, context: ProjectContext): { rows: PlannedRow[]; problems: StoredProblem[] } {
  const records = parseCsv(text);
  const problems: StoredProblem[] = [];
  if (records.length < 2) return { rows: [], problems: [{ row: 1, message: message('The file has no rows under its header.') }] };
  if (records.length - 1 > MAX_ROWS) {
    return { rows: [], problems: [{ row: 1, message: message('The file has {count, number} rows; at most {max, number} can be imported at once.', { count: records.length - 1, max: MAX_ROWS }) }] };
  }
  const header = records[0]!.cells.map(normalise);
  const index = {} as Record<Column, number>;
  for (const [column, names] of Object.entries(COLUMNS) as [Column, readonly string[]][]) {
    index[column] = header.findIndex((name) => names.includes(name));
  }
  if (index.subject < 0) return { rows: [], problems: [{ row: 1, message: message('The header needs a Subject column (or Title, or Name).') }] };
  // An apostrophe the export put before =, +, - or @ (so spreadsheets do not run it as a formula) is not part of the value.
  const cell = (cells: string[], column: Column) => (index[column] >= 0 ? (cells[index[column]] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '');

  const rows: PlannedRow[] = [];
  const keys = new Map<string, number>();
  for (const record of records.slice(1)) {
    const { line, cells } = record;
    const problem = (column: string, text: Message) => problems.push({ row: line, column, message: text });
    const subject = cell(cells, 'subject');
    if (!subject) problem('Subject', message('A subject is needed.'));
    else if (subject.length > 255) problem('Subject', message('The subject is longer than 255 characters.'));
    const key = cell(cells, 'key') || `#line${line}`;
    if (keys.has(key)) problem('ID', message('The ID {key} is used on line {other} too.', { key, other: keys.get(key)! }));
    keys.set(key, line);

    const typeName = cell(cells, 'type');
    const type = typeName ? context.types.get(typeName.toLowerCase()) : context.defaultType;
    if (!type) {
      problem('Type', message('{type} is not a type in this project: use one of {types}.', { type: typeName, types: [...context.types.values()].map((entry) => entry.name).join(', ') }));
    }
    const start = parseDay(cell(cells, 'start'));
    const due = parseDay(cell(cells, 'due'));
    if (start === undefined) problem('Start date', message('{value} is not a date: write 2026-11-02 or 02/11/2026.', { value: cell(cells, 'start') }));
    if (due === undefined) problem('Due date', message('{value} is not a date: write 2026-11-02 or 02/11/2026.', { value: cell(cells, 'due') }));
    let first = start ?? null;
    let last = due ?? null;
    if (type?.milestone) {
      if (first && last && first !== last) problem('Due date', message('A milestone is on one day: give it a due date only, or the same start and due date.'));
      first = last = last ?? first;
      if (!last && start !== undefined && due !== undefined) problem('Due date', message('A milestone needs its date.'));
    } else if (first && last && last < first) {
      problem('Due date', message('The due date is before the start date.'));
    }
    const estimate = parseHours(cell(cells, 'estimate'));
    if (estimate === undefined) problem('Estimated hours', message('{value} is not a number of hours.', { value: cell(cells, 'estimate') }));

    const lookup = (column: Column, label: string, map: Map<string, string>, what: Message) => {
      const value = cell(cells, column);
      if (!value) return null;
      const id = map.get(value.toLowerCase());
      if (!id) problem(label, message('{value} is not {what}.', { value, what }));
      return id ?? null;
    };
    const assigneeId = lookup('assignee', 'Assignee', context.members, message('a member of this project (give their login, email or full name)'));
    const statusId = lookup('status', 'Status', context.statuses, message('a status'));
    const priorityId = lookup('priority', 'Priority', context.priorities, message('a priority'));
    const versionId = lookup('version', 'Version', context.versions, message('a version in this project'));

    const parent = cell(cells, 'parent');
    const predecessors = cell(cells, 'predecessors')
      .split(/[;,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const description = cell(cells, 'description');
    rows.push({
      line,
      key,
      parentKey: parent && !/^#\d+$/.test(parent) ? parent : null,
      parentId: /^#\d+$/.test(parent) ? parent.slice(1) : null,
      depth: 0,
      typeId: type?.id ?? '',
      typeName: type?.name ?? typeName,
      milestone: Boolean(type?.milestone),
      subject,
      description: description || null,
      start: first,
      due: last,
      estimate: estimate ?? null,
      assigneeId,
      statusId,
      priorityId,
      versionId,
      predecessors,
    });
  }

  // Parents and dependencies point at rows in the file (or existing work as #123); the hierarchy has no loops.
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const row of rows) {
    if (row.parentKey && !byKey.has(row.parentKey)) problems.push({ row: row.line, column: 'Parent ID', message: message('No row has the ID {key}.', { key: row.parentKey }) });
    if (row.parentKey === row.key) problems.push({ row: row.line, column: 'Parent ID', message: message('A row cannot be its own parent.') });
    for (const predecessor of row.predecessors) {
      if (predecessor === row.key) problems.push({ row: row.line, column: 'Predecessors', message: message('A row cannot follow itself.') });
      else if (!/^#\d+$/.test(predecessor) && !byKey.has(predecessor)) {
        problems.push({ row: row.line, column: 'Predecessors', message: message('No row has the ID {key}.', { key: predecessor }) });
      }
    }
  }
  for (const row of rows) {
    let depth = 0;
    let at: PlannedRow | undefined = row;
    const seen = new Set<string>();
    while (at?.parentKey && byKey.has(at.parentKey)) {
      if (seen.has(at.key)) {
        problems.push({ row: row.line, column: 'Parent ID', message: message('The parents go round in a loop.') });
        break;
      }
      seen.add(at.key);
      depth += 1;
      at = byKey.get(at.parentKey);
    }
    row.depth = depth;
  }
  problems.sort((a, b) => a.row - b.row);
  return { rows, problems };
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

const renderProblem = (problem: StoredProblem): TaskImportProblem => ({
  row: problem.row,
  ...(problem.column ? { column: problem.column } : {}),
  message: render(contextLanguage(), problem.message, contextConventions()),
});

function canRun(row: TaskImport): boolean {
  if (['checked', 'failed', 'cancelled'].includes(row.status)) return true;
  return row.status === 'running' && (!row.heartbeatAt || Date.now() - row.heartbeatAt.getTime() > STALE_MS);
}

export function importView(row: TaskImport): TaskImportView {
  const rows = row.rows as unknown as PlannedRow[];
  const problems = row.problems as unknown as StoredProblem[];
  const errors = row.errors as unknown as { row: number; message: string }[];
  const byType: Record<string, number> = {};
  for (const planned of rows) byType[planned.typeName] = (byType[planned.typeName] ?? 0) + 1;
  return {
    id: row.id,
    projectId: String(row.projectId),
    fileName: row.fileName,
    status: row.status as TaskImportStatus,
    total: row.total,
    created: row.created,
    linked: row.linked,
    failed: row.failed,
    byType,
    levels: rows.reduce((deepest, planned) => Math.max(deepest, planned.depth + 1), 0),
    relations: rows.reduce((sum, planned) => sum + planned.predecessors.length, 0),
    problems: problems.slice(0, 500).map(renderProblem),
    problemCount: problems.length,
    errors: errors.slice(0, 500),
    errorCount: errors.length,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    canRun: canRun(row) && problems.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/** Checks an uploaded file and keeps it, ready to run if it is clean. */
export async function checkImport(projectId: number, fileName: string, text: string, actorId: string): Promise<TaskImportView> {
  const context = await projectContext(projectId);
  const { rows, problems } = checkRows(text, context);
  const row = await prisma.taskImport.create({
    data: {
      projectId,
      createdBy: actorId,
      fileName: fileName.slice(0, 200),
      status: problems.length === 0 ? 'checked' : 'invalid',
      total: rows.length,
      rows: rows as unknown as object,
      problems: problems as unknown as object,
    },
  });
  return importView(row);
}

export async function getImport(id: string): Promise<TaskImport> {
  const row = await prisma.taskImport.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That import');
  return row;
}

export async function listImports(projectId: number): Promise<TaskImportView[]> {
  const rows = await prisma.taskImport.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 });
  return rows.map(importView);
}

/** A template for the project: its own types, and an example of each column. */
export async function templateFor(projectId: number): Promise<string> {
  const context = await projectContext(projectId);
  const types = [...context.types.values()];
  const summary = types.find((type) => /^(epic|summary task|phase|feature)$/i.test(type.name)) ?? context.defaultType;
  const task = context.defaultType;
  const milestone = types.find((type) => type.milestone);
  const header = ['ID', 'Parent ID', 'Type', 'Subject', 'Description', 'Start date', 'Due date', 'Estimated hours', 'Assignee', 'Status', 'Priority', 'Version', 'Predecessors'];
  const rows = [
    ['E1', '', summary.name, 'Customer portal', 'Everything for the portal launch', '2026-11-02', '2026-12-18', '', '', '', '', '', ''],
    ['T1', 'E1', task.name, 'Design the screens', '', '2026-11-02', '2026-11-13', '40', '', '', '', '', ''],
    ['S1', 'T1', task.name, 'Login screen', '', '2026-11-02', '2026-11-04', '8', '', '', '', '', ''],
    ['T2', 'E1', task.name, 'Build the API', '', '2026-11-16', '2026-12-04', '80', '', '', '', '', 'T1'],
    ...(milestone ? [['M1', 'E1', milestone.name, 'Portal live', '', '', '2026-12-18', '', '', '', '', '', 'T2']] : []),
  ];
  return [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function cancelImport(id: string): Promise<TaskImportView> {
  const row = await prisma.taskImport.update({ where: { id }, data: { cancelRequested: true } });
  return importView(row);
}

/** Starts — or resumes — a clean import in the background, under the caller's account. */
export async function startImport(id: string, auth: AuthContext): Promise<TaskImportView> {
  const row = await getImport(id);
  if ((row.problems as unknown[]).length > 0) throw EpmError.conflict('Fix the problems in the file and upload it again.');
  if (!canRun(row)) throw EpmError.conflict(row.status === 'done' ? 'This import has finished.' : 'This import is running.');
  const started = await prisma.taskImport.update({
    where: { id },
    data: { status: 'running', startedAt: row.startedAt ?? new Date(), heartbeatAt: new Date(), cancelRequested: false, finishedAt: null },
  });
  void runWithAuth(auth, () => execute(id)).catch(async (error: unknown) => {
    await prisma.taskImport
      .update({ where: { id }, data: { status: 'failed', heartbeatAt: new Date(), errors: [...((await getImport(id)).errors as object[]), { row: 0, message: String(error instanceof Error ? error.message : error) }] } })
      .catch(() => undefined);
  });
  return importView(started);
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

class Stop extends Error {
  constructor(readonly status: 'cancelled' | 'failed', reason: string) {
    super(reason);
  }
}

async function execute(id: string): Promise<void> {
  const start = await getImport(id);
  const rows = start.rows as unknown as PlannedRow[];
  const results = new Map(Object.entries(start.results as Record<string, string>));
  // A resumed run tries again every row not yet made, so earlier failures are forgotten.
  const errors: { row: number; message: string }[] = [];
  const failedKeys = new Set<string>();
  let linked = start.linked;
  let sinceSave = 0;

  const save = async (extra: Partial<Pick<TaskImport, 'status' | 'finishedAt'>> = {}): Promise<boolean> => {
    const row = await prisma.taskImport.update({
      where: { id },
      data: {
        results: Object.fromEntries(results) as object,
        errors: errors as unknown as object,
        created: [...results.keys()].filter((key) => !key.startsWith('link:')).length,
        failed: errors.length,
        linked,
        heartbeatAt: new Date(),
        ...extra,
      },
    });
    return row.cancelRequested;
  };
  // Only between batches, once every request in flight has settled — so
  // nothing made is ever left out of what is saved.
  let stop: Stop | null = null;
  const tick = () => {
    sinceSave += 1;
  };
  const settle = async () => {
    if (stop) throw stop;
    if (sinceSave >= SAVE_EVERY) {
      sinceSave = 0;
      if (await save()) throw new Stop('cancelled', 'Cancelled.');
    }
  };
  const fail = (row: PlannedRow, error: unknown) => {
    if (error instanceof OpenProjectError && error.upstreamStatus === 401) {
      // Not this row's fault: it is tried again when the import is resumed.
      stop ??= new Stop('failed', 'Your sign-in expired part-way: sign in again and resume the import.');
      return;
    }
    failedKeys.add(row.key);
    errors.push({ row: row.line, message: error instanceof Error ? error.message : String(error) });
  };

  try {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const rootOf = (row: PlannedRow): string => {
      let at = row;
      while (at.parentKey && byKey.has(at.parentKey)) at = byKey.get(at.parentKey)!;
      return at.parentId ? `#${at.parentId}` : at.key;
    };
    const deepest = rows.reduce((max, row) => Math.max(max, row.depth), 0);
    for (let depth = 0; depth <= deepest; depth += 1) {
      // Each new child updates its parent and every ancestor upstream, so two
      // rows under the same top-level item made at once can be refused as a
      // conflict: a batch holds at most one row of each tree.
      let level = rows.filter((row) => row.depth === depth && !results.has(row.key));
      while (level.length > 0) {
        const batch: PlannedRow[] = [];
        const parents = new Set<string>();
        const rest: PlannedRow[] = [];
        for (const row of level) {
          const tree = rootOf(row);
          if (batch.length < CONCURRENCY && !parents.has(tree)) {
            batch.push(row);
            parents.add(tree);
          } else {
            rest.push(row);
          }
        }
        level = rest;
        await Promise.all(
          batch.map(async (row) => {
            const parent = row.parentKey ? results.get(row.parentKey) : row.parentId;
            if (row.parentKey && !parent) {
              failedKeys.add(row.key);
              errors.push({ row: row.line, message: 'Its parent could not be created.' });
              return;
            }
            try {
              const created = await withConflictRetry(() =>
                openProject.request<{ id: number }>(`/projects/${start.projectId}/work_packages`, {
                  method: 'POST',
                  body: payloadOf(row, parent ?? null),
                  query: { notify: 'false' },
                  once: true,
                  timeoutMs: 120_000,
                }),
              );
              results.set(row.key, String(created.id));
            } catch (error) {
              fail(row, error);
            }
            tick();
          }),
        );
        await settle();
      }
    }
    // Dependencies, once everything they join exists.
    // Two links touching the same work package at once can be refused upstream,
    // so each batch holds only links that share none.
    let links = rows.flatMap((row) => row.predecessors.map((predecessor) => ({ row, predecessor })));
    while (links.length > 0) {
      const batch: typeof links = [];
      const busy = new Set<string>();
      const rest: typeof links = [];
      for (const link of links) {
        const ends = [link.row.key, link.predecessor];
        if (batch.length < CONCURRENCY && !ends.some((end) => busy.has(end))) {
          batch.push(link);
          ends.forEach((end) => busy.add(end));
        } else {
          rest.push(link);
        }
      }
      links = rest;
      await Promise.all(
        batch.map(async ({ row, predecessor }) => {
          const done = `link:${row.key}:${predecessor}`;
          if (results.has(done)) return;
          const successor = results.get(row.key);
          const target = /^#\d+$/.test(predecessor) ? predecessor.slice(1) : results.get(predecessor);
          if (!successor || !target) return;
          try {
            await withConflictRetry(() =>
              openProject.request(`/work_packages/${successor}/relations`, {
                method: 'POST',
                body: { _links: { to: { href: `/api/v3/work_packages/${target}` } }, type: 'follows' },
                once: true,
                timeoutMs: 120_000,
              }),
            );
            results.set(done, '1');
            linked += 1;
          } catch (error) {
            fail(row, error);
          }
          tick();
        }),
      );
      await settle();
    }
    await save({ status: 'done', finishedAt: new Date() });
    const finished = await getImport(id);
    await withAudit(async () => finished, {
      actorId: finished.createdBy,
      projectId: String(finished.projectId),
      entityType: 'project',
      entityId: String(finished.projectId),
      action: 'tasks.imported',
      summary: message('{created, number} work packages imported from {file}; {failed, number} rows could not be.', {
        created: finished.created,
        file: finished.fileName,
        failed: finished.failed,
      }),
      after: { importId: id, created: finished.created, linked: finished.linked, failed: finished.failed },
    });
  } catch (error) {
    if (error instanceof Stop) {
      if (error.status === 'failed') errors.push({ row: 0, message: error.message });
      await save({ status: error.status });
    } else {
      throw error;
    }
  } finally {
    requestHealthRecalc(String(start.projectId));
    requestScheduleRecalc();
    requestCalculatedRecalc();
  }
}

/** A write refused as a conflict was not carried out: wait a moment and try again, up to five times. */
async function withConflictRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof OpenProjectError && error.upstreamStatus === 409) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1) + Math.random() * 300));
    }
  }
}

function payloadOf(row: PlannedRow, parentId: string | null): Record<string, unknown> {
  const links: Record<string, { href: string }> = { type: { href: `/api/v3/types/${row.typeId}` } };
  if (parentId) links.parent = { href: `/api/v3/work_packages/${parentId}` };
  if (row.assigneeId) links.assignee = { href: `/api/v3/users/${row.assigneeId}` };
  if (row.statusId) links.status = { href: `/api/v3/statuses/${row.statusId}` };
  if (row.priorityId) links.priority = { href: `/api/v3/priorities/${row.priorityId}` };
  if (row.versionId) links.version = { href: `/api/v3/versions/${row.versionId}` };
  return {
    subject: row.subject,
    ...(row.description ? { description: { format: 'markdown', raw: row.description } } : {}),
    ...(row.milestone ? (row.due ? { date: row.due } : {}) : { ...(row.start ? { startDate: row.start } : {}), ...(row.due ? { dueDate: row.due } : {}) }),
    ...(row.estimate !== null ? { estimatedTime: `PT${row.estimate}H` } : {}),
    _links: links,
  };
}
