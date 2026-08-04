import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DisasterRecoveryModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('DisasterRecoveryModule', () => {
  let kernel: Kernel; let dr: DisasterRecoveryModule;
  beforeEach(async () => {
    kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new DisasterRecoveryModule());
    await kernel.boot(); dr = kernel.getModule<DisasterRecoveryModule>('disaster-recovery');
  });

  it('creates snapshots and restores them', async () => {
    const storage = kernel.getModule('storage') as unknown as { namespace: (n: string) => Promise<{ set: (k: string, v: unknown) => Promise<unknown>; get: <T>(k: string) => Promise<T | undefined>; size: () => Promise<number> }> };
    const ns = await storage.namespace('test.data');
    await ns.set('key1', { name: 'Alice', value: 42 });
    await ns.set('key2', { name: 'Bob', value: 99 });

    const snap = await dr.createSnapshot('test.data', 'admin');
    assert.equal(snap.entryCount, 2);
    assert.ok(snap.contentHash);

    // Delete data to simulate disaster.
    // (We can't delete from namespace directly, so let's overwrite and restore.)
    await ns.set('key1', { name: 'CORRUPTED' });
    const before = await ns.get<{ name: string }>('key1');
    assert.equal(before!.name, 'CORRUPTED');

    // Restore.
    const result = await dr.restore(snap.id, 'admin');
    assert.equal(result.restoredEntries, 2);
    assert.equal(result.verified, true);

    const after = await ns.get<{ name: string }>('key1');
    assert.equal(after!.name, 'Alice');
  });

  it('lists and filters snapshots', async () => {
    await dr.createSnapshot('ns-a', 'admin');
    await dr.createSnapshot('ns-b', 'admin');
    await dr.createSnapshot('ns-a', 'admin');
    assert.equal((await dr.listSnapshots()).length, 3);
    assert.equal((await dr.listSnapshots('ns-a')).length, 2);
  });

  it('deletes snapshots for retention', async () => {
    const snap = await dr.createSnapshot('ns-x', 'admin');
    assert.equal(await dr.deleteSnapshot(snap.id), true);
    assert.equal(await dr.getSnapshot(snap.id), undefined);
  });

  it('emits snapshot and restore events', async () => {
    let snap = 0; let restore = 0;
    kernel.bus.on('dr.snapshot.created', () => { snap++; });
    kernel.bus.on('dr.restore.completed', () => { restore++; });
    const storage = kernel.getModule('storage') as unknown as { namespace: (n: string) => Promise<{ set: (k: string, v: unknown) => Promise<unknown> }> };
    await (await storage.namespace('e.test')).set('k', 'v');
    const s = await dr.createSnapshot('e.test', 'admin');
    await dr.restore(s.id, 'admin');
    assert.equal(snap, 1);
    assert.equal(restore, 1);
  });
});
