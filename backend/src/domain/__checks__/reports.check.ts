import assert from 'node:assert/strict';

import { prisma } from '../../db/prisma.js';
import { MAX_ATTEMPTS } from '../../email/outbox.js';
import type { EmailProvider } from '../../email/provider.js';
import { COLOURS, PdfDocument, fitText, textWidth, winAnsi, wrapText } from '../../lib/pdf.js';
import { buildWorkbook } from '../../lib/xlsx.js';
import { createEmailWorker } from '../../scheduler/email-worker.js';
import { describeTiming, nextOccurrence, periodFor, zonedInstant, type ScheduleTiming } from '../report-schedule.js';

/**
 * Worked examples for scheduled reports (BR-207, BR-208): when a schedule
 * next runs, in its own time zone and across daylight saving; what period a
 * report covers; that the PDF and workbook writers produce files a reader
 * accepts; and that a mail relay outage is retried and, when retries run out,
 * raises an operations alert instead of dropping the email in silence.
 *
 * The outage is simulated in this process, on an outbox row scheduled hours
 * ahead, with the worker's clock moved forward — so no other worker sharing
 * the database can pick the row up, and nothing is sent.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/reports.check.ts
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

const at = (iso: string) => new Date(iso);
const weekly = (weekday: number, time: string, timeZone: string): ScheduleTiming => ({ frequency: 'weekly', weekday, timeOfDay: time, timeZone });

console.log('When a schedule runs (BR-207)');

await check('weekly on Monday 07:00 in Dubai is 03:00 UTC on the coming Monday', () => {
  // Tuesday 6 Oct 2026 12:00 UTC: the next Monday is 12 Oct.
  assert.equal(nextOccurrence(weekly(1, '07:00', 'Asia/Dubai'), at('2026-10-06T12:00:00Z')).toISOString(), '2026-10-12T03:00:00.000Z');
});

await check('an occurrence later today is today; one already past is next week', () => {
  // Tuesday 6 Oct 2026, 12:00 UTC.
  assert.equal(nextOccurrence(weekly(2, '13:00', 'UTC'), at('2026-10-06T12:00:00Z')).toISOString(), '2026-10-06T13:00:00.000Z');
  assert.equal(nextOccurrence(weekly(2, '11:00', 'UTC'), at('2026-10-06T12:00:00Z')).toISOString(), '2026-10-13T11:00:00.000Z');
  // Exactly at the occurrence, the next is a week on: "strictly after".
  assert.equal(nextOccurrence(weekly(2, '12:00', 'UTC'), at('2026-10-06T12:00:00Z')).toISOString(), '2026-10-13T12:00:00.000Z');
});

await check('across a daylight-saving change the wall-clock time holds and the instant moves', () => {
  const london = weekly(1, '09:00', 'Europe/London');
  // Monday 23 Mar 2026 is GMT; Monday 30 Mar is BST (clocks went forward on the 29th).
  assert.equal(nextOccurrence(london, at('2026-03-20T00:00:00Z')).toISOString(), '2026-03-23T09:00:00.000Z');
  assert.equal(nextOccurrence(london, at('2026-03-24T00:00:00Z')).toISOString(), '2026-03-30T08:00:00.000Z');
});

await check('a time the clock skips in spring is taken an hour later', () => {
  // 01:30 does not exist in London on 29 Mar 2026; 02:30 BST is 01:30 UTC.
  assert.equal(zonedInstant('2026-03-29', '01:30', 'Europe/London').toISOString(), '2026-03-29T01:30:00.000Z');
});

await check('daily, and monthly on a day or the last day', () => {
  assert.equal(
    nextOccurrence({ frequency: 'daily', timeOfDay: '06:30', timeZone: 'Asia/Kolkata' }, at('2026-10-06T12:00:00Z')).toISOString(),
    '2026-10-07T01:00:00.000Z',
  );
  assert.equal(
    nextOccurrence({ frequency: 'monthly', dayOfMonth: 1, timeOfDay: '08:00', timeZone: 'UTC' }, at('2026-10-06T12:00:00Z')).toISOString(),
    '2026-11-01T08:00:00.000Z',
  );
  assert.equal(
    nextOccurrence({ frequency: 'monthly', dayOfMonth: 0, timeOfDay: '17:00', timeZone: 'UTC' }, at('2027-02-10T00:00:00Z')).toISOString(),
    '2027-02-28T17:00:00.000Z',
  );
});

await check('the timing reads as people say it', () => {
  assert.equal(describeTiming(weekly(1, '07:00', 'Asia/Dubai')), 'Mondays at 07:00 (Asia/Dubai)');
  assert.equal(describeTiming({ frequency: 'monthly', dayOfMonth: 0, timeOfDay: '17:00', timeZone: 'UTC' }), 'Monthly on the last day at 17:00 (UTC)');
});

await check('the period a report covers, from the day it runs', () => {
  // Monday 12 Oct 2026.
  assert.deepEqual(periodFor('previous-week', '2026-10-12'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(periodFor('previous-month', '2026-10-12'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodFor('last-4-weeks', '2026-10-12'), { from: '2026-09-14', to: '2026-10-11' });
  assert.deepEqual(periodFor('month-to-date', '2026-10-12'), { from: '2026-10-01', to: '2026-10-11' });
  // On the first of the month, "to date" is the month just ended: never an empty period.
  assert.deepEqual(periodFor('month-to-date', '2026-10-01'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodFor('year-to-date', '2027-01-01'), { from: '2026-01-01', to: '2026-12-31' });
});

console.log('The files (BR-208)');

await check('text is measured with the Helvetica metrics and fitted or wrapped to a width', () => {
  assert.equal(textWidth('Hello', 10), 22.78); // H 722 + e 556 + l 222 + l 222 + o 556 = 2278
  assert.equal(textWidth('Hello', 10, true), 24.45); // bold: 722 + 556 + 278 + 278 + 611 = 2445
  assert.ok(textWidth(fitText('A long project name that does not fit', 60, 8), 8) <= 60);
  assert.deepEqual(wrapText('one two three four', textWidth('one two', 9), 9), ['one two', 'three', 'four']);
});

await check('characters are written as Windows-1252, and what has no byte is reduced', () => {
  assert.deepEqual(winAnsi('Café – €'), [0x43, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x80]);
  assert.deepEqual(winAnsi('Ć'), [0x43]); // C acute is not in Latin-1: its letter
  assert.deepEqual(winAnsi('Łódź'), [0x4c, 0xf3, 0x64, 0x7a]); // the stroke is not an accent, so mapped
  assert.deepEqual(winAnsi('中'), [0x3f]);
});

await check('the PDF is well formed: every cross-reference points at its object', () => {
  const doc = new PdfDocument({ title: 'Check (a) report', landscape: true, createdAt: new Date('2026-10-06T12:00:00Z') });
  doc.text('Portfolio health — All projects', 36, 36, { size: 16, bold: true });
  doc.rect(36, 60, 100, 40, { fill: COLOURS.brandSoft, stroke: COLOURS.border });
  doc.link(36, 60, 100, 40, 'https://epm.example/projects/7');
  doc.addPage();
  doc.text('Second page', 36, 36);
  const text = Buffer.from(doc.build()).toString('latin1');

  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)\n/.exec(text)![1]);
  assert.ok(text.slice(start).startsWith('xref'));
  const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  entries.forEach((offset, index) => assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj`), `object ${index + 1}`));
  assert.ok(text.includes('/Count 2'));
  assert.ok(text.includes('(Portfolio health \\227 All projects) Tj'));
  assert.ok(text.includes('/URI (https://epm.example/projects/7)'));
  assert.ok(text.includes('/Title (Check \\(a\\) report)'));
});

await check('the workbook is a ZIP of the parts Excel needs, one sheet each, names made legal and unique', () => {
  const bytes = buildWorkbook([
    { name: 'Projects: status/health', headers: ['Project', 'Overdue'], rows: [['Alpha', 3]] },
    { name: 'Projects: status/health', headers: ['A'], rows: [] },
  ]);
  const text = Buffer.from(bytes).toString('latin1');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes('<sheet name="Projects  status health" sheetId="1"'));
  assert.ok(text.includes('<sheet name="Projects  status health (2)" sheetId="2"'));
  assert.ok(text.includes('<c r="B2"><v>3</v></c>'), 'numbers are numbers');
  assert.equal(Buffer.from(bytes.slice(0, 4)).readUInt32LE(0), 0x04034b50);
});

console.log('A mail relay outage (BR-208)');

await check('a send that keeps failing is retried, and when retries run out operations are alerted', async () => {
  // Hours ahead of the real clock: no worker but this one will ever find it due.
  const start = new Date(Date.now() + 6 * 60 * 60_000);
  const row = await prisma.emailOutbox.create({
    data: {
      recipientId: 'external:outage-check@example.invalid',
      toEmail: 'outage-check@example.invalid',
      template: 'scheduled-report',
      subject: 'Outage check — 1 Sep – 30 Sep 2026',
      payload: {
        firstName: 'there',
        reportName: 'Outage check',
        title: 'Portfolio health — All projects',
        periodLabel: '1 Sep – 30 Sep 2026',
        figures: [],
        excludedProjects: 0,
        artifactIds: [],
        attachmentNames: [],
      },
      channel: 'immediate',
      dedupeKey: `outage-check:${start.getTime()}`,
      scheduledFor: start,
    },
  });

  let attempts = 0;
  const handed = new Set<string>();
  const relayDown: EmailProvider = {
    async send(messages) {
      for (const message of messages) handed.add(message.to);
      attempts += messages.filter((message) => message.to === 'outage-check@example.invalid').length;
      return messages.map(() => ({ ok: false as const, error: 'connect ECONNREFUSED 127.0.0.1:25', retryable: true }));
    },
  };
  let clock = start.getTime();
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; }, level: 'silent', silent() {} };
  const worker = createEmailWorker({
    log: quiet as never,
    provider: relayDown,
    now: () => new Date(clock),
    digestHourUtc: (new Date(clock).getUTCHours() + 12) % 24,
    // This row and nothing else: the outbox is shared with every other worker.
    only: { id: row.id },
  });

  try {
    for (let tick = 0; tick < MAX_ATTEMPTS; tick += 1) {
      await worker.tick();
      const current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
      if (tick < MAX_ATTEMPTS - 1) {
        assert.equal(current.status, 'queued', `back in the queue after attempt ${tick + 1}`);
        assert.ok(current.scheduledFor.getTime() > clock, 'retried later, not at once');
        clock = current.scheduledFor.getTime() + 1000;
      } else {
        assert.equal(current.status, 'failed', 'failed for good after the last attempt');
        assert.equal(current.attempts, MAX_ATTEMPTS);
      }
    }
    assert.equal(attempts, MAX_ATTEMPTS, 'every attempt reached the relay');
    assert.deepEqual([...handed], ['outage-check@example.invalid'], 'and nothing else was handed to it');

    const alerts = await prisma.notification.findMany({ where: { dedupeKey: `ops-alert:email:${row.id}` } });
    assert.ok(alerts.length > 0, 'operations were told in-app');
    assert.ok(alerts.every((alert) => alert.severity === 'critical' && alert.link === '/reports/scheduled'));
    const journal = await prisma.auditEvent.findFirst({
      where: { action: 'operations.alert', metadata: { path: ['dedupeKey'], equals: `email:${row.id}` } },
    });
    assert.ok(journal, 'and the alert is in the journal');
  } finally {
    worker.stop();
    // The alert's own in-app notices and their digest copies, so nothing from
    // this check reaches a real mailbox; the journal entry stays, as it must.
    await prisma.notification.deleteMany({ where: { dedupeKey: `ops-alert:email:${row.id}` } });
    await prisma.emailOutbox.deleteMany({ where: { OR: [{ id: row.id }, { dedupeKey: `notification:ops-alert:email:${row.id}` }] } });
  }
});

console.log(`\n${passed} passed`);
await prisma.$disconnect();
process.exit(0);
