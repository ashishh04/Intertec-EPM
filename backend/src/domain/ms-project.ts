import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { env } from '../config/env.js';
import { decodeText, type CsvRecord } from '../lib/csv-parse.js';
import { durationToHours } from '../lib/duration.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { childOf, childrenOf, escapeXml, parseXml, textOf, XmlError, type XmlElement } from '../lib/xml-read.js';
import { href, title, type ProjectWork } from './task-export.js';

/**
 * Microsoft Project plans in and out of a project (Tasks → Import and Export).
 *
 * In: a Microsoft Project XML file (File → Save As → XML Format), read here,
 * or one of Microsoft Project's own files — .mpp, the template .mpt, the older
 * .mpx — which MPXJ, a Java library the image carries (Dockerfile), turns into
 * that XML first. The plan becomes the rows the CSV import reads
 * (task-import.ts), so it is checked, shown and imported the same way: the
 * outline becomes parents and subtasks, summary tasks phases, milestones
 * milestones, with the dates, the work, the progress, the notes, the person
 * with most work on each task, and the finish-to-start dependencies. Every
 * task keeps the dates the plan gave it: each is scheduled manually, so
 * nothing moves when the dependencies are added. A task that came from EPM
 * (its hyperlink names its work package, see below) updates that work
 * package; any other is matched to what an earlier import of the same file
 * made, so a plan imported again updates its tasks rather than repeating them.
 *
 * Out: the project as Microsoft Project XML, which Microsoft Project opens and
 * can save as .mpp. Nothing outside Microsoft Project writes .mpp itself — MPXJ
 * reads it but cannot write it — so the XML is the file to hand over. Each
 * task carries a hyperlink to its work package, so the file can come back.
 */

const NAMESPACE = 'http://schemas.microsoft.com/project';

/** Microsoft Project's own file types, read through MPXJ. */
export const MS_PROJECT_FILE = /\.(mpp|mpt|mpx)$/i;

/** Whether an upload is Microsoft Project XML: a Project root in Project's namespace. */
export function isMsProjectXml(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, 4096));
  return head.includes(NAMESPACE) && /<(?:\w+:)?Project[\s>]/.test(head);
}

/* -------------------------------------------------------------------------- */
/* Reading .mpp                                                               */
/* -------------------------------------------------------------------------- */

const CONVERT_TIMEOUT_MS = 120_000;
/** Plans read at once: each conversion is a Java process with its own heap. */
const MAX_CONVERSIONS = 2;
let converting = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (converting >= MAX_CONVERSIONS) await new Promise<void>((resolve) => waiting.push(resolve));
  converting += 1;
  try {
    return await work();
  } finally {
    converting -= 1;
    waiting.shift()?.();
  }
}

const unreadableHere = () =>
  EpmError.validation(
    message('Microsoft Project files (.mpp) cannot be read on this server. In Microsoft Project choose File → Save As, save the plan as XML Format (*.xml), and import that file.'),
  );

/**
 * A Microsoft Project file (.mpp, .mpt, .mpx) as Microsoft Project XML, through
 * MPXJ's converter. Run without a shell, with fixed arguments, on a copy in a
 * folder of its own that is removed afterwards, with a time limit and a heap
 * limit: the file is whatever was uploaded.
 */
export async function msProjectFileToXml(bytes: Uint8Array, filename: string): Promise<string> {
  const home = env.EPM_MPXJ_HOME;
  if (!home) throw unreadableHere();
  const java = env.EPM_JAVA ?? 'java';
  const extension = (MS_PROJECT_FILE.exec(filename)?.[1] ?? 'mpp').toLowerCase();
  return slot(async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'epm-plan-'));
    const input = path.join(folder, `plan.${extension}`);
    const output = path.join(folder, 'plan.xml');
    try {
      await writeFile(input, bytes);
      const classpath = [path.join(home, 'mpxj.jar'), path.join(home, 'lib', '*')].join(path.delimiter);
      await new Promise<void>((resolve, reject) => {
        execFile(
          java,
          ['-Xmx768m', '-Djava.awt.headless=true', '-cp', classpath, 'org.mpxj.sample.MpxjConvert', input, output],
          { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
            appLog.warn({ err: error, stderr: String(stderr).slice(-2000) }, missing ? 'No Java runtime to read Microsoft Project files' : 'A Microsoft Project file could not be read');
            reject(missing ? unreadableHere() : EpmError.validation(message('The Microsoft Project file could not be read. It may be damaged or protected with a password: open it in Microsoft Project, save it as XML Format (*.xml), and import that file.')));
          },
        );
      });
      // MPXJ reports some failures on its error stream and still ends normally.
      const xml = decodeText(await readFile(output).catch(() => {
        throw EpmError.validation(message('The Microsoft Project file could not be read. It may be damaged or protected with a password: open it in Microsoft Project, save it as XML Format (*.xml), and import that file.'));
      }));
      return xml;
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Reading the XML                                                            */
/* -------------------------------------------------------------------------- */

/** The import's columns this file fills, in the order the CSV import reads them. */
const HEADER = ['ID', 'Parent ID', 'Type', 'Subject', 'Description', 'Start date', 'Due date', 'Estimated hours', 'Done %', 'Assignee', 'Manual scheduling', 'Predecessors'];

/** Finish-to-start, the dependency both tools mean by "follows". */
const FINISH_TO_START = '1';

export interface MsProjectTypes {
  /** The project's milestone type, for Project's milestones. */
  milestone?: string;
  /** A type for Project's summary tasks, such as Phase; blank leaves them the default. */
  summary?: string;
}

export interface MsProjectRows {
  records: CsvRecord[];
  /** The plan's title, for the import's name. */
  title?: string;
  tasks: number;
  /** Dependencies of another kind (start-to-start, finish-to-finish…) or to a task left out. */
  linksLeftOut: number;
}

const flag = (element: XmlElement, name: string) => textOf(element, name) === '1';

/** "2026-11-02T08:00:00" → "2026-11-02"; a finish at midnight ended the day before. */
function dayOf(value: string | undefined, finish = false): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value ?? '');
  if (!match) return '';
  const day = match[1]!;
  if (finish && match[2] === '00' && match[3] === '00') {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  return day;
}

const hoursOf = (value: string | undefined) => {
  const hours = durationToHours(value);
  return hours === undefined || hours <= 0 ? undefined : Math.round(hours * 100) / 100;
};

/** The work package a task came from, when EPM exported it: its hyperlink names it. */
function workPackageOf(task: XmlElement): string | undefined {
  const text = textOf(task, 'Hyperlink') ?? '';
  if (/^WP\d+$/i.test(text)) return text.toUpperCase();
  const address = /\/tasks\/(\d+)(?:[/?#]|$)/.exec(textOf(task, 'HyperlinkAddress') ?? '');
  return address ? `WP${address[1]}` : undefined;
}

/** A Microsoft Project XML plan as the rows the CSV import reads. */
export function recordsFromMsProject(xml: string, types: MsProjectTypes = {}): MsProjectRows {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    throw EpmError.validation(message('The Microsoft Project XML file could not be read: {reason}', { reason: error instanceof XmlError ? error.message : 'it is not well formed.' }));
  }
  if (root.name !== 'Project') throw EpmError.validation(message('This XML file is not a Microsoft Project plan.'));

  // Work resources by id: people, or roles standing in for them; not materials or costs.
  const resources = new Map<string, string>();
  for (const resource of childrenOf(childOf(root, 'Resources'), 'Resource')) {
    const uid = textOf(resource, 'UID');
    const name = textOf(resource, 'Name');
    const type = textOf(resource, 'Type') ?? '1';
    if (!uid || !name || flag(resource, 'IsNull') || type !== '1') continue;
    resources.set(uid, name);
  }
  // On each task, the resource with most of its work.
  const assigned = new Map<string, { name: string; work: number }>();
  for (const assignment of childrenOf(childOf(root, 'Assignments'), 'Assignment')) {
    const task = textOf(assignment, 'TaskUID');
    const name = resources.get(textOf(assignment, 'ResourceUID') ?? '');
    if (!task || !name) continue;
    const work = durationToHours(textOf(assignment, 'Work')) ?? 0;
    const best = assigned.get(task);
    if (!best || work > best.work) assigned.set(task, { name, work });
  }

  // The tasks that are the plan: not the project's own summary row, blank rows,
  // inactive tasks or tasks of another project linked in.
  interface Read {
    uid: string;
    level: number;
    element: XmlElement;
    key: string;
    parentKey?: string;
    summary: boolean;
  }
  const read: Read[] = [];
  const ancestors: Read[] = [];
  for (const task of childrenOf(childOf(root, 'Tasks'), 'Task')) {
    const uid = textOf(task, 'UID');
    const level = Number(textOf(task, 'OutlineLevel') ?? '1');
    if (!uid || level < 1 || uid === '0' || flag(task, 'IsNull') || flag(task, 'ExternalTask') || textOf(task, 'Active') === '0') continue;
    // The nearest task above it in the outline that was kept is its parent.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= level) ancestors.pop();
    const parent = ancestors[ancestors.length - 1];
    const row: Read = { uid, level, element: task, key: workPackageOf(task) ?? `MSP${uid}`, parentKey: parent?.key, summary: flag(task, 'Summary') };
    if (parent) parent.summary = true;
    read.push(row);
    ancestors.push(row);
  }
  const keyOf = new Map(read.map((row) => [row.uid, row.key]));

  let linksLeftOut = 0;
  const records: CsvRecord[] = [{ line: 1, cells: HEADER }];
  for (const [index, row] of read.entries()) {
    const task = row.element;
    const milestone = flag(task, 'Milestone');
    const start = dayOf(textOf(task, 'Start'));
    const finish = dayOf(textOf(task, 'Finish'), true) || start;
    const predecessors: string[] = [];
    for (const link of childrenOf(task, 'PredecessorLink')) {
      const key = keyOf.get(textOf(link, 'PredecessorUID') ?? '');
      if (!key || (textOf(link, 'Type') ?? FINISH_TO_START) !== FINISH_TO_START || flag(link, 'CrossProject')) {
        linksLeftOut += 1;
        continue;
      }
      if (!predecessors.includes(key)) predecessors.push(key);
    }
    const leaf = !row.summary;
    const done = Number(textOf(task, 'PercentComplete') ?? '0');
    records.push({
      line: index + 2,
      cells: [
        row.key,
        row.parentKey ?? '',
        milestone ? (types.milestone ?? '') : row.summary ? (types.summary ?? '') : '',
        (textOf(task, 'Name') || `Task ${textOf(task, 'ID') ?? row.uid}`).slice(0, 255),
        textOf(task, 'Notes') ?? '',
        milestone ? '' : start,
        milestone ? finish || start : finish,
        // A summary's work and progress are its tasks' added up: the parent works them out again.
        leaf ? String(hoursOf(textOf(task, 'Work')) ?? '') : '',
        leaf && Number.isFinite(done) && done > 0 ? String(Math.min(100, Math.round(done))) : '',
        leaf ? (assigned.get(row.uid)?.name ?? '') : '',
        // The plan's own dates, kept: added dependencies move nothing.
        leaf ? 'Yes' : '',
        predecessors.join(';'),
      ],
    });
  }
  return { records, title: textOf(root, 'Title') || undefined, tasks: read.length, linksLeftOut };
}

/* -------------------------------------------------------------------------- */
/* Writing the XML                                                            */
/* -------------------------------------------------------------------------- */

const HOURS_PER_DAY = 8;
/** Microsoft Project keeps a link's lag in tenths of a minute. */
const LAG_PER_DAY = HOURS_PER_DAY * 60 * 10;

export interface MsProjectExport {
  projectName: string;
  /** The file's name, for the plan's own Name. */
  fileName: string;
  work: ProjectWork;
  /** OpenProject's working weekdays, 1 Monday to 7 Sunday. */
  workingDays: Set<number>;
  /** OpenProject's non-working days. */
  holidays: { date: string; name?: string }[];
  /** EPM's address, for each task's link back to its work package. */
  appBaseUrl: string;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Working days from one day to another, both counted; OpenProject numbers Monday 1 to Sunday 7. */
function workingDaysBetween(from: string, to: string, workingDays: Set<number>, holidays: Set<string>, everyDay: boolean): number {
  let count = 0;
  const end = new Date(`${to}T00:00:00Z`);
  for (let day = new Date(`${from}T00:00:00Z`); day <= end && count < 10_000; day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (everyDay || (workingDays.has(weekday) && !holidays.has(isoDay(day)))) count += 1;
  }
  return count;
}

const duration = (hours: number) => {
  const whole = Math.floor(hours);
  return `PT${whole}H${Math.round((hours - whole) * 60)}M0S`;
};

/** The project's work packages as a Microsoft Project XML plan. */
export function msProjectXml(input: MsProjectExport): string {
  const { items, parentOf, predecessors, lags } = input.work;
  const holidays = new Set(input.holidays.map((day) => day.date));

  // Parents before their children, each level in id order, as the CSV export reads.
  const children = new Map<string | null, typeof items>();
  for (const item of items) {
    const parent = parentOf.get(String(item.id)) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const ordered: { item: (typeof items)[number]; outline: string; level: number }[] = [];
  const placed = new Set<number>();
  const visit = (parent: string | null, prefix: string, level: number) => {
    let position = 0;
    for (const item of children.get(parent) ?? []) {
      if (placed.has(item.id)) continue;
      placed.add(item.id);
      position += 1;
      const outline = prefix ? `${prefix}.${position}` : String(position);
      ordered.push({ item, outline, level });
      visit(String(item.id), outline, level + 1);
    }
  };
  visit(null, '', 1);
  for (const item of items) if (!placed.has(item.id)) ordered.push({ item, outline: String(ordered.length + 1), level: 1 });

  const uidOf = new Map(ordered.map(({ item }, index) => [String(item.id), index + 1]));
  const hasChildren = (id: number) => (children.get(String(id)) ?? []).length > 0;

  // People: each assignee once.
  const resources = new Map<string, { uid: number; name: string }>();
  for (const { item } of ordered) {
    const person = href(item._links, 'assignee');
    if (person && !resources.has(person)) resources.set(person, { uid: resources.size + 1, name: title(item._links, 'assignee') || person });
  }

  const out: string[] = [];
  const line = (indent: number, text: string) => out.push(`${' '.repeat(indent * 4)}${text}`);
  const value = (indent: number, name: string, content: string | number) => line(indent, `<${name}>${escapeXml(String(content))}</${name}>`);

  const dated = ordered.flatMap(({ item }) => [item.startDate, item.dueDate, item.date].filter((day): day is string => Boolean(day)));
  const first = dated.length ? dated.reduce((a, b) => (a < b ? a : b)) : isoDay(new Date());
  const last = dated.length ? dated.reduce((a, b) => (a > b ? a : b)) : first;

  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  line(0, `<Project xmlns="${NAMESPACE}">`);
  value(1, 'SaveVersion', 14);
  value(1, 'Name', input.fileName);
  value(1, 'Title', input.projectName);
  value(1, 'ScheduleFromStart', 1);
  value(1, 'StartDate', `${first}T08:00:00`);
  value(1, 'FinishDate', `${last}T17:00:00`);
  value(1, 'CalendarUID', 1);
  value(1, 'DefaultStartTime', '08:00:00');
  value(1, 'DefaultFinishTime', '17:00:00');
  value(1, 'MinutesPerDay', HOURS_PER_DAY * 60);
  value(1, 'MinutesPerWeek', HOURS_PER_DAY * 60 * Math.max(1, input.workingDays.size));
  value(1, 'DaysPerMonth', 20);
  value(1, 'DurationFormat', 7);
  value(1, 'WorkFormat', 2);
  value(1, 'NewTasksEffortDriven', 0);

  // One calendar: OpenProject's working week, and its non-working days.
  line(1, '<Calendars>');
  line(2, '<Calendar>');
  value(3, 'UID', 1);
  value(3, 'Name', 'Standard');
  value(3, 'IsBaseCalendar', 1);
  value(3, 'IsBaselineCalendar', 0);
  value(3, 'BaseCalendarUID', -1);
  line(3, '<WeekDays>');
  for (let dayType = 1; dayType <= 7; dayType += 1) {
    // Project numbers Sunday 1 to Saturday 7.
    const working = input.workingDays.has(dayType === 1 ? 7 : dayType - 1);
    line(4, '<WeekDay>');
    value(5, 'DayType', dayType);
    value(5, 'DayWorking', working ? 1 : 0);
    if (working) {
      line(5, '<WorkingTimes>');
      for (const [from, to] of [['08:00:00', '12:00:00'], ['13:00:00', '17:00:00']] as const) {
        line(6, '<WorkingTime>');
        value(7, 'FromTime', from);
        value(7, 'ToTime', to);
        line(6, '</WorkingTime>');
      }
      line(5, '</WorkingTimes>');
    }
    line(4, '</WeekDay>');
  }
  line(3, '</WeekDays>');
  if (input.holidays.length > 0) {
    line(3, '<Exceptions>');
    for (const holiday of input.holidays) {
      line(4, '<Exception>');
      value(5, 'EnteredByOccurrences', 0);
      line(5, '<TimePeriod>');
      value(6, 'FromDate', `${holiday.date}T00:00:00`);
      value(6, 'ToDate', `${holiday.date}T23:59:59`);
      line(5, '</TimePeriod>');
      value(5, 'Occurrences', 1);
      value(5, 'Name', holiday.name || 'Non-working day');
      value(5, 'Type', 1);
      value(5, 'DayWorking', 0);
      line(4, '</Exception>');
    }
    line(3, '</Exceptions>');
  }
  line(2, '</Calendar>');
  line(1, '</Calendars>');

  interface Assignment {
    task: number;
    resource: number;
    start?: string;
    finish?: string;
    work: number;
    remaining: number;
    units: number;
  }
  const assignments: Assignment[] = [];

  line(1, '<Tasks>');
  for (const [index, { item, outline, level }] of ordered.entries()) {
    const uid = index + 1;
    const summary = hasChildren(item.id);
    const milestone = item.date !== undefined && item.startDate === undefined && item.dueDate === undefined;
    const startDay = milestone ? (item.date ?? null) : (item.startDate ?? item.dueDate ?? null);
    const finishDay = milestone ? (item.date ?? null) : (item.dueDate ?? item.startDate ?? null);
    const follows = [...(predecessors.get(String(item.id))?.keys() ?? [])].filter((id) => uidOf.has(id));
    // OpenProject schedules automatically only from predecessors or subtasks.
    const manual = !summary && (item.scheduleManually !== false || follows.length === 0);
    const days = startDay && finishDay && !milestone ? Math.max(1, workingDaysBetween(startDay, finishDay, input.workingDays, holidays, Boolean(item.ignoreNonWorkingDays))) : 0;
    const work = summary ? undefined : durationToHours(item.estimatedTime);
    const start = startDay ? `${startDay}T${milestone ? '17' : '08'}:00:00` : undefined;
    const finish = finishDay ? `${finishDay}T17:00:00` : undefined;

    line(2, '<Task>');
    value(3, 'UID', uid);
    value(3, 'ID', uid);
    value(3, 'Name', item.subject);
    value(3, 'Active', 1);
    value(3, 'Manual', manual ? 1 : 0);
    // Fixed duration: the dates stay as planned, whatever the work.
    value(3, 'Type', summary ? 0 : 1);
    value(3, 'IsNull', 0);
    value(3, 'WBS', outline);
    value(3, 'OutlineNumber', outline);
    value(3, 'OutlineLevel', level);
    if (start) value(3, 'Start', start);
    if (finish) value(3, 'Finish', finish);
    value(3, 'Duration', duration(days * HOURS_PER_DAY));
    value(3, 'DurationFormat', 7);
    if (work !== undefined) value(3, 'Work', duration(work));
    value(3, 'EffortDriven', 0);
    value(3, 'Estimated', 0);
    value(3, 'Milestone', milestone ? 1 : 0);
    value(3, 'Summary', summary ? 1 : 0);
    if (!summary && item.percentageDone != null) value(3, 'PercentComplete', Math.round(item.percentageDone));
    value(3, 'Hyperlink', `WP${item.id}`);
    value(3, 'HyperlinkAddress', `${input.appBaseUrl.replace(/\/+$/, '')}/tasks/${item.id}`);
    const notes = item.description?.raw?.trim();
    if (notes) value(3, 'Notes', notes);
    for (const predecessor of follows) {
      line(3, '<PredecessorLink>');
      value(4, 'PredecessorUID', uidOf.get(predecessor)!);
      value(4, 'Type', 1);
      value(4, 'CrossProject', 0);
      value(4, 'LinkLag', (lags.get(`${item.id}:${predecessor}`) ?? 0) * LAG_PER_DAY);
      value(4, 'LagFormat', 7);
      line(3, '</PredecessorLink>');
    }
    if (manual && start) value(3, 'ManualStart', start);
    if (manual && finish) value(3, 'ManualFinish', finish);
    line(2, '</Task>');

    const person = href(item._links, 'assignee');
    const resource = person ? resources.get(person) : undefined;
    if (resource && !summary) {
      const hours = days * HOURS_PER_DAY;
      assignments.push({
        task: uid,
        resource: resource.uid,
        start,
        finish,
        work: work ?? 0,
        remaining: (work ?? 0) * (1 - Math.min(100, Math.max(0, item.percentageDone ?? 0)) / 100),
        // The share of the person's day the work takes over the task's dates.
        units: work && hours > 0 ? Math.max(0.01, Math.round((work / hours) * 100) / 100) : 1,
      });
    }
  }
  line(1, '</Tasks>');

  line(1, '<Resources>');
  for (const resource of resources.values()) {
    line(2, '<Resource>');
    value(3, 'UID', resource.uid);
    value(3, 'ID', resource.uid);
    value(3, 'Name', resource.name);
    value(3, 'Type', 1);
    value(3, 'IsNull', 0);
    value(3, 'MaxUnits', 1);
    line(2, '</Resource>');
  }
  line(1, '</Resources>');

  line(1, '<Assignments>');
  for (const [index, assignment] of assignments.entries()) {
    line(2, '<Assignment>');
    value(3, 'UID', index + 1);
    value(3, 'TaskUID', assignment.task);
    value(3, 'ResourceUID', assignment.resource);
    if (assignment.finish) value(3, 'Finish', assignment.finish);
    value(3, 'RemainingWork', duration(assignment.remaining));
    if (assignment.start) value(3, 'Start', assignment.start);
    value(3, 'Units', assignment.units);
    value(3, 'Work', duration(assignment.work));
    line(2, '</Assignment>');
  }
  line(1, '</Assignments>');
  line(0, '</Project>');
  return `${out.join('\r\n')}\r\n`;
}

