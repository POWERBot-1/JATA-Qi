// Scheduled-backup automation tests (PR4 — Security Hardening).
// Covers the backup cycle (snapshot + retention pruning), the interval
// scheduler, audit/notification integration, and shutdown cleanup.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { NotificationsModule } from '@jataqi/notifications';
import { SecurityModule } from '@jataqi/security';
import { DisasterRecoveryModule } from '../src/index.js';
import type { BackupScheduleHandle } from '../src/index.js';

describe('DisasterRecoveryModule — scheduled backups', () => {
  let kernel: Kernel;
  let dr: DisasterRecoveryModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new SecurityModule());
    kernel.register(new NotificationsModule());
    kernel.register(new DisasterRecoveryModule());
    await kernel.boot();
    dr = kernel.getModule<DisasterRecoveryModule>('disaster-recovery');
    // Seed some data into two namespaces.
    const storage = kernel.getModule('storage') as unknown as {
      namespace: (n: string) => Promise<{ set: (k: string, v: unknown) => Promise<unknown> }>;
    };
    const nsA = await storage.namespace('app.a');
    await nsA.set('k', { v: 1 });
    const nsB = await storage.namespace('app.b');
    await nsB.set('k', { v: 2 });
  });

  afterEach(async () => {
    await kernel.shutdown();
  });

  it('runs a backup cycle: snapshots each namespace and reports counts', async () => {
    const result = await dr.runBackupCycle({ namespaces: ['app.a', 'app.b'], intervalMs: 60_000, createdBy: 'sys' });
    assert.equal(result.snapshotIds.length, 2);
    assert.equal(result.pruned, 0);
    for (const id of result.snapshotIds) {
      const snap = await dr.getSnapshot(id);
      assert.ok(snap);
      assert.equal(snap!.entryCount, 1);
    }
  });

  it('enforces retention by pruning older snapshots beyond the window', async () => {
    // retention=2: the third cycle should prune the oldest.
    await dr.runBackupCycle({ namespaces: ['app.a'], intervalMs: 1_000, retention: 2 });
    await dr.runBackupCycle({ namespaces: ['app.a'], intervalMs: 1_000, retention: 2 });
    const r3 = await dr.runBackupCycle({ namespaces: ['app.a'], intervalMs: 1_000, retention: 2 });
    assert.ok(r3.pruned >= 1, 'should prune at least one out-of-retention snapshot');
    const remaining = await dr.listSnapshots('app.a');
    assert.ok(remaining.length <= 2, `retention=2 should leave at most 2, got ${remaining.length}`);
  });

  it('starts a scheduler whose runNow performs an on-demand cycle', async () => {
    const handle: BackupScheduleHandle = await dr.startScheduler({ namespaces: ['app.a'], intervalMs: 5_000 });
    assert.equal(handle.running, true);
    assert.ok(dr.listSchedulers().some((s) => s.id === handle.id));
    const res = await handle.runNow();
    assert.equal(res.snapshotIds.length, 1);
    assert.equal(handle.lastRunAt, res.ranAt);
    handle.stop();
    assert.equal(handle.running, false);
    assert.equal(dr.listSchedulers().some((s) => s.id === handle.id), false);
  });

  it('fires an event and writes an audit record on each cycle', async () => {
    const events: string[] = [];
    kernel.bus.on('dr.backup.run', () => { events.push('run'); });
    await dr.runBackupCycle({ namespaces: ['app.a'], intervalMs: 1_000, createdBy: 'sys' });
    assert.ok(events.includes('run'));
    const sec = kernel.getModule<SecurityModule>('security');
    const audit = await sec.getAuditLog().query({ action: 'dr.backup_run' });
    assert.ok(audit.length >= 1);
  });

  it('sends a notification on backup completion (notifications integration)', async () => {
    await dr.runBackupCycle({ namespaces: ['app.a'], intervalMs: 1_000, createdBy: 'ops', notifyRecipient: 'ops' });
    const notifications = kernel.getModule<NotificationsModule>('notifications');
    const list = await notifications.list('ops');
    assert.ok(list.some((n) => /Backup complete/.test(n.title)));
  });

  it('stops all schedulers on shutdown (no leaked intervals)', async () => {
    const h1 = await dr.startScheduler({ namespaces: ['app.a'], intervalMs: 1_000 });
    const h2 = await dr.startScheduler({ namespaces: ['app.b'], intervalMs: 1_000 });
    assert.equal(dr.listSchedulers().length, 2);
    await kernel.shutdown();
    assert.equal(h1.running, false);
    assert.equal(h2.running, false);
    // Mark kernel as already shut down so afterEach doesn't double-shutdown.
    kernel = createTestKernel();
    await kernel.boot();
    await kernel.shutdown();
  });

  it('rejects invalid scheduler config', async () => {
    await assert.rejects(() => dr.startScheduler({ namespaces: [], intervalMs: 1_000 }), /at least one namespace/);
    await assert.rejects(() => dr.startScheduler({ namespaces: ['app.a'], intervalMs: 0 }), /intervalMs/);
  });
});
