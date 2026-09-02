/**
 * Reads the shape of the connected OpenProject instance.
 *
 * The EPM contract has exactly 6 task statuses, 4 priorities and 6 types.
 * OpenProject's are instance-configurable, so the mapping in `src/mapping/`
 * cannot be written until we know what this instance actually defines. This
 * script reports that, plus which optional modules (budgets, backlogs, custom
 * fields) are available to source the fields OpenProject has no native home for.
 *
 *   npm run probe
 *
 * Writes openproject-profile.json (gitignored) and prints a summary. It never
 * prints the API key.
 */

import { writeFileSync } from 'node:fs';
import { openProject } from '../openproject/client.js';
import { env } from '../config/env.js';
import type {
  OpPriority,
  OpProject,
  OpRoot,
  OpStatus,
  OpType,
  OpVersion,
} from '../openproject/types.js';

const OUTPUT = new URL('../../openproject-profile.json', import.meta.url);

async function count(path: string): Promise<number | null> {
  try {
    const collection = await openProject.getCollection<unknown>(path, { pageSize: 1 });
    return collection.total ?? 0;
  } catch {
    return null;
  }
}

async function probe() {
  console.log(`Probing ${env.OPENPROJECT_BASE_URL} …\n`);

  const root = await openProject.request<OpRoot>('/');
  console.log(`Instance : ${root.instanceName}`);
  console.log(`Core     : ${root.coreVersion}\n`);

  const [statuses, types, priorities, versions, projects] = await Promise.all([
    openProject.getAll<OpStatus>('/statuses'),
    openProject.getAll<OpType>('/types'),
    openProject.getAll<OpPriority>('/priorities'),
    openProject.getAll<OpVersion>('/versions'),
    openProject.getAll<OpProject>('/projects', { pageSize: 100 }),
  ]);

  console.log(`STATUSES (${statuses.items.length}) — must map onto 6 EPM statuses`);
  for (const status of statuses.items) {
    console.log(
      `  ${String(status.id).padStart(4)}  ${status.name.padEnd(28)} ${
        status.isClosed ? 'closed' : 'open  '
      } pos=${status.position}`,
    );
  }

  console.log(`\nTYPES (${types.items.length}) — must map onto 6 EPM types`);
  for (const type of types.items) {
    console.log(
      `  ${String(type.id).padStart(4)}  ${type.name.padEnd(28)} ${
        type.isMilestone ? 'milestone' : ''
      }`,
    );
  }

  console.log(`\nPRIORITIES (${priorities.items.length}) — must map onto 4 EPM priorities`);
  for (const priority of priorities.items) {
    console.log(`  ${String(priority.id).padStart(4)}  ${priority.name}`);
  }

  console.log(`\nVERSIONS (${versions.items.length}) — the candidate source for sprints`);
  for (const version of versions.items.slice(0, 20)) {
    console.log(
      `  ${String(version.id).padStart(4)}  ${version.name.padEnd(28)} ${version.status} ` +
        `${version.startDate ?? '—'} → ${version.endDate ?? '—'}`,
    );
  }
  if (versions.items.length > 20) console.log(`  … ${versions.items.length - 20} more`);

  console.log(`\nPROJECTS (${projects.total})`);
  for (const project of projects.items.slice(0, 15)) {
    console.log(`  ${String(project.id).padStart(4)}  ${project.identifier.padEnd(24)} ${project.name}`);
  }
  if (projects.items.length > 15) console.log(`  … ${projects.items.length - 15} more`);

  // Custom fields are how this instance can supply department, portfolio and
  // story points — the EPM fields OpenProject has no column for.
  let customFields: unknown[] = [];
  try {
    const schema = await openProject.request<Record<string, unknown>>(
      '/work_packages/schemas/1-1',
    );
    customFields = Object.keys(schema).filter((key) => key.startsWith('customField'));
  } catch {
    /* schema unavailable — reported as none below */
  }
  console.log(`\nWORK PACKAGE CUSTOM FIELDS: ${customFields.length ? customFields.join(', ') : 'none visible'}`);

  console.log('\nOPTIONAL ENDPOINTS (null = not available to this token)');
  const availability: Record<string, number | null> = {};
  for (const path of [
    '/users',
    '/groups',
    '/memberships',
    '/time_entries',
    '/notifications',
    '/budgets',
    '/attachments',
    '/relations',
    '/activities',
  ]) {
    const total = await count(path);
    availability[path] = total;
    console.log(`  ${path.padEnd(18)} ${total === null ? 'unavailable' : `${total} records`}`);
  }

  const profile = {
    probedAt: new Date().toISOString(),
    instance: { name: root.instanceName, coreVersion: root.coreVersion },
    statuses: statuses.items.map((s) => ({
      id: s.id,
      name: s.name,
      isClosed: s.isClosed,
      position: s.position,
    })),
    types: types.items.map((t) => ({ id: t.id, name: t.name, isMilestone: t.isMilestone })),
    priorities: priorities.items.map((p) => ({ id: p.id, name: p.name, position: p.position })),
    versions: versions.items.map((v) => ({
      id: v.id,
      name: v.name,
      status: v.status,
      startDate: v.startDate,
      endDate: v.endDate,
    })),
    projects: projects.items.map((p) => ({ id: p.id, identifier: p.identifier, name: p.name })),
    customFields,
    availability,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`\nWrote ${OUTPUT.pathname}`);
}

probe().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nProbe failed: ${message}`);
  console.error(
    '\nCheck OPENPROJECT_BASE_URL and OPENPROJECT_API_KEY in backend/.env. ' +
      'The key must belong to a user who can see the projects EPM should surface.',
  );
  process.exit(1);
});
