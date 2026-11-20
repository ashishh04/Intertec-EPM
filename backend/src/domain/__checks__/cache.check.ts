import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { runWithAuth, type AuthContext } from '../../auth/context.js';
import { SwrCache, TtlCache, wasServedStale } from '../../lib/cache.js';
import { OpenProjectClient, type CollectionQuery } from '../../openproject/client.js';
import type { HalCollection } from '../../openproject/types.js';

/**
 * The caches behind every list (`lib/cache.ts`) and the collection walk behind
 * every read of a whole collection (`OpenProjectClient.getAll`): kept answers
 * are fast and are never older than the last write for the person who made it;
 * pages come back complete and in order, a few at a time.
 *
 *   npx tsx --env-file-if-exists=.env src/domain/__checks__/cache.check.ts
 */

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

const person = (userId: string): AuthContext => ({ accessToken: `token-${userId}`, userId, sessionId: `s-${userId}` });
const as = <T>(userId: string, run: () => T): T => runWithAuth(person(userId), run);
/** A loader that answers `value` after `ms`, counting its calls. */
function loader<T>(value: () => T, ms = 0) {
  const counter = { calls: 0, signals: [] as AbortSignal[] };
  const load = async (signal: AbortSignal) => {
    counter.calls += 1;
    counter.signals.push(signal);
    if (ms) await sleep(ms);
    return value();
  };
  return Object.assign(load, counter, { count: () => counter.calls });
}

console.log('Kept lists (SwrCache)');

await check('a fresh answer is served from memory, one load for many reads', async () => {
  const cache = new SwrCache(1_000, 60_000);
  let calls = 0;
  const load = async () => {
    calls += 1;
    return 'list';
  };
  assert.equal(await cache.get('k', load), 'list');
  assert.equal(await cache.get('k', load), 'list');
  assert.equal(calls, 1);
});

await check('past its fresh period it is answered at once, refreshed behind, and said to be stale', async () => {
  const cache = new SwrCache(30, 60_000);
  let version = 1;
  const load = async () => `v${version}`;
  await as('7', () => cache.get('list:u7', load));
  await sleep(50);
  version = 2;
  const auth = person('7');
  const answer = await runWithAuth(auth, () => cache.get('list:u7', load));
  assert.equal(answer, 'v1');
  assert.equal(wasServedStale(auth), true);
  await sleep(10);
  const next = person('7');
  assert.equal(await runWithAuth(next, () => cache.get('list:u7', load)), 'v2');
  assert.equal(wasServedStale(next), false);
});

await check('after a write the writer waits for the change; everyone else is answered at once, then refreshed', async () => {
  const cache = new SwrCache(60_000, 600_000);
  let version = 1;
  const load = async () => {
    await sleep(20);
    return `v${version}`;
  };
  await as('1', () => cache.get('sprints:u1', load));
  await as('2', () => cache.get('sprints:u2', load));
  version = 2;
  as('1', () => cache.written());
  assert.equal(await as('1', () => cache.get('sprints:u1', load)), 'v2', 'the writer sees their own write');
  assert.equal(await as('2', () => cache.get('sprints:u2', load)), 'v1', 'another person is answered at once');
  await sleep(40);
  assert.equal(await as('2', () => cache.get('sprints:u2', load)), 'v2', 'and refreshed for their next look');
});

await check('a load begun before the write is neither joined nor kept for the writer', async () => {
  const cache = new SwrCache(60_000, 600_000);
  let version = 1;
  const slow = async () => {
    const seen = version;
    await sleep(80);
    return `v${seen}`;
  };
  const before = as('3', () => cache.get('tasks:u3', slow));
  await sleep(10);
  version = 2;
  as('3', () => cache.written());
  const after = await as('3', () => cache.get('tasks:u3', slow));
  assert.equal(after, 'v2');
  assert.equal(await before, 'v1', 'the earlier reader still gets its answer');
  await sleep(20);
  assert.equal(await as('3', () => cache.get('tasks:u3', slow)), 'v2', 'and the earlier answer did not replace the later one');
});

await check('an older answer never replaces a newer one', async () => {
  const cache = new SwrCache(10, 600_000);
  let version = 1;
  const variable = async () => {
    const seen = version;
    await sleep(seen === 1 ? 120 : 10);
    return `v${seen}`;
  };
  await cache.get('k:system', async () => 'v0');
  await sleep(20);
  void cache.get('k:system', variable); // stale: refresh behind, slow, sees v1
  await sleep(5);
  version = 2;
  cache.expire(); // a write elsewhere: the slow refresh is no longer joined
  await sleep(20);
  void cache.get('k:system', variable); // another refresh behind, fast, sees v2
  await sleep(200);
  const answer = await cache.get('k:system', async () => 'never');
  assert.equal(answer, 'v2');
});

await check('invalidating drops the entry, and a load begun before is not kept', async () => {
  const cache = new SwrCache(60_000, 600_000);
  let version = 1;
  const slow = async () => {
    const seen = version;
    await sleep(60);
    return `v${seen}`;
  };
  const early = cache.get('views:u9', slow);
  await sleep(5);
  version = 2;
  cache.invalidatePrefix('views');
  assert.equal(await cache.get('views:u9', slow), 'v2');
  await early;
  assert.equal(await cache.get('views:u9', async () => 'never'), 'v2');
});

console.log('\nShort caches (TtlCache)');

await check('display data past its time is answered at once and reloaded behind on a signal of its own', async () => {
  const cache = new TtlCache(30);
  let version = 1;
  const signals: (AbortSignal | undefined)[] = [];
  const load = async (signal?: AbortSignal) => {
    signals.push(signal);
    return `v${version}`;
  };
  await cache.get('metrics:u4', load, 30, { staleMs: 60_000 });
  await sleep(50);
  version = 2;
  const auth = person('4');
  assert.equal(await runWithAuth(auth, () => cache.get('metrics:u4', load, 30, { staleMs: 60_000 })), 'v1');
  assert.equal(wasServedStale(auth), true);
  assert.ok(signals[1] instanceof AbortSignal, 'the reload behind has a signal of its own');
  await sleep(10);
  assert.equal(await cache.get('metrics:u4', load, 30, { staleMs: 60_000 }), 'v2');
});

await check('what decides access is never answered past its time', async () => {
  const cache = new TtlCache(30);
  let version = 1;
  const load = async () => `v${version}`;
  await cache.get('permissions:u5', load);
  await sleep(50);
  version = 2;
  assert.equal(await cache.get('permissions:u5', load), 'v2');
});

await check('a write drops the writer’s entries and expires everyone else’s', async () => {
  const cache = new TtlCache(60_000);
  let version = 1;
  const load = async () => `v${version}`;
  await cache.get('dashboard:u1', load);
  await cache.get('dashboard:u2', load, undefined, { staleMs: 60_000 });
  await cache.get('strict:u2', load);
  version = 2;
  cache.written('u1');
  assert.equal(await cache.get('dashboard:u1', load), 'v2', 'the writer');
  assert.equal(await cache.get('dashboard:u2', load, undefined, { staleMs: 60_000 }), 'v1', 'display data for someone else, at once');
  assert.equal(await cache.get('strict:u2', load), 'v2', 'anything else, reloaded');
});

await check('an invalidation during a load keeps that load’s answer out of the cache', async () => {
  const cache = new TtlCache(60_000);
  let version = 1;
  const slow = async () => {
    const seen = version;
    await sleep(50);
    return `v${seen}`;
  };
  const early = cache.get('users:u6', slow);
  await sleep(5);
  version = 2;
  cache.invalidatePrefix('users');
  assert.equal(await early, 'v1');
  assert.equal(await cache.get('users:u6', slow), 'v2');
});

console.log('\nWhole collections (getAll)');

/** A collection of `size` items served `pageSize` at a time, counting requests and how many ran at once. */
class StubClient extends OpenProjectClient {
  calls: number[] = [];
  running = 0;
  mostAtOnce = 0;
  constructor(
    private size: number,
    private readonly grow: (call: number) => number = () => 0,
  ) {
    super('http://stub.invalid', 'stub');
  }
  override async getCollection<T>(_path: string, query: CollectionQuery = {}): Promise<HalCollection<T>> {
    const page = query.offset ?? 1;
    const pageSize = query.pageSize ?? 200;
    this.calls.push(page);
    this.size += this.grow(this.calls.length);
    this.running += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.running);
    await sleep(5);
    this.running -= 1;
    const start = (page - 1) * pageSize;
    const elements = Array.from({ length: Math.max(0, Math.min(pageSize, this.size - start)) }, (_, index) => ({ id: start + index + 1 }));
    return { total: this.size, count: elements.length, _embedded: { elements }, _links: {} } as unknown as HalCollection<T>;
  }
}

const ids = (items: { id: number }[]) => items.map((item) => item.id);
const upTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

await check('an empty collection is one request', async () => {
  const client = new StubClient(0);
  const result = await client.getAll<{ id: number }>('/x', { pageSize: 200 });
  assert.deepEqual(result, { items: [], total: 0, truncated: false });
  assert.equal(client.calls.length, 1);
});

await check('one page, exactly full, is one request', async () => {
  const client = new StubClient(200);
  const result = await client.getAll<{ id: number }>('/x', { pageSize: 200 });
  assert.deepEqual(ids(result.items), upTo(200));
  assert.equal(client.calls.length, 1);
});

await check('3,000 items come back complete and in order, at most four pages at a time', async () => {
  const client = new StubClient(3_000);
  const result = await client.getAll<{ id: number }>('/x', { pageSize: 200 });
  assert.deepEqual(ids(result.items), upTo(3_000));
  assert.equal(result.total, 3_000);
  assert.equal(result.truncated, false);
  assert.equal(client.calls.length, 15);
  assert.ok(client.mostAtOnce <= 4 && client.mostAtOnce > 1, `ran ${client.mostAtOnce} at once`);
});

await check('a partly filled last page ends the walk', async () => {
  const client = new StubClient(401);
  const result = await client.getAll<{ id: number }>('/x', { pageSize: 200 });
  assert.deepEqual(ids(result.items), upTo(401));
  assert.equal(client.calls.length, 3);
});

await check('the page limit still stops the walk and says the result is incomplete', async () => {
  const client = new StubClient(1_000);
  const result = await client.getAll<{ id: number }>('/x', { pageSize: 200 }, { maxPages: 3 });
  assert.deepEqual(ids(result.items), upTo(600));
  assert.equal(result.truncated, true);
  assert.equal(client.calls.length, 3);
});

await check('items added while it reads are read too, one page at a time after the rest', async () => {
  // The first page says 1,000; by the last of the side-by-side pages there are 1,150.
  const client = new StubClient(1_000, (call) => (call === 5 ? 150 : 0));
  const result = await client.getAll<{ id: number }>('/x', { pageSize: 200 });
  assert.deepEqual(ids(result.items), upTo(1_150));
  assert.equal(result.truncated, false);
});

console.log(`\n${passed} passed`);
