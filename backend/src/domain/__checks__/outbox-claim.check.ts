import assert from 'node:assert/strict';

import { prisma } from '../../db/prisma.js';
import type { EmailProvider } from '../../email/provider.js';
import { createEmailWorker } from '../../scheduler/email-worker.js';

/**
 * Two servers, one email (NFR03). The outbox claim takes rows with FOR UPDATE
 * SKIP LOCKED and marks them in the same statement, so when two workers tick
 * at the same moment each queued email is handed to exactly one of them — the
 * old claim read first and marked after, and both could send. Also: a claim
 * records when and by whom, and a stalled one goes back to the queue by the
 * claim's age.
 *
 * Run on rows scheduled hours ahead, with both workers' clocks moved forward
 * and each confined to its row, so no other worker sharing the database can
 * touch them; the provider is a stand-in, so nothing is sent anywhere.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/outbox-claim.check.ts
 */

let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

const quiet = { info() {}, warn() {}, debug() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; }, level: 'silent', silent() {} };

async function queuedRow(label: string, at: Date) {
  return prisma.emailOutbox.create({
    data: {
      recipientId: `external:${label}@example.invalid`,
      toEmail: `${label}@example.invalid`,
      template: 'scheduled-report',
      subject: `Claim check — ${label}`,
      payload: {
        firstName: 'there',
        reportName: 'Claim check',
        title: 'Portfolio health — All projects',
        periodLabel: '1 Sep – 30 Sep 2026',
        figures: [],
        excludedProjects: 0,
        artifactIds: [],
        attachmentNames: [],
      },
      channel: 'immediate',
      dedupeKey: `claim-check:${label}:${at.getTime()}`,
      scheduledFor: at,
    },
  });
}

console.log('The outbox claim (NFR03)');

await check('two workers ticking at once hand a queued email to the relay exactly once', async () => {
  // Hours ahead of the real clock: no worker but these two will find it due.
  const at = new Date(Date.now() + 6 * 60 * 60_000);
  const row = await queuedRow('race', at);
  const handed: string[] = [];
  const relay: EmailProvider = {
    async send(messages) {
      for (const message of messages) handed.push(message.to);
      // Slow enough that both ticks are inside their claim at the same time.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return messages.map(() => ({ ok: true as const, providerId: `claim-check-${Date.now()}` }));
    },
  };
  const worker = () =>
    createEmailWorker({
      log: quiet as never,
      provider: relay,
      now: () => new Date(at.getTime() + 1000),
      digestHourUtc: (at.getUTCHours() + 12) % 24,
      only: { id: row.id },
    });
  const [a, b] = [worker(), worker()];
  try {
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(handed.length, 1, `handed to the relay ${handed.length} times`);
    const sent = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(sent.status, 'sent');
    assert.ok(sent.claimedAt, 'the claim is timed');
    assert.ok(sent.claimedBy, 'and names the process that made it');
  } finally {
    a.stop();
    b.stop();
    await prisma.emailOutbox.deleteMany({ where: { id: row.id } });
  }
});

await check('a stalled claim goes back to the queue by its age, a fresh one does not', async () => {
  const at = new Date(Date.now() + 6 * 60 * 60_000);
  const stalled = await queuedRow('stalled', at);
  const fresh = await queuedRow('fresh', at);
  // Claimed and never finished: one eleven minutes ago, one a second ago —
  // both rows were due long before either claim.
  await prisma.emailOutbox.update({
    where: { id: stalled.id },
    data: { status: 'sending', claimedAt: new Date(at.getTime() + 60_000), claimedBy: 'a-server-that-died' },
  });
  await prisma.emailOutbox.update({
    where: { id: fresh.id },
    data: { status: 'sending', claimedAt: new Date(at.getTime() + 11 * 60_000 - 1000), claimedBy: 'a-busy-server' },
  });
  const sendNothing: EmailProvider = { async send(messages) { return messages.map(() => ({ ok: false as const, error: 'not in this check', retryable: true })); } };
  const run = (id: string) =>
    createEmailWorker({
      log: quiet as never,
      provider: sendNothing,
      now: () => new Date(at.getTime() + 12 * 60_000),
      digestHourUtc: (at.getUTCHours() + 12) % 24,
      only: { id },
    });
  try {
    // Only recovery matters here: the worker puts the stalled row back first,
    // then claims it again — which is the point — and the stand-in relay
    // refuses it, so it ends queued for a retry rather than sent.
    await run(stalled.id).tick();
    await run(fresh.id).tick();
    const [s, f] = await Promise.all([
      prisma.emailOutbox.findUniqueOrThrow({ where: { id: stalled.id } }),
      prisma.emailOutbox.findUniqueOrThrow({ where: { id: fresh.id } }),
    ]);
    assert.notEqual(s.claimedBy, 'a-server-that-died', 'the stalled claim was taken back');
    assert.equal(f.status, 'sending', 'the claim a busy server made a moment ago is left alone');
    assert.equal(f.claimedBy, 'a-busy-server');
  } finally {
    await prisma.emailOutbox.deleteMany({ where: { id: { in: [stalled.id, fresh.id] } } });
  }
});

console.log(`\n${passed} passed`);
await prisma.$disconnect();
process.exit(0);
