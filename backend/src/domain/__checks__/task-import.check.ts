import assert from 'node:assert/strict';

import { parseCsv } from '../../lib/csv-parse.js';
import { checkRows, parseDay, parseHours } from '../task-import.js';

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

console.log(`\n${passed} passed`);
