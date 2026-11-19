import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { env } from '../../config/env.js';
import { parseXml, XmlError } from '../../lib/xml-read.js';
import { isMsProjectXml, MS_PROJECT_FILE, msProjectFileToXml, msProjectMpp, msProjectXml, mppWriting, recordsFromMsProject } from '../ms-project.js';
import type { OpWork, ProjectWork } from '../task-export.js';
import { checkRows } from '../task-import.js';

/**
 * Microsoft Project plans in and out, without OpenProject or Java.
 *
 *   npx tsx src/domain/__checks__/ms-project.check.ts [plan.xml]
 *
 * With a plan named — its XML, or an .mpp, .mpt or .mpx when EPM_MPXJ_HOME
 * (and EPM_JAVA, or java on the path) can read one — it is read too and every
 * row checked as the import would.
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
    ['phase', { id: '3', name: 'Phase', milestone: false }],
  ]),
  defaultType: { id: '1', name: 'Task', milestone: false },
  statuses: new Map([['new', '1']]),
  priorities: new Map([['normal', '8']]),
  versions: new Map<string, string>(),
  members: new Map([['ada person', '12']]),
};

const PLAN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!-- As MPXJ and Microsoft Project write it, cut down. -->
<Project xmlns="http://schemas.microsoft.com/project">
  <Title>Office fit-out &amp; move</Title>
  <Tasks>
    <Task><UID>0</UID><ID>0</ID><Name>Office fit-out</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>1</UID><ID>1</ID><Name>Phase</Name><Active>1</Active><OutlineLevel>1</OutlineLevel><Start>2026-11-02T08:00:00</Start><Finish>2026-11-13T17:00:00</Finish><Work>PT64H0M0S</Work><Summary>1</Summary></Task>
    <Task><UID>2</UID><ID>2</ID><Name>Design &lt;draft&gt;</Name><Active>1</Active><OutlineLevel>2</OutlineLevel><Start>2026-11-02T08:00:00</Start><Finish>2026-11-06T17:00:00</Finish><Work>PT40H0M0S</Work><PercentComplete>25</PercentComplete><Notes><![CDATA[Walls, desks & cabling]]></Notes></Task>
    <Task><UID>3</UID><ID>3</ID><Name>Build</Name><Active>1</Active><OutlineLevel>2</OutlineLevel><Start>2026-11-09T08:00:00</Start><Finish>2026-11-12T00:00:00</Finish><Work>PT24H0M0S</Work>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>0</LinkLag></PredecessorLink>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type></PredecessorLink>
    </Task>
    <Task><UID>4</UID><ID>4</ID><Name>Handover</Name><Active>1</Active><OutlineLevel>2</OutlineLevel><Start>2026-11-13T17:00:00</Start><Finish>2026-11-13T17:00:00</Finish><Milestone>1</Milestone>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type></PredecessorLink>
    </Task>
    <Task><UID>5</UID><ID>5</ID><IsNull>1</IsNull></Task>
    <Task><UID>6</UID><ID>6</ID><Name>Struck out</Name><Active>0</Active><OutlineLevel>1</OutlineLevel></Task>
    <Task><UID>7</UID><ID>7</ID><Name>Came from EPM</Name><Active>1</Active><OutlineLevel>1</OutlineLevel><Start>2026-11-16T08:00:00</Start><Finish>2026-11-16T17:00:00</Finish><Hyperlink>WP4521</Hyperlink></Task>
  </Tasks>
  <Resources>
    <Resource><UID>0</UID><ID>0</ID><Type>1</Type><IsNull>0</IsNull></Resource>
    <Resource><UID>1</UID><ID>1</ID><Name>Ada Person</Name><Type>1</Type></Resource>
    <Resource><UID>2</UID><ID>2</ID><Name>Cement</Name><Type>0</Type></Resource>
    <Resource><UID>3</UID><ID>3</ID><Name>Bo Helper</Name><Type>1</Type></Resource>
  </Resources>
  <Assignments>
    <Assignment><UID>1</UID><TaskUID>2</TaskUID><ResourceUID>3</ResourceUID><Work>PT8H0M0S</Work></Assignment>
    <Assignment><UID>2</UID><TaskUID>2</TaskUID><ResourceUID>1</ResourceUID><Work>PT32H0M0S</Work></Assignment>
    <Assignment><UID>3</UID><TaskUID>3</TaskUID><ResourceUID>2</ResourceUID><Work>PT24H0M0S</Work></Assignment>
  </Assignments>
</Project>`;

const table = (records: { cells: string[] }[]) => records.map((record) => record.cells);

check('a plan reads as the import rows: outline, dates, work, progress, people and links', () => {
  assert.equal(isMsProjectXml(new TextEncoder().encode(PLAN)), true);
  assert.equal(isMsProjectXml(new TextEncoder().encode('ID,Subject\nA,x\n')), false);
  const plan = recordsFromMsProject(PLAN, { milestone: 'Milestone', summary: 'Phase' });
  assert.equal(plan.title, 'Office fit-out & move');
  assert.equal(plan.tasks, 5, 'not the project row, a blank row or an inactive task');
  assert.equal(plan.linksLeftOut, 1, 'the start-to-start link');
  assert.deepEqual(table(plan.records), [
    ['ID', 'Parent ID', 'Type', 'Subject', 'Description', 'Start date', 'Due date', 'Estimated hours', 'Done %', 'Assignee', 'Manual scheduling', 'Predecessors'],
    ['MSP1', '', 'Phase', 'Phase', '', '2026-11-02', '2026-11-13', '', '', '', '', ''],
    ['MSP2', 'MSP1', '', 'Design <draft>', 'Walls, desks & cabling', '2026-11-02', '2026-11-06', '40', '25', 'Ada Person', 'Yes', ''],
    // A finish at midnight ended the day before; a material is nobody to assign.
    ['MSP3', 'MSP1', '', 'Build', '', '2026-11-09', '2026-11-11', '24', '', '', 'Yes', 'MSP2'],
    ['MSP4', 'MSP1', 'Milestone', 'Handover', '', '', '2026-11-13', '', '', '', 'Yes', 'MSP3'],
    ['WP4521', '', '', 'Came from EPM', '', '2026-11-16', '2026-11-16', '', '', '', 'Yes', ''],
  ]);
});

check('the rows pass the import’s own checks', () => {
  const plan = recordsFromMsProject(PLAN, { milestone: 'Milestone', summary: 'Phase' });
  const { rows, problems } = checkRows(plan.records, context, { withoutPeople: true });
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 5);
  const design = rows.find((row) => row.key === 'MSP2')!;
  assert.equal(design.parentKey, 'MSP1');
  assert.deepEqual(rows.find((row) => row.key === 'MSP3')!.predecessors, ['MSP2']);
});

check('a file that is not a plan, or not XML at all, is refused in words', () => {
  assert.throws(() => recordsFromMsProject('<html><body/></html>'), /not a Microsoft Project plan/);
  assert.throws(() => recordsFromMsProject('<Project><Tasks></Project>'), /could not be read/);
  assert.throws(() => parseXml('<a><b></a>'), XmlError);
  // Entities a document declares are never expanded.
  const tree = parseXml('<!DOCTYPE x [<!ENTITY big "boom">]><x>&big;&amp;&#65;</x>');
  assert.equal(tree.text, '&big;&A');
});

const work = (id: number, fields: Partial<OpWork> & { parent?: number; assignee?: [string, string] }): OpWork => ({
  id,
  subject: `Task ${id}`,
  _links: {
    type: { href: '/api/v3/types/1', title: 'Task' },
    ...(fields.assignee ? { assignee: { href: fields.assignee[0], title: fields.assignee[1] } } : {}),
  },
  ...fields,
});

check('a project goes out as a plan Microsoft Project opens, and comes back to the same work packages', () => {
  const items = [
    work(10, { subject: 'Phase', startDate: '2026-11-02', dueDate: '2026-11-13' }),
    work(11, { subject: 'Design & build', startDate: '2026-11-02', dueDate: '2026-11-06', estimatedTime: 'P1DT16H', percentageDone: 50, scheduleManually: true, assignee: ['/api/v3/users/12', 'Ada Person'], description: { raw: 'Walls <b>and</b> desks' } }),
    work(12, { subject: 'Test', startDate: '2026-11-09', dueDate: '2026-11-13', estimatedTime: 'PT20H', scheduleManually: false, assignee: ['/api/v3/users/12', 'Ada Person'] }),
    work(13, { subject: 'Go live', date: '2026-11-13' }),
  ];
  const projectWork: ProjectWork = {
    items,
    parentOf: new Map([['10', null], ['11', '10'], ['12', '10'], ['13', '10']]),
    predecessors: new Map([['12', new Map([['11', '900']])], ['13', new Map([['12', '901']])]]),
    lags: new Map([['12:11', 1]]),
  };
  const xml = msProjectXml({
    projectName: 'Portal',
    fileName: 'portal.xml',
    work: projectWork,
    workingDays: new Set([1, 2, 3, 4, 5]),
    holidays: [{ date: '2026-12-02', name: 'National Day' }],
    appBaseUrl: 'https://epm.example.test/',
  });
  // MS_PROJECT_DUMP=<file> keeps the plan, to open in Microsoft Project or read with MPXJ.
  if (process.env.MS_PROJECT_DUMP) writeFileSync(process.env.MS_PROJECT_DUMP, xml);
  const root = parseXml(xml);
  assert.equal(root.name, 'Project');
  const tasks = root.children.find((child) => child.name === 'Tasks')!.children;
  assert.equal(tasks.length, 4);
  const field = (index: number, name: string) => tasks[index]!.children.find((child) => child.name === name)?.text;
  assert.equal(field(0, 'Summary'), '1');
  assert.equal(field(1, 'OutlineNumber'), '1.1');
  assert.equal(field(1, 'Manual'), '1');
  assert.equal(field(1, 'Duration'), 'PT40H0M0S', 'five working days');
  assert.equal(field(1, 'Work'), 'PT40H0M0S');
  assert.equal(field(1, 'HyperlinkAddress'), 'https://epm.example.test/tasks/11');
  assert.equal(field(2, 'Manual'), '0', 'scheduled from its predecessor');
  assert.equal(field(3, 'Milestone'), '1');
  assert.match(xml, /<LinkLag>4800<\/LinkLag>/, 'a day of lag in tenths of a minute');
  assert.match(xml, /<Name>Design &amp; build<\/Name>/);
  assert.match(xml, /<DayType>1<\/DayType>\s*<DayWorking>0<\/DayWorking>/, 'Sunday off');
  assert.match(xml, /<Name>National Day<\/Name>/);
  // Element order within a task, as Microsoft Project's schema has it.
  const names = tasks[1]!.children.map((child) => child.name);
  const order = ['UID', 'ID', 'Name', 'Active', 'Manual', 'Type', 'IsNull', 'WBS', 'OutlineNumber', 'OutlineLevel', 'Start', 'Finish', 'Duration', 'DurationFormat', 'Work', 'EffortDriven', 'Estimated', 'Milestone', 'Summary', 'PercentComplete', 'Hyperlink', 'HyperlinkAddress', 'Notes', 'PredecessorLink', 'ManualStart', 'ManualFinish'];
  assert.deepEqual(names, order.filter((name) => names.includes(name)));

  // And back: every task finds its work package again.
  const back = recordsFromMsProject(xml, { milestone: 'Milestone' });
  assert.deepEqual(back.records.slice(1).map((record) => [record.cells[0], record.cells[1], record.cells[11]]), [
    ['WP10', '', ''],
    ['WP11', 'WP10', ''],
    ['WP12', 'WP10', 'WP11'],
    ['WP13', 'WP10', 'WP12'],
  ]);
  assert.equal(back.records[2]!.cells[7], '40');
  assert.equal(back.records[2]!.cells[9], 'Ada Person');
});

const sample = process.argv[2];
if (sample) {
  // Microsoft Project's own file through MPXJ, as an upload is.
  const xml = MS_PROJECT_FILE.test(sample) ? await msProjectFileToXml(readFileSync(sample), sample) : readFileSync(sample, 'utf8');
  check(`a real plan: ${sample}`, () => {
    const plan = recordsFromMsProject(xml, { milestone: 'Milestone', summary: 'Phase' });
    const { rows, problems } = checkRows(plan.records, context, { withoutPeople: true });
    console.log(`        ${plan.tasks} tasks, ${plan.linksLeftOut} links left out, ${rows.length} rows, ${problems.length} problems`);
    for (const problem of problems.slice(0, 10)) console.log('       ', JSON.stringify(problem));
    assert.equal(rows.length, plan.tasks);
  });
}

// Writing .mpp: Aspose.Tasks with its licence (EPM_ASPOSE_TASKS_HOME and
// EPM_ASPOSE_TASKS_LICENSE). Without them the reason is checked; with them the
// fixture plan is written as .mpp and, where MPXJ is installed, read back.
const writing = await mppWriting();
check(`.mpp writing on this machine: ${writing.available ? 'available' : `not available (${writing.reason})`}`, () => {
  if (!env.EPM_ASPOSE_TASKS_HOME) assert.equal(writing.reason, 'not-installed');
  else if (!env.EPM_ASPOSE_TASKS_LICENSE) assert.equal(writing.reason, 'no-licence');
});
if (writing.available) {
  const plan = msProjectXml({
    projectName: 'Portal',
    fileName: 'portal.mpp',
    work: {
      items: [work(10, { subject: 'Phase', startDate: '2026-11-02', dueDate: '2026-11-13' }), work(11, { subject: 'Build', startDate: '2026-11-02', dueDate: '2026-11-06', scheduleManually: true }), work(12, { subject: 'Go live', date: '2026-11-13' })],
      parentOf: new Map([['10', null], ['11', '10'], ['12', '10']]),
      predecessors: new Map([['12', new Map([['11', '1']])]]),
      lags: new Map(),
    },
    workingDays: new Set([1, 2, 3, 4, 5]),
    holidays: [],
    appBaseUrl: 'https://epm.example.test',
  });
  const mpp = await msProjectMpp(plan);
  const back = env.EPM_MPXJ_HOME ? recordsFromMsProject(await msProjectFileToXml(mpp, 'portal.mpp')) : undefined;
  check('a plan is written as .mpp, and reads back the same', () => {
    // An .mpp is an OLE compound file.
    assert.deepEqual([...mpp.subarray(0, 4)], [0xd0, 0xcf, 0x11, 0xe0]);
    if (back) {
      assert.deepEqual(back.records.slice(1).map((record) => [record.cells[0], record.cells[3], record.cells[6]]), [
        ['WP10', 'Phase', '2026-11-13'],
        ['WP11', 'Build', '2026-11-06'],
        ['WP12', 'Go live', '2026-11-13'],
      ]);
    }
  });
}

console.log(`\n${passed} checks passed`);
