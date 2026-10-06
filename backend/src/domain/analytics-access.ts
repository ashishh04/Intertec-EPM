import { PrismaClient } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

/**
 * The analytics role, and proof of what it can and cannot do (BR-401).
 *
 * Reporting reads a streaming replica of EPM's database as a role that can
 * read the analytics schema and nothing else: not EPM's application tables,
 * and no write of any kind. The replica refuses writes by being a hot
 * standby; the role refuses them by holding no privilege to write — two
 * independent locks, so a mistake in one is not a hole.
 *
 * `verifyAnalyticsAccess` connects as the role (to the replica where one is
 * configured), reads every table and function the model publishes, and then
 * tries to write: insert, update, delete, truncate, create a table, read an
 * application table, and switch the session to read-write first. Every read
 * must succeed and every write must be refused.
 */

export const ANALYTICS_ROLE = 'epm_analytics';

export interface AccessProbe {
  /** What was attempted, as a person would describe it. */
  attempt: string;
  statement: string;
  /** For a read: it worked. For a write: it was refused. */
  ok: boolean;
  /** The database's refusal, for a write. */
  code?: string;
  message?: string;
}

export interface AnalyticsAccessCheck {
  configured: boolean;
  checkedAt: string;
  role?: string;
  /** True when the connection is to a replica in recovery (a hot standby). */
  replica?: boolean;
  /** Replication lag in seconds, on a replica. */
  lagSeconds?: number | null;
  reads: AccessProbe[];
  writes: AccessProbe[];
  /**
   * The second lock, checked on its own: the role's privileges as the primary
   * records them, which hold whether or not the connection is a replica.
   */
  grants: AccessProbe[];
  /** Every read worked, every write was refused, and the role holds no write privilege. */
  ok: boolean;
  error?: string;
}

/** The tables and views the model publishes: every one the role must be able to read. */
async function publishedTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'analytics' ORDER BY table_name`,
  );
  return rows.map((row) => row.name);
}

function refusal(error: unknown): { code?: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  // Prisma wraps the server's error; its SQLSTATE is in the text.
  const code = /Code: `(\w+)`/.exec(text)?.[1] ?? /\b(42501|25006|42P01|0A000)\b/.exec(text)?.[1];
  const message = /Message: `([^`]+)`/.exec(text)?.[1] ?? text.split('\n').find((line) => line.trim()) ?? text;
  return { code, message: message.slice(0, 300) };
}

export async function verifyAnalyticsAccess(): Promise<AnalyticsAccessCheck> {
  const checkedAt = new Date().toISOString();
  if (!env.EPM_ANALYTICS_DATABASE_URL) {
    return { configured: false, checkedAt, reads: [], writes: [], grants: [], ok: false };
  }

  const client = new PrismaClient({ datasourceUrl: env.EPM_ANALYTICS_DATABASE_URL });
  try {
    const [who] = await client.$queryRawUnsafe<{ role: string; replica: boolean; lag: number | null }[]>(
      `SELECT current_user AS role, pg_is_in_recovery() AS replica,
              CASE WHEN pg_is_in_recovery()
                   THEN EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::float8 END AS lag`,
    );

    const reads: AccessProbe[] = [];
    for (const table of await publishedTables()) {
      const statement = `SELECT count(*) FROM analytics.${table}`;
      try {
        await client.$queryRawUnsafe(statement);
        reads.push({ attempt: `Read analytics.${table}`, statement, ok: true });
      } catch (error) {
        reads.push({ attempt: `Read analytics.${table}`, statement, ok: false, ...refusal(error) });
      }
    }
    const asAt = `SELECT count(*) FROM analytics.work_packages_as_at(now())`;
    try {
      await client.$queryRawUnsafe(asAt);
      reads.push({ attempt: 'Reconstruct work as at now', statement: asAt, ok: true });
    } catch (error) {
      reads.push({ attempt: 'Reconstruct work as at now', statement: asAt, ok: false, ...refusal(error) });
    }

    const attempts: { attempt: string; statements: string[] }[] = [
      {
        attempt: 'Insert into the model',
        statements: [`INSERT INTO analytics.refresh_state (key, value, updated_at) VALUES ('access-probe', 'x', now())`],
      },
      { attempt: 'Update the model', statements: [`UPDATE analytics.dim_date SET is_weekend = is_weekend WHERE date_key = 0`] },
      { attempt: 'Delete from the model', statements: [`DELETE FROM analytics.fact_work_package WHERE false`] },
      { attempt: 'Empty a table', statements: [`TRUNCATE analytics.refresh_state`] },
      { attempt: 'Create a table in the model', statements: [`CREATE TABLE analytics.access_probe (x int)`] },
      { attempt: 'Create a table elsewhere', statements: [`CREATE TABLE public.access_probe (x int)`] },
      { attempt: 'Read an application table', statements: [`SELECT * FROM public.sessions LIMIT 1`] },
      {
        attempt: 'Switch to read-write, then insert',
        statements: [
          `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`,
          `INSERT INTO analytics.refresh_state (key, value, updated_at) VALUES ('access-probe', 'x', now())`,
        ],
      },
    ];

    const writes: AccessProbe[] = [];
    for (const { attempt, statements } of attempts) {
      const statement = statements.join('; ');
      try {
        // In a transaction rolled back whatever happens: a probe that was not
        // refused must not leave anything behind.
        await client.$transaction(async (tx) => {
          for (const sql of statements) await tx.$executeRawUnsafe(sql);
          throw new Error('ACCESS_PROBE_NOT_REFUSED');
        });
        writes.push({ attempt, statement, ok: false, message: 'The database allowed it.' });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        writes.push(
          text.includes('ACCESS_PROBE_NOT_REFUSED')
            ? { attempt, statement, ok: false, message: 'The database allowed it.' }
            : { attempt, statement, ok: true, ...refusal(error) },
        );
      }
    }

    const grants = await privilegeProbes(who?.role ?? ANALYTICS_ROLE);

    return {
      configured: true,
      checkedAt,
      role: who?.role,
      replica: who?.replica,
      lagSeconds: who?.lag ?? null,
      reads,
      writes,
      grants,
      ok:
        reads.length > 0 &&
        reads.every((probe) => probe.ok) &&
        writes.every((probe) => probe.ok) &&
        grants.every((probe) => probe.ok),
    };
  } catch (error) {
    return { configured: true, checkedAt, reads: [], writes: [], grants: [], ok: false, error: refusal(error).message };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

/**
 * What the role may do, as the primary's catalogue says: SELECT on every
 * analytics table and nothing more, and no SELECT on any application table.
 */
async function privilegeProbes(role: string): Promise<AccessProbe[]> {
  const rows = await prisma.$queryRawUnsafe<{ schema: string; name: string; select: boolean; write: boolean }[]>(
    `SELECT n.nspname AS schema, c.relname AS name,
            has_table_privilege($1, c.oid, 'SELECT') AS select,
            (has_table_privilege($1, c.oid, 'INSERT') OR has_table_privilege($1, c.oid, 'UPDATE')
              OR has_table_privilege($1, c.oid, 'DELETE') OR has_table_privilege($1, c.oid, 'TRUNCATE')) AS write
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('analytics', 'public') AND c.relkind IN ('r', 'v', 'p')
      ORDER BY n.nspname, c.relname`,
    role,
  );
  const analytics = rows.filter((row) => row.schema === 'analytics');
  const application = rows.filter((row) => row.schema === 'public');
  const [canCreate] = await prisma.$queryRawUnsafe<{ analytics: boolean; public: boolean }[]>(
    `SELECT has_schema_privilege($1, 'analytics', 'CREATE') AS analytics, has_schema_privilege($1, 'public', 'CREATE') AS public`,
    role,
  );
  return [
    {
      attempt: `No write privilege on any of the ${analytics.length} analytics tables`,
      statement: 'has_table_privilege(role, table, INSERT | UPDATE | DELETE | TRUNCATE)',
      ok: analytics.every((row) => !row.write),
      message: analytics.filter((row) => row.write).map((row) => row.name).join(', ') || undefined,
    },
    {
      attempt: `Read privilege on every analytics table`,
      statement: 'has_table_privilege(role, table, SELECT)',
      ok: analytics.every((row) => row.select),
      message: analytics.filter((row) => !row.select).map((row) => row.name).join(', ') || undefined,
    },
    {
      attempt: `No access to any of the ${application.length} application tables`,
      statement: 'has_table_privilege(role, public table, any)',
      ok: application.every((row) => !row.select && !row.write),
      message: application.filter((row) => row.select || row.write).map((row) => row.name).join(', ') || undefined,
    },
    {
      attempt: 'Cannot create anything in either schema',
      statement: 'has_schema_privilege(role, schema, CREATE)',
      ok: !canCreate?.analytics && !canCreate?.public,
    },
  ];
}

/**
 * Creates or updates the analytics role on the primary: login with the given
 * password, read-only by default, able to read the analytics schema — what is
 * there now and anything the refresh creates later — and nothing else.
 *
 * Run by `npm run analytics -- role`, as a user allowed to create roles. The
 * replica follows on its own: roles and grants stream with everything else.
 */
export async function provisionAnalyticsRole(password: string): Promise<string[]> {
  if (password.length < 16) throw new Error('The analytics role needs a password of at least 16 characters.');
  const quoted = `'${password.replaceAll("'", "''")}'`;
  const [owner] = await prisma.$queryRawUnsafe<{ owner: string }[]>(
    `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'analytics'`,
  );
  if (!owner) throw new Error('The analytics schema does not exist yet. Run the migrations first.');

  const statements = [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ANALYTICS_ROLE}') THEN
         CREATE ROLE ${ANALYTICS_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
       END IF;
     END $$`,
    `ALTER ROLE ${ANALYTICS_ROLE} WITH LOGIN PASSWORD ${quoted} CONNECTION LIMIT 20`,
    // Belt and braces: the grants below are what refuse writes; this makes
    // every transaction read-only unless the session asks otherwise.
    `ALTER ROLE ${ANALYTICS_ROLE} SET default_transaction_read_only = on`,
    `ALTER ROLE ${ANALYTICS_ROLE} SET statement_timeout = '5min'`,
    `REVOKE ALL ON SCHEMA public FROM ${ANALYTICS_ROLE}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ANALYTICS_ROLE}`,
    `REVOKE CREATE ON SCHEMA analytics FROM ${ANALYTICS_ROLE}`,
    `GRANT USAGE ON SCHEMA analytics TO ${ANALYTICS_ROLE}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO ${ANALYTICS_ROLE}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA analytics TO ${ANALYTICS_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner.owner} IN SCHEMA analytics GRANT SELECT ON TABLES TO ${ANALYTICS_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner.owner} IN SCHEMA analytics GRANT EXECUTE ON FUNCTIONS TO ${ANALYTICS_ROLE}`,
  ];
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
  return statements.map((statement) => statement.replace(quoted, "'…'"));
}

export const REPLICATION_ROLE = 'epm_replicator';

/**
 * Creates or updates the account the replica streams with, and — when a slot
 * is named — the physical replication slot that keeps the WAL the replica
 * still needs. A slot nobody reads would keep WAL for ever, so its reach is
 * capped (`max_slot_wal_keep_size`, 4 GB by default): a replica gone for good
 * costs at most that, and must then be cloned again.
 */
export async function provisionReplicationRole(
  password: string,
  slot?: string,
  walCap = '4GB',
): Promise<string[]> {
  if (password.length < 16) throw new Error('The replication account needs a password of at least 16 characters.');
  if (slot && !/^[a-z0-9_]{1,63}$/.test(slot)) throw new Error('A slot name is lower-case letters, digits and underscores.');
  if (!/^\d+(MB|GB|TB)$/.test(walCap)) throw new Error('The WAL cap is a size like 4GB.');
  const quoted = `'${password.replaceAll("'", "''")}'`;

  const statements = [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${REPLICATION_ROLE}') THEN
         CREATE ROLE ${REPLICATION_ROLE} WITH REPLICATION LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
       END IF;
     END $$`,
    `ALTER ROLE ${REPLICATION_ROLE} WITH REPLICATION LOGIN PASSWORD ${quoted}`,
  ];
  if (slot) {
    statements.push(
      `SELECT pg_create_physical_replication_slot('${slot}', true)
        WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slot}')`,
      `ALTER SYSTEM SET max_slot_wal_keep_size = '${walCap}'`,
      `SELECT pg_reload_conf()`,
    );
  }
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
  return statements.map((statement) => statement.replace(quoted, "'…'"));
}

/** Who is streaming from this database, and how far behind each is. */
export async function replicationStatus(): Promise<
  { applicationName: string; clientAddress: string | null; state: string; replayLagSeconds: number | null }[]
> {
  const rows = await prisma.$queryRawUnsafe<
    { application_name: string; client_addr: string | null; state: string; replay_lag: number | null }[]
  >(
    `SELECT application_name, client_addr::text, state, EXTRACT(EPOCH FROM replay_lag)::float8 AS replay_lag
       FROM pg_stat_replication ORDER BY application_name`,
  );
  return rows.map((row) => ({
    applicationName: row.application_name,
    clientAddress: row.client_addr,
    state: row.state,
    replayLagSeconds: row.replay_lag,
  }));
}
