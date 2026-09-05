// T-04 transaction/CAS integrity regression tests.
//
// These tests deliberately use real PostgreSQL transactions. They prove that
// CAS bound to an IStorageTransaction never owns the outer transaction's
// lifecycle, while standalone CAS retains its own safe transaction behavior.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PostgresDriver } from '../src/index.js';
import { runWithTenant } from '../src/index.js';
import { dropTestDb, makeDriver, newTestDb, pgAvailable, stopServer } from './pg-test-harness.js';

type Row = { id: string; n: number; value?: string };
type TenantRow = Row & { tenantId: string };

type Transaction = Awaited<ReturnType<PostgresDriver['beginTransaction']>>;

function logicalName(label: string): string {
  return `t04-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

async function rollbackQuietly(tx: Transaction): Promise<void> {
  try {
    await tx.rollback();
  } catch {
    // The test may already have settled the transaction; preserve the test's
    // original assertion/error rather than masking it during cleanup.
  }
}

describe('T-04 PostgreSQL transaction/CAS ownership', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.fail('DATABASE INTEGRATION NOT EXECUTED.');
    });
    return;
  }

  const db = await newTestDb();
  if (!db) {
    it('PostgreSQL test database could not be created', () => {
      assert.fail('PostgreSQL integration was reported available but no test database was created.');
    });
    return;
  }

  const driver = makeDriver(db.config);
  await driver.init();

  after(async () => {
    await driver.close().catch(() => undefined);
    await dropTestDb(db.database);
    await stopServer();
  });

  it('A/B: CAS inside an outer transaction rolls back with earlier and later writes', async () => {
    const name = logicalName('rollback');
    await driver.openCollection<Row>(name);
    const tx = await driver.beginTransaction();
    try {
      const col = await tx.collection<Row>(name);
      await col.put({ id: 'before', n: 0, value: 'before' });
      const result = await col.cas('before', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }));
      assert.equal(result.ok, true, 'CAS should win inside the outer transaction');
      await col.put({ id: 'after', n: 2, value: 'after' });
      await tx.rollback();
    } finally {
      await rollbackQuietly(tx);
    }

    const check = await driver.openCollection<Row>(name);
    assert.equal(await check.get('before'), undefined, 'CAS write must not commit independently');
    assert.equal(await check.get('after'), undefined, 'later outer-transaction write must roll back with CAS');
  });

  it('B/H: a later failure rolls back CAS and earlier writes without an accidental partial commit', async () => {
    const name = logicalName('failure');
    await driver.openCollection<Row>(name);
    const tx = await driver.beginTransaction();
    let threw = false;
    try {
      const col = await tx.collection<Row>(name);
      await col.put({ id: 'before', n: 0 });
      await col.cas('before', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }));
      throw new Error('injected outer failure');
    } catch (error) {
      threw = (error as Error).message === 'injected outer failure';
      await tx.rollback();
    } finally {
      await rollbackQuietly(tx);
    }
    assert.equal(threw, true, 'the injected outer failure must propagate');

    const check = await driver.openCollection<Row>(name);
    assert.equal(await check.get('before'), undefined, 'earlier write and CAS must roll back together');
  });

  it('C/I: successful outer commit persists CAS atomically and leaves the client usable before commit', async () => {
    const name = logicalName('commit');
    await driver.openCollection<Row>(name);
    const tx = await driver.beginTransaction();
    try {
      const col = await tx.collection<Row>(name);
      await col.put({ id: 'before', n: 0 });
      const result = await col.cas('before', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }));
      assert.equal(result.ok, true);
      // This operation must still be part of the same outer transaction.
      await col.put({ id: 'after', n: 2 });
      await tx.commit();
    } finally {
      await rollbackQuietly(tx);
    }

    const check = await driver.openCollection<Row>(name);
    assert.equal((await check.get('before'))?.n, 1, 'CAS result must persist after outer commit');
    assert.equal((await check.get('after'))?.n, 2, 'same outer client must remain usable until commit');
  });

  it('D: multiple CAS operations remain in one outer transaction', async () => {
    const name = logicalName('multiple');
    await driver.openCollection<Row>(name);
    const tx = await driver.beginTransaction();
    try {
      const col = await tx.collection<Row>(name);
      await col.put({ id: 'counter', n: 0 });
      const first = await col.cas('counter', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }));
      const second = await col.cas('counter', (current) => current?.n === 1, (current) => ({ ...current!, n: 2 }));
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal((await col.get('counter'))?.n, 2, 'both CAS operations must see the same outer transaction state');
      await tx.rollback();
    } finally {
      await rollbackQuietly(tx);
    }

    const check = await driver.openCollection<Row>(name);
    assert.equal(await check.get('counter'), undefined, 'rollback must remove both CAS writes');
  });

  it('E: tenant-bound CAS has the same outer transaction ownership semantics', async () => {
    const name = logicalName('tenant');
    let rejected = false;
    try {
      await runWithTenant(driver.pool, 'acme', async (scope) => {
        const col = await scope.getCollection<TenantRow>(name);
        await col.put({ id: 'tenant-row', tenantId: 'acme', n: 0 });
        const result = await col.cas('tenant-row', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }));
        assert.equal(result.ok, true);
        await col.put({ id: 'tenant-after', tenantId: 'acme', n: 2 });
        throw new Error('injected tenant outer failure');
      });
    } catch (error) {
      rejected = (error as Error).message === 'injected tenant outer failure';
    }
    assert.equal(rejected, true, 'tenant-bound outer failure must propagate');

    await runWithTenant(driver.pool, 'acme', async (scope) => {
      const col = await scope.getCollection<TenantRow>(name);
      assert.equal(await col.get('tenant-row'), undefined, 'tenant CAS must roll back with the outer transaction');
      assert.equal(await col.get('tenant-after'), undefined, 'tenant later write must also roll back');
    });
    await runWithTenant(driver.pool, 'globex', async (scope) => {
      const col = await scope.getCollection<TenantRow>(name);
      assert.equal(await col.get('tenant-row'), undefined, 'other tenant must not observe rolled-back data');
      assert.equal(await col.get('tenant-after'), undefined, 'other tenant must remain isolated');
    });
  });

  it('F: standalone CAS outside an outer transaction still commits safely', async () => {
    const name = logicalName('standalone');
    const col = await driver.openCollection<Row>(name);
    await col.put({ id: 'standalone', n: 0 });
    const result = await col.cas('standalone', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }));
    assert.equal(result.ok, true);
    assert.equal((await col.get('standalone'))?.n, 1);
  });

  it('G: independent PostgreSQL workers still have exactly one CAS winner', async () => {
    const name = logicalName('concurrency');
    const workerA = makeDriver(db.config);
    const workerB = makeDriver(db.config);
    await workerA.init();
    await workerB.init();
    try {
      const colA = await workerA.openCollection<Row>(name);
      const colB = await workerB.openCollection<Row>(name);
      await colA.put({ id: 'race', n: 0 });
      const attempts = [
        ...Array.from({ length: 8 }, () => colA.cas('race', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }))),
        ...Array.from({ length: 8 }, () => colB.cas('race', (current) => current?.n === 0, (current) => ({ ...current!, n: 1 }))),
      ];
      const results = await Promise.all(attempts);
      assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one independent worker must win CAS');
      assert.equal((await colA.get('race'))?.n, 1);
    } finally {
      await workerA.close();
      await workerB.close();
    }
  });

  it('H: a failed nested CAS operation leaves outer rollback/commit control with the caller', async () => {
    const name = logicalName('nested-failure');
    await driver.openCollection<Row>(name);
    const tx = await driver.beginTransaction();
    try {
      const col = await tx.collection<Row>(name);
      await col.put({ id: 'before', n: 0 });
      await assert.rejects(
        () => col.cas('before', () => true, () => { throw new Error('nested CAS failure'); }),
        /nested CAS failure/,
      );
      await col.put({ id: 'after', n: 1 });
      await tx.rollback();
    } finally {
      await rollbackQuietly(tx);
    }

    const check = await driver.openCollection<Row>(name);
    assert.equal(await check.get('before'), undefined, 'outer rollback must include writes before failed CAS');
    assert.equal(await check.get('after'), undefined, 'outer rollback must include writes after failed CAS');
  });
});
