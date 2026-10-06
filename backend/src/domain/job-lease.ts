import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { prisma } from '../db/prisma.js';

/**
 * Leases for scheduled jobs (NFR03, NFR04).
 *
 * Every server runs the same timers. A job that must run once per tick — a
 * sweep that raises escalations, a recalculation of every project — takes a
 * lease first, and a server that finds it held skips that tick. A lease
 * expires by itself, so a server that dies mid-run holds the job up for one
 * lease length rather than for ever. The times are the database's own
 * (`now()`), so servers whose clocks disagree still agree on who holds it.
 */

/** This process, as a lease holder. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

/** Takes the lease if it is free, expired, or already ours. */
export async function acquireLease(name: string, ttlMs: number): Promise<boolean> {
  const seconds = Math.max(1, Math.round(ttlMs / 1000));
  const rows = await prisma.$queryRaw<{ holder: string }[]>`
    INSERT INTO job_leases (name, holder, "expiresAt")
    VALUES (${name}, ${INSTANCE_ID}, now() + make_interval(secs => ${seconds}))
    ON CONFLICT (name) DO UPDATE
      SET holder = EXCLUDED.holder, "expiresAt" = EXCLUDED."expiresAt"
      WHERE job_leases."expiresAt" < now() OR job_leases.holder = EXCLUDED.holder
    RETURNING holder`;
  return rows.length === 1;
}

export async function releaseLease(name: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE job_leases SET "expiresAt" = now() WHERE name = ${name} AND holder = ${INSTANCE_ID}`;
}

/**
 * Runs `job` only if this server takes the lease, and lets it go afterwards.
 * `ran` is false when another server holds it — a skipped tick, not a failure.
 */
export async function withLease<T>(
  name: string,
  ttlMs: number,
  job: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!(await acquireLease(name, ttlMs))) return { ran: false };
  try {
    return { ran: true, result: await job() };
  } finally {
    await releaseLease(name).catch(() => undefined);
  }
}
