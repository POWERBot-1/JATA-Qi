import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
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
  FsCollection,
  FsDriver,
  FsSingleProcessStorageError,
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

  it('replaces a complete collection snapshot', async () => {
    await c.put({ id: 'old', name: 'Old', age: 1 });
    await c.replaceAll([
      { id: '1', name: 'Alice', age: 30 },
      { id: '2', name: 'Bob', age: 25 },
    ]);
    assert.deepEqual((await c.all()).map((entry) => entry.id), ['1', '2']);
    await assert.rejects(
      () => c.replaceAll([{ id: 'duplicate', name: 'One', age: 1 }, { id: 'duplicate', name: 'Two', age: 2 }]),
      /duplicate document id/,
    );
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
  afterEach(async () => {
    await driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists namespaces across an orderly driver restart', async () => {
    const ns1 = await driver.openNamespace('settings');
    await ns1.set('theme', 'dark');
    await driver.close();

    const restarted = new FsDriver({ root: tmpDir });
    const ns2 = await restarted.openNamespace('settings');
    assert.equal(await ns2.get('theme'), 'dark');
    await restarted.close();
  });

  it('reacquires its local root when reused after an orderly close', async () => {
    const first = await driver.openCollection<{ id: string; value: string }>('reused');
    await first.put({ id: 'saved', value: 'survives-reopen' });
    await driver.close();

    const reopened = await driver.openCollection<{ id: string; value: string }>('reused');
    assert.deepEqual(await reopened.get('saved'), { id: 'saved', value: 'survives-reopen' });
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

  it('serializes concurrent same-process collection writes without temporary-file collisions', async () => {
    const siblingDriver = new FsDriver({ root: tmpDir });
    try {
      const collection = await driver.openCollection<{ id: string; value: number }>('concurrent');
      const siblingCollection = await siblingDriver.openCollection<{ id: string; value: number }>('concurrent');
      // Also exercise a separately-created handle for the same file. Driver
      // handles are shared per root, while this proves stale local caches cannot
      // overwrite another same-process handle's update.
      const independentCollection = new FsCollection<{ id: string; value: number }>(
        'concurrent',
        path.join(tmpDir, 'collections', 'concurrent.jsonl'),
      );
      const documents = Array.from({ length: 128 }, (_, value) => ({ id: `id-${value}`, value }));
      await Promise.all(documents.map((document, index) => [collection, siblingCollection, independentCollection][index % 3]!.put(document)));

      assert.equal(await collection.count(), documents.length);
      const persisted = await fs.readFile(path.join(tmpDir, 'collections', 'concurrent.jsonl'), 'utf8');
      assert.equal(persisted.trim().split('\n').length, documents.length);
      const names = await fs.readdir(path.join(tmpDir, 'collections'));
      assert.equal(names.filter((name) => name.includes('.tmp-')).length, 0);

      await driver.close();
      await siblingDriver.close();
      const restarted = new FsDriver({ root: tmpDir });
      const recovered = await restarted.openCollection<{ id: string; value: number }>('concurrent');
      assert.equal(await recovered.count(), documents.length);
      assert.deepEqual((await recovered.all()).map((document) => document.id).sort(), documents.map((document) => document.id).sort());
      await restarted.close();
    } finally {
      await siblingDriver.close();
    }
  });

  it('allows exactly one simultaneous process owner for a filesystem root', async () => {
    const moduleUrl = new URL('../src/index.js', import.meta.url).href;
    const startContender = (id: string) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', `
        const { FsDriver } = await import(process.env.JATAQI_STORAGE_MODULE);
        process.stdout.write('WAITING');
        process.stdin.resume();
        process.stdin.once('data', async () => {
          try {
            const driver = new FsDriver({ root: process.env.JATAQI_STORAGE_ROOT });
            const collection = await driver.openCollection('race');
            await collection.put({ id: process.env.JATAQI_CONTENDER_ID });
            process.stdout.write('OWNED');
            process.stdin.once('data', () => process.exit(0));
          } catch (error) {
            process.stdout.write('REJECTED:' + error?.name);
            process.exit(0);
          }
        });
      `], {
        env: {
          ...process.env,
          JATAQI_STORAGE_MODULE: moduleUrl,
          JATAQI_STORAGE_ROOT: tmpDir,
          JATAQI_CONTENDER_ID: id,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!child.stdout || !child.stdin) throw new Error('filesystem race child did not expose piped stdio');

      let output = '';
      const waitFor = (marker: string): Promise<void> => {
        if (output.includes(marker)) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const onData = (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes(marker)) {
              child.stdout!.off('data', onData);
              resolve();
            }
          };
          child.stdout!.on('data', onData);
          child.once('error', reject);
          child.once('exit', (code, signal) => {
            if (!output.includes(marker)) {
              reject(new Error(`filesystem race child exited before ${marker} (code=${code}, signal=${signal}, output=${output})`));
            }
          });
        });
      };
      return { child, output: () => output, waitFor };
    };

    const contenders = [startContender('one'), startContender('two')];
    try {
      await Promise.all(contenders.map((contender) => contender.waitFor('WAITING')));
      for (const contender of contenders) contender.child.stdin!.write('go');
      await Promise.all(contenders.map((contender) => contender.waitFor('OWNED').catch(() => contender.waitFor('REJECTED:FsSingleProcessStorageError'))));

      const owners = contenders.filter((contender) => contender.output().includes('OWNED'));
      const rejected = contenders.filter((contender) => contender.output().includes('REJECTED:FsSingleProcessStorageError'));
      assert.equal(owners.length, 1);
      assert.equal(rejected.length, 1);
      await fs.stat(path.join(tmpDir, '.jataqi-fs.lock'));

      const owner = owners[0]!;
      const exited = once(owner.child, 'exit');
      owner.child.stdin!.write('exit');
      await exited;
      const recovered = await driver.openCollection<{ id: string }>('race');
      assert.equal(await recovered.count(), 1);
    } finally {
      for (const contender of contenders) {
        if (contender.child.exitCode === null && contender.child.signalCode === null) {
          const exited = once(contender.child, 'exit');
          contender.child.kill('SIGKILL');
          await exited;
        }
      }
    }
  });

  it('rejects a second process for the same root and recovers a stale root lock after abrupt exit', async () => {
    const moduleUrl = new URL('../src/index.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      const { FsDriver } = await import(process.env.JATAQI_STORAGE_MODULE);
      const driver = new FsDriver({ root: process.env.JATAQI_STORAGE_ROOT });
      const collection = await driver.openCollection('shared');
      await collection.put({ id: 'child', value: 'written-before-abrupt-exit' });
      process.stdout.write('READY\\n');
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(0));
    `], {
      env: { ...process.env, JATAQI_STORAGE_MODULE: moduleUrl, JATAQI_STORAGE_ROOT: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!child.stdout || !child.stdin) throw new Error('filesystem lock child did not expose piped stdio');
    const childStdout = child.stdout;
    const childStdin = child.stdin;
    let output = '';
    const ready = new Promise<void>((resolve, reject) => {
      childStdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('READY\n')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (!output.includes('READY\n')) reject(new Error(`filesystem lock child exited before readiness (code=${code}, signal=${signal})`));
      });
    });

    try {
      await ready;
      await assert.rejects(
        () => driver.openCollection<{ id: string; value: string }>('shared'),
        (error: unknown) => error instanceof FsSingleProcessStorageError,
      );

      const exited = once(child, 'exit');
      childStdin.write('exit\n'); // Deliberately exits without driver.close(): crash-style lock.
      await exited;

      const restarted = new FsDriver({ root: tmpDir });
      const recovered = await restarted.openCollection<{ id: string; value: string }>('shared');
      assert.deepEqual(await recovered.get('child'), { id: 'child', value: 'written-before-abrupt-exit' });
      await restarted.close();
      await assert.rejects(() => fs.stat(path.join(tmpDir, '.jataqi-fs.lock')), { code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('preserves the canonical snapshot and removes stale temporary files after a crash-style partial write', async () => {
    const collection = await driver.openCollection<{ id: string; value: string }>('recoverable');
    await collection.put({ id: 'canonical', value: 'durable' });

    const staleFiles = [
      path.join(tmpDir, 'collections', '.jataqi-tmp', 'recoverable.jsonl.tmp-crash'),
      path.join(tmpDir, 'ns', 'settings', '.jataqi-tmp', 'value.json.tmp-crash'),
      path.join(tmpDir, 'blobs', 'files', '.jataqi-tmp', 'blob.tmp-crash'),
    ];
    for (const stale of staleFiles) {
      await fs.mkdir(path.dirname(stale), { recursive: true });
      await fs.writeFile(stale, '{partial temporary content');
    }
    const settings = await driver.openNamespace('settings');
    await settings.set('user.tmp-key', 'must-survive-recovery');
    const abandonedLockCandidate = path.join(tmpDir, '.jataqi-fs.lock.candidate-999999-orphan');
    await fs.writeFile(abandonedLockCandidate, '{partial lock candidate');

    await driver.close();
    const restarted = new FsDriver({ root: tmpDir });
    const recovered = await restarted.openCollection<{ id: string; value: string }>('recoverable');
    assert.deepEqual(await recovered.get('canonical'), { id: 'canonical', value: 'durable' });
    const recoveredSettings = await restarted.openNamespace('settings');
    assert.equal(await recoveredSettings.get('user.tmp-key'), 'must-survive-recovery');
    for (const stale of staleFiles) await assert.rejects(() => fs.stat(stale), { code: 'ENOENT' });
    await assert.rejects(() => fs.stat(abandonedLockCandidate), { code: 'ENOENT' });
    await restarted.close();
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

describe('compare-and-swap (cas) atomic transition', () => {
  it('MemoryCollection cas wins only when the guard holds and writes atomically', async () => {
    const col = new MemoryCollection<{ id: string; n: number }>('cas-mem');
    await col.put({ id: 'a', n: 1 });
    const won = await col.cas('a', (cur) => cur?.n === 1, (cur) => ({ id: cur!.id, n: 2 }));
    assert.equal(won.ok, true);
    assert.equal(won.doc?.n, 2);
    const lost = await col.cas('a', (cur) => cur?.n === 99, (cur) => ({ id: cur!.id, n: 3 }));
    assert.equal(lost.ok, false);
    assert.equal(lost.doc?.n, 2);
    assert.equal((await col.get('a'))?.n, 2);
    // guard can create an absent document (insert-if-absent)
    const created = await col.cas('b', (cur) => cur === undefined, () => ({ id: 'b', n: 5 }));
    assert.equal(created.ok, true);
    assert.equal((await col.get('b'))?.n, 5);
  });

  it('FsCollection cas is atomic under its per-file lock and persists', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-cas-'));
    const driver = new FsDriver({ root: tmpDir });
    const col = await driver.openCollection<{ id: string; n: number }>('cas-fs');
    await col.put({ id: 'a', n: 1 });
    // Two concurrent cas transitions on the same doc: exactly one can advance from n===1.
    const outcomes = await Promise.all(
      [1, 2].map(() => col.cas('a', (cur) => cur?.n === 1, (cur) => ({ id: cur!.id, n: cur!.n + 1 }))),
    );
    assert.equal(outcomes.filter((o) => o.ok).length, 1);
    assert.equal((await col.get('a'))?.n, 2);
    await driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
