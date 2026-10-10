import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { classifyStatus } from '../../mapping/catalog.js';
import { modelFacts, startedAt } from '../measure-facts.js';
import { evaluateMeasures } from '../measures.js';
import { isDelivered } from '../work-definitions.js';

/**
 * Cycle time checked against OpenProject's journals (BR-316): for every work
 * package delivered, the days from first leaving a not-started status to
 * closing, worked out twice — by EPM, from its analytics model, and here,
 * independently, from OpenProject's own `journals` table read straight out of
 * its database — must agree item by item, and so must the median the Delivery
 * dashboard shows.
 *
 * The independent side shares nothing with EPM's extract but the definition:
 * which statuses count as not started (`classifyStatus`, the same rule the
 * Delivery measures read). It reads each version's status and the start of
 * its validity period, as OpenProject stores them.
 *
 * Reads the dev databases; writes nothing.
 *
 *   env -u PORT npx tsx --env-file-if-exists=.env src/domain/__checks__/cycle-time.check.ts
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

/** Rows from OpenProject's database, through its container: tab-separated. */
function openProjectRows(sql: string): string[][] {
  const output = execFileSync('docker', ['exec', 'openproject', 'bash', '-lc', `psql "$DATABASE_URL" -At -F $'\\t' -c "${sql.replaceAll('"', '\\"')}"`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'));
}

const days = (from: string, to: string) => Math.round(((Date.parse(to) - Date.parse(from)) / 86_400_000) * 10) / 10;

const facts = await modelFacts();
const delivered = facts.workPackages.filter((work) => isDelivered(work) && work.closedAt);
console.log(`Cycle time against OpenProject's journals: ${delivered.length} work packages delivered`);

// EPM's side, exactly as the measure computes it.
const epmStarted = await startedAt(delivered.map((work) => work.id));
const epm = new Map(delivered.map((work) => [work.id, days(epmStarted.get(work.id) ?? work.closedAt!, work.closedAt!)]));

// The independent side: OpenProject's statuses and journals.
const statuses = new Map(
  openProjectRows('SELECT id, name, is_closed FROM statuses').map(([id, name, closed]) => [
    Number(id),
    { closed: closed === 't', category: classifyStatus({ name: name!, isClosed: closed === 't' }) },
  ]),
);
const journalRows = openProjectRows(
  `SELECT j.journable_id, j.version, to_char(lower(j.validity_period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), wpj.status_id
     FROM journals j JOIN work_package_journals wpj ON wpj.id = j.data_id
    WHERE j.journable_type = 'WorkPackage' AND j.journable_id IN (${delivered.map((work) => work.id).join(',') || 'NULL'})
    ORDER BY j.journable_id, j.version`,
);
const history = new Map<number, { at: string; status: number }[]>();
for (const [id, , at, status] of journalRows) {
  const list = history.get(Number(id)) ?? [];
  list.push({ at: at!, status: Number(status) });
  history.set(Number(id), list);
}
const independent = new Map<number, number>();
const instants = new Map<number, { started: string; closed: string }>();
for (const work of delivered) {
  const versions = history.get(work.id) ?? [];
  // Started: the first version in a status that is not "not started".
  const started = versions.find((version) => !['todo', 'backlog'].includes(statuses.get(version.status)?.category ?? 'todo'))?.at;
  // Closed: the first version of the last closed stretch.
  let closed: string | undefined;
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    if (statuses.get(versions[index]!.status)?.closed) closed = versions[index]!.at;
    else break;
  }
  if (closed) {
    independent.set(work.id, days(started ?? closed, closed));
    instants.set(work.id, { started: started ?? closed, closed });
  }
}

/** To the millisecond, as EPM's model keeps it. */
const instant = (value: string) => new Date(value).toISOString();

await check('OpenProject has a journal for every delivered work package', () => {
  const without = delivered.filter((work) => !independent.has(work.id)).map((work) => work.id);
  assert.deepEqual(without, []);
});

await check('each one started and closed at the very instants its journals say', () => {
  const differ = delivered
    .filter((work) => {
      const theirs = instants.get(work.id);
      const started = epmStarted.get(work.id) ?? work.closedAt!;
      return !theirs || instant(theirs.started) !== instant(started) || instant(theirs.closed) !== instant(work.closedAt!);
    })
    .map((work) => `#${work.id}: EPM ${epmStarted.get(work.id) ?? work.closedAt} → ${work.closedAt}, journals ${JSON.stringify(instants.get(work.id))}`);
  assert.deepEqual(differ, []);
});

await check('each work package’s cycle time matches the one worked out from the journals', () => {
  const differ = delivered
    .filter((work) => Math.abs((epm.get(work.id) ?? NaN) - (independent.get(work.id) ?? NaN)) > 0.05)
    .map((work) => `#${work.id}: EPM ${epm.get(work.id)} d, journals ${independent.get(work.id)} d`);
  assert.deepEqual(differ, []);
  console.log(`        (${delivered.length} compared; ${[...epm.values()].filter((value) => value > 0).length} took longer than a day)`);
});

await check('and the median the Delivery dashboard shows is the median of the journals’ figures', async () => {
  const closings = delivered.map((work) => work.closedAt!.slice(0, 10)).sort();
  const period = { from: closings[0]!, to: closings.at(-1)! };
  const viewer = { visibleProjectIds: new Set(facts.projects.keys()) };
  const measure = (await evaluateMeasures(['work.cycleTime'], { kind: 'instance' }, period, viewer, period.to)).measures['work.cycleTime'];
  // The measure counts active projects only, as every instance figure does.
  const counted = delivered.filter((work) => facts.projects.get(work.projectId)?.active !== false);
  const values = counted.map((work) => independent.get(work.id)!).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  assert.equal(measure?.value, Math.round(median * 10) / 10);
  console.log(`        (median ${measure?.value} days over ${counted.length} delivered from ${period.from} to ${period.to})`);
});

console.log(`\n${passed} passed`);
process.exit(0);
