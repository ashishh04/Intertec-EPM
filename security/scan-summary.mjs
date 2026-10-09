#!/usr/bin/env node
/**
 * Summarise a Grype JSON report for the workflow page (BR-610).
 *
 *   node security/scan-summary.mjs <grype-report.json> <image-name> [gate]
 *
 * Prints Markdown: findings by severity, then each critical and high finding
 * with the version that fixes it, then what the ignore list in
 * security/grype.yaml set aside. `gate` is the severity the job fails on, shown
 * so a reader knows whether a high finding stopped the release or not.
 */
import { readFileSync } from 'node:fs';

const [file, image, gate = 'none'] = process.argv.slice(2);
if (!file || !image) {
  console.error('usage: node security/scan-summary.mjs <grype-report.json> <image-name> [gate]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, 'utf8'));
const ORDER = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'];
const matches = report.matches ?? [];
const ignored = report.ignoredMatches ?? [];

const counts = Object.fromEntries(ORDER.map((s) => [s, 0]));
for (const m of matches) counts[m.vulnerability.severity in counts ? m.vulnerability.severity : 'Unknown'] += 1;

const target = report.source?.target ?? {};
const out = [];
out.push(`### ${image} — vulnerability scan`);
out.push('');
out.push(`Scanned \`${target.userInput ?? image}\` (${report.distro?.name ?? 'unknown OS'} ${report.distro?.version ?? ''}) with Grype ${report.descriptor?.version ?? ''}, database built ${report.descriptor?.db?.built ?? report.descriptor?.db?.status?.built ?? 'unknown'}. Fails on: **${gate}**.`);
out.push('');
out.push(`| ${ORDER.join(' | ')} | Set aside |`);
out.push(`| ${ORDER.map(() => '---').join(' | ')} | --- |`);
out.push(`| ${ORDER.map((s) => counts[s]).join(' | ')} | ${ignored.length} |`);

const serious = matches
  .filter((m) => m.vulnerability.severity === 'Critical' || m.vulnerability.severity === 'High')
  .sort((a, b) => ORDER.indexOf(a.vulnerability.severity) - ORDER.indexOf(b.vulnerability.severity)
    || a.artifact.name.localeCompare(b.artifact.name));
if (serious.length > 0) {
  out.push('');
  out.push('| Severity | Package | Installed | Fixed in | Advisory |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const m of serious.slice(0, 60)) {
    const v = m.vulnerability;
    out.push(`| ${v.severity} | ${m.artifact.name} (${m.artifact.type}) | ${m.artifact.version} | ${(v.fix?.versions ?? []).join(', ') || '—'} | ${v.id} |`);
  }
  if (serious.length > 60) out.push(`| … | ${serious.length - 60} more in the report artifact | | | |`);
}
if (ignored.length > 0) {
  out.push('');
  out.push('Set aside by security/grype.yaml (each entry there says why):');
  const seen = new Set();
  for (const m of ignored) {
    const key = `${m.vulnerability.id} ${m.artifact.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`- ${m.vulnerability.id} in ${m.artifact.name} ${m.artifact.version}`);
  }
}
out.push('');
console.log(out.join('\n'));
