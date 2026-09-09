// T-06 production-path PostgreSQL RLS proof (Workstream A).
//
// These tests prove the PRODUCTION wiring end to end — not just the
// `runWithTenant` helper: `StorageModule.atomically(fn, { tenantId })`
// (used by the billing/payments/revenue-ledger/commercial-memory durable
// effects) must open a real PostgreSQL transaction under the tenant's RLS
// context. What is verified against real PostgreSQL:
//
//   1. atomically({ tenantId }) establishes the per-transaction tenant
//      context (statement-level: set_config('app.tenant_id', tenant, true)
//      runs inside the composed transaction).
//   2. Tenant-bound transactions are enforced by PostgreSQL RLS.
//   3. Tenant A cannot read Tenant B data through the production path.
//   4. Tenant A cannot mutate/delete Tenant B data through the production
//      path (driver assertions AND RLS).
//   5. Non-superuser database access is actually subject to RLS (policy is
//      enforced for a real application role without BYPASSRLS).
//   6. FORCE ROW LEVEL SECURITY remains effective on every collection.
//   7. Driver/session restart starts pooled sessions BLIND (no ambient
//      scope, INV-15/GAP-07) and tenant contexts still establish correctly.
//   8. The explicit system scope ('*') remains supported ONLY as an
//      explicit per-transaction SET LOCAL grant; unscoped composed writes
//      span tenants exactly like pre-RLS, with no session-level residue.
//   9. Invalid tenant ids fail closed before any write.
//  10. No T-01/T-04 transaction-ownership guarantees regress (single
//      BEGIN/COMMIT per composed scope; CAS participates in the caller's
//      transaction; rollback hides both the entry and its sequence counter
//      allocation).
//
// PostgreSQL is a HARD requirement: when it cannot start these tests FAIL
// loudly ("DATABASE INTEGRATION NOT EXECUTED") rather than skipping.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver, deriveTableName, TENANT_ID_COLUMN } from '../src/index.js';
import { TenantIsolationDriverError } from '../src/index.js';
import { dropTestDb, makeDriver, newTestDb, pgAvailable, stopServer } from './pg-test-harness.js';

after(async () => {
  await stopServer();
});

type TenantDoc = { id: string; tenantId?: string; payload: string };

/** Capture every SQL statement (text + parameter values + issuing pooled
 *  client id) through the pool. `cid` lets ownership assertions attribute
 *  statements to the composed transaction's own client — required since
 *  INV-15/GAP-07, because schema-isolation grants now run as separate,
 *  explicit system-scope transactions on OTHER pooled clients (they are
 *  separately enumerated in the driver audit; they must never appear
 *  inside the caller's transaction). */
function instrumentedPool(connectionString: string, statements: Array<{ text: string; values?: unknown[]; cid: number }>): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 4 });
  let clientSeq = 0;
  pool.on('connect', (client) => {
    const cid = ++clientSeq;
    (client as unknown as { __cid: number }).__cid = cid;
    const originalQuery = client.query.bind(client);
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      const values = (Array.isArray(args[1]) ? args[1] : undefined) as unknown[] | undefined;
      if (text) statements.push({ text, values, cid: (client as unknown as { __cid: number }).__cid });
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    };
  });
  return pool;
}

async function bootStorage(driver: PostgresDriver): Promise<{ storage: StorageModule; shutdown: () => Promise<void> }> {
  const storage = new StorageModule({ driverInstance: driver });
  const kernel = createTestKernel();
  kernel.register(storage);
  await kernel.boot();
  return { storage, shutdown: () => kernel.shutdown() };
}

describe('T-06 production-path RLS (real PostgreSQL)', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('PostgreSQL integration unavailable', () => {
      assert.fail('DATABASE INTEGRATION NOT EXECUTED — real PostgreSQL required for the T-06 RLS proof.');
    });
    return;
  }

  it('atomically({tenantId}) sets the tenant context inside the transaction (statement-level)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const statements: Array<{ text: string; values?: unknown[]; cid: number }> = [];
    const driver = new PostgresDriver({ pool: instrumentedPool(db.config.connectionString!, statements), requireExplicitConfig: true });
    const { storage, shutdown } = await bootStorage(driver);
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-ctx-col');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'secret' });
      }, { tenantId: 'acme' });

      const contextSets = statements.filter((s) => s.text.includes("set_config('app.tenant_id'"));
      assert.ok(contextSets.length >= 1, `expected set_config(app.tenant_id,...) inside the scope; got ${JSON.stringify(statements.map((s) => s.text))}`);
      const withValue = contextSets.find((s) => JSON.stringify(s.values ?? []) === JSON.stringify(['acme']));
      assert.ok(withValue, 'tenant context must be set to the requested tenant id (acme) inside the transaction');
      // The context statement must run between BEGIN and COMMIT (transaction-scoped SET LOCAL).
      const verbs = statements.map((s) => s.text.trim().split(/\s+/)[0]!.toUpperCase());
      const beginAt = verbs.indexOf('BEGIN');
      const commitAt = verbs.indexOf('COMMIT');
      const ctxAt = statements.findIndex((s) => s.text.includes("set_config('app.tenant_id'"));
      assert.ok(beginAt >= 0 && commitAt > beginAt && ctxAt > beginAt && ctxAt < commitAt,
        'tenant context must be established inside the transaction (SET LOCAL semantics)');

      // Context is transaction-local and does NOT leak between transactions on
      // the SAME driver: after COMMIT the pooled session reverts to NO scope at
      // all — INV-15/GAP-07 removed the ambient connect-time '*'. Neither the
      // tenant value NOR a system default may be observable on a fresh
      // checkout: any non-empty GUC is now a fail-closed posture violation.
      const probe = await driver.pool.connect();
      try {
        const g = await probe.query("SELECT current_setting('app.tenant_id', true) AS v");
        const leaked = g.rows[0]?.v;
        assert.ok(
          leaked === null || leaked === undefined || leaked === '',
          `tenant context must not leak past COMMIT and no ambient scope may exist (INV-15); observed ${JSON.stringify(leaked)}`,
        );
      } finally {
        probe.release();
      }
      assert.equal(await driver.hasAmbientConnectScope(), false,
        'INV-15: the driver pool must not hand out sessions with ambient scope');
      // Sequential tenant scopes on the same driver stay isolated: a globex
      // scope opened AFTER the committed acme scope cannot see acme's row.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-ctx-col');
        assert.equal(await coll.get('a1'), undefined, 'globex scope (next transaction) must not see acme row');
        assert.equal(await coll.count(), 0);
      }, { tenantId: 'globex' });
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('tenant A cannot read tenant B data through the production path', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-rw');
        await coll.put({ id: 'doc-a1', tenantId: 'acme', payload: 'acme-secret' });
        await coll.put({ id: 'doc-a2', tenantId: 'acme', payload: 'acme-second' });
      }, { tenantId: 'acme' });
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-rw');
        await coll.put({ id: 'doc-b1', tenantId: 'globex', payload: 'globex-secret' });
      }, { tenantId: 'globex' });

      // Production-path reads under each tenant.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-rw');
        assert.equal(await coll.get('doc-a1'), undefined, 'tenant B must not see tenant A doc via get()');
        assert.equal((await coll.get('doc-b1'))?.tenantId, 'globex', 'tenant B sees its own doc');
        const all = await coll.all();
        assert.equal(all.length, 1, 'tenant B all() must return only its own row');
        assert.equal(await coll.has('doc-a1'), false, 'tenant B has() must be false for tenant A doc');
        assert.equal(await coll.count(), 1, 'tenant B count() must exclude tenant A rows');
      }, { tenantId: 'globex' });

      // Cross-tenant retrieval inside tenant B scope must be empty even by id.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-rw');
        assert.equal(await coll.get('doc-a1'), undefined);
      }, { tenantId: 'globex' });
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('tenant A cannot mutate or delete tenant B data (driver + RLS fail closed)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-mut');
        await coll.put({ id: 'shared-id', tenantId: 'acme', payload: 'acme-row' });
      }, { tenantId: 'acme' });

      // delete from the wrong tenant must not remove the row.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-mut');
        assert.equal(await coll.delete('shared-id'), false, 'delete of another tenant row must report false');
      }, { tenantId: 'globex' });

      // Writing the same global id under a different tenant must be refused.
      await assert.rejects(
        storage.atomically(async (scope) => {
          const coll = await scope.collection<TenantDoc>('t06-mut');
          await coll.put({ id: 'shared-id', tenantId: 'globex', payload: 'takeover' });
        }, { tenantId: 'globex' }),
        TenantIsolationDriverError,
        'cross-tenant id takeover must be refused by the driver',
      );

      // A body with a tenant field mismatching the bound tenant must be refused.
      await assert.rejects(
        storage.atomically(async (scope) => {
          const coll = await scope.collection<TenantDoc>('t06-mut');
          await coll.put({ id: 'new-id', tenantId: 'globex', payload: 'x' });
        }, { tenantId: 'acme' }),
        TenantIsolationDriverError,
        'body tenantId must match the active tenant',
      );

      // The acme row is intact and still owned by acme.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-mut');
        assert.equal((await coll.get('shared-id'))?.tenantId, 'acme');
      }, { tenantId: 'acme' });
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('non-superuser access is subject to RLS and FORCE RLS stays effective', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    const appRole = `jataqi_app_${process.pid}`;
    const appPw = 'app_pw';
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-app-role');
        await coll.put({ id: 'r1', tenantId: 'acme', payload: 'acme-row' });
      }, { tenantId: 'acme' });
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-app-role');
        await coll.put({ id: 'r2', tenantId: 'globex', payload: 'globex-row' });
      }, { tenantId: 'globex' });

      const admin = await driver.pool.connect();
      try {
        await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
        await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        await admin.query(`GRANT CONNECT ON DATABASE ${db.database} TO ${appRole}`);
        await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${appRole}`);
        await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${appRole}`);
        await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${appRole}`);
        const bypass = await admin.query('SELECT rolbypassrls FROM pg_roles WHERE rolname = $1', [appRole]);
        assert.equal(bypass.rows[0]?.rolbypassrls, false, 'app role must not bypass RLS');
        // FORCE RLS is on (table owner is also subject to the policy).
        const tableName = deriveTableName('collection', 't06-app-role');
        const rls = await admin.query(
          'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
          [tableName],
        );
        assert.equal(rls.rows[0]?.relrowsecurity, true);
        assert.equal(rls.rows[0]?.relforcerowsecurity, true, 'FORCE ROW LEVEL SECURITY must remain effective');
        // Execution-level FORCE proof: make the app role the table OWNER. On a
        // non-forced RLS table the owner bypasses RLS entirely; with FORCE RLS
        // the owner stays subject to the policies (verified via appConn below).
        await admin.query(`ALTER TABLE "${tableName}" OWNER TO ${appRole}`);
      } finally {
        admin.release();
      }

      const connUrl = new URL(db.config.connectionString!);
      const appConn = new pg.Client({
        host: connUrl.hostname,
        port: Number(connUrl.port),
        user: appRole,
        password: appPw,
        database: connUrl.pathname.replace(/^\//, ''),
      });
      await appConn.connect();
      try {
        const tableName = deriveTableName('collection', 't06-app-role');
        // No tenant context: nothing visible.
        const none = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.equal(none.rows.length, 0, 'no GUC -> no rows (fail closed)');
        // Wrong tenant context: with acme set, only the acme row is visible.
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['acme']);
        const acme = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.equal(acme.rows.length, 1);
        assert.equal(acme.rows[0]!.id, 'r1');
        // Switch to globex: only its row.
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['globex']);
        const globex = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.equal(globex.rows.length, 1);
        assert.equal(globex.rows[0]!.id, 'r2');
        // Owner cannot modify another tenant's row: FORCE RLS subjects the
        // table owner to the UPDATE policy (an owner without FORCE would see
        // and mutate every row).
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['acme']);
        const upd = await appConn.query(`UPDATE "${tableName}" SET body = $1::jsonb WHERE id = 'r2'`, [JSON.stringify({ id: 'r2', tenantId: 'globex', payload: 'pwned' })]);
        assert.equal(upd.rowCount, 0, 'table-owner role must not update another tenant row (FORCE RLS effective at execution level)');
        // The attempted takeover left tenant B's row byte-intact.
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['globex']);
        const intact = await appConn.query(`SELECT body FROM "${tableName}" WHERE id = 'r2'`);
        assert.equal(intact.rows.length, 1, 'owner still reads its own tenant row under the GUC');
        assert.equal((intact.rows[0]!.body as { payload?: string })?.payload, 'globex-row', 'globex row payload unchanged after owner update attempt');
        // Cross-tenant write under a tenant context is refused by RLS.
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['acme']);
        await assert.rejects(
          appConn.query(`INSERT INTO "${tableName}" (id, body, ${TENANT_ID_COLUMN}) VALUES ('x1', $1::jsonb, 'globex')`, [JSON.stringify({ id: 'x1', tenantId: 'globex' })]),
          /row-level security|new row violates/i,
          'RLS WITH CHECK must refuse a cross-tenant insert by a non-superuser',
        );
      } finally {
        await appConn.end();
        const cleanup = await driver.pool.connect();
        try {
          await cleanup.query(`DROP OWNED BY ${appRole} CASCADE`);
          await cleanup.query(`DROP ROLE IF EXISTS ${appRole}`);
        } finally {
          cleanup.release();
        }
      }
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('driver/session restart: system-safe default and tenant contexts survive a fresh driver', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driverA = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driverA);
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-restart');
        await coll.put({ id: 'r1', tenantId: 'acme', payload: 'acme' });
      }, { tenantId: 'acme' });
    } finally {
      await shutdown().catch(() => undefined);
      await driverA.close().catch(() => undefined); // all pooled sessions closed
    }

    // "Restart": a brand-new driver (new connection pool) against the same DB.
    const driverB = makeDriver(db.config);
    try {
      await driverB.init();
      // Unscoped system path still works (system-safe default on fresh sessions).
      const unscoped = await driverB.openCollection<TenantDoc>('t06-restart');
      assert.equal((await unscoped.get('r1'))?.payload, 'acme', 'fresh sessions keep the system-safe default scope');
      // Tenant contexts are still enforced on the fresh pool.
      const txB = await driverB.beginTransaction({ tenantId: 'globex' });
      try {
        const coll = await txB.collection<TenantDoc>('t06-restart');
        assert.equal(await coll.get('r1'), undefined, 'globex must not see acme row after restart');
        assert.equal(await coll.count(), 0);
      } finally {
        await txB.rollback();
      }
      const txA = await driverB.beginTransaction({ tenantId: 'acme' });
      try {
        const coll = await txA.collection<TenantDoc>('t06-restart');
        assert.equal((await coll.get('r1'))?.tenantId, 'acme', 'acme still sees its row after restart');
      } finally {
        await txA.rollback();
      }
      // RLS is still in force after the restart (DDL persisted in the database).
      const c = await driverB.pool.connect();
      try {
        const tableName = deriveTableName('collection', 't06-restart');
        const rls = await c.query('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [tableName]);
        assert.equal(rls.rows[0]?.relrowsecurity, true);
        assert.equal(rls.rows[0]?.relforcerowsecurity, true);
      } finally {
        c.release();
      }
    } finally {
      await driverB.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('system scope ("*") remains explicit for unscoped composed writes', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-sys');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'acme' });
      }, { tenantId: 'acme' });
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-sys');
        await coll.put({ id: 'b1', tenantId: 'globex', payload: 'globex' });
      }, { tenantId: 'globex' });

      // Unscoped composed write (no tenantId) = system scope: spans tenants.
      let seen: string[] = [];
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-sys');
        seen = (await coll.all()).map((d) => d.id).sort();
      });
      assert.deepEqual(seen, ['a1', 'b1'], 'system scope sees all tenants (server-side plumbing)');
      assert.equal(await (await storage.collection<TenantDoc>('t06-sys')).count(), 2);

      // Explicit system scope spans tenants — and only in the INV-15 form:
      // transaction-local SET LOCAL with no session-level residue. The
      // pre-INV-15 pattern (session-level set_config(..., false) on a pooled
      // client) is itself forbidden: it leaks broad authority across checkouts.
      const tableName = deriveTableName('collection', 't06-sys');
      const c = await driver.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', '*', true)`);
        const res = await c.query(`SELECT count(*)::int AS n FROM "${tableName}"`);
        assert.equal(res.rows[0]?.n, 2, 'explicit "*" scope reads every tenant row');
        await c.query('COMMIT');
        const after = await c.query("SELECT current_setting('app.tenant_id', true) AS v");
        const residue = after.rows[0]?.v;
        assert.ok(
          residue === null || residue === undefined || residue === '',
          `SET LOCAL scope must not survive COMMIT on the pooled client; observed ${JSON.stringify(residue)}`,
        );
      } finally {
        c.release();
      }
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('invalid tenant ids fail closed before any write', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage } = await bootStorage(driver);
    try {
      for (const bad of ['bad id!', "a'b", '', 'a;DROP TABLE x', 'tenant/with/slashes']) {
        await assert.rejects(
          storage.atomically(async (scope) => {
            const coll = await scope.collection<TenantDoc>('t06-invalid');
            await coll.put({ id: 'x1', tenantId: bad, payload: 'x' });
          }, { tenantId: bad }),
          /tenant/i,
          `invalid tenant id "${bad}" must fail closed`,
        );
        await assert.rejects(
          driver.beginTransaction({ tenantId: bad }),
          /tenant/i,
          `beginTransaction with invalid tenant id "${bad}" must fail closed`,
        );
      }
      // Nothing was written by any rejected attempt.
      const coll = await driver.openCollection<TenantDoc>('t06-invalid');
      assert.equal(await coll.count(), 0, 'no partial writes from rejected tenant ids');
    } finally {
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('T-01/T-04 ownership: one transaction per composed scope; rollback hides entry AND sequence allocation', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const statements: Array<{ text: string; values?: unknown[]; cid: number }> = [];
    const driver = new PostgresDriver({ pool: instrumentedPool(db.config.connectionString!, statements), requireExplicitConfig: true });
    const { storage, shutdown } = await bootStorage(driver);
    try {
      const SEQ_COLLECTION = 't06-seqs';

      // Happy path: counter CAS + entry write commit together (one BEGIN/COMMIT pair).
      await storage.atomically(async (scope) => {
        const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>(SEQ_COLLECTION);
        const entries = await scope.collection<TenantDoc & { sequence?: number }>('t06-ledger');
        // CAS advance (mirrors revenue-ledger nextSequence usage).
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const cur = await seq.get('seq:acme');
          const observed = cur ?? { id: 'seq:acme', tenantId: 'acme', sequence: 0 };
          const next = { id: 'seq:acme', tenantId: 'acme', sequence: observed.sequence + 1 };
          const res = await seq.cas('seq:acme', (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
          if (res.ok) {
            await entries.put({ id: 'ledger-1', tenantId: 'acme', payload: 'e1', sequence: next.sequence });
            return;
          }
        }
        assert.fail('counter CAS did not converge');
      }, { tenantId: 'acme' });

      // Ownership is asserted ON THE COMPOSED TRANSACTION'S OWN CLIENT:
      // exactly one BEGIN/COMMIT pair and no ROLLBACK. (INV-15/GAP-07: the
      // first-open isolation grants are separate explicit system-scope
      // transactions on other pooled clients — enumerated and cross-checked
      // below against the driver audit, never embedded in the caller's tx.)
      const txBegin = statements.find((s) => s.text.trim() === 'BEGIN');
      assert.ok(txBegin, 'composed scope must open a transaction');
      const txCid = txBegin!.cid;
      const txStatements = statements.filter((s) => s.cid === txCid
        && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s.text.trim().split(/\s+/)[0]!.toUpperCase()));
      assert.equal(txStatements.filter((s) => s.text === 'BEGIN').length, 1, 'one BEGIN for the composed scope');
      assert.equal(txStatements.filter((s) => s.text === 'COMMIT').length, 1, 'one COMMIT for the composed scope');
      assert.equal(txStatements.filter((s) => s.text === 'ROLLBACK').length, 0, 'no inner rollback');
      // The composed transaction never acquires system scope: exactly one
      // explicit scope grant, parameterized to the tenant's own id.
      const txScoped = statements.filter((s) => s.cid === txCid && s.text.includes("set_config('app.tenant_id'"));
      assert.equal(txScoped.length, 1, 'the composed transaction sets exactly one explicit scope');
      assert.notEqual((txScoped[0] as { values?: unknown[] }).values?.[0], '*',
        'a tenant-scoped composed write must not run in system scope');
      // INV-15 enumeration cross-check: every BEGIN on a NON-tx pooled client
      // is an explicit, counted schema-isolation grant — the statement ledger
      // and the driver's boot-audit ledger must agree exactly.
      const grants = statements.filter((s) => s.text.trim() === 'BEGIN' && s.cid !== txCid);
      const auditGrants = driver.getSystemScopeAudit().uses['schema:isolation'] ?? 0;
      assert.equal(grants.length, auditGrants,
        `explicit system-scope transactions observed (${grants.length}) must equal the enumerated audit count (${auditGrants})`);
      assert.ok(auditGrants > 0, 'first-open isolation path must be enumerated');

      // Failure path: a throw after the counter CAS + entry put rolls back BOTH.
      await assert.rejects(
        storage.atomically(async (scope) => {
          const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>(SEQ_COLLECTION);
          const entries = await scope.collection<TenantDoc & { sequence?: number }>('t06-ledger');
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const cur = await seq.get('seq:acme');
            const observed = cur ?? { id: 'seq:acme', tenantId: 'acme', sequence: 0 };
            const next = { id: 'seq:acme', tenantId: 'acme', sequence: observed.sequence + 1 };
            const res = await seq.cas('seq:acme', (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
            if (res.ok) {
              await entries.put({ id: 'ledger-2', tenantId: 'acme', payload: 'e2', sequence: next.sequence });
              throw new Error('injected failure after allocation+write');
            }
          }
        }, { tenantId: 'acme' }),
        /injected failure/,
      );

      // After rollback: the rolled-back allocation (2) and the rolled-back
      // entry are both gone; the counter stands at 1 (the committed
      // allocation from the happy path) — allocation and entry roll back
      // TOGETHER.
      await storage.atomically(async (scope) => {
        const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>(SEQ_COLLECTION);
        const entries = await scope.collection<TenantDoc & { sequence?: number }>('t06-ledger');
        assert.equal((await seq.get('seq:acme'))?.sequence, 1, 'rolled-back allocation (2) must not persist; counter stays at last committed allocation (1)');
        assert.equal(await entries.get('ledger-2'), undefined, 'rolled-back entry must not persist');
        assert.equal((await entries.get('ledger-1'))?.sequence, 1, 'committed entry intact');
      }, { tenantId: 'acme' });

      // Retry after the failure produces a valid continuation (sequence 1 reused cleanly).
      await storage.atomically(async (scope) => {
        const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>(SEQ_COLLECTION);
        const entries = await scope.collection<TenantDoc & { sequence?: number }>('t06-ledger');
        const cur = await seq.get('seq:acme');
        const observed = cur ?? { id: 'seq:acme', tenantId: 'acme', sequence: 0 };
        const next = { id: 'seq:acme', tenantId: 'acme', sequence: observed.sequence + 1 };
        const res = await seq.cas('seq:acme', (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
        assert.equal(res.ok, true);
        await entries.put({ id: 'ledger-2', tenantId: 'acme', payload: 'e2', sequence: next.sequence });
      }, { tenantId: 'acme' });

      await storage.atomically(async (scope) => {
        const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>(SEQ_COLLECTION);
        const entries = await scope.collection<TenantDoc & { sequence?: number }>('t06-ledger');
        assert.equal((await seq.get('seq:acme'))?.sequence, 2);
        const rows = (await entries.all()).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        assert.deepEqual(rows.map((r) => r.sequence), [1, 2], 'retry continues the sequence contiguously');
      }, { tenantId: 'acme' });
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('identical row ids across tenants: second tenant cannot clobber or read the first tenant\'s row (fail closed)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      // Tenant A creates row with id 'dup'.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-same-id');
        await coll.put({ id: 'dup', tenantId: 'acme', payload: 'acme-v1' });
      }, { tenantId: 'acme' });
      // Tenant B cannot see it…
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-same-id');
        assert.equal(await coll.get('dup'), undefined, 'globex must not read acme row with the same id');
        assert.equal(await coll.count(), 0);
      }, { tenantId: 'globex' });
      // …and cannot take it over: an identical-id write from tenant B must
      // fail closed (RLS makes the existing acme row invisible to the upsert),
      // never silently overwrite tenant A's row.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-same-id');
        await assert.rejects(
          coll.put({ id: 'dup', tenantId: 'globex', payload: 'globex-v2' }),
          /already exists under a different tenant|row-level security|cannot affect|duplicate key|unique violation/i,
          'identical-id write across tenants must fail closed (driver guard and/or RLS)',
        );
      }, { tenantId: 'globex' });
      // Tenant A's row is byte-intact and still exclusively visible to A.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('t06-same-id');
        assert.equal((await coll.get('dup'))?.payload, 'acme-v1', 'acme row must be untouched after globex takeover attempt');
      }, { tenantId: 'acme' });
      // System scope can see exactly one row with id 'dup'.
      const sys = await driver.openCollection<TenantDoc>('t06-same-id');
      const all = await sys.all();
      assert.equal(all.filter((r) => r.id === 'dup').length, 1, 'exactly one row exists for the id');
      assert.equal(all.filter((r) => r.id === 'dup')[0]?.tenantId, 'acme');
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });
});
