/**
 * The analytics model from the command line.
 *
 *   npm run analytics -- refresh [full|incremental]   refresh, and print the run
 *   npm run analytics -- capture                      capture every work package from API v3
 *   npm run analytics -- compare <captureId>          reconstruction against that capture
 *   npm run analytics -- role                         create or update the read-only analytics role
 *                                                     (password from EPM_ANALYTICS_DB_PASSWORD)
 *   npm run analytics -- replication [slot]           create or update the replication account
 *                                                     (password from EPM_REPLICATION_PASSWORD)
 *   npm run analytics -- access                       check the analytics role reads all, writes nothing
 *
 * The same operations the scheduler and the administration page run, behind
 * the same lease, so a server refreshing at that moment makes this one wait
 * its turn rather than load the same rows twice.
 */
import { prisma } from '../db/prisma.js';
import { readFileSync } from 'node:fs';

import { provisionAnalyticsRole, provisionReplicationRole, replicationStatus, verifyAnalyticsAccess } from '../domain/analytics-access.js';
import { captureWorkPackages, compareCapture } from '../domain/analytics-history.js';
import { refreshModel, type RefreshKind } from '../domain/analytics-model.js';

const [command, argument] = process.argv.slice(2);

/** A password from the environment, or from the file `<NAME>_FILE` names. */
function secret(name: string): string {
  const direct = process.env[name];
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  throw new Error(`Set ${name} (or ${name}_FILE) first.`);
}

async function main(): Promise<boolean> {
  switch (command) {
    case 'refresh': {
      const kind = (argument === 'incremental' ? 'incremental' : 'full') as RefreshKind;
      const run = await refreshModel(kind, 'manual');
      if (!run) {
        console.log('Another server is refreshing the model; nothing was done.');
        return false;
      }
      console.log(JSON.stringify(run, null, 2));
      return run.status === 'succeeded';
    }
    case 'capture': {
      console.log(JSON.stringify(await captureWorkPackages('manual'), null, 2));
      return true;
    }
    case 'compare': {
      if (!argument) throw new Error('Name the capture: npm run analytics -- compare <captureId>');
      const check = await compareCapture(argument);
      console.log(JSON.stringify(check, null, 2));
      return check.matches;
    }
    case 'role': {
      const done = await provisionAnalyticsRole(secret('EPM_ANALYTICS_DB_PASSWORD'));
      console.log(done.join(';\n'));
      return true;
    }
    case 'replication': {
      const done = await provisionReplicationRole(secret('EPM_REPLICATION_PASSWORD'), argument);
      console.log(done.join(';\n'));
      console.log(JSON.stringify(await replicationStatus(), null, 2));
      return true;
    }
    case 'access': {
      const check = await verifyAnalyticsAccess();
      console.log(JSON.stringify(check, null, 2));
      return check.ok;
    }
    default:
      console.log(
        'Usage: npm run analytics -- refresh [full|incremental] | capture | compare <captureId> | role | replication [slot] | access',
      );
      return false;
  }
}

const ok = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return false;
});
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
