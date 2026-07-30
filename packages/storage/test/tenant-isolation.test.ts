// Multi-tenant storage isolation tests (PR4 — Security Hardening).
// Proves that data written through one TenantScope is invisible to every other
// tenant, across all storage drivers.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  StorageModule,
  MemoryDriver,
  FsDriver,
  tenantPartitionName,
  isTenantPartition,
} from '../src/index.js';

describe('tenant partition naming', () => {
  it('produces a namespaced physical name per tenant', () => {
    assert.equal(tenantPartitionName('org-a', 'tasks'), 'tenant:org-a:tasks');
    assert.equal(tenantPartitionName('org-b', 'tasks'), 'tenant:org-b:tasks');
    assert.notEqual(tenantPartitionName('org-a', 'tasks'), tenantPartitionName('org-b', 'tasks'));
  });

  it('rejects invalid tenant ids', () => {
    assert.throws(() => tenantPartitionName('', 'tasks'), /tenantId is required/);
    assert.throws(() => tenantPartitionName('a/b', 'tasks'), /invalid tenantId/);
    assert.throws(() => tenantPartitionName('a:b', 'tasks'), /invalid tenantId/);
    assert.throws(() => tenantPartitionName('tenant', 'tasks'), /invalid tenantId/);
  });

  it('detects tenant partitions', () => {
    assert.equal(isTenantPartition('tenant:org-a:tasks'), true);
    assert.equal(isTenantPartition('security.users'), false);
    assert.equal(isTenantPartition('orgs.organizations'), false);
  });
});

describe('TenantScope isolation (memory driver)', () => {
  it('isolates collections between tenants', async () => {
    const driver = new MemoryDriver();
    const modLike = {
      collection: <T extends { id: string }>(n: string) => driver.openCollection<T>(n),
      namespace: (n: string) => driver.openNamespace(n),
      blobStore: (n: string) => driver.openBlobStore(n),
    };
    // Simulate the StorageModule.tenant() partitioning via the public helper.
    const aCol = await modLike.collection<{ id: string; v: number }>(tenantPartitionName('org-a', 'docs'));
    const bCol = await modLike.collection<{ id: string; v: number }>(tenantPartitionName('org-b', 'docs'));
    await aCol.put({ id: '1', v: 100 });
    await bCol.put({ id: '1', v: 200 });
    assert.equal((await aCol.get('1'))!.v, 100);
    assert.equal((await bCol.get('1'))!.v, 200);
    assert.equal(await aCol.count(), 1);
    assert.equal(await bCol.count(), 1);
    await driver.close();
  });

  it('isolates namespaces between tenants', async () => {
    const driver = new MemoryDriver();
    const nsA = await driver.openNamespace(tenantPartitionName('org-a', 'kv'));
    const nsB = await driver.openNamespace(tenantPartitionName('org-b', 'kv'));
    await nsA.set('secret', 'alice-secret');
    await nsB.set('secret', 'bob-secret');
    assert.equal(await nsA.get('secret'), 'alice-secret');
    assert.equal(await nsB.get('secret'), 'bob-secret');
    // Deleting in one tenant must not affect the other.
    await nsA.delete('secret');
    assert.equal(await nsA.get('secret'), undefined);
    assert.equal(await nsB.get('secret'), 'bob-secret');
    await driver.close();
  });
});

describe('TenantScope isolation (filesystem driver, persists across restarts)', () => {
  let tmpDir: string;
  let driver: FsDriver;

  after(async () => {
    await driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps tenant data isolated across a simulated restart', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-tenant-'));
    driver = new FsDriver({ root: tmpDir });
    const nsA = await driver.openNamespace(tenantPartitionName('acme', 'data'));
    const nsB = await driver.openNamespace(tenantPartitionName('globex', 'data'));
    await nsA.set('k', 'acme-value');
    await nsB.set('k', 'globex-value');
    await driver.close();

    // Re-open the same directory to simulate a restart.
    driver = new FsDriver({ root: tmpDir });
    const nsA2 = await driver.openNamespace(tenantPartitionName('acme', 'data'));
    const nsB2 = await driver.openNamespace(tenantPartitionName('globex', 'data'));
    assert.equal(await nsA2.get('k'), 'acme-value');
    assert.equal(await nsB2.get('k'), 'globex-value');
  });
});

describe('StorageModule.tenant() integration', () => {
  let kernel: Kernel;

  it('returns isolated scopes through the module API', async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    await kernel.boot();
    const storage = kernel.getModule<StorageModule>('storage');
    const acme = storage.tenant('acme');
    const globex = storage.tenant('globex');
    const acmeNs = await acme.namespace('secrets');
    const globexNs = await globex.namespace('secrets');
    await acmeNs.set('api-key', 'acme-key');
    await globexNs.set('api-key', 'globex-key');
    assert.equal(await acmeNs.get('api-key'), 'acme-key');
    assert.equal(await globexNs.get('api-key'), 'globex-key');
    // The global namespace with the same name is a different store entirely.
    const globalNs = await storage.namespace('secrets');
    await globalNs.set('api-key', 'global-key');
    assert.equal(await globalNs.get('api-key'), 'global-key');
    assert.equal(await acmeNs.get('api-key'), 'acme-key');
    // Tenant isolation metadata is queryable.
    assert.equal(storage.isTenantPartition('tenant:acme:secrets'), true);
    assert.equal(storage.isTenantPartition('secrets'), false);
    await kernel.shutdown();
  });

  it('validates tenant ids eagerly', () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    return kernel.boot().then(async () => {
      const storage = kernel.getModule<StorageModule>('storage');
      assert.throws(() => storage.tenant('bad/id'), /invalid tenantId/);
      await kernel.shutdown();
    });
  });
});
