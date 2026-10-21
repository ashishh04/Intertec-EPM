import assert from 'node:assert/strict';

import { treePage } from '../../routes/queries.js';
import type { EpmTask } from '../../types/epm.js';

/**
 * The task list's tree: rows ordered parent → children → grandchildren, paged
 * by top-level item, whatever order the query returned them in.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/task-tree.check.ts
 */

let passed = 0;
function check(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const task = (id: string, parentId: string | null) => ({ id, parentId, subject: id }) as unknown as EpmTask;
// In id order, as the query returns them: every epic before any task, every task before any subtask.
const rows = [task('E1', null), task('E2', null), task('T1', 'E1'), task('T2', 'E2'), task('T3', 'E1'), task('S1', 'T1'), task('S2', 'T3'), task('X', 'gone')];

check('epic → task → subtask, depth-first, siblings in the query order', () => {
  const { rows: page, roots, tree } = treePage(rows, 1, 10);
  assert.deepEqual(page.map((row) => `${'  '.repeat(tree.depth[row.id]!)}${row.id}`), ['E1', '  T1', '    S1', '  T3', '    S2', 'E2', '  T2', 'X']);
  assert.equal(roots, 3);
  assert.deepEqual([tree.children.E1, tree.children.T1, tree.children.S1], [2, 1, 0]);
  assert.deepEqual(tree.parentOutside, ['X'], 'a row whose parent is filtered out stands at the top, marked');
});

check('a page is so many top-level items, each with its whole tree', () => {
  assert.deepEqual(treePage(rows, 1, 1).rows.map((row) => row.id), ['E1', 'T1', 'S1', 'T3', 'S2']);
  assert.deepEqual(treePage(rows, 2, 1).rows.map((row) => row.id), ['E2', 'T2']);
  assert.deepEqual(treePage(rows, 4, 1).rows, []);
});

check('grouped by project: each group holds its own trees, and paging runs across the groups', () => {
  const groups = [
    { value: 'Alpha', count: 5, taskIds: ['E1', 'T1', 'T3', 'S1', 'S2'] },
    { value: 'Beta', count: 3, taskIds: ['E2', 'T2', 'X'] },
  ];
  const first = treePage(rows, 1, 2, groups);
  assert.equal(first.roots, 3);
  assert.deepEqual(first.groups!.map((group) => [group.value, group.count, group.taskIds.join()]), [
    ['Alpha', 5, 'E1,T1,S1,T3,S2'],
    ['Beta', 3, 'E2,T2'],
  ]);
  assert.deepEqual(treePage(rows, 2, 2, groups).groups!.map((group) => group.taskIds.join()), ['', 'X']);
});

console.log(`\n${passed} passed`);
