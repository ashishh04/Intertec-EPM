#!/usr/bin/env node
/**
 * The dependency gate (BR-610).
 *
 *   node security/audit-gate.mjs backend frontend
 *
 * Runs `npm audit --omit=dev --json` in each directory named and fails when a
 * production dependency carries a high or critical advisory nobody has
 * assessed. Development tooling is left out on purpose: it never reaches an
 * image, and a gate that blocks a release over a build tool's advisory teaches
 * people to bypass the gate.
 *
 * An assessment is an entry in security/accepted-advisories.json: the advisory,
 * the package, why it does not put EPM at risk, and a date by which it is looked
 * at again. Past that date the entry stops counting and the advisory blocks
 * again, so an acceptance cannot quietly become permanent. Entries that no
 * longer match anything are reported so the file does not fill with history.
 *
 * Moderate and low advisories are listed but never block; the patch process
 * gives them a longer service level and Dependabot raises them.
 *
 * Exit status: 0 clear, 1 something blocks, 2 the audit itself could not run.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTED_FILE = join(ROOT, 'security', 'accepted-advisories.json');
const BLOCKING = new Set(['high', 'critical']);
const RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node security/audit-gate.mjs <package-dir> [<package-dir> ...]');
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const accepted = JSON.parse(readFileSync(ACCEPTED_FILE, 'utf8')).accepted ?? [];
const used = new Set();

function audit(dir) {
  // npm audit exits 1 whenever it finds anything, so the status says nothing
  // about whether it ran. The JSON does: no `vulnerabilities` key means it failed.
  let out;
  try {
    out = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: join(ROOT, dir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    out = error.stdout;
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    report = null;
  }
  if (!report || typeof report.vulnerabilities !== 'object') {
    console.error(`npm audit did not produce a report in ${dir}.`);
    if (report?.error) console.error(report.error.summary ?? report.error);
    process.exit(2);
  }
  return report.vulnerabilities;
}

function advisoryId(url) {
  return /GHSA(-[a-z0-9]{4}){3}/i.exec(url ?? '')?.[0] ?? url ?? 'unknown';
}

function acceptanceFor(dir, id, pkg) {
  const index = accepted.findIndex(
    (entry) => entry.advisory === id && entry.package === pkg && (!entry.directory || entry.directory === dir),
  );
  if (index === -1) return null;
  used.add(index);
  return accepted[index];
}

const findings = [];
for (const dir of dirs) {
  const seen = new Set();
  for (const vuln of Object.values(audit(dir))) {
    // `via` mixes advisories (objects) with the names of vulnerable packages
    // this one depends on (strings). Each advisory is listed under the package
    // it is actually about, so the strings can be skipped without losing any.
    for (const via of vuln.via) {
      if (typeof via !== 'object') continue;
      const id = advisoryId(via.url);
      const key = `${id}|${via.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const acceptance = acceptanceFor(dir, id, via.name);
      const expired = acceptance && acceptance.reviewBy < today;
      findings.push({
        dir,
        pkg: via.name,
        severity: via.severity,
        id,
        title: via.title,
        range: via.range,
        fix: vuln.fixAvailable === false ? 'none' : vuln.fixAvailable === true ? 'yes' : `${vuln.fixAvailable.name}@${vuln.fixAvailable.version}${vuln.fixAvailable.isSemVerMajor ? ' (major)' : ''}`,
        status: acceptance && !expired ? `accepted to ${acceptance.reviewBy}` : expired ? `acceptance expired ${acceptance.reviewBy}` : BLOCKING.has(via.severity) ? 'BLOCKING' : 'listed',
        blocking: BLOCKING.has(via.severity) && (!acceptance || expired),
      });
    }
  }
}

findings.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.pkg.localeCompare(b.pkg));
const blocking = findings.filter((f) => f.blocking);
const stale = accepted.filter((_, i) => !used.has(i));

const lines = [];
lines.push(`## Production dependency audit — ${dirs.join(', ')}`);
lines.push('');
if (findings.length === 0) {
  lines.push('No advisories against production dependencies.');
} else {
  lines.push('| Where | Package | Severity | Advisory | Fix | Status |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const f of findings) {
    lines.push(`| ${f.dir} | ${f.pkg} ${f.range ?? ''} | ${f.severity} | [${f.id}](https://github.com/advisories/${f.id}) ${f.title ?? ''} | ${f.fix} | ${f.status} |`);
  }
}
if (stale.length > 0) {
  lines.push('');
  lines.push('Acceptances that no longer match an advisory (remove them from security/accepted-advisories.json):');
  for (const entry of stale) lines.push(`- ${entry.advisory} ${entry.package}${entry.directory ? ` (${entry.directory})` : ''}`);
}
lines.push('');
lines.push(blocking.length === 0
  ? 'Result: clear — nothing high or critical is unassessed.'
  : `Result: ${blocking.length} high or critical advisor${blocking.length === 1 ? 'y' : 'ies'} without an assessment. Patch, or record why EPM is not at risk in security/accepted-advisories.json — see the vulnerability and patch process.`);

const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
process.exit(blocking.length === 0 ? 0 : 1);
