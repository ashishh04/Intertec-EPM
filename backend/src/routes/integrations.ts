import type { FastifyPluginAsync } from 'fastify';

import { env } from '../config/env.js';
import { optional, prisma } from '../db/prisma.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';
import type { OpRoot } from '../openproject/types.js';
import type { ConnectionState, IntegrationStatus } from '../types/epm.js';

/**
 * Integration health for /settings/integration.
 *
 * Deliberately reports only connection state, version and record counts. No
 * token, no credential, and no upstream address — administrators see health,
 * never secrets, and never a route to the system behind EPM.
 */

const COUNTED_RESOURCES = [
  { resource: 'Projects', path: '/projects', countAll: false },
  // Without an explicit empty filter OpenProject counts open work packages
  // only, which under-reports by every closed record.
  { resource: 'Work packages', path: '/work_packages', countAll: true },
  { resource: 'Users', path: '/users', countAll: false },
  { resource: 'Groups', path: '/groups', countAll: false },
  { resource: 'Versions', path: '/versions', countAll: false },
  { resource: 'Time entries', path: '/time_entries', countAll: false },
] as const;

async function countResource(
  path: string,
  countAll: boolean,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const collection = await openProject.getCollection<unknown>(
      path,
      countAll ? { pageSize: 1, filters: [] } : { pageSize: 1 },
      signal,
    );
    return collection.total ?? 0;
  } catch {
    // A resource this token cannot read is not an outage — it is reported as
    // uncounted rather than failing the whole health check.
    return null;
  }
}

interface Probe {
  checkedAt: string;
  apiState: ConnectionState;
  apiVersion: string;
  counts: { resource: string; count: number | null }[];
}

/** Reads instance reachability, version and per-resource counts. */
async function probeInstance(
  signal: AbortSignal,
  log: (error: unknown) => void,
): Promise<Probe> {
  const checkedAt = new Date().toISOString();

  let apiState: ConnectionState = 'disconnected';
  let apiVersion = 'unknown';

  try {
    const root = await openProject.request<OpRoot>('/', { signal });
    apiState = 'connected';
    apiVersion = root.coreVersion ?? 'unknown';
  } catch (error) {
    log(error);
  }

  const counts =
    apiState === 'connected'
      ? await Promise.all(
          COUNTED_RESOURCES.map(async ({ resource, path, countAll }) => ({
            resource,
            count: await countResource(path, countAll, signal),
          })),
        )
      : [];

  return { checkedAt, apiState, apiVersion, counts };
}

function toStatus(probe: Probe, lastSyncAt: string): IntegrationStatus {
  const readable = probe.counts.filter((entry) => entry.count !== null);

  // Neither the upstream identity nor its address is reported: the client is
  // not meant to know which system sits behind EPM, let alone reach it.
  return {
    state: connectionState(probe.apiState, readable.length, probe.counts.length),
    apiState: probe.apiState,
    // No webhook receiver is implemented yet; reporting anything else would
    // claim a capability that does not exist.
    webhookState: 'disconnected',
    lastSyncAt,
    apiVersion: probe.apiVersion,
    syncedResources: readable.map((entry) => ({
      resource: entry.resource,
      count: entry.count as number,
      lastSyncAt,
    })),
  };
}

/**
 * When the last sync actually ran. Distinct from the time of this health check:
 * reading the instance is not syncing it, and reporting "now" would make a
 * stale integration look fresh on every page load.
 */
async function lastRecordedSync(fallback: string): Promise<string> {
  const latest = await optional(
    () =>
      prisma.syncRun.findFirst({
        where: { ok: true, finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
    null,
  );

  return latest?.finishedAt?.toISOString() ?? fallback;
}

/** One row per resource, so a partially readable instance is visible as such. */
async function recordRun(probe: Probe, startedAt: Date): Promise<void> {
  const finishedAt = new Date(probe.checkedAt);

  await optional(
    () =>
      prisma.syncRun.createMany({
        data: probe.counts.map((entry) => ({
          resource: entry.resource,
          startedAt,
          finishedAt,
          recordCount: entry.count,
          ok: entry.count !== null,
          error: entry.count === null ? 'Resource not readable with this token.' : null,
        })),
      }),
    { count: 0 },
  );
}

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/integrations/status', async (request) => {
    const probe = await probeInstance(requestSignal(request), (err) =>
      request.log.error({ err }, 'OpenProject reachability check failed'),
    );

    return toStatus(probe, await lastRecordedSync(probe.checkedAt));
  });

  /**
   * Refreshes the counts and records the run. There is nothing to pull into a
   * local mirror — OpenProject stays the system of record — so a "sync" here is
   * a re-read plus the bookkeeping that gives `lastSyncAt` a real value.
   */
  app.post('/integrations/status/sync', async (request) => {
    const startedAt = new Date();
    const probe = await probeInstance(requestSignal(request), (err) =>
      request.log.error({ err }, 'OpenProject sync failed'),
    );

    await recordRun(probe, startedAt);

    return toStatus(probe, probe.checkedAt);
  });
};

/**
 * Overall state covers the API and whether we can read what EPM needs.
 * `webhookState` is reported separately so a missing webhook receiver does not
 * permanently mark an otherwise healthy integration as degraded.
 */
function connectionState(
  apiState: ConnectionState,
  readable: number,
  checked: number,
): ConnectionState {
  if (apiState !== 'connected') return 'disconnected';
  if (readable === 0) return 'disconnected';
  return readable === checked ? 'connected' : 'degraded';
}
