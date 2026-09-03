/**
 * Inventories the legacy free-text `UserProfile.department` column.
 *
 *   npx tsx src/scripts/department-inventory.ts
 *
 * Employee mapping superseded that column with a real reference, but it was
 * kept rather than dropped: this database never held a value, and another
 * deployment might. Run this against any database before removing the column.
 *
 * Classification is exact, then case-insensitive, then unmatched. Nothing is
 * fuzzy-matched and nothing is written — organisational data is not guessed at.
 */

import { prisma } from '../db/prisma.js';

const profiles = await prisma.userProfile.findMany({
  select: { openProjectId: true, department: true, departmentId: true },
});
const departments = await prisma.department.findMany({ select: { id: true, name: true } });

const byName = new Map(departments.map((d) => [d.name, d]));
const byLowerName = new Map(departments.map((d) => [d.name.toLowerCase(), d]));

const withText = profiles.filter((p) => p.department?.trim());
const values = [...new Set(withText.map((p) => p.department as string))];

const exact = values.filter((v) => byName.has(v));
const caseInsensitive = values.filter((v) => !byName.has(v) && byLowerName.has(v.toLowerCase()));
const unmatched = values.filter((v) => !byName.has(v) && !byLowerName.has(v.toLowerCase()));

// Two spellings of one value are ambiguous only in the sense that a reader has
// to decide they are the same thing; the match itself is still deterministic.
const ambiguous = values.filter((value) =>
  values.some((other) => other !== value && other.toLowerCase() === value.toLowerCase()),
);

console.log('Legacy free-text department inventory\n');
console.log(`  user_profiles rows                 ${profiles.length}`);
console.log(`  rows with a free-text value        ${withText.length}`);
console.log(`  rows already mapped                ${profiles.filter((p) => p.departmentId).length}`);
console.log(`  distinct values                    ${values.length}`);
console.log(`  exact matches to a department      ${exact.length}`);
console.log(`  case-insensitive matches           ${caseInsensitive.length}`);
console.log(`  unmatched                          ${unmatched.length}`);
console.log(`  values differing only by case      ${ambiguous.length}`);

const show = (label: string, list: string[]) => {
  if (list.length === 0) return;
  console.log(`\n${label}`);
  for (const value of list) {
    const owners = withText.filter((p) => p.department === value).map((p) => p.openProjectId);
    console.log(`  ${JSON.stringify(value).padEnd(32)} ${owners.length} row(s): ${owners.join(', ')}`);
  }
};

show('Exact matches — safe to migrate:', exact);
show('Case-insensitive matches — safe to migrate:', caseInsensitive);
show('Unmatched — leave in place, no department exists for these:', unmatched);
show('Differ only by case — confirm they mean the same department:', ambiguous);

if (values.length === 0) {
  console.log('\n  Nothing to migrate. The column is empty in this database.');
} else {
  console.log(
    `\n  ${exact.length + caseInsensitive.length} of ${values.length} values could be migrated.` +
      (unmatched.length ? ` ${unmatched.length} would be left untouched.` : ''),
  );
  console.log('  This script reports only. No row is modified.');
}

await prisma.$disconnect();
