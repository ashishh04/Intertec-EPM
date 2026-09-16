import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { describeEmailProvider, emailProvider } from '../email/index.js';
import { enqueueEmail, markFailed, markSent } from '../email/outbox.js';
import type { EmailProvider, OutgoingEmail } from '../email/provider.js';
import { resolveRecipient } from '../email/recipients.js';
import { renderStored } from '../email/templates/index.js';
import { RESEND_BATCH_LIMIT } from '../email/resend.js';

/**
 * The outbox worker.
 *
 * Built like the analytics snapshot scheduler and for the same reasons: one
 * Node process beside one Postgres, so a timer that reads a table is the whole
 * job system. It runs outside any request, which is how the recipient lookup
 * gets the service key without being handed a credential.
 *
 * A tick does two things. It claims every immediate row that is due and sends
 * them as one batch, marking each on its own result. And once a day, at the
 * configured UTC hour, it folds everything waiting on the digest channel into
 * one email per person and queues that as an immediate row — the send path is
 * then the same one, and there is nothing digest-specific about delivery.
 *
 * Failure is contained. A tick that throws is logged and the timer continues;
 * a row whose send fails is retried with backoff until it has been tried five
 * times, and then stays `failed` for someone to look at.
 */

/** How long after startup the first tick runs. */
const FIRST_RUN_DELAY_MS = 10_000;

/** A claim older than this belongs to a tick that died; the row goes back. */
const STALE_CLAIM_MS = 10 * 60_000;

export interface EmailWorker {
  /** Begins the timer. Safe to call once; a second call is refused and logged. */
  start(): void;
  /** Clears the timer. Safe to call when never started. */
  stop(): void;
  /** Runs one tick now, with the same guards the timer uses. */
  tick(): Promise<void>;
  readonly started: boolean;
  /** True while a tick is in flight. */
  readonly running: boolean;
}

export interface EmailWorkerOptions {
  log: FastifyBaseLogger;
  /** Overridable so a test can capture what would have been sent. */
  provider?: EmailProvider;
  intervalMs?: number;
  firstRunDelayMs?: number;
  /** A tick that outlives this is abandoned so it cannot block the next one. */
  timeoutMs?: number;
  digestHourUtc?: number;
  /** Overridable so a test can be "now" whenever it likes. */
  now?: () => Date;
}

interface OutboxRow {
  id: string;
  recipientId: string;
  toEmail: string;
  template: string;
  subject: string;
  payload: unknown;
  attempts: number;
}

interface DigestItem {
  title: string;
  body: string;
  url?: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * What one queued row contributes to a digest. Each template's payload has
 * its own shape, so this is where they are read; the row's stored subject is
 * the fallback for anything unfamiliar.
 */
function digestItemOf(row: { template: string; subject: string; payload: unknown }): DigestItem {
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
  const url = text(payload.url) || undefined;

  switch (row.template) {
    case 'notification':
      return { title: text(payload.title) || row.subject, body: text(payload.body), url };
    case 'task-updated':
    case 'task-assigned':
      return {
        title: `${text(payload.taskKey)} · ${text(payload.subject)}`.replace(/^ · /, ''),
        body: `${text(payload.projectName)} · ${text(payload.status)}`.replace(/^ · | · $/g, ''),
        url,
      };
    default:
      return { title: row.subject, body: '' };
  }
}

export function createEmailWorker(options: EmailWorkerOptions): EmailWorker {
  const log = options.log;
  const intervalMs = options.intervalMs ?? env.EPM_EMAIL_WORKER_INTERVAL_SECONDS * 1000;
  const firstRunDelayMs = options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? 2 * 60_000;
  const digestHourUtc = options.digestHourUtc ?? env.EPM_EMAIL_DIGEST_HOUR_UTC;
  const now = options.now ?? (() => new Date());
  const provider = () => options.provider ?? emailProvider();

  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  let started = false;
  let running = false;
  /** The UTC day the digest last completed, so it runs once per day. */
  let lastDigestDay: string | undefined;

  /** Rows a previous tick claimed and never resolved, back to the queue. */
  async function recoverStaleClaims(): Promise<void> {
    const result = await prisma.emailOutbox.updateMany({
      where: { status: 'sending', scheduledFor: { lte: new Date(now().getTime() - STALE_CLAIM_MS) } },
      data: { status: 'queued', lastError: 'reclaimed after a stalled send' },
    });
    if (result.count > 0) log.warn({ rows: result.count }, 'Email rows reclaimed from a stalled send');
  }

  /**
   * Claims due immediate rows by moving them to `sending` in one transaction,
   * so that even a second worker (a hot reload that built the app twice)
   * could not send the same row.
   */
  async function claimDue(): Promise<OutboxRow[]> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.emailOutbox.findMany({
        where: { status: 'queued', channel: 'immediate', scheduledFor: { lte: now() } },
        orderBy: { scheduledFor: 'asc' },
        take: RESEND_BATCH_LIMIT,
        select: {
          id: true,
          recipientId: true,
          toEmail: true,
          template: true,
          subject: true,
          payload: true,
          attempts: true,
        },
      });
      if (rows.length === 0) return [];

      await tx.emailOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'queued' },
        data: { status: 'sending' },
      });

      return rows;
    });
  }

  async function sendDue(): Promise<{ sent: number; requeued: number; failed: number }> {
    const rows = await claimDue();
    const outcome = { sent: 0, requeued: 0, failed: 0 };
    if (rows.length === 0) return outcome;

    // Rendering can fail — an unknown template, a payload from an older
    // build — and that is final for the row, not a reason to skip the batch.
    const messages: { row: OutboxRow; message: OutgoingEmail }[] = [];
    for (const row of rows) {
      try {
        const rendered = renderStored(row.template, row.payload);
        messages.push({
          row,
          message: { to: row.toEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The email could not be rendered.';
        await markFailed(row, reason, false);
        outcome.failed += 1;
      }
    }
    if (messages.length === 0) return outcome;

    const results = await provider().send(messages.map((entry) => entry.message));

    for (const [index, { row }] of messages.entries()) {
      // A provider that returned fewer results than messages has broken its
      // contract; treat the missing ones as a retryable failure rather than
      // guessing they went.
      const result = results[index] ?? { ok: false as const, error: 'No result from the provider.', retryable: true };

      if (result.ok) {
        await markSent(row.id, result.providerId);
        outcome.sent += 1;
      } else {
        const state = await markFailed(row, result.error, result.retryable);
        outcome[state] += 1;
        if (state === 'failed') {
          log.warn({ id: row.id, template: row.template, error: result.error }, 'Email failed permanently');
        }
      }
    }

    return outcome;
  }

  /**
   * Folds the digest channel into one email per person. Only at the digest
   * hour, only once per day — tracked in memory for the process's lifetime,
   * and by the digest row's own dedupe key across restarts.
   */
  async function runDigest(): Promise<number> {
    const at = now();
    const day = at.toISOString().slice(0, 10);
    if (at.getUTCHours() !== digestHourUtc || lastDigestDay === day) return 0;

    const pending = await prisma.emailOutbox.findMany({
      where: { status: 'queued', channel: 'digest' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, recipientId: true, template: true, subject: true, payload: true },
    });

    const byRecipient = new Map<string, typeof pending>();
    for (const row of pending) {
      byRecipient.set(row.recipientId, [...(byRecipient.get(row.recipientId) ?? []), row]);
    }

    const startOfDay = new Date(`${day}T00:00:00.000Z`);
    const dateLabel = at.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });

    let digests = 0;

    for (const [recipientId, rows] of byRecipient) {
      // Already done today — by an earlier tick this hour, or before a restart.
      // The rows that arrived since wait for tomorrow's.
      const already = await prisma.emailOutbox.findFirst({
        where: { recipientId, template: 'digest', createdAt: { gte: startOfDay } },
        select: { id: true },
      });
      if (already) continue;

      const recipient = await resolveRecipient(recipientId);

      const written = await enqueueEmail({
        recipientId,
        template: 'digest',
        payload: {
          firstName: recipient?.firstName ?? 'there',
          dateLabel,
          items: rows.map(digestItemOf),
        },
        channel: 'immediate',
        dedupeKey: `digest:${recipientId}:${day}`,
        gate: 'digest',
      });

      // Absorbed either way. A person with digests turned off has said they
      // do not want these, and leaving the rows queued would only make them
      // pile up for a send that will never come.
      await prisma.emailOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'queued' },
        data: {
          status: 'cancelled',
          lastError: written === 'queued' ? 'absorbed into digest' : `absorbed into digest (${written})`,
        },
      });

      if (written === 'queued') digests += 1;
    }

    lastDigestDay = day;
    return digests;
  }

  async function work(): Promise<void> {
    await recoverStaleClaims();
    const digests = await runDigest();
    const sent = await sendDue();

    if (digests > 0 || sent.sent > 0 || sent.requeued > 0 || sent.failed > 0) {
      log.info({ digests, ...sent }, 'Email worker tick');
    } else {
      log.debug('Email worker tick: nothing to send');
    }
  }

  async function tick(): Promise<void> {
    // A slow provider must not let ticks pile up behind each other; the next
    // tick will find whatever this one did not get to.
    if (running) {
      log.warn('Email worker tick skipped: the previous one is still running');
      return;
    }

    running = true;
    const startedAt = Date.now();

    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`The tick did not finish within ${timeoutMs} ms.`)), timeoutMs).unref(),
        ),
      ]);
    } catch (error) {
      // Rows claimed by a tick that got this far are reclaimed after a while
      // by the next one, so nothing is lost — just delayed and logged.
      log.warn({ err: error, durationMs: Date.now() - startedAt }, 'Email worker tick failed');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (started) {
        log.warn('Email worker already started; ignoring');
        return;
      }
      started = true;

      // The early first run exists so a restart drains the queue promptly. An
      // interval already shorter than that delay gets there first, and a
      // second timer would only collide with it.
      if (firstRunDelayMs < intervalMs) {
        firstRun = setTimeout(() => void tick(), firstRunDelayMs);
        firstRun.unref();
      }
      timer = setInterval(() => void tick(), intervalMs);

      // Neither timer should hold the process open on its own.
      timer.unref();

      log.info(
        { intervalSeconds: Math.round(intervalMs / 1000), digestHourUtc, provider: describeEmailProvider() },
        'Email worker enabled',
      );
    },

    stop() {
      if (firstRun) clearTimeout(firstRun);
      if (timer) clearInterval(timer);
      firstRun = undefined;
      timer = undefined;
      started = false;
    },

    tick,

    get started() {
      return started;
    },
    get running() {
      return running;
    },
  };
}
