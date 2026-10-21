import assert from 'node:assert/strict';

import { parseCsv } from '../../lib/csv-parse.js';
import { buildWorkbook } from '../../lib/xlsx.js';
import { readXlsx } from '../../lib/xlsx-read.js';
import { normaliseSource } from '../task-import-formats.js';
import { changesOf, checkRows, nextWorkingDay, parseDay, parseDone, parseHours, type ExistingWork } from '../task-import.js';

/**
 * The CSV task import's reading and checking, without OpenProject.
 *
 *   npx tsx src/domain/__checks__/task-import.check.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const context = {
  types: new Map([
    ['task', { id: '1', name: 'Task', milestone: false }],
    ['milestone', { id: '2', name: 'Milestone', milestone: true }],
    ['summary task', { id: '3', name: 'Summary task', milestone: false }],
  ]),
  defaultType: { id: '1', name: 'Task', milestone: false },
  statuses: new Map([['new', '1'], ['in progress', '7']]),
  priorities: new Map([['normal', '8'], ['high', '9']]),
  versions: new Map([['sprint 1', '4']]),
  members: new Map([['dev@example.net', '12'], ['dev', '12'], ['dana dev', '12']]),
};

check('reads quoted fields, separators and line breaks inside them, and a byte-order mark', () => {
  const records = parseCsv('﻿ID,Subject\r\nA,"Hello, ""world"""\r\nB,"two\nlines"\n');
  assert.deepEqual(records.map((record) => [record.line, ...record.cells]), [
    [1, 'ID', 'Subject'],
    [2, 'A', 'Hello, "world"'],
    [3, 'B', 'two\nlines'],
  ]);
  assert.deepEqual(parseCsv('ID;Subject\nA;x;\n')[1]!.cells, ['A', 'x', ''], 'semicolons, as Excel writes them in many locales');
});

check('dates and hours as people write them', () => {
  assert.equal(parseDay('2026-11-02'), '2026-11-02');
  assert.equal(parseDay('02/11/2026'), '2026-11-02');
  assert.equal(parseDay('31/02/2026'), undefined);
  assert.equal(parseDay(''), null);
  assert.equal(parseHours('8'), 8);
  assert.equal(parseHours('7,5h'), 7.5);
  assert.equal(parseHours('PT2H30M'), 2.5);
  assert.equal(parseHours('lots'), undefined);
});

check('an epic, a task, a subtask and a milestone, with a dependency: clean, three levels deep', () => {
  const csv = [
    'ID,Parent ID,Type,Subject,Start date,Due date,Estimated hours,Assignee,Status,Priority,Version,Predecessors',
    'E1,,Summary task,Portal,2026-11-02,2026-12-18,,,,,,',
    'T1,E1,Task,Design,02/11/2026,13/11/2026,40,dev@example.net,In progress,High,Sprint 1,',
    'S1,T1,Task,Login screen,2026-11-02,2026-11-04,8,Dana Dev,,,,',
    'M1,E1,Milestone,Live,,2026-12-18,,,,,,T1',
  ].join('\n');
  const { rows, problems } = checkRows(csv, context);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map((row) => [row.key, row.depth, row.typeId]), [['E1', 0, '3'], ['T1', 1, '1'], ['S1', 2, '1'], ['M1', 1, '2']]);
  const milestone = rows[3]!;
  assert.equal(`${milestone.start}/${milestone.due}/${milestone.predecessors.join()}`, '2026-12-18/2026-12-18/T1');
  assert.equal(`${rows[1]!.assigneeId}/${rows[1]!.statusId}/${rows[1]!.priorityId}/${rows[1]!.versionId}`, '12/7/9/4');
});

check('every problem is found and named by line, and nothing is resolved by guess', () => {
  const csv = [
    'ID,Parent,Type,Subject,Start,Due,Hours,Assignee,Predecessors',
    'A,,Epic,No such type,,,,,',
    'B,ZZ,Task,Missing parent,,,,,',
    'C,,Task,,,,,,',
    'D,,Task,Backwards,2026-12-01,2026-11-01,,,',
    'E,,Task,Not a member,,,,stranger@example.net,',
    'F,,Task,Bad date,31/02/2026,,,,',
    'G,,Task,Follows a ghost,,,,,Q9',
    'A,,Task,Duplicate key,,,,,',
    'L1,L2,Task,Loop one,,,,,',
    'L2,L1,Task,Loop two,,,,,',
  ].join('\n');
  const { problems } = checkRows(csv, context);
  const lines = [...new Set(problems.map((problem) => problem.row))];
  assert.deepEqual(lines, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

check('10,000 rows are checked in well under a few seconds', () => {
  const lines = ['ID,Parent ID,Type,Subject,Start date,Due date,Estimated hours,Predecessors'];
  for (let epic = 0; epic < 100; epic += 1) {
    lines.push(`E${epic},,Summary task,Epic ${epic},2026-11-02,2027-03-31,,`);
    for (let task = 0; task < 99; task += 1) lines.push(`E${epic}T${task},E${epic},Task,Task ${task},2026-11-02,2026-11-20,8,${task > 0 ? `E${epic}T${task - 1}` : ''}`);
  }
  const started = Date.now();
  const { rows, problems } = checkRows(lines.join('\n'), context);
  const took = Date.now() - started;
  assert.equal(rows.length, 10_000);
  assert.deepEqual(problems, []);
  assert.ok(took < 5000, `took ${took} ms`);
  console.log(`        (10,000 rows checked in ${took} ms)`);
});

// The project as it is: an epic with two tasks, the second following the first, and a milestone.
const work = (id: string, fields: Partial<ExistingWork>): [string, ExistingWork] => [
  id,
  {
    id,
    typeId: '1',
    type: 'Task',
    milestone: false,
    subject: `Task ${id}`,
    description: '',
    start: '2026-11-02',
    due: '2026-11-13',
    estimate: 8,
    done: null,
    assigneeId: '12',
    assignee: 'Dana Dev',
    statusId: '1',
    status: 'New',
    priorityId: '8',
    priority: 'Normal',
    versionId: null,
    version: '',
    parentId: '100',
    parentElsewhere: false,
    predecessors: new Map(),
    scheduleManually: false,
    ignoreNonWorkingDays: false,
    accountableId: null,
    accountable: '',
    categoryId: null,
    category: '',
    points: null,
    custom: {},
    ...fields,
  },
];
const withWork = {
  ...context,
  existing: new Map([
    work('100', { typeId: '3', type: 'Summary task', subject: 'Portal', done: 10, parentId: null, estimate: null, assigneeId: null, assignee: '' }),
    work('101', { subject: 'Design', done: 50 }),
    work('102', { subject: 'Build', done: 0, predecessors: new Map([['101', '900']]) }),
    work('103', { typeId: '2', type: 'Milestone', milestone: true, subject: 'Live', start: '2026-12-18', due: '2026-12-18', estimate: null }),
  ]),
};
const exported = [
  'ID,Parent ID,Type,Subject,Description,Start date,Due date,Estimated hours,Assignee,Status,Priority,Version,Predecessors,Work package,Done %',
  'WP100,,Summary task,Portal,,2026-11-02,2026-11-13,,,New,Normal,,,#100,10',
  'WP101,WP100,Task,Design,,2026-11-02,2026-11-13,8,Dana Dev,New,Normal,,,#101,50',
  'WP102,WP100,Task,Build,,2026-11-02,2026-11-13,8,Dana Dev,New,Normal,,WP101,#102,0',
  'WP103,WP100,Milestone,Live,,,2026-12-18,,Dana Dev,New,Normal,,,#103,',
];

check('an export imported back unedited changes nothing, whatever its read-only columns say', () => {
  const { rows, problems } = checkRows(exported.join('\n'), withWork);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map((row) => row.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.deepEqual(rows.flatMap((row) => [...row.predecessors, ...(row.unlink ?? [])]), []);
});

check('edited cells update only what changed; a new row is created under an existing one', () => {
  const lines = [...exported];
  lines[2] = 'WP101,WP100,Task,Design the screens,,2026-11-02,20/11/2026,12,,In progress,Normal,,,#101,50';
  lines[3] = 'WP102,N1,Task,Build,,2026-11-02,2026-11-13,8,Dana Dev,New,Normal,,N1,#102,0';
  lines.push('N1,WP100,Task,Review,,2026-11-16,2026-11-18,4,,,,,WP101,,');
  const { rows, problems } = checkRows(lines.join('\n'), withWork);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map((row) => row.action), ['unchanged', 'update', 'update', 'unchanged', 'create']);
  const design = rows[1]!;
  assert.deepEqual([...design.set!].sort(), ['assignee', 'due', 'estimate', 'status', 'subject']);
  assert.deepEqual(changesOf(design, null), {
    subject: 'Design the screens',
    dueDate: '2026-11-20',
    estimatedTime: 'PT12H',
    _links: { assignee: { href: null }, status: { href: '/api/v3/statuses/7' } },
  });
  // Build moves under the new row and follows it instead of Design: one link removed, one added.
  const build = rows[2]!;
  assert.deepEqual(build.set, ['parent']);
  assert.deepEqual(build.unlink, ['900']);
  assert.deepEqual(build.predecessors, ['N1']);
  assert.equal(rows[4]!.parentKey, 'WP100');
  assert.deepEqual(rows[4]!.predecessors, ['WP101']);
  // A file of new rows only may name the project's work by WP and its number.
  const only = checkRows(['ID,Parent ID,Subject,Predecessors', 'N1,WP100,Review,WP101'].join('\n'), withWork);
  assert.deepEqual(only.problems, []);
  assert.equal(`${only.rows[0]!.parentId}/${only.rows[0]!.predecessors.join()}`, '100/#101');
});

check('IDs of another project make copies; a spreadsheet date is read', () => {
  const { rows } = checkRows(['ID,Parent ID,Subject', 'WP555,,Elsewhere', 'WP556,WP555,Child'].join('\n'), withWork);
  assert.deepEqual(rows.map((row) => `${row.action}/${row.copy ?? false}`), ['create/true', 'create/true']);
  assert.equal(parseDay('46328'), '2026-11-02');
  assert.equal(parseDay('99999'), undefined);
});

// OpenProject's own CSV export of the same tasks, as it writes it.
const opExport = [
  'id,Project,Subject,Type,Parent,Status,Priority,Author,Assignee,Accountable,Updated on,Target versions,Start date,Finish date,Work,Total work,% Complete,Created on,Sprint,Description',
  '100,EPM,Portal,Summary task,,New,Normal,Admin,,,10/19/2026 01:58 PM,,11/02/2026,11/13/2026,,16.0,0.1,10/19/2026 01:58 PM,,',
  '101,EPM,Design,Task,Summary task #100: Portal,New,Normal,Admin,Dana Dev,,10/19/2026 01:58 PM,,11/02/2026,11/13/2026,8.0,,0.5,10/19/2026 01:58 PM,,',
  '102,EPM,Build,Task,Summary task #100: Portal,In progress,Normal,Admin,Dana Dev,,10/19/2026 01:58 PM,,11/02/2026,11/13/2026,8.0,,0.25,10/19/2026 01:58 PM,,',
];

check('OpenProject\'s export: its ids are the same tasks, parents by number, progress a fraction, dates month first', () => {
  const { records, source } = normaliseSource(parseCsv(opExport.join('\n')));
  assert.deepEqual(source, { format: 'openproject', dateOrder: 'month-first' });
  const { rows, problems, ignored } = checkRows(records, withWork);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map((row) => `${row.key}/${row.parentKey ?? ''}/${row.action}`), ['WP100//unchanged', 'WP101/WP100/unchanged', 'WP102/WP100/update']);
  assert.deepEqual(rows[2]!.changes!.map((change) => `${change.column}: ${change.from} -> ${change.to}`), ['Done %: 0 -> 25', 'Status: New -> In progress']);
  assert.ok(ignored.includes('Author') && ignored.includes('Total work') && ignored.includes('Sprint (not imported)'), ignored.join());
  // Its own sprint board is not EPM's version: a blank Sprint never clears a version.
  assert.ok(!rows.some((row) => row.set?.includes('version')));
});

check('a day-first export, and the XLS export "with relations": rows merged, Precedes and Follows become Predecessors', () => {
  const dayFirst = normaliseSource(parseCsv(['id,Subject,Author,Accountable,Start date,Finish date', '101,Design,A,B,02/11/2026,13/11/2026'].join('\n')));
  assert.deepEqual([dayFirst.source.dateOrder, dayFirst.records[1]!.cells[4], dayFirst.records[1]!.cells[5]], ['day-first', '2026-11-02', '2026-11-13']);
  const relations = normaliseSource([
    { line: 1, cells: ['Work packages', '', '', '', '', '', '', 'Relations'] },
    { line: 2, cells: ['', 'ID', 'Subject', 'Author', 'Accountable', '', 'Relation type', 'Lag', 'Description', 'ID', 'Subject'] },
    { line: 3, cells: ['', '101', 'Design', 'A', '', '', 'Precedes', '', '', '102', 'Build'] },
    { line: 4, cells: ['', '102', 'Build', 'A', '', '', 'Follows', '', '', '101', 'Design'] },
    { line: 5, cells: ['', '102', 'Build', 'A', '', '', 'child of', '', '', '100', 'Portal'] },
    { line: 6, cells: ['', '103', 'Live', 'A', '', '', 'Follows', '', '', '102', 'Build'] },
  ]);
  assert.deepEqual(relations.records.map((record) => record.cells.join('|')), [
    'ID|Subject|Author|Accountable|Predecessors',
    'WP101|Design|A||',
    'WP102|Build|A||WP101',
    'WP103|Live|A||WP102',
  ]);
});

check('the extra columns: accountable, category, story points, manual scheduling and the project\'s own fields', () => {
  const fields = [
    { key: 'customField1', name: 'Severity', format: 'option' as const, options: new Map([['high', '7'], ['low', '8']]), optionValues: new Map(), types: new Set(['1']) },
    { key: 'customField3', name: 'Change value', format: 'float' as const, options: new Map(), optionValues: new Map(), types: new Set(['41']) },
  ];
  const context = { ...withWork, fields, categories: new Map([['backend', '5']]) };
  const sheet = ['ID,Subject,Type,Accountable,Category,Story points,Manual scheduling,Severity,Change value', 'WP101,Design,Task,Dana Dev,Backend,5,Yes,High,', 'N1,New one,Task,,,x,maybe,Medium,12.5'];
  const { rows, problems } = checkRows(sheet.join('\n'), context);
  assert.deepEqual(rows[0]!.set!.sort(), ['accountable', 'category', 'customField1', 'manual', 'points']);
  assert.deepEqual(changesOf(rows[0]!, null), {
    storyPoints: 5,
    scheduleManually: true,
    _links: { responsible: { href: '/api/v3/users/12' }, category: { href: '/api/v3/categories/5' }, customField1: { href: '/api/v3/custom_options/7' } },
  });
  // Points not a number, not Yes or No, no such option, and a field Tasks do not have.
  assert.deepEqual(problems.map((problem) => `${problem.row} ${problem.column}`), ['3 Story points', '3 Manual scheduling', '3 Severity', '3 Change value']);
  // Automatic scheduling needs predecessors or subtasks to schedule from.
  const lone = checkRows(['ID,Subject,Manual scheduling,Predecessors', 'N1,Alone,No,', 'N2,After it,No,N1'].join('\n'), context);
  assert.deepEqual(lone.problems.map((problem) => `${problem.row} ${problem.column}`), ['2 Manual scheduling']);
});

check('a date edit on a parent whose dates follow its children is left out, and said so; one scheduled by hand is kept', () => {
  const lines = [...exported];
  lines[1] = 'WP100,,Summary task,Portal,,2026-11-02,2026-12-31,,,New,Normal,,,#100,10';
  const { rows } = checkRows(lines.join('\n'), withWork);
  assert.equal(`${rows[0]!.action}/${rows[0]!.datesFollow}`, 'unchanged/children');
  const manual = { ...withWork, existing: new Map([...withWork.existing].map(([id, item]) => [id, id === '100' ? { ...item, scheduleManually: true } : item])) };
  const kept = checkRows(lines.join('\n'), manual).rows[0]!;
  assert.equal(`${kept.action}/${kept.set!.join()}`, 'update/due');
  // Once the file moves its children elsewhere, its dates are its own again.
  const moved = [lines[0]!, lines[1]!, ...exported.slice(2).map((line) => line.replace(',WP100,', ',,'))];
  assert.equal(checkRows(moved.join('\n'), withWork).rows[0]!.action, 'update');
  // Build follows Design: its start is Design's end, so a new start is left out; a new due date alone is its length, and kept.
  const start = [...exported];
  start[3] = 'WP102,WP100,Task,Build,,2026-11-05,2026-11-20,8,Dana Dev,New,Normal,,WP101,#102,0';
  assert.equal(`${checkRows(start.join('\n'), withWork).rows[2]!.action}/${checkRows(start.join('\n'), withWork).rows[2]!.datesFollow}`, 'unchanged/predecessors');
  const due = [...exported];
  due[3] = 'WP102,WP100,Task,Build,,2026-11-02,2026-11-20,8,Dana Dev,New,Normal,,WP101,#102,0';
  assert.deepEqual(checkRows(due.join('\n'), withWork).rows[2]!.set, ['due']);
});

check('the same sheet uploaded again overwrites the tasks an earlier import made from its IDs', () => {
  const sheet = [
    'ID,Parent ID,Type,Subject,Due date,Done %',
    'E1,,Summary task,Portal,,',
    'T1,E1,Task,Design,2026-11-13,60',
    'T2,E1,Task,Build,2026-11-13,',
  ].join('\n');
  const remembered = { ...withWork, remembered: new Map([['E1', '100'], ['T1', '101'], ['T2', '102'], ['#line9', '103']]) };
  const { rows, problems } = checkRows(sheet, remembered);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map((row) => `${row.action}/${row.workPackageId}/${row.matchedEarlier}`), ['unchanged/100/true', 'update/101/true', 'unchanged/102/true']);
  assert.deepEqual(rows[1]!.set, ['done'], 'Done % 60 where it was empty; T2’s blank Done % leaves it');
  assert.deepEqual(changesOf(rows[1]!, null), { percentageDone: 60 });
  // Where Done % follows status, it is said to be ignored rather than sent.
  const byStatus = checkRows(sheet, { ...remembered, progressWritable: false });
  assert.equal(`${byStatus.rows[1]!.action}/${byStatus.rows[1]!.progressIgnored}`, 'unchanged/true');
});

check('possible duplicates are named: a new row with an existing subject, two rows for one task', () => {
  const { rows } = checkRows(['ID,Subject', 'X1,design', ',Brand new'].join('\n'), withWork);
  assert.deepEqual(rows.map((row) => row.sameSubjectAs ?? null), ['101', null]);
  const twice = checkRows(['ID,Subject', 'WP101,Design', 'T1,Design again'].join('\n'), { ...withWork, remembered: new Map([['T1', '101']]) });
  assert.deepEqual(twice.problems.map((problem) => problem.row), [3]);
  assert.equal(parseDone('45%'), 45);
  assert.equal(parseDone('0.45'), 45);
  assert.equal(parseDone('120'), undefined);
});

check('dates on a weekend move to the next working day, as the schedule moves them, so they are no change', () => {
  const nonWorking = { weekdays: new Set([6, 7]), dates: new Set(['2026-11-16']) };
  assert.equal(nextWorkingDay('2026-11-14', nonWorking), '2026-11-17', 'Saturday, Sunday and a holiday Monday skipped');
  assert.equal(nextWorkingDay('2026-11-13', nonWorking), '2026-11-13');
  // Design starts Monday 2 November; a sheet's Saturday 31 October is that same Monday, and its Saturday 14 November is Tuesday 17 (the 16th a holiday).
  const lines = [...exported];
  lines[2] = 'WP101,WP100,Task,Design,,2026-10-31,2026-11-14,8,Dana Dev,New,Normal,,,#101,50';
  const { rows } = checkRows(lines.join('\n'), { ...withWork, nonWorking });
  assert.equal(`${rows[1]!.start}/${rows[1]!.due}/${rows[1]!.datesMoved}`, '2026-11-02/2026-11-17/2');
  assert.deepEqual(rows[1]!.changes!.map((change) => `${change.column}:${change.to}`), ['Due date:2026-11-17']);
});

check('the .xlsx the export writes is read back as the same rows', () => {
  const header = exported[0]!.split(',');
  const body = exported.slice(1).map((line) => line.split(','));
  const records = readXlsx(buildWorkbook([{ name: 'Tasks', headers: header, rows: body }]));
  assert.deepEqual(records.map((record) => record.cells.slice(0, header.length).map((cell) => cell ?? '')), [header, ...body]);
  const { rows } = checkRows(records, withWork);
  assert.deepEqual(rows.map((row) => row.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
});

console.log(`\n${passed} passed`);
