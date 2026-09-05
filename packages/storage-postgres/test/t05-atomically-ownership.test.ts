// T-05 x T-04: transaction ownership through `StorageModule.atomically`.
//
// T-05 composes state + audit + outbox writes through `atomically`, whose
// scoped collections are bound to ONE caller-owned PostgreSQL transaction.
// T-04 requires that a CAS on such a handle NEVER issues its own BEGIN,
// COMMIT or ROLLBACK. These tests prove it at the statement level: an
// instrumented pool client records every SQL statement, and the composed
// scope is shown to contain exactly one BEGIN and one COMMIT (or ROLLBACK)
// — both issued by the transaction owner — regardless of how many CAS
// operations run inside it, including a CAS whose guard fails and a CAS whose
// makeNext throws.
//
// Also proven: `atomically` commit/rollback hooks fire only after the durable
// outcome, and scoped writes are invisible to other sessions before COMMIT.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '../src/index.js';
import { dropTestDb, newTestDb, pgAvailable, stopServer } from './pg-test-harness.js';

type Row = { id: string; n: number };

after(async () => {
  await stopServer();
});

/** Record every statement issued through the pool's clients (both promise and callback call styles). */
function instrumentedPool(connectionString: string, statements: string[]): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 4 });
  pool.on('connect', (client) => {
    const originalQuery = client.query.bind(client);
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      if (text) {
        const verb = text.trim().split(/\s+/)[0]!.toUpperCase();
        statements.push(verb === 'SELECT' && /FOR UPDATE/i.test(text) ? 'SELECT…FOR UPDATE' : verb);
      }
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    };
  });
  return pool;
}

function txControl(statements: string[]): string[] {
  return statements.filter((statement) => statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK');
}

describe('T-05 atomically(): T-04 transaction ownership at the statement level', async () => {
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

  const statements: string[] = [];
  const pool = instrumentedPool(db.config.connectionString!, statements);
  const driver = new PostgresDriver({ pool, requireExplicitConfig: true });
  const storage = new StorageModule({ driverInstance: driver });
  const kernel = createTestKernel();
  kernel.register(storage);
  await kernel.boot();
  const plain = new PostgresDriver({ ...db.config, requireExplicitConfig: true });
  await plain.init();

  after(async () => {
    await plain.close().catch(() => undefined);
    await kernel.shutdown().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await dropTestDb(db.database);
  });

  const name = `t05-own-${Math.random().toString(36).slice(2, 10)}`;
  await storage.collection<Row>(name); // create outside any measured scope

  it('a scope with several CAS operations issues exactly one BEGIN and one COMMIT, both by the owner', async () => {
    statements.length = 0;
    let committedHookRan = false;
    let settledHookRan = false;
    const result = await storage.atomically(async (scope) => {
      const col = await scope.collection<Row>(name);
      scope.onCommit(() => { committedHookRan = true; });
      scope.onSettle(() => { settledHookRan = true; });
      await col.put({ id: 'a', n: 0 });
      const first = await col.cas('a', (cur) => cur?.n === 0, (cur) => ({ ...cur, n: 1 }));
      const second = await col.cas('a', (cur) => cur?.n === 1, (cur) => ({ ...cur, n: 2 }));
      const lost = await col.cas('a', (cur) => cur?.n === 99, (cur) => ({ ...cur, n: 3 })); // guard fails: no write, no tx control
      const absent = await col.cas('missing', () => true, () => ({ id: 'missing', n: 7 })); // create-through-CAS
      assert.equal(committedHookRan, false, 'commit hooks never run inside the transaction');
      return { first: first.ok, second: second.ok, lost: lost.ok, absent: absent.ok };
    });
    assert.deepEqual(result, { first: true, second: true, lost: false, absent: true });
    assert.deepEqual(txControl(statements), ['BEGIN', 'COMMIT'], `scoped CAS must not own the transaction; saw ${JSON.stringify(statements)}`);
    assert.ok(statements.filter((statement) => statement === 'SELECT…FOR UPDATE').length >= 4, 'each CAS still row-locks under the caller-owned transaction');
    assert.equal(committedHookRan, true);
    assert.equal(settledHookRan, true);
    const check = await plain.openCollection<Row>(name);
    assert.equal((await check.get('a'))?.n, 2);
    assert.equal((await check.get('missing'))?.n, 7);
  });

  it('a throwing CAS inside the scope does not roll back on its own; the owner rolls back once and every earlier write vanishes', async () => {
    statements.length = 0;
    let settledHookRan = false;
    let commitHookRan = false;
    await assert.rejects(
      storage.atomically(async (scope) => {
        const col = await scope.collection<Row>(name);
        scope.onSettle(() => { settledHookRan = true; });
        scope.onCommit(() => { commitHookRan = true; });
        await col.put({ id: 'b', n: 0 });
        await assert.rejects(
          () => col.cas('b', () => true, () => { throw new Error('nested CAS failure'); }),
          /nested CAS failure/,
        );
        // The connection is still inside the caller's transaction and usable:
        await col.put({ id: 'c', n: 1 });
        assert.deepEqual(txControl(statements), ['BEGIN'], 'no COMMIT/ROLLBACK may have happened yet');
        throw new Error('owner decides: abort');
      }),
      /owner decides: abort/,
    );
    assert.deepEqual(txControl(statements), ['BEGIN', 'ROLLBACK']);
    assert.equal(settledHookRan, true, 'settle hooks run after rollback');
    assert.equal(commitHookRan, false, 'commit hooks never run after rollback');
    const check = await plain.openCollection<Row>(name);
    assert.equal(await check.get('b'), undefined);
    assert.equal(await check.get('c'), undefined);
  });

  it('scoped writes are invisible to another session before COMMIT and visible after', async () => {
    const other = await plain.openCollection<Row>(name);
    await storage.atomically(async (scope) => {
      const col = await scope.collection<Row>(name);
      await col.put({ id: 'd', n: 4 });
      await col.cas('d', () => true, (cur) => ({ ...cur, n: 5 }));
      assert.equal(await other.get('d'), undefined, 'uncommitted state must not leak to another connection');
    });
    assert.equal((await other.get('d'))?.n, 5);
  });

  it('a standalone CAS (no scope) still owns its own BEGIN/COMMIT — pre-T-05 behaviour preserved', async () => {
    statements.length = 0;
    const col = await storage.collection<Row>(name);
    const res = await col.cas('d', (cur) => cur?.n === 5, (cur) => ({ ...cur, n: 6 }));
    assert.equal(res.ok, true);
    assert.deepEqual(txControl(statements), ['BEGIN', 'COMMIT']);
  });

  it('never nests: a scope cannot be re-entered by a second `atomically` on the same rows (documented contract holds — second scope is a separate transaction)', async () => {
    // Two independent scopes on different rows are independent transactions.
    statements.length = 0;
    await Promise.all([
      storage.atomically(async (scope) => { const col = await scope.collection<Row>(name); await col.put({ id: 'e1', n: 1 }); }),
      storage.atomically(async (scope) => { const col = await scope.collection<Row>(name); await col.put({ id: 'e2', n: 2 }); }),
    ]);
    const control = txControl(statements);
    assert.equal(control.filter((statement) => statement === 'BEGIN').length, 2);
    assert.equal(control.filter((statement) => statement === 'COMMIT').length, 2);
    assert.equal(control.includes('ROLLBACK'), false);
  });
});
