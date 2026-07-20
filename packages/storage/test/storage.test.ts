import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  MemoryDriver,
  MemoryNamespace,
  MemoryCollection,
  MemoryBlobStore,
  FsDriver,
  StorageModule,
  StorageEvents,
} from '../src/index.js';

describe('MemoryNamespace', () => {
  let ns: MemoryNamespace;
  beforeEach(() => { ns = new MemoryNamespace('test'); });

  it('set/get/has/delete basic flow', async () => {
    assert.equal(await ns.has('a'), false);
    const meta = await ns.set('a', { x: 1 });
    assert.equal(await ns.has('a'), true);
    assert.deepEqual(await ns.get('a'), { x: 1 });
    assert.equal(meta.key, 'a');
    assert.ok(meta.etag);
    assert.ok(meta.createdAt <= Date.now());
    assert.equal(await ns.delete('a'), true);
    assert.equal(await ns.has('a'), false);
    assert.equal(await ns.get('a'), undefined);
    assert.equal(await ns.delete('a'), false);
  });

  it('lists by prefix and supports cursor pagination', async () => {
    await ns.set('user:1', 'a');
    await ns.set('user:2', 'b');
    await ns.set('post:1', 'c');
    await ns.set('user:3', 'd');
    const all = await ns.list({ prefix: 'user:' });
    assert.equal(all.items.length, 3);
    const page1 = await ns.list({ prefix: 'user:', limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await ns.list({ prefix: 'user:', limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, undefined);
  });

  it('clear and size', async () => {
    await ns.set('a', 1); await ns.set('b', 2);
    assert.equal(await ns.size(), 2);
    await ns.clear();
    assert.equal(await ns.size(), 0);
  });

  it('preserves createdAt across updates', async () => {
    const m1 = await ns.set('k', 'v1');
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await ns.set('k', 'v2');
    assert.equal(m1.createdAt, m2.createdAt);
    assert.ok(m2.updatedAt >= m1.updatedAt);
  });
});

describe('MemoryCollection', () => {
  let c: MemoryCollection<{ id: string; name: string; age: number }>;
  beforeEach(() => { c = new MemoryCollection('people'); });

  it('put/get/delete/has/count', async () => {
    await c.put({ id: '1', name: 'Alice', age: 30 });
    await c.put({ id: '2', name: 'Bob', age: 25 });
    assert.equal(await c.count(), 2);
    assert.equal((await c.get('1'))!.name, 'Alice');
    assert.equal(await c.has('2'), true);
    await c.delete('2');
    assert.equal(await c.has('2'), false);
    assert.equal(await c.count(), 1);
  });

  it('requires an id', async () => {
    await assert.rejects(() => c.put({ name: 'x' } as any), /must have an id/);
  });

  it('queries with where, orderBy, limit, offset', async () => {
    await c.put({ id: '1', name: 'C', age: 40 });
    await c.put({ id: '2', name: 'A', age: 20 });
    await c.put({ id: '3', name: 'B', age: 30 });
    await c.put({ id: '4', name: 'D', age: 35 });
    const over30 = await c.query({ where: (d) => d.age >= 30, orderBy: 'age', order: 'asc' });
    assert.deepEqual(over30.map((d) => d.id), ['3', '4', '1']);
    const page = await c.query({ orderBy: 'name', limit: 2, offset: 1 });
    assert.deepEqual(page.map((d) => d.name), ['B', 'C']);
  });
});

describe('MemoryBlobStore', () => {
  let b: MemoryBlobStore;
  beforeEach(() => { b = new MemoryBlobStore('blobs'); });

  it('stores and retrieves text/binary', async () => {
    await b.put('hello.txt', 'hello world', 'text/plain');
    assert.equal(await b.getAsText('hello.txt'), 'hello world');
    const bytes = await b.get('hello.txt');
    assert.ok(bytes instanceof Uint8Array);
    const meta = await b.getMeta('hello.txt');
    assert.equal(meta!.size, 11);
    await b.put('bin', new Uint8Array([1, 2, 3]));
    const bb = await b.get('bin');
    assert.deepEqual([...bb!], [1, 2, 3]);
  });
});

describe('MemoryDriver', () => {
  it('caches opened namespaces and resets on close', async () => {
    const d = new MemoryDriver();
    const n1 = await d.openNamespace('a');
    const n2 = await d.openNamespace('a');
    assert.equal(n1, n2);
    await n1.set('k', 'v');
    await d.close();
    const n3 = await d.openNamespace('a');
    assert.notEqual(n1, n3);
    assert.equal(await n3.get('k'), undefined);
    await d.close();
  });
});

describe('FsDriver', () => {
  let tmpDir: string;
  let driver: FsDriver;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-storage-'));
    driver = new FsDriver({ root: tmpDir });
  });
  after(async () => {
    await driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists namespaces across driver instances', async () => {
    const ns1 = await driver.openNamespace('settings');
    await ns1.set('theme', 'dark');
    // Re-open namespace to simulate restart.
    const driver2 = new FsDriver({ root: tmpDir });
    const ns2 = await driver2.openNamespace('settings');
    assert.equal(await ns2.get('theme'), 'dark');
    await driver2.close();
  });

  it('persists collections as JSONL', async () => {
    const col = await driver.openCollection<{ id: string; v: number }>('items');
    await col.put({ id: 'x', v: 1 });
    await col.put({ id: 'y', v: 2 });
    // Read raw file to confirm shape.
    const txt = await fs.readFile(path.join(tmpDir, 'collections', 'items.jsonl'), 'utf8');
    const lines = txt.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes('"v":1'));
  });

  it('persists blobs with metadata', async () => {
    const bs = await driver.openBlobStore('files');
    await bs.put('a.txt', 'hi there', 'text/plain');
    assert.equal(await bs.getAsText('a.txt'), 'hi there');
    const meta = await bs.getMeta('a.txt');
    assert.ok(meta && meta.size === 'hi there'.length);
  });
});

describe('StorageModule (kernel integration)', () => {
  let kernel: Kernel;
  beforeEach(() => { kernel = createTestKernel(); });

  it('boots with memory driver by default and wires container bindings', async () => {
    kernel.register(new StorageModule());
    const created: string[] = [];
    kernel.bus.on(StorageEvents.NamespaceCreated, (p: any) => { created.push(p.name); });
    await kernel.boot();
    const mod = kernel.getModule<StorageModule>('storage');
    assert.equal(mod.getDriver().id, 'memory');
    const ns = await mod.namespace('testns');
    await ns.set('k', 42);
    assert.equal(await ns.get('k'), 42);
    assert.ok(created.includes('testns'));
    const fromContainer = await kernel.container.resolve<StorageModule>('storage.module');
    assert.equal(fromContainer, mod);
    await kernel.shutdown();
  });

  it('boots with filesystem driver when configured', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-storagemod-'));
    const k2 = createTestKernel({ configDefaults: { storage: { driver: 'filesystem', fsRoot: tmpDir } } });
    k2.register(new StorageModule());
    await k2.boot();
    const mod = k2.getModule<StorageModule>('storage');
    assert.equal(mod.getDriver().id, 'filesystem');
    const col = await mod.collection<{ id: string; v: number }>('c');
    await col.put({ id: '1', v: 99 });
    assert.equal((await col.get('1'))!.v, 99);
    await k2.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
