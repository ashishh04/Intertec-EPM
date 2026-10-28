import type { TaskImport } from '@prisma/client';

import { runAsSystem, runWithAuth, type AuthContext } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { parseCsv, type CsvRecord } from '../lib/csv-parse.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { contextConventions, contextLanguage, message, render, t, type Message } from '../lib/i18n.js';
import { buildWorkbook } from '../lib/xlsx.js';
import { getCatalog } from '../mapping/catalog.js';
import { idFromHref, openProject } from '../openproject/client.js';
import { EVERY_USER } from '../openproject/people.js';
import type { TaskImportChange, TaskImportProblem, TaskImportStatus, TaskImportView } from '../types/epm.js';
import { withAudit } from './audit.js';
import { requestCalculatedRecalc } from './calculated-fields.js';
import { requestHealthRecalc } from './health.js';
import { requestScheduleRecalc } from './schedule.js';
import { href, IMPORT_COLUMNS, readProjectWork, title } from './task-export.js';
import { fieldValue, parseYesNo, projectFields, type FieldFormat, type TaskField } from './task-fields.js';
import { normaliseSource } from './task-import-formats.js';

/**
 * Importing tasks from a CSV or Excel file into a project: creating new ones
 * and updating existing ones.
 *
 * OpenProject exports work packages but imports none (17.9.2 imports from Jira
 * only), so this is EPM's. One rule decides what a row does: an ID naming a
 * work package of this project updates it — only the cells that differ, and
 * only the columns the file has; every other row is created. An ID names a work
 * package when it is WP<number>, or when an earlier import into the project
 * created a work package from a row with that ID (E1, T1…): so the same sheet
 * uploaded again, edited or not, overwrites rather than duplicates. Nothing is
 * ever deleted: work missing from the file is left as it is. A file exported
 * from Tasks > Export and imported into another project makes a copy.
 *
 * A file is checked in full first — every row's type, dates, assignee, status,
 * parent and dependencies resolved against the project, and every update
 * compared with the work package as it is — and nothing is changed until it is
 * clean. The import then runs in the background under the importer's own
 * account, so OpenProject applies their permissions to every row: new rows
 * first, parents before children, a level at a time, several at once; then the
 * updates, a level at a time too (a work package can move under one the file
 * creates); then dependencies removed and added. Progress is saved as it goes:
 * a run stopped part-way — cancelled, a sign-in expired, a server restarted —
 * is resumed from where it stopped, and no row is made twice.
 */

export const MAX_ROWS = 20_000;
const CONCURRENCY = 8;
const SAVE_EVERY = 50;
const STALE_MS = 2 * 60_000;
/** Update rows whose changes are shown before importing. */
const CHANGES_SHOWN = 300;

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
  done: ['done', 'percent done', 'done percent', 'progress', 'complete', 'percent complete', 'percentage done'],
  assignee: ['assignee', 'assigned to', 'owner', 'resource'],
  status: ['status', 'state'],
  priority: ['priority'],
  version: ['version', 'target version', 'target versions', 'sprint', 'release'],
  accountable: ['accountable', 'responsible'],
  category: ['category'],
  points: ['story points', 'points'],
  manual: ['manual scheduling', 'scheduled manually', 'schedule manually'],
  predecessors: ['predecessors', 'depends on', 'dependencies', 'follows', 'after'],
} as const;
type Column = keyof typeof COLUMNS;

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A work package's own number in an ID: "WP123" → "123". */
const workPackageNumber = (key: string) => /^WP(\d+)$/i.exec(key)?.[1] ?? null;

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

/** A calendar date: 2026-11-02, 2026/11/02, day first — 02/11/2026, 02-11-2026, 02.11.2026 — or a spreadsheet's date number. */
export function parseDay(raw: string): string | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  // A spreadsheet's own date — days since 1899-12-30 — as an edited .xlsx holds it.
  const serial = /^(\d{5})(?:\.0+)?$/.exec(value);
  if (serial) {
    const days = Number(serial[1]);
    return days >= 20_000 && days <= 80_000 ? new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10) : undefined;
  }
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
  return hours >= 0 && hours <= 100_000 ? Math.round(hours * 100) / 100 : undefined;
}

/** Done %: 0 to 100, with or without the sign; a spreadsheet's percentage (0.5) when the cell holds a fraction. */
export function parseDone(raw: string): number | null | undefined {
  const value = raw.trim().replace(/\s*%$/, '');
  if (!value) return null;
  if (!/^\d+(?:[.,]\d+)?$/.test(value)) return undefined;
  let done = Number(value.replace(',', '.'));
  if (!raw.includes('%') && done > 0 && done < 1 && value.includes('.')) done *= 100;
  return done >= 0 && done <= 100 ? Math.round(done) : undefined;
}

/* -------------------------------------------------------------------------- */
/* Checking a file                                                            */
/* -------------------------------------------------------------------------- */

/** What a row does: creates a work package, updates one, or leaves one as it is. */
export type RowAction = 'create' | 'update' | 'unchanged';

/** A work package field an update sets. */
type UpdateField =
  | 'subject'
  | 'description'
  | 'type'
  | 'start'
  | 'due'
  | 'estimate'
  | 'done'
  | 'assignee'
  | 'accountable'
  | 'status'
  | 'priority'
  | 'version'
  | 'category'
  | 'points'
  | 'manual'
  | 'parent'
  | `customField${number}`;

/** A custom field's value as it will be written: an option's or a person's id, or the value itself. */
interface CustomValue {
  key: string;
  format: FieldFormat;
  value: string | number | boolean | null;
  /** As the file has it, for showing a change. */
  text: string;
}

/** A row as it will be created, or as it changes a work package. */
export interface PlannedRow {
  line: number;
  key: string;
  /** Absent on imports checked before updates existed: they create. */
  action?: RowAction;
  /** The work package an update row changes. */
  workPackageId?: string;
  /** Update rows: the fields to set, and what changes, for reading. */
  set?: UpdateField[];
  changes?: TaskImportChange[];
  /** Update rows: dependencies to remove, by relation id. */
  unlink?: string[];
  /** A created row whose ID names a work package of another project: a copy. */
  copy?: boolean;
  /** Update rows: date edits left out, the work package's dates following its children or the work it follows. */
  datesFollow?: 'children' | 'predecessors';
  /** Done % in the file that cannot be set: the instance derives it from status. */
  progressIgnored?: boolean;
  /** Its ID is not WP<number> but one an earlier import made a work package from. */
  matchedEarlier?: boolean;
  /** A created row with the subject of a work package the file does not otherwise name: perhaps a duplicate. */
  sameSubjectAs?: string;
  /** Dates in the file on a non-working day, moved to the next working day as the schedule would. */
  datesMoved?: number;
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
  /** Done %; null leaves it as it is. */
  done: number | null;
  assigneeId: string | null;
  statusId: string | null;
  priorityId: string | null;
  versionId: string | null;
  /** Absent on imports checked before these columns existed. */
  accountableId?: string | null;
  categoryId?: string | null;
  points?: number | null;
  /** Manual scheduling; null leaves it as it is. */
  manual?: boolean | null;
  custom?: CustomValue[];
  /** Keys in the file, or "#123" for existing work. Update rows: only those to add. */
  predecessors: string[];
}

/** A work package of the project as it is now, for comparing an update row with. */
export interface ExistingWork {
  id: string;
  typeId: string;
  type: string;
  milestone: boolean;
  subject: string;
  description: string;
  start: string | null;
  due: string | null;
  estimate: number | null;
  done: number | null;
  assigneeId: string | null;
  assignee: string;
  statusId: string | null;
  status: string;
  priorityId: string | null;
  priority: string;
  versionId: string | null;
  version: string;
  accountableId: string | null;
  accountable: string;
  categoryId: string | null;
  category: string;
  points: number | null;
  /** Custom field key → its value as a sheet shows it, and a list option's or person's id. */
  custom: Record<string, { text: string; id: string | null }>;
  /** Its parent, when the parent is in the project. */
  parentId: string | null;
  /** Its parent is in another project: the file cannot show it, so a blank Parent ID keeps it. */
  parentElsewhere: boolean;
  /** Predecessor id → relation id, for those in the project. */
  predecessors: Map<string, string>;
  /** Scheduled by hand: its dates are its own even with children. */
  scheduleManually: boolean;
  /** Its dates may fall on non-working days. */
  ignoreNonWorkingDays: boolean;
}

interface StoredProblem {
  row: number;
  column?: string;
  message: Message;
}

export interface ProjectContext {
  types: Map<string, { id: string; name: string; milestone: boolean }>;
  defaultType: { id: string; name: string; milestone: boolean };
  statuses: Map<string, string>;
  priorities: Map<string, string>;
  versions: Map<string, string>;
  /** Login, email and full name (lower case) → user id, for the project's members. */
  members: Map<string, string>;
  /** The project's work packages by id, read with the importer's access; absent for a template. */
  existing?: Map<string, ExistingWork>;
  /** IDs earlier imports into the project made work packages from (E1 → 123), latest last. */
  remembered?: Map<string, string>;
  /** Whether Done % can be set: not when the instance derives it from status. */
  progressWritable?: boolean;
  /** Days no work is scheduled on: weekdays (1 Monday … 7 Sunday) and dates. */
  nonWorking?: { weekdays: Set<number>; dates: Set<string> };
  /** The project's custom fields a sheet can set (task-fields.ts). */
  fields?: TaskField[];
  /** Category name (lower case) → id. */
  categories?: Map<string, string>;
  /** The members' full names, for the template. */
  memberNames?: string[];
  /** Names as the project shows them, for the template. */
  versionNames?: string[];
  categoryNames?: string[];
  statusNames?: string[];
  priorityNames?: string[];
}

/**
 * A date on a non-working day moved to the next working day — what OpenProject
 * does, without a word, to a start or due date set on one. Done here first, so
 * a file is compared with the dates it will actually produce: a sheet with a
 * Saturday in it would otherwise show that date as a change on every upload.
 */
export function nextWorkingDay(date: string, nonWorking: { weekdays: Set<number>; dates: Set<string> }): string {
  let at = new Date(`${date}T00:00:00Z`);
  for (let guard = 0; guard < 366; guard += 1) {
    const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
    const iso = at.toISOString().slice(0, 10);
    if (!nonWorking.weekdays.has(weekday) && !nonWorking.dates.has(iso)) return iso;
    at = new Date(at.getTime() + 86_400_000);
  }
  return date;
}

interface OpNamed {
  id: number;
  name: string;
  isMilestone?: boolean;
}

async function projectContext(projectId: number, withWork = true): Promise<ProjectContext> {
  const [types, catalog, versions, memberships, work] = await Promise.all([
    openProject.getAll<OpNamed>(`/projects/${projectId}/types`, { pageSize: 200 }),
    getCatalog(),
    openProject.getAll<OpNamed>(`/projects/${projectId}/versions`, { pageSize: 200 }).catch(() => ({ items: [] as OpNamed[] })),
    runAsSystem(() =>
      openProject.getAll<{ _links: { principal?: { href?: string } } }>('/memberships', {
        filters: [{ field: 'project', operator: '=', values: [String(projectId)] }],
        pageSize: 500,
      }),
    ),
    withWork ? readProjectWork(projectId, true) : null,
  ]);
  const [week, holidays] = withWork
    ? await Promise.all([
        openProject.getAll<{ day: number; working: boolean }>('/days/week').catch(() => null),
        openProject
          .getAll<{ date: string }>('/days/non_working', {
            filters: [{ field: 'date', operator: '<>d', values: [`${new Date().getUTCFullYear() - 2}-01-01`, `${new Date().getUTCFullYear() + 3}-12-31`] }],
            pageSize: 1000,
          })
          .catch(() => null),
      ])
    : [null, null];
  const offered = await projectFields(projectId, types.items.map((type) => String(type.id)));
  const memberIds = new Set(memberships.items.map((row) => idFromHref(row._links.principal?.href)).filter((id): id is string => Boolean(id)));
  const people = await runAsSystem(() => openProject.getAll<{ id: number; login?: string; email?: string; name?: string }>('/principals', { pageSize: 1000, filters: EVERY_USER }));
  const members = new Map<string, string>();
  const memberNames: string[] = [];
  for (const person of people.items) {
    const id = String(person.id);
    if (!memberIds.has(id)) continue;
    if (person.name) memberNames.push(person.name);
    for (const name of [person.login, person.email, person.name]) if (name) members.set(name.trim().toLowerCase(), id);
  }
  const typeMap = new Map(types.items.map((type) => [type.name.toLowerCase(), { id: String(type.id), name: type.name, milestone: Boolean(type.isMilestone) }]));
  const defaultType = typeMap.get('task') ?? [...typeMap.values()].find((type) => !type.milestone) ?? [...typeMap.values()][0];
  if (!defaultType) throw EpmError.validation('This project has no work package types to import into.');
  const typeById = new Map([...typeMap.values()].map((type) => [type.id, type]));
  const existing = new Map<string, ExistingWork>();
  for (const item of work?.items ?? []) {
    const id = String(item.id);
    const typeId = idFromHref(href(item._links, 'type')) ?? '';
    const milestone = typeById.get(typeId)?.milestone ?? (item.date !== undefined && item.startDate === undefined && item.dueDate === undefined);
    const hours = durationToHours(item.estimatedTime);
    const parentId = work!.parentOf.get(id) ?? null;
    existing.set(id, {
      id,
      typeId,
      type: title(item._links, 'type'),
      milestone,
      subject: item.subject,
      description: item.description?.raw ?? '',
      start: (milestone ? item.date : item.startDate) ?? null,
      due: (milestone ? item.date : item.dueDate) ?? null,
      estimate: hours === undefined ? null : Math.round(hours * 100) / 100,
      done: item.percentageDone ?? null,
      assigneeId: idFromHref(href(item._links, 'assignee')) ?? null,
      assignee: title(item._links, 'assignee'),
      statusId: idFromHref(href(item._links, 'status')) ?? null,
      status: title(item._links, 'status'),
      priorityId: idFromHref(href(item._links, 'priority')) ?? null,
      priority: title(item._links, 'priority'),
      versionId: idFromHref(href(item._links, 'version')) ?? null,
      version: title(item._links, 'version'),
      accountableId: idFromHref(href(item._links, 'responsible')) ?? null,
      accountable: title(item._links, 'responsible'),
      categoryId: idFromHref(href(item._links, 'category')) ?? null,
      category: title(item._links, 'category'),
      points: typeof item.storyPoints === 'number' ? item.storyPoints : null,
      custom: Object.fromEntries(offered.fields.map((field) => [field.key, fieldValue(item as unknown as Record<string, unknown>, field)])),
      parentId,
      parentElsewhere: !parentId && Boolean(idFromHref(href(item._links, 'parent'))),
      predecessors: work!.predecessors.get(id) ?? new Map(),
      scheduleManually: Boolean(item.scheduleManually),
      ignoreNonWorkingDays: Boolean(item.ignoreNonWorkingDays),
    });
  }
  return {
    types: typeMap,
    defaultType,
    statuses: new Map([...catalog.statusById.values()].map((status) => [status.name.toLowerCase(), status.id])),
    priorities: new Map([...catalog.priorityById.values()].map((priority) => [priority.name.toLowerCase(), priority.id])),
    versions: new Map(versions.items.map((version) => [version.name.toLowerCase(), String(version.id)])),
    versionNames: versions.items.map((version) => version.name),
    categoryNames: offered.categoryNames,
    statusNames: [...catalog.statusById.values()].map((status) => status.name),
    priorityNames: [...catalog.priorityById.values()].map((priority) => priority.name),
    members,
    memberNames: memberNames.sort((a, b) => a.localeCompare(b)),
    fields: offered.fields,
    categories: offered.categories,
    ...(work ? { existing, progressWritable: offered.progressWritable } : {}),
    ...(week
      ? { nonWorking: { weekdays: new Set(week.items.filter((day) => !day.working).map((day) => day.day)), dates: new Set((holidays?.items ?? []).map((day) => day.date)) } }
      : {}),
  };
}

/** Row IDs → the work packages earlier imports into the project made from them, the latest winning. */
async function rememberedIds(projectId: number): Promise<Map<string, string>> {
  const earlier = await prisma.taskImport.findMany({ where: { projectId, startedAt: { not: null } }, orderBy: { createdAt: 'asc' }, select: { results: true } });
  const remembered = new Map<string, string>();
  for (const { results } of earlier) {
    for (const [key, id] of Object.entries(results as Record<string, string>)) {
      // A row without an ID was keyed by its line, which says nothing about the next file.
      if (isCreatedKey(key) && !key.startsWith('#line')) remembered.set(key, id);
    }
  }
  return remembered;
}

const sameText = (a: string, b: string) => a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim();
const hoursText = (hours: number | null) => (hours === null ? '' : String(Math.round(hours * 100) / 100));

/** Reads and checks a file against the project, and works out what each row will do. Nothing is changed. */
export function checkRows(input: string | CsvRecord[], context: ProjectContext): { rows: PlannedRow[]; problems: StoredProblem[]; ignored: string[] } {
  // Rows left empty — a spreadsheet keeps formatted ones — are not rows.
  const records = (typeof input === 'string' ? parseCsv(input) : input).filter((record, index) => index === 0 || record.cells.some((cell) => cell.trim()));
  const problems: StoredProblem[] = [];
  if (records.length < 2) return { rows: [], problems: [{ row: 1, message: message('The file has no rows under its header.') }], ignored: [] };
  if (records.length - 1 > MAX_ROWS) {
    return { rows: [], problems: [{ row: 1, message: message('The file has {count, number} rows; at most {max, number} can be imported at once.', { count: records.length - 1, max: MAX_ROWS }) }], ignored: [] };
  }
  const header = records[0]!.cells.map(normalise);
  // Each column by the first of its names the header has: Version before Sprint, say.
  const index = {} as Record<Column, number>;
  for (const [column, names] of Object.entries(COLUMNS) as [Column, readonly string[]][]) {
    index[column] = names.map((name) => header.indexOf(name)).find((at) => at >= 0) ?? -1;
  }
  const present = (column: Column) => index[column] >= 0;
  if (!present('subject')) return { rows: [], problems: [{ row: 1, message: message('The header needs a Subject column (or Title, or Name).') }], ignored: [] };
  // Custom fields by the names the project gave them, in columns no other field has taken.
  const used = new Set(Object.values(index).filter((at) => at >= 0));
  const fieldAt = new Map<string, number>();
  for (const field of context.fields ?? []) {
    const at = header.findIndex((name, column) => !used.has(column) && name === normalise(field.name));
    if (at < 0) continue;
    fieldAt.set(field.key, at);
    used.add(at);
  }
  const fieldsByKey = new Map((context.fields ?? []).map((field) => [field.key, field]));
  const ignored = records[0]!.cells.filter((name, column) => !used.has(column) && name.trim()).map((name) => name.trim());
  // An apostrophe the export put before =, +, - or @ (so spreadsheets do not run it as a formula) is not part of the value.
  const cell = (cells: string[], column: Column) => (present(column) ? (cells[index[column]] ?? '').trim().replace(/^'(?=[=+\-@])/, '') : '');
  const existingOf = (key: string) => {
    const number = workPackageNumber(key) ?? context.remembered?.get(key);
    return number ? context.existing?.get(number) : undefined;
  };

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
    const current = existingOf(key);

    // An update keeps what a blank Type, Status or Priority leaves out; a new row takes the defaults.
    const typeName = cell(cells, 'type');
    const type = typeName
      ? context.types.get(typeName.toLowerCase())
      : current
        ? { id: current.typeId, name: current.type, milestone: current.milestone }
        : context.defaultType;
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
      if (!last && start !== undefined && due !== undefined && !current) problem('Due date', message('A milestone needs its date.'));
    } else if (first && last && last < first) {
      problem('Due date', message('The due date is before the start date.'));
    }
    // Dates on a non-working day, moved to the next working day as the schedule will.
    let datesMoved = 0;
    if (context.nonWorking && !current?.ignoreNonWorkingDays) {
      const move = (date: string | null) => {
        if (!date) return date;
        const moved = nextWorkingDay(date, context.nonWorking!);
        if (moved !== date) datesMoved += 1;
        return moved;
      };
      const oneDay = Boolean(type?.milestone) && first === last;
      first = move(first);
      last = oneDay ? first : move(last);
    }
    const estimate = parseHours(cell(cells, 'estimate'));
    if (estimate === undefined) problem('Estimated hours', message('{value} is not a number of hours.', { value: cell(cells, 'estimate') }));
    const done = parseDone(cell(cells, 'done'));
    if (done === undefined) problem('Done %', message('{value} is not a percentage from 0 to 100.', { value: cell(cells, 'done') }));

    // A value as the work package already has it is kept even if it could not be chosen now (a former member, say).
    const lookup = (column: Column, label: string, map: Map<string, string>, what: Message, now?: { id: string | null; name: string }) => {
      const value = cell(cells, column);
      if (!value) return null;
      if (now?.id && value.toLowerCase() === now.name.toLowerCase()) return now.id;
      const id = map.get(value.toLowerCase());
      if (!id) problem(label, message('{value} is not {what}.', { value, what }));
      return id ?? null;
    };
    const assigneeId = lookup('assignee', 'Assignee', context.members, message('a member of this project (give their login, email or full name)'), current && { id: current.assigneeId, name: current.assignee });
    const statusId = lookup('status', 'Status', context.statuses, message('a status'), current && { id: current.statusId, name: current.status });
    const priorityId = lookup('priority', 'Priority', context.priorities, message('a priority'), current && { id: current.priorityId, name: current.priority });
    const versionId = lookup('version', 'Version', context.versions, message('a version in this project'), current && { id: current.versionId, name: current.version });
    const accountableId = lookup('accountable', 'Accountable', context.members, message('a member of this project (give their login, email or full name)'), current && { id: current.accountableId, name: current.accountable });
    const categoryId = lookup('category', 'Category', context.categories ?? new Map(), message('a category in this project'), current && { id: current.categoryId, name: current.category });
    const pointsText = cell(cells, 'points');
    const points = !pointsText ? null : /^\d+$/.test(pointsText) ? Number(pointsText) : undefined;
    if (points === undefined) problem('Story points', message('{value} is not a whole number of points.', { value: pointsText }));
    const manual = parseYesNo(cell(cells, 'manual'));
    if (manual === undefined) problem('Manual scheduling', message('{value} is not Yes or No.', { value: cell(cells, 'manual') }));
    const custom: CustomValue[] = [];
    for (const [key, at] of fieldAt) {
      const field = fieldsByKey.get(key)!;
      const raw = (cells[at] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
      if (type && !field.types.has(type.id)) {
        if (raw) problem(field.name, message('{field} is not a field of {type} tasks in this project.', { field: field.name, type: type.name }));
        continue;
      }
      const value = fieldInput(raw, field, context.members, current?.custom[key]);
      if (value === undefined) problem(field.name, message('{value} is not a valid {field}.', { value: raw, field: field.name }));
      else custom.push({ key, format: field.format, value, text: raw });
    }

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
      done: done ?? null,
      ...(datesMoved ? { datesMoved } : {}),
      assigneeId,
      statusId,
      priorityId,
      versionId,
      accountableId,
      categoryId,
      points: points ?? null,
      manual: manual ?? null,
      custom,
      predecessors,
    });
  }

  // Parents and dependencies point at rows in the file, or at existing work: #123, WP123, or an ID an earlier import made.
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const outside = (key: string) => (byKey.has(key) ? null : existingOf(key) ? `#${existingOf(key)!.id}` : null);
  for (const row of rows) {
    if (row.parentKey && outside(row.parentKey)) {
      row.parentId = outside(row.parentKey)!.slice(1);
      row.parentKey = null;
    }
    row.predecessors = row.predecessors.map((predecessor) => outside(predecessor) ?? predecessor);
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

  // What each row does. A row naming a work package of this project is compared with it, column by column.
  const cellsByLine = new Map(records.slice(1).map((record) => [record.line, record.cells]));
  const named = new Map<string, number>();
  for (const row of rows) {
    const current = existingOf(row.key);
    if (!current) continue;
    if (named.has(current.id)) problems.push({ row: row.line, column: 'ID', message: message('This row and line {other} are the same task (WP{id}).', { other: named.get(current.id)!, id: current.id }) });
    else named.set(current.id, row.line);
  }
  const bySubject = new Map<string, string[]>();
  for (const work of context.existing?.values() ?? []) bySubject.set(work.subject.trim().toLowerCase(), [...(bySubject.get(work.subject.trim().toLowerCase()) ?? []), work.id]);
  const idOfKey = (key: string) => (/^#\d+$/.test(key) ? key.slice(1) : byKey.get(key) && existingOf(key) ? existingOf(key)!.id : null);
  for (const row of rows) {
    const current = existingOf(row.key);
    if (!current) {
      row.action = 'create';
      if (workPackageNumber(row.key)) row.copy = true;
      const twin = (bySubject.get(row.subject.trim().toLowerCase()) ?? []).find((id) => !named.has(id));
      if (twin) row.sameSubjectAs = twin;
      if (row.done !== null && context.progressWritable === false) {
        row.progressIgnored = true;
        row.done = null;
      }
      continue;
    }
    const cells = cellsByLine.get(row.line)!;
    const set = new Set<UpdateField>();
    const changes: TaskImportChange[] = [];
    const differ = (field: UpdateField, column: string, from: string, to: string) => {
      if (from === to) return;
      set.add(field);
      changes.push({ column, from, to });
    };
    if (!sameText(current.subject, row.subject)) differ('subject', 'Subject', current.subject, row.subject);
    if (present('description') && !sameText(current.description, row.description ?? '')) differ('description', 'Description', current.description.trim(), row.description ?? '');
    if (row.typeId && row.typeId !== current.typeId) differ('type', 'Type', current.type, row.typeName);
    if (row.milestone) {
      if (present('start') || present('due')) differ('due', 'Date', current.due ?? '', row.due ?? '');
    } else {
      if (present('start')) differ('start', 'Start date', current.start ?? '', row.start ?? '');
      if (present('due')) differ('due', 'Due date', current.due ?? '', row.due ?? '');
    }
    // A milestone has one date and a task two: changing between them sends the dates again.
    if (set.has('type') && row.milestone !== current.milestone) {
      if (row.milestone) set.add('due');
      else {
        if (present('start')) set.add('start');
        if (present('due')) set.add('due');
      }
    }
    if (present('estimate')) differ('estimate', 'Estimated hours', hoursText(current.estimate), hoursText(row.estimate));
    if (row.done !== null && row.done !== current.done) {
      if (context.progressWritable === false) row.progressIgnored = true;
      else differ('done', 'Done %', current.done === null ? '' : String(current.done), String(row.done));
    }
    if (present('assignee') && row.assigneeId !== current.assigneeId) differ('assignee', 'Assignee', current.assignee, cell(cells, 'assignee'));
    if (row.statusId && row.statusId !== current.statusId) differ('status', 'Status', current.status, cell(cells, 'status'));
    if (row.priorityId && row.priorityId !== current.priorityId) differ('priority', 'Priority', current.priority, cell(cells, 'priority'));
    if (present('version') && row.versionId !== current.versionId) differ('version', 'Version', current.version, cell(cells, 'version'));
    if (present('accountable') && row.accountableId !== current.accountableId) differ('accountable', 'Accountable', current.accountable, cell(cells, 'accountable'));
    if (present('category') && row.categoryId !== current.categoryId) differ('category', 'Category', current.category, cell(cells, 'category'));
    if (present('points') && (row.points ?? null) !== current.points) differ('points', 'Story points', current.points === null ? '' : String(current.points), row.points == null ? '' : String(row.points));
    if (row.manual != null && row.manual !== current.scheduleManually) differ('manual', 'Manual scheduling', current.scheduleManually ? 'Yes' : 'No', row.manual ? 'Yes' : 'No');
    for (const value of row.custom ?? []) {
      const now = current.custom[value.key] ?? { text: '', id: null };
      if (!sameValue(fieldsByKey.get(value.key)!, now, value.value)) differ(value.key as UpdateField, fieldsByKey.get(value.key)!.name, now.text, value.text);
    }
    if (present('parent')) {
      // A blank Parent ID takes a work package out from under its parent — unless that parent is in another project, which the file cannot show.
      const keep = !row.parentKey && !row.parentId && current.parentElsewhere;
      // Under a row the file creates: not made yet, so a move whatever it is under now.
      const underNew = Boolean(row.parentKey && !idOfKey(row.parentKey));
      const wanted = row.parentKey ? idOfKey(row.parentKey) : row.parentId;
      if (!keep && (underNew || wanted !== current.parentId)) {
        differ('parent', 'Parent ID', current.parentId ? `WP${current.parentId}` : '', cell(cells, 'parent'));
      }
    }
    // Dependencies as the file lists them: those missing are added, those no longer listed are removed.
    row.unlink = [];
    if (present('predecessors')) {
      const wanted = new Set(row.predecessors.map(idOfKey).filter((id): id is string => Boolean(id)));
      const toAdd = row.predecessors.filter((predecessor) => {
        const id = idOfKey(predecessor);
        return !id || !current.predecessors.has(id);
      });
      row.unlink = [...current.predecessors].filter(([id]) => !wanted.has(id)).map(([, relation]) => relation);
      if (toAdd.length > 0 || row.unlink.length > 0) {
        changes.push({ column: 'Predecessors', from: [...current.predecessors.keys()].map((id) => `WP${id}`).join(';'), to: cell(cells, 'predecessors') });
      }
      row.predecessors = toAdd;
    } else {
      row.predecessors = [];
    }
    row.workPackageId = current.id;
    if (!workPackageNumber(row.key)) row.matchedEarlier = true;
    row.set = [...set];
    row.changes = changes;
  }

  // Work scheduled automatically takes its dates from its children, and its
  // start from the work it follows, and ignores such dates set on it: those
  // edits are left out and said so, not reported as done — or the same sheet
  // would show them as changes every time it is uploaded. Changing only the due
  // date of work that follows another is its length, and is kept. Children and
  // predecessors as they will be once the file is imported.
  const parentAfter = (row: PlannedRow, current?: ExistingWork) => {
    if (current && (!present('parent') || (!row.parentKey && !row.parentId && current.parentElsewhere))) return current.parentId;
    return row.parentKey ? (idOfKey(row.parentKey) ?? `new:${row.parentKey}`) : row.parentId;
  };
  const parents = new Set<string>();
  const inFile = new Set<string>();
  for (const row of rows) {
    const current = existingOf(row.key);
    if (current) inFile.add(current.id);
    const parent = parentAfter(row, current);
    if (parent) parents.add(parent);
  }
  for (const current of context.existing?.values() ?? []) if (!inFile.has(current.id) && current.parentId) parents.add(current.parentId);
  // Automatic scheduling needs something to schedule from: predecessors or subtasks.
  for (const row of rows) {
    if (row.manual !== false) continue;
    const current = existingOf(row.key);
    const follows = current ? current.predecessors.size - (row.unlink?.length ?? 0) + row.predecessors.length > 0 : row.predecessors.length > 0;
    const leads = parents.has(current ? current.id : `new:${row.key}`);
    if (!follows && !leads && (!current || current.scheduleManually)) {
      problems.push({ row: row.line, column: 'Manual scheduling', message: message('Manual scheduling can be No only for a task with predecessors or subtasks: the schedule needs one of them to set its dates.') });
    }
  }
  for (const row of rows) {
    if (!row.workPackageId || !row.set) continue;
    const current = context.existing!.get(row.workPackageId)!;
    const follows = current.predecessors.size - (row.unlink?.length ?? 0) + row.predecessors.length > 0;
    // Scheduled by hand — now, or by this very row — its dates are its own.
    const datesFollow = (row.manual ?? current.scheduleManually)
      ? undefined
      : parents.has(current.id)
        ? 'children'
        : follows && (row.milestone || row.set.includes('start'))
          ? 'predecessors'
          : undefined;
    if (datesFollow && (row.set.includes('start') || row.set.includes('due'))) {
      row.set = row.set.filter((field) => field !== 'start' && field !== 'due');
      row.changes = row.changes!.filter((change) => !['Start date', 'Due date', 'Date'].includes(change.column));
      row.datesFollow = datesFollow;
    }
    row.action = row.changes!.length > 0 ? 'update' : 'unchanged';
  }
  problems.sort((a, b) => a.row - b.row);
  return { rows, problems, ignored };
}

/** A custom field's cell as the value to write; undefined when it is not one. */
function fieldInput(raw: string, field: TaskField, members: Map<string, string>, now?: { text: string; id: string | null }): string | number | boolean | null | undefined {
  if (!raw) return null;
  switch (field.format) {
    case 'string':
    case 'text':
      return raw;
    case 'int':
      return /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    case 'float': {
      const value = Number(raw.replace(',', '.'));
      return /^-?\d+(?:[.,]\d+)?$/.test(raw) && Number.isFinite(value) ? value : undefined;
    }
    case 'bool':
      return parseYesNo(raw);
    case 'date':
      return parseDay(raw) ?? undefined;
    case 'option':
      if (now?.id && raw.toLowerCase() === now.text.toLowerCase()) return now.id;
      return field.options.get(raw.toLowerCase());
    case 'user':
      if (now?.id && raw.toLowerCase() === now.text.toLowerCase()) return now.id;
      return members.get(raw.toLowerCase());
  }
}

/** Whether a custom field already holds the value. */
function sameValue(field: TaskField, now: { text: string; id: string | null }, value: string | number | boolean | null): boolean {
  if (field.format === 'option' || field.format === 'user') return (now.id ?? null) === value;
  if (value === null) return now.text === '';
  if (field.format === 'bool') return (now.text === 'Yes') === value && now.text !== '';
  if (field.format === 'int' || field.format === 'float') return now.text !== '' && Number(now.text) === value;
  if (field.format === 'text') return sameText(now.text, String(value));
  return now.text === String(value);
}

/** Custom field values into a write: scalars and text in the body, lists and people as links. */
function writeCustom(values: CustomValue[], body: Record<string, unknown>, links: Record<string, { href: string | null }>, only?: Set<string>): void {
  for (const { key, format, value } of values) {
    if (only && !only.has(key)) continue;
    if (!only && value === null) continue;
    if (format === 'option') links[key] = { href: value ? `/api/v3/custom_options/${value}` : null };
    else if (format === 'user') links[key] = { href: value ? `/api/v3/users/${value}` : null };
    else if (format === 'text') body[key] = { format: 'markdown', raw: value === null ? '' : String(value) };
    else body[key] = value;
  }
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

const renderProblem = (problem: StoredProblem): TaskImportProblem => ({
  row: problem.row,
  ...(problem.column ? { column: problem.column } : {}),
  message: render(contextLanguage(), problem.message, contextConventions()),
});

const actionOf = (row: PlannedRow): RowAction => row.action ?? 'create';

/** Markers in `results` beside row key → new work package id. */
const UPDATED = 'upd:';
const LINKED = 'link:';
const UNLINKED = 'unlink:';
const MOVED = 'move:';
const isCreatedKey = (key: string) => ![UPDATED, LINKED, UNLINKED, MOVED].some((marker) => key.startsWith(marker));

function counts(rows: PlannedRow[]) {
  return {
    toCreate: rows.filter((row) => actionOf(row) === 'create').length,
    toUpdate: rows.filter((row) => actionOf(row) === 'update').length,
  };
}

function canRun(row: TaskImport): boolean {
  if (['checked', 'failed', 'cancelled'].includes(row.status)) return true;
  return row.status === 'running' && (!row.heartbeatAt || Date.now() - row.heartbeatAt.getTime() > STALE_MS);
}

export function importView(row: TaskImport): TaskImportView {
  const rows = row.rows as unknown as PlannedRow[];
  const problems = row.problems as unknown as StoredProblem[];
  const errors = row.errors as unknown as { row: number; message: string }[];
  const results = Object.keys(row.results as Record<string, string>);
  const { toCreate, toUpdate } = counts(rows);
  const byType: Record<string, number> = {};
  for (const planned of rows) if (actionOf(planned) === 'create') byType[planned.typeName] = (byType[planned.typeName] ?? 0) + 1;
  const updates = rows.filter((planned) => actionOf(planned) === 'update');
  return {
    id: row.id,
    projectId: String(row.projectId),
    fileName: row.fileName,
    status: row.status as TaskImportStatus,
    total: row.total,
    toCreate,
    toUpdate,
    unchanged: rows.length - toCreate - toUpdate,
    copies: rows.filter((planned) => planned.copy).length,
    matchedEarlier: rows.filter((planned) => planned.matchedEarlier).length,
    sameSubject: rows.filter((planned) => planned.sameSubjectAs).slice(0, CHANGES_SHOWN).map((planned) => ({ row: planned.line, key: planned.key.startsWith('#line') ? '' : planned.key, subject: planned.subject, existing: `WP${planned.sameSubjectAs}` })),
    progressIgnored: rows.filter((planned) => planned.progressIgnored).length,
    datesMoved: rows.reduce((sum, planned) => sum + (planned.datesMoved ?? 0), 0),
    created: row.created,
    updated: results.filter((key) => key.startsWith(UPDATED)).length,
    linked: row.linked,
    unlinked: results.filter((key) => key.startsWith(UNLINKED)).length,
    failed: row.failed,
    byType,
    levels: rows.reduce((deepest, planned) => Math.max(deepest, planned.depth + 1), 0),
    relations: rows.reduce((sum, planned) => sum + planned.predecessors.length, 0),
    relationsRemoved: rows.reduce((sum, planned) => sum + (planned.unlink?.length ?? 0), 0),
    datesSkipped: rows
      .filter((planned) => planned.datesFollow)
      .slice(0, CHANGES_SHOWN)
      .map((planned) => ({ row: planned.line, key: planned.key, subject: planned.subject, reason: planned.datesFollow! })),
    changes: updates.slice(0, CHANGES_SHOWN).map((planned) => ({ row: planned.line, key: planned.key, subject: planned.subject, changes: planned.changes ?? [] })),
    problems: problems.slice(0, 500).map(renderProblem),
    problemCount: problems.length,
    errors: errors.slice(0, 500),
    errorCount: errors.length,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    canRun: canRun(row) && problems.length === 0 && (toCreate > 0 || toUpdate > 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Checks an uploaded file and keeps it, ready to run if it is clean. Updates
 * need `task:edit` in the project as well as `task:create`.
 */
export async function checkImport(projectId: number, fileName: string, input: CsvRecord[], actorId: string, mayEdit: boolean): Promise<TaskImportView> {
  const [context, remembered] = await Promise.all([projectContext(projectId), rememberedIds(projectId)]);
  context.remembered = remembered;
  const { records, source } = normaliseSource(input);
  const { rows, problems, ignored } = checkRows(records, context);
  const { toUpdate } = counts(rows);
  if (toUpdate > 0 && !mayEdit) {
    problems.unshift({ row: 1, message: message('The file changes {count, number} existing tasks, and you may not edit tasks in this project. Take those rows out, or ask for edit access.', { count: toUpdate }) });
  }
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
  return { ...importView(row), source: { ...source, ignoredColumns: ignored } };
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

/**
 * A template for the project, as a workbook: a Tasks sheet with the header
 * only, to fill in; an Example sheet with a small plan; and a How to fill sheet
 * naming what each column takes, with the project's own types, statuses,
 * priorities, versions, categories, members and list options. Only the first
 * sheet is imported, so the example is never created by mistake; and dates
 * typed into a workbook stay dates, where a CSV saved by a spreadsheet can
 * turn 2 November into 11/2 and be read the other way round.
 */
export async function templateFor(projectId: number): Promise<Uint8Array> {
  const context = await projectContext(projectId, false);
  const language = contextLanguage();
  const types = [...context.types.values()];
  const summary = types.find((type) => /^(epic|summary task|phase|feature)$/i.test(type.name)) ?? context.defaultType;
  const task = context.defaultType;
  const milestone = types.find((type) => type.milestone);
  const header = [...IMPORT_COLUMNS, ...(context.fields ?? []).map((field) => field.name)];
  const example = (values: Partial<Record<(typeof IMPORT_COLUMNS)[number], string | number>>) => header.map((column) => values[column as (typeof IMPORT_COLUMNS)[number]] ?? '');
  const examples = [
    example({ ID: 'E1', Type: summary.name, Subject: 'Customer portal', Description: 'Everything for the portal launch', 'Start date': '2026-11-02', 'Due date': '2026-12-18' }),
    example({ ID: 'T1', 'Parent ID': 'E1', Type: task.name, Subject: 'Design the screens', 'Start date': '2026-11-02', 'Due date': '2026-11-13', 'Estimated hours': 40 }),
    example({ ID: 'S1', 'Parent ID': 'T1', Type: task.name, Subject: 'Login screen', 'Start date': '2026-11-02', 'Due date': '2026-11-04', 'Estimated hours': 8, 'Done %': 0, 'Story points': 3 }),
    example({ ID: 'T2', 'Parent ID': 'E1', Type: task.name, Subject: 'Build the API', 'Start date': '2026-11-16', 'Due date': '2026-12-04', 'Estimated hours': 80, Predecessors: 'T1' }),
    ...(milestone ? [example({ ID: 'M1', 'Parent ID': 'E1', Type: milestone.name, Subject: 'Portal live', 'Due date': '2026-12-18', Predecessors: 'T2' })] : []),
  ];
  const list = (values: string[]) => values.join(', ');
  const member = t(language, 'A member of the project: full name, login or email.');
  const guide: [string, string, string][] = [
    ['ID', t(language, 'Your own label for the row, such as E1 or T1. Needed when another row names it as its parent or predecessor. Uploading the sheet again updates the tasks its IDs made.'), ''],
    ['Parent ID', t(language, 'The ID of the row this one sits under. Blank: the top level.'), ''],
    ['Type', t(language, 'The kind of task. Blank: {type}.', { type: task.name }), list(types.map((type) => type.name))],
    ['Subject', t(language, 'Required.'), ''],
    ['Description', t(language, 'Text.'), ''],
    ['Start date', t(language, 'A date. A milestone takes its due date only.'), ''],
    ['Due date', t(language, 'A date.'), ''],
    ['Estimated hours', t(language, 'Hours, such as 8 or 7.5.'), ''],
    ['Done %', t(language, 'From 0 to 100. Blank: unchanged.'), ''],
    ['Assignee', member, list(context.memberNames ?? [])],
    ['Accountable', member, list(context.memberNames ?? [])],
    ['Status', t(language, 'Blank: the first status.'), list(context.statusNames ?? [])],
    ['Priority', t(language, 'Blank: the default priority.'), list(context.priorityNames ?? [])],
    ['Version', t(language, 'A version of the project.'), list(context.versionNames ?? [])],
    ['Category', t(language, 'A category of the project.'), list(context.categoryNames ?? [])],
    ['Story points', t(language, 'A whole number.'), ''],
    ['Manual scheduling', t(language, 'Yes or No. Blank: as the schedule decides. No only for a task with predecessors or subtasks.'), 'Yes, No'],
    ['Predecessors', t(language, 'The IDs of the rows it follows, separated by ;'), ''],
    ...(context.fields ?? []).map((field): [string, string, string] => [
      field.name,
      {
        string: t(language, 'Text.'),
        text: t(language, 'Text.'),
        int: t(language, 'A whole number.'),
        float: t(language, 'A number, such as 7.5.'),
        bool: t(language, 'Yes or No.'),
        date: t(language, 'A date.'),
        option: t(language, 'One of the allowed values.'),
        user: member,
      }[field.format],
      field.format === 'option' ? list([...field.optionValues.values()]) : field.format === 'bool' ? 'Yes, No' : field.format === 'user' ? list(context.memberNames ?? []) : '',
    ]),
  ];
  const widths = header.map((column) => Math.max(12, Math.min(40, column.length + 4)));
  return buildWorkbook(
    [
      { name: t(language, 'Tasks'), headers: header, rows: [], widths },
      { name: t(language, 'Example'), headers: header, rows: examples, widths },
      {
        name: t(language, 'How to fill'),
        headers: [t(language, 'Column'), t(language, 'What to put'), t(language, 'Allowed values')],
        rows: [
          ['', t(language, 'Fill in the Tasks sheet, one row per task; only that sheet is imported. Upload it in Tasks > Import: every row is checked before anything is created.'), ''],
          ...guide,
        ],
        widths: [20, 90, 70],
      },
    ],
    { title: t(language, 'Task import template'), rightToLeft: language === 'ar' },
  );
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
  // A resumed run tries again every row not yet done, so earlier failures are forgotten.
  const errors: { row: number; message: string }[] = [];
  let linked = start.linked;
  let sinceSave = 0;

  const save = async (extra: Partial<Pick<TaskImport, 'status' | 'finishedAt'>> = {}): Promise<boolean> => {
    const row = await prisma.taskImport.update({
      where: { id },
      data: {
        results: Object.fromEntries(results) as object,
        errors: errors as unknown as object,
        created: [...results.keys()].filter(isCreatedKey).length,
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
    errors.push({ row: row.line, message: error instanceof Error ? error.message : String(error) });
  };

  try {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // A row's work package: made by this import, or the one an update row changes.
    const idOf = (key: string) => results.get(key) ?? byKey.get(key)?.workPackageId;
    const rootOf = (row: PlannedRow): string => {
      let at = row;
      while (at.parentKey && byKey.has(at.parentKey)) at = byKey.get(at.parentKey)!;
      return at.parentId ? `#${at.parentId}` : at.key;
    };
    // Each change to a child updates its parent and every ancestor upstream, so
    // two rows under the same top-level item at once can be refused as a
    // conflict: a batch holds at most one row of each tree, a level at a time.
    const byLevels = async (pending: PlannedRow[], act: (row: PlannedRow) => Promise<void>) => {
      const deepest = pending.reduce((max, row) => Math.max(max, row.depth), 0);
      for (let depth = 0; depth <= deepest; depth += 1) {
        let level = pending.filter((row) => row.depth === depth);
        while (level.length > 0) {
          const batch: PlannedRow[] = [];
          const trees = new Set<string>();
          const rest: PlannedRow[] = [];
          for (const row of level) {
            const tree = rootOf(row);
            if (batch.length < CONCURRENCY && !trees.has(tree)) {
              batch.push(row);
              trees.add(tree);
            } else {
              rest.push(row);
            }
          }
          level = rest;
          await Promise.all(batch.map(act));
          await settle();
        }
      }
    };

    // New rows.
    await byLevels(
      rows.filter((row) => actionOf(row) === 'create' && !results.has(row.key)),
      async (row) => {
        const parent = row.parentKey ? idOf(row.parentKey) : row.parentId;
        if (row.parentKey && !parent) {
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
      },
    );

    // Updates: each read for its lock version just before it is changed, so a
    // change made meanwhile is never overwritten blind.
    const patch = async (row: PlannedRow, body: Record<string, unknown>) =>
      withConflictRetry(async () => {
        const current = await openProject.request<{ lockVersion: number }>(`/work_packages/${row.workPackageId}`);
        await openProject.request(`/work_packages/${row.workPackageId}`, {
          method: 'PATCH',
          body: { lockVersion: current.lockVersion, ...body },
          query: { notify: 'false' },
          timeoutMs: 120_000,
        });
      });
    const updates = rows.filter((row) => actionOf(row) === 'update' && !results.has(`${UPDATED}${row.key}`));
    // Moves first, a level at a time: a parent's dates follow its children, so
    // one that loses them in the file takes its new dates only afterwards.
    const failedMoves = new Set<string>();
    await byLevels(
      updates.filter((row) => row.set!.includes('parent') && !results.has(`${MOVED}${row.key}`)),
      async (row) => {
        const parent = row.parentKey ? idOf(row.parentKey) : row.parentId;
        if (row.parentKey && !parent) {
          failedMoves.add(row.key);
          errors.push({ row: row.line, message: 'Its new parent could not be created.' });
          return;
        }
        try {
          await patch(row, changesOf(row, parent ?? null, 'parent'));
          results.set(`${MOVED}${row.key}`, '1');
        } catch (error) {
          failedMoves.add(row.key);
          fail(row, error);
        }
        tick();
      },
    );
    // Then everything else; a row whose only change is its parent or its
    // dependencies is done here without a request.
    await byLevels(
      updates.filter((row) => !failedMoves.has(row.key)),
      async (row) => {
        const body = changesOf(row, null, 'fields');
        try {
          if (Object.keys(body).length > 0) await patch(row, body);
          results.set(`${UPDATED}${row.key}`, '1');
        } catch (error) {
          fail(row, error);
        }
        tick();
      },
    );

    // Dependencies no longer listed, then those to add, once everything they join exists.
    // Two changes touching the same work package at once can be refused upstream,
    // so each batch holds only links that share none.
    const inBatches = async <T>(items: T[], ends: (item: T) => string[], act: (item: T) => Promise<void>) => {
      let pending = items;
      while (pending.length > 0) {
        const batch: T[] = [];
        const busy = new Set<string>();
        const rest: T[] = [];
        for (const item of pending) {
          const touched = ends(item);
          if (batch.length < CONCURRENCY && !touched.some((end) => busy.has(end))) {
            batch.push(item);
            touched.forEach((end) => busy.add(end));
          } else {
            rest.push(item);
          }
        }
        pending = rest;
        await Promise.all(batch.map(act));
        await settle();
      }
    };
    await inBatches(
      rows.flatMap((row) => (row.unlink ?? []).map((relation) => ({ row, relation }))).filter(({ relation }) => !results.has(`${UNLINKED}${relation}`)),
      ({ row }) => [row.key],
      async ({ row, relation }) => {
        try {
          await withConflictRetry(() => openProject.request(`/relations/${relation}`, { method: 'DELETE', timeoutMs: 120_000 }));
          results.set(`${UNLINKED}${relation}`, '1');
        } catch (error) {
          // Gone already: what was wanted.
          if (error instanceof OpenProjectError && error.upstreamStatus === 404) results.set(`${UNLINKED}${relation}`, '1');
          else fail(row, error);
        }
        tick();
      },
    );
    await inBatches(
      rows.flatMap((row) => row.predecessors.map((predecessor) => ({ row, predecessor }))),
      ({ row, predecessor }) => [row.key, predecessor],
      async ({ row, predecessor }) => {
        const done = `${LINKED}${row.key}:${predecessor}`;
        if (results.has(done)) return;
        const successor = idOf(row.key);
        const target = /^#\d+$/.test(predecessor) ? predecessor.slice(1) : idOf(predecessor);
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
      },
    );
    await save({ status: 'done', finishedAt: new Date() });
    const finished = await getImport(id);
    const updated = Object.keys(finished.results as Record<string, string>).filter((key) => key.startsWith(UPDATED)).length;
    await withAudit(async () => finished, {
      actorId: finished.createdBy,
      projectId: String(finished.projectId),
      entityType: 'project',
      entityId: String(finished.projectId),
      action: 'tasks.imported',
      summary: message('{created, number} work packages created and {updated, number} updated from {file}; {failed, number} rows could not be.', {
        created: finished.created,
        updated,
        file: finished.fileName,
        failed: finished.failed,
      }),
      after: { importId: id, created: finished.created, updated, linked: finished.linked, failed: finished.failed },
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
  const links: Record<string, { href: string | null }> = { type: { href: `/api/v3/types/${row.typeId}` } };
  if (row.accountableId) links.responsible = { href: `/api/v3/users/${row.accountableId}` };
  if (row.categoryId) links.category = { href: `/api/v3/categories/${row.categoryId}` };
  const extra: Record<string, unknown> = {};
  if (row.points != null) extra.storyPoints = row.points;
  if (row.manual) extra.scheduleManually = true;
  writeCustom(row.custom ?? [], extra, links);
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
    ...(row.done !== null && row.done !== undefined ? { percentageDone: row.done } : {}),
    ...extra,
    _links: links,
  };
}

/** Only the fields an update row changes — its parent, the rest, or both; a blank cell clears its field. */
export function changesOf(row: PlannedRow, parentId: string | null, part: 'parent' | 'fields' | 'all' = 'all'): Record<string, unknown> {
  const set = new Set((row.set ?? []).filter((field) => part === 'all' || (part === 'parent') === (field === 'parent')));
  const body: Record<string, unknown> = {};
  const links: Record<string, { href: string | null }> = {};
  if (set.has('subject')) body.subject = row.subject;
  if (set.has('description')) body.description = { format: 'markdown', raw: row.description ?? '' };
  if (set.has('type')) links.type = { href: `/api/v3/types/${row.typeId}` };
  if (row.milestone) {
    if (set.has('start') || set.has('due')) body.date = row.due;
  } else {
    if (set.has('start')) body.startDate = row.start;
    if (set.has('due')) body.dueDate = row.due;
  }
  if (set.has('estimate')) body.estimatedTime = row.estimate === null ? null : `PT${row.estimate}H`;
  if (set.has('done') && row.done !== null) body.percentageDone = row.done;
  if (set.has('assignee')) links.assignee = { href: row.assigneeId ? `/api/v3/users/${row.assigneeId}` : null };
  if (set.has('status') && row.statusId) links.status = { href: `/api/v3/statuses/${row.statusId}` };
  if (set.has('priority') && row.priorityId) links.priority = { href: `/api/v3/priorities/${row.priorityId}` };
  if (set.has('version')) links.version = { href: row.versionId ? `/api/v3/versions/${row.versionId}` : null };
  if (set.has('parent')) links.parent = { href: parentId ? `/api/v3/work_packages/${parentId}` : null };
  if (set.has('accountable')) links.responsible = { href: row.accountableId ? `/api/v3/users/${row.accountableId}` : null };
  if (set.has('category')) links.category = { href: row.categoryId ? `/api/v3/categories/${row.categoryId}` : null };
  if (set.has('points')) body.storyPoints = row.points ?? null;
  if (set.has('manual')) body.scheduleManually = row.manual;
  writeCustom(row.custom ?? [], body, links, new Set([...set].filter((field) => field.startsWith('customField'))));
  if (Object.keys(links).length > 0) body._links = links;
  return body;
}
