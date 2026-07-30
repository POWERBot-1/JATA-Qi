import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteDriver } from '../src/drivers/sqlite.js';
import type { INamespace, ICollection, IBlobStore } from '../src/types.js';

describe('SqliteDriver — in-memory mode', () => {
  let driver: SqliteDriver;

  beforeEach(() => { driver = new SqliteDriver({ path: ':memory:' }); });
  afterEach(async () => { await driver.close(); });

  // --- Namespace (KV) --------------------------------------------------------

  it('sets and gets values in a namespace', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('key1', { name: 'Alice', value: 42 });
    const val = await ns.get<{ name: string; value: number }>('key1');
    assert.deepEqual(val, { name: 'Alice', value: 42 });
  });

  it('returns undefined for missing keys', async () => {
    const ns = await driver.openNamespace('test');
    assert.equal(await ns.get('nonexistent'), undefined);
  });

  it('deletes keys', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('key1', 'val1');
    assert.equal(await ns.delete('key1'), true);
    assert.equal(await ns.get('key1'), undefined);
    assert.equal(await ns.delete('key1'), false);
  });

  it('checks existence with has()', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('key1', 'val1');
    assert.equal(await ns.has('key1'), true);
    assert.equal(await ns.has('key2'), false);
  });

  it('lists entries with pagination', async () => {
    const ns = await driver.openNamespace('test');
    for (let i = 0; i < 10; i++) await ns.set(`key${i}`, `val${i}`);
    const page1 = await ns.list({ limit: 5 });
    assert.equal(page1.items.length, 5);
    assert.ok(page1.nextCursor);
    const page2 = await ns.list({ limit: 5, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 5);
    assert.equal(page2.nextCursor, undefined);
  });

  it('lists with prefix filter', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('user:1', 'a'); await ns.set('user:2', 'b'); await ns.set('post:1', 'c');
    const result = await ns.list({ prefix: 'user:' });
    assert.equal(result.items.length, 2);
  });

  it('reports namespace size', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('a', 1); await ns.set('b', 2);
    assert.equal(await ns.size(), 2);
  });

  it('clears a namespace', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('a', 1); await ns.set('b', 2);
    await ns.clear();
    assert.equal(await ns.size(), 0);
  });

  it('updates preserve created_at', async () => {
    const ns = await driver.openNamespace('test');
    await ns.set('key', 'v1');
    const entry1 = await ns.getEntry('key');
    await new Promise(r => setTimeout(r, 10));
    await ns.set('key', 'v2');
    const entry2 = await ns.getEntry('key');
    assert.equal(entry2!.meta.createdAt, entry1!.meta.createdAt);
    assert.ok(entry2!.meta.updatedAt > entry1!.meta.updatedAt);
    assert.equal(entry2!.value, 'v2');
  });

  // --- Collection (Documents) ------------------------------------------------

  it('puts and gets documents in a collection', async () => {
    const col = await driver.openCollection<{ id: string; name: string }>('users');
    await col.put({ id: 'u1', name: 'Alice' });
    const doc = await col.get('u1');
    assert.equal(doc!.name, 'Alice');
  });

  it('deletes documents', async () => {
    const col = await driver.openCollection<{ id: string }>('items');
    await col.put({ id: 'i1' });
    assert.equal(await col.delete('i1'), true);
    assert.equal(await col.get('i1'), undefined);
  });

  it('queries with where predicate', async () => {
    const col = await driver.openCollection<{ id: string; age: number }>('people');
    await col.put({ id: 'p1', age: 25 });
    await col.put({ id: 'p2', age: 30 });
    await col.put({ id: 'p3', age: 35 });
    const results = await col.query({ where: (d) => d.age >= 30 });
    assert.equal(results.length, 2);
  });

  it('counts documents', async () => {
    const col = await driver.openCollection<{ id: string }>('things');
    await col.put({ id: 't1' }); await col.put({ id: 't2' });
    assert.equal(await col.count(), 2);
  });

  it('returns all documents', async () => {
    const col = await driver.openCollection<{ id: string; n: number }>('nums');
    for (let i = 0; i < 5; i++) await col.put({ id: `n${i}`, n: i });
    const all = await col.all();
    assert.equal(all.length, 5);
  });

  // --- BlobStore -------------------------------------------------------------

  it('puts and gets binary blobs', async () => {
    const store = await driver.openBlobStore('media');
    await store.put('file1', new Uint8Array([1, 2, 3, 4, 5]));
    const data = await store.get('file1');
    assert.deepEqual(data, new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('puts and gets text blobs', async () => {
    const store = await driver.openBlobStore('text');
    await store.put('doc1', 'Hello, World!', 'text/plain');
    const text = await store.getAsText('doc1');
    assert.equal(text, 'Hello, World!');
  });

  it('lists blobs', async () => {
    const store = await driver.openBlobStore('files');
    await store.put('a.txt', 'a'); await store.put('b.txt', 'b');
    const result = await store.list();
    assert.equal(result.items.length, 2);
  });

  // --- Isolation -------------------------------------------------------------

  it('isolates namespaces', async () => {
    const ns1 = await driver.openNamespace('ns1');
    const ns2 = await driver.openNamespace('ns2');
    await ns1.set('key', 'val1');
    await ns2.set('key', 'val2');
    assert.equal(await ns1.get('key'), 'val1');
    assert.equal(await ns2.get('key'), 'val2');
  });

  it('isolates collections', async () => {
    const c1 = await driver.openCollection<{ id: string; v: string }>('c1');
    const c2 = await driver.openCollection<{ id: string; v: string }>('c2');
    await c1.put({ id: 'x', v: 'a' });
    await c2.put({ id: 'x', v: 'b' });
    assert.equal((await c1.get('x'))!.v, 'a');
    assert.equal((await c2.get('x'))!.v, 'b');
  });

  // --- Transactions ----------------------------------------------------------

  it('supports transactions', () => {
    const result = driver.transaction(() => {
      // Do something synchronous within the transaction.
      return 'committed';
    });
    assert.equal(result, 'committed');
  });

  it('rolls back on error', () => {
    assert.throws(() => {
      driver.transaction(() => { throw new Error('rollback test'); });
    }, /rollback test/);
    // Data should still be consistent.
  });
});

describe('SqliteDriver — file-based persistence', () => {
  const dbPath = join(tmpdir(), `jataqi-test-${Date.now()}.db`);

  afterEach(() => {
    try { rmSync(dbPath); } catch { /* */ }
    try { rmSync(dbPath + '-wal'); } catch { /* */ }
    try { rmSync(dbPath + '-shm'); } catch { /* */ }
  });

  it('persists data across driver restarts', async () => {
    // Write data with first driver instance.
    {
      const driver = new SqliteDriver({ path: dbPath });
      const ns = await driver.openNamespace('persistent');
      await ns.set('survivor', { msg: 'I survived!' });
      const col = await driver.openCollection<{ id: string; name: string }>('users');
      await col.put({ id: 'u1', name: 'Alice' });
      await driver.close();
    }
    // Verify the database file exists.
    assert.ok(existsSync(dbPath), 'database file should exist');
    // Read data with a second driver instance.
    {
      const driver = new SqliteDriver({ path: dbPath });
      const ns = await driver.openNamespace('persistent');
      const val = await ns.get<{ msg: string }>('survivor');
      assert.equal(val!.msg, 'I survived!');
      const col = await driver.openCollection<{ id: string; name: string }>('users');
      const user = await col.get('u1');
      assert.equal(user!.name, 'Alice');
      await driver.close();
    }
  });

  it('supports concurrent namespaces in the same database', async () => {
    const driver = new SqliteDriver({ path: dbPath });
    const ns1 = await driver.openNamespace('space1');
    const ns2 = await driver.openNamespace('space2');
    const col = await driver.openCollection<{ id: string }>('docs');
    await ns1.set('k1', 'v1');
    await ns2.set('k1', 'v2');
    await col.put({ id: 'd1' });
    assert.equal(await ns1.size(), 1);
    assert.equal(await ns2.size(), 1);
    assert.equal(await col.count(), 1);
    await driver.close();
  });
});
