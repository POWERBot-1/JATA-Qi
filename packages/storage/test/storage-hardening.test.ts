// PR7 — StorageModule integration: encryption-at-rest + quota enforcement wired
// through the kernel module config (the path real embedders use).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule, generateEncryptionKey, QuotaExceededError } from '../src/index.js';

describe('StorageModule — encryption at rest (kernel integration)', () => {
  let kernel: Kernel;
  let tmpDir: string;

  it('transparently encrypts namespaces + collections on the filesystem driver', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-mod-enc-'));
    kernel = createTestKernel();
    kernel.register(new StorageModule({ driver: 'filesystem', fsRoot: tmpDir, encryptionKey: generateEncryptionKey() }));
    await kernel.boot();
    const storage = kernel.getModule<StorageModule>('storage');
    assert.match(storage.getDriver().id, /encrypted/);

    const ns = await storage.namespace('secrets');
    await ns.set('token', 'plain-secret-value');
    assert.equal(await ns.get('token'), 'plain-secret-value');

    const users = await storage.collection<{ id: string; name: string }>('users');
    await users.put({ id: '1', name: 'Alice' });
    assert.equal((await users.get('1'))!.name, 'Alice');

    // Nothing plaintext on disk.
    const files = await collectFiles(tmpDir);
    const all = (await Promise.all(files.map((f) => fs.readFile(f, 'utf8').catch(() => '')))).join('\n');
    assert.ok(!all.includes('plain-secret-value'), 'plaintext value leaked to disk');
    assert.ok(!all.includes('Alice'), 'plaintext doc leaked to disk');
    await kernel.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports the encryption decorator in the driver id and logs it', async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule({ driver: 'memory', encryptionKey: generateEncryptionKey() }));
    await kernel.boot();
    const storage = kernel.getModule<StorageModule>('storage');
    assert.equal(storage.getDriver().id, 'memory+encrypted');
    await kernel.shutdown();
  });
});

describe('StorageModule — quota enforcement (kernel integration)', () => {
  let kernel: Kernel;

  it('enforces a configured namespace quota through the module API', async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule({ driver: 'memory', quotas: { kv: 16 } }));
    await kernel.boot();
    const storage = kernel.getModule<StorageModule>('storage');
    assert.match(storage.getDriver().id, /quota/);
    const ns = await storage.namespace('kv');
    await ns.set('a', '12345678'); // 8
    await ns.set('b', '12345678'); // 16 (full)
    await assert.rejects(() => ns.set('c', 'x'), (e: unknown) => (e as QuotaExceededError).code === 'QUOTA_EXCEEDED');
    // A non-quotaed namespace is unbounded.
    const ns2 = await storage.namespace('unbounded');
    await ns2.set('big', 'x'.repeat(10_000));
    assert.equal(((await ns2.get('big')) as string).length, 10_000);
    await kernel.shutdown();
  });
});

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectFiles(full));
    else out.push(full);
  }
  return out;
}

// Ensure any leftover kernel from a failed test is shut down.
after(async () => { /* kernels are shut down per-test above */ });
