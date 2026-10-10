import assert from 'node:assert/strict';

import { prisma } from '../../db/prisma.js';
import { evaluateProjects, loadEvmShared } from '../earned-value-store.js';
import { modelFacts, workFactsAsAt, type ModelFacts, type WorkFact } from '../measure-facts.js';

/**
 * Earned value rebuilt for a past moment (BR-303), checked against an
 * independent record of that moment: the analytics model's captures — every
 * work package as API v3 reported it, taken without reference to the journals.
 * For each capture, every project's budget, planned value and earned value,
 * and every work package's earned value, rebuilt from the journals as they
 * stood then must equal the same figures computed from the capture.
 *
 * A capture is only a witness if it is right. One that disagrees with a work
 * package that was never changed — a single version in its journal, from
 * before the capture — recorded something that never was, and is reported and
 * left out rather than allowed to fail the reconstruction. (On the dev
 * database, capture 2 is one: taken before captures read durations of a day
 * or more correctly, it has "P5D", 120 hours, as 40.)
 *
 * Reads the dev database; writes nothing.
 *
 *   env -u PORT npx tsx --env-file-if-exists=.env src/domain/__checks__/evm-history.check.ts
 */

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/** A capture's rows as work facts: the same shape the journals rebuild. */
async function captured(captureId: number, facts: ModelFacts): Promise<WorkFact[]> {
  const rows = await prisma.$queryRawUnsafe<
    {
      work_package_id: number;
      project_id: number;
      type_id: number;
      status_id: number;
      priority_id: number | null;
      assignee_user_id: number | null;
      accountable_user_id: number | null;
      parent_id: number | null;
      version_id: number | null;
      subject: string | null;
      start_date: Date | null;
      due_date: Date | null;
      done_ratio: number | null;
      estimated_hours: number | null;
    }[]
  >(
    `SELECT work_package_id, project_id, type_id, status_id, priority_id, assignee_user_id, accountable_user_id,
            parent_id, version_id, subject, start_date, due_date, done_ratio, estimated_hours
       FROM analytics.snapshot_work_package WHERE capture_id = $1`,
    captureId,
  );
  return rows.map((row) => {
    const status = facts.statuses.get(row.status_id);
    const type = facts.types.get(row.type_id);
    return {
      id: row.work_package_id,
      projectId: row.project_id,
      typeId: row.type_id,
      statusId: row.status_id,
      priorityId: row.priority_id,
      assigneeId: row.assignee_user_id,
      accountableId: row.accountable_user_id,
      parentId: row.parent_id,
      versionId: row.version_id,
      subject: row.subject ?? '',
      startDate: day(row.start_date),
      dueDate: day(row.due_date),
      createdAt: null,
      closedAt: null,
      isClosed: status?.isClosed ?? false,
      isMilestone: type?.isMilestone ?? false,
      statusCategory: status?.category ?? 'todo',
      typeCategory: type?.category ?? 'task',
      priorityCategory: 'medium',
      estimatedHours: row.estimated_hours,
      spentHours: 0,
      doneRatio: row.done_ratio,
      storyPoints: null,
    };
  });
}

const facts = await modelFacts();
const evm = await loadEvmShared(facts);

/** Work packages never changed: their one version, and when it began. */
const unchanged = new Map(
  (
    await prisma.$queryRawUnsafe<{ work_package_id: number; estimated_hours: number | null; valid_from: Date }[]>(
      `SELECT work_package_id, max(estimated_hours) AS estimated_hours, min(valid_from) AS valid_from
         FROM analytics.fact_work_package_version GROUP BY work_package_id HAVING count(*) = 1`,
    )
  ).map((row) => [row.work_package_id, row]),
);
const captures = await prisma.$queryRawUnsafe<{ capture_id: number; captured_at: Date }[]>(
  'SELECT capture_id, captured_at FROM analytics.snapshot_capture ORDER BY captured_at',
);

console.log(`Earned value rebuilt from the journals, against ${captures.length} captures (BR-303)`);

let skipped = 0;
let projectsCompared = 0;
let itemsCompared = 0;
let measured = 0;
for (const capture of captures) {
  const instant = capture.captured_at;
  const at = instant.toISOString().slice(0, 10);
  const fromCapture = await captured(capture.capture_id, facts);
  const wrong = fromCapture.filter((item) => {
    const only = unchanged.get(item.id);
    return only !== undefined && only.valid_from.getTime() <= instant.getTime() && only.estimated_hours !== item.estimatedHours;
  });
  if (wrong.length > 0) {
    console.log(
      `  SKIP  capture ${capture.capture_id}, ${instant.toISOString()}: it disagrees with ${wrong.length} work packages that were never changed ` +
        `(e.g. #${wrong[0]!.id}: ${wrong[0]!.estimatedHours} hours captured, ${unchanged.get(wrong[0]!.id)!.estimated_hours} recorded)`,
    );
    skipped += 1;
    continue;
  }
  const fromJournals = await workFactsAsAt(instant, facts);
  const projectIds = [...new Set(fromCapture.map((item) => item.projectId))]
    .filter((id) => facts.projects.get(id)?.active)
    .sort((a, b) => a - b);

  await check(`capture ${capture.capture_id}, ${instant.toISOString()}: ${projectIds.length} projects`, () => {
    const time = facts.time;
    const a = evaluateProjects(evm, { projectIds, at, instant, work: fromJournals.filter((item) => projectIds.includes(item.projectId)), time });
    const b = evaluateProjects(evm, { projectIds, at, instant, work: fromCapture, time });
    for (const [index, project] of a.projects.entries()) {
      const other = b.projects[index]!;
      const pick = (totals: typeof project.evaluation.totals) => ({ bac: totals.bac, pv: totals.pv, ev: totals.ev });
      assert.deepEqual(pick(project.evaluation.totals), pick(other.evaluation.totals), `project ${project.projectId}`);
      const earned = new Map(other.evaluation.items.map((item) => [item.workPackageId, item.ev]));
      for (const item of project.evaluation.items) {
        assert.equal(item.ev, earned.get(item.workPackageId), `project ${project.projectId}, work package ${item.workPackageId}`);
        itemsCompared += 1;
      }
      projectsCompared += 1;
      if (project.evaluation.totals.bac > 0) measured += 1;
    }
    assert.deepEqual(
      { bac: a.totals.bac, pv: a.totals.pv, ev: a.totals.ev },
      { bac: b.totals.bac, pv: b.totals.pv, ev: b.totals.ev },
      'the instance',
    );
  });
}

await check('and the comparison had something to compare', () => {
  assert.ok(captures.length - skipped > 0, 'no usable capture: run `npm run analytics -- capture` first');
  assert.ok(measured > 0, 'no project with a budget in any capture');
  console.log(
    `        (${captures.length - skipped} captures, ${projectsCompared} project figures, ${measured} with a budget, and ${itemsCompared} work packages compared; ${skipped} capture skipped)`,
  );
});

console.log(`\n${passed} passed`);
await prisma.$disconnect();
