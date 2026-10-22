import assert from 'node:assert/strict';

import { prisma } from '../../db/prisma.js';
import { MAX_ATTEMPTS, processEvent, receiveEvent, registerProcessor, replayEvents, retryDue } from '../integration-inbox.js';

/**
 * The integration inbox (BR-506) against EPM's database, with processors of
 * its own under a source no real event uses; everything it makes is removed,
 * except its replays' entries in the journal, which is append-only by design.
 *
 *   env -u PORT npx tsx --env-file-if-exists=.env src/domain/__checks__/integration-inbox.check.ts
 */

let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const SOURCE = `check-${Date.now()}`;
const effects: string[] = [];
let failNext = 0;
registerProcessor(SOURCE, async (action, payload) => {
  if (failNext > 0) {
    failNext -= 1;
    throw new Error('the receiver was down');
  }
  // An effect keyed on the event, as the real processors' are.
  const key = `${action}:${(payload as { id: string }).id}`;
  if (!effects.includes(key)) effects.push(key);
});

try {
  await check('a new event is processed once; the same event again is counted, not processed', async () => {
    const first = await receiveEvent({ source: SOURCE, eventKey: 'a', action: 'thing:made', payload: { id: 'a' } });
    const again = await receiveEvent({ source: SOURCE, eventKey: 'a', action: 'thing:made', payload: { id: 'a' } });
    assert.equal(first.status, 'done');
    assert.equal(again.duplicate, true);
    const row = await prisma.integrationEvent.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(row.deliveries, 2);
    assert.equal(row.attempts, 1);
    assert.deepEqual(effects, ['thing:made:a']);
  });

  await check('a failure is kept for a retry on its back-off, not lost', async () => {
    failNext = 1;
    const outcome = await receiveEvent({ source: SOURCE, eventKey: 'b', action: 'thing:made', payload: { id: 'b' } });
    assert.equal(outcome.status, 'failed');
    const row = await prisma.integrationEvent.findUniqueOrThrow({ where: { id: outcome.id } });
    assert.equal(row.lastError, 'the receiver was down');
    assert.ok(row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now(), 'its next attempt is ahead');
    // Not due yet: a retry pass leaves it.
    await retryDue();
    assert.equal((await prisma.integrationEvent.findUniqueOrThrow({ where: { id: outcome.id } })).status, 'failed');
    // Due: retried, and done.
    await prisma.integrationEvent.update({ where: { id: outcome.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await retryDue();
    assert.equal((await prisma.integrationEvent.findUniqueOrThrow({ where: { id: outcome.id } })).status, 'done');
    assert.ok(effects.includes('thing:made:b'));
  });

  await check(`after ${MAX_ATTEMPTS} failed attempts it is dead-lettered, and a replay brings it through`, async () => {
    failNext = MAX_ATTEMPTS;
    const outcome = await receiveEvent({ source: SOURCE, eventKey: 'c', action: 'thing:made', payload: { id: 'c' } });
    let status: string = outcome.status;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await prisma.integrationEvent.update({ where: { id: outcome.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      status = await processEvent(outcome.id);
    }
    assert.equal(status, 'dead');
    assert.ok(!effects.includes('thing:made:c'));
    const replay = await replayEvents({ id: outcome.id }, 'check');
    assert.deepEqual(replay, { replayed: 1, done: 1, failed: 0 });
    assert.ok(effects.includes('thing:made:c'));
  });

  await check('a replayed batch produces no duplicate effects', async () => {
    const before = [...effects];
    const ids = (await prisma.integrationEvent.findMany({ where: { source: SOURCE }, select: { id: true } })).map((row) => row.id);
    for (const id of ids) await replayEvents({ id }, 'check');
    assert.deepEqual(effects, before);
  });
} finally {
  await prisma.integrationEvent.deleteMany({ where: { source: SOURCE } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed`);
