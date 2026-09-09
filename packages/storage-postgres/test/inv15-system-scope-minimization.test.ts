// INV-15/GAP-07 — Ambient security-scope minimization proof (real PostgreSQL).
//
// P1-GAP-07 recorded that every pooled session used to start with the
// ambient system scope `'*'` (`SET app.tenant_id = '*'` on the pool's
// 'connect' event): any statement not inside an explicitly tenant-scoped
// transaction ran cross-tenant at the RLS layer. The PG-5 contract requires:
//
//   * pooled sessions start UNSET (blind) — no ambient scope at all;
//   * system scope exists ONLY via explicit per-transaction SET LOCAL;
//   * every remaining system-scope use is ENUMERATED (machine-readable boot
//     audit artifact: `PostgresDriver.getSystemScopeAudit()`), and a label
//     outside the declared exception registry is a boot failure.
//
// This suite proves all three, plus the adversarial boundary properties the
// minimization must not disturb: forged/cross-tenant/conflicting tenant
// metadata denies; missing/blank/ambiguous tenant ids deny before any write;
// explicitly authorized system transactions ALLOW; unscoped pool-path
// handles WITHOUT explicit authority fail closed (the former ambient path
// requires authority now); tenant isolation holds under concurrency and
// across driver restart; and RLS/FORCE posture remains effective.
//
// PostgreSQL is a HARD requirement: when it cannot start these tests FAIL
// loudly ("DATABASE INTEGRATION NOT EXECUTED") rather than skipping.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  PostgresCollection,
  PostgresDriver,
  deriveTableName,
  ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS,
  isDeclaredSystemScopeLabel,
} from '../src/index.js';
import { dropTestDb, makeDriver, newTestDb, pgAvailable, stopServer } from './pg-test-harness.js';

after(async () => {
  await stopServer();
});

type TenantDoc = { id: string; tenantId?: string; payload: string };

async function bootStorage(driver: PostgresDriver): Promise<{ storage: StorageModule; shutdown: () => Promise<void> }> {
  const storage = new StorageModule({ driverInstance: driver });
  const kernel = createTestKernel();
  kernel.register(storage);
  await kernel.boot();
  return { storage, shutdown: () => kernel.shutdown() };
}

describe('INV-15/GAP-07 ambient security-scope minimization (real PostgreSQL)', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('PostgreSQL integration unavailable', () => {
      assert.fail('DATABASE INTEGRATION NOT EXECUTED — real PostgreSQL required for the INV-15 scope-minimization proof.');
    });
    return;
  }

  it('pooled sessions start blind: no ambient scope on fresh checkout; regression is detectable', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    try {
      // (1) The minimization itself: the driver reports NO ambient scope and
      // a fresh pooled session observes an empty GUC (never '*', never a
      // stale tenant).
      assert.equal(await driver.hasAmbientConnectScope(), false,
        'INV-15: driver pool must not hand out sessions with a session-level scope');
      const c = await driver.pool.connect();
      try {
        const res = await c.query("SELECT current_setting('app.tenant_id', true) AS v");
        const v = res.rows[0]?.v;
        assert.ok(v === null || v === undefined || v === '',
          `fresh checkout must be scope-blind; observed ${JSON.stringify(v)}`);
      } finally {
        c.release();
      }

      // (2) The probe is a LIVE negative test, not a constant: a legacy
      // ambient 'connect' handler installed on a pool is detected as ambient
      // (this is exactly what the production-posture invariant forbids).
      const legacyPool = new pg.Pool({ connectionString: db.config.connectionString, max: 2 });
      legacyPool.on('connect', (client: pg.PoolClient) => {
        void client.query(`SET app.tenant_id = '*'`).catch(() => undefined);
      });
      const ambientDriver = new PostgresDriver({ pool: legacyPool, requireExplicitConfig: true });
      try {
        assert.equal(await ambientDriver.hasAmbientConnectScope(), true,
          'ambient connect-time scope on a pool MUST be observable by the probe');
      } finally {
        await ambientDriver.close().catch(() => undefined);
        await legacyPool.end().catch(() => undefined);
      }
    } finally {
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('unscoped session sees no rows and cannot write; tenant scope and explicit system scope behave (non-superuser role)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    const appRole = `jataqi_inv15_${process.pid}`;
    const appPw = 'app_pw';
    try {
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('inv15-role');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'acme-row' });
      }, { tenantId: 'acme' });
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('inv15-role');
        await coll.put({ id: 'b1', tenantId: 'globex', payload: 'globex-row' });
      }, { tenantId: 'globex' });

      const admin = await driver.pool.connect();
      try {
        await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
        await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        await admin.query(`GRANT CONNECT ON DATABASE ${db.database} TO ${appRole}`);
        await admin.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
        const bypass = await admin.query('SELECT rolbypassrls FROM pg_roles WHERE rolname = $1', [appRole]);
        assert.equal(bypass.rows[0]?.rolbypassrls, false);
        const tableName = deriveTableName('collection', 'inv15-role');
        const rls = await admin.query(
          'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
          [tableName],
        );
        assert.equal(rls.rows[0]?.relrowsecurity, true, 'RLS remains enabled after minimization');
        assert.equal(rls.rows[0]?.relforcerowsecurity, true, 'FORCE ROW LEVEL SECURITY remains effective after minimization');
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
        const tableName = deriveTableName('collection', 'inv15-role');
        // Missing scope ⇒ DENY-by-blinding: sees no rows (the former ambient
        // '*' grant is gone; this is the GAP-07 acceptance test).
        const none = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.equal(none.rows.length, 0, 'no-context session must see ZERO rows (INV-15 acceptance)');
        // Missing scope ⇒ cannot write.
        await assert.rejects(
          appConn.query(`INSERT INTO "${tableName}" (id, body, tenant_id) VALUES ('x1', '{"id":"x1"}', 'acme')`),
          /row-level security|policy/i,
          'no-context session must be refused writes by the WITH CHECK policy',
        );
        // Explicit tenant scope ⇒ only its rows (transaction-local form).
        await appConn.query('BEGIN');
        await appConn.query(`SELECT set_config('app.tenant_id', $1, true)`, ['acme']);
        const acme = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.deepEqual(acme.rows.map((r: { id: string }) => r.id).sort(), ['a1']);
        await appConn.query('ROLLBACK');
        // Explicit system scope (SET LOCAL form) ⇒ spans tenants.
        await appConn.query('BEGIN');
        await appConn.query(`SELECT set_config('app.tenant_id', '*', true)`);
        const all = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.deepEqual(all.rows.map((r: { id: string }) => r.id).sort(), ['a1', 'b1'],
          'legitimately authorized system operations remain ALLOWED (explicit SET LOCAL)');
        await appConn.query('COMMIT');
        // After the transaction, scope reverts to blind — no residue.
        const afterTx = await appConn.query(`SELECT id FROM "${tableName}"`);
        assert.equal(afterTx.rows.length, 0, 'SET LOCAL system scope must not survive COMMIT');
      } finally {
        await appConn.end().catch(() => undefined);
      }
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('pool-path parity: unscoped collection ops run inside explicit per-operation system scope', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      const before = driver.getSystemScopeAudit().totalSystemScopeOperations;

      const coll = await storage.collection<TenantDoc>('inv15-parity');
      await coll.put({ id: 'p1', tenantId: 'acme', payload: 'one' });
      await coll.put({ id: 'p2', tenantId: 'globex', payload: 'two' });
      assert.deepEqual((await coll.get('p1'))?.payload, 'one');
      assert.equal((await coll.all()).length, 2, 'unscoped pool path still spans tenants (behavior parity)');
      assert.equal(await coll.count(), 2);
      assert.ok(await coll.has('p2'));
      assert.equal((await coll.query({ where: (d) => d.tenantId === 'globex' })).length, 1);

      // CAS + replaceAll + clear run as standalone explicit-scope transactions.
      const cas = await coll.cas('p1', (cur) => (cur as TenantDoc | undefined)?.payload === 'one', (cur) => ({ ...cur, payload: 'updated' }));
      assert.equal(cas.ok, true, 'standalone CAS participates in the explicit system-scope transaction');
      await coll.replaceAll([{ id: 'p3', tenantId: 'acme', payload: 'three' }]);
      assert.equal((await coll.get('p1')), undefined, 'replaceAll snapshot replaced the rows');
      await coll.clear();
      assert.equal(await coll.count(), 0);

      const after = driver.getSystemScopeAudit();
      assert.ok(after.totalSystemScopeOperations > before,
        'every pool-path operation was counted as an explicit system-scope use');
      assert.ok((after.uses['poolpath:inv15-parity'] ?? 0) >= 10,
        `per-collection enumeration must reflect the ops; got ${JSON.stringify(after.uses)}`);
      assert.deepEqual(after.undeclaredLabels, [], 'observed labels must all fall under the declared exceptions');
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('the former ambient "*" path now requires explicit authority (fail-closed)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      // Populate + seed a row through the sanctioned path.
      const coll = await storage.collection<TenantDoc>('inv15-authority');
      await coll.put({ id: 'x1', tenantId: 'acme', payload: 'secret' });

      // A pool-path handle constructed WITHOUT the driver's runner (i.e. the
      // shape an ambient-scope engine would silently bless) must fail closed:
      // no reads, no writes, no CAS — never "empty but quiet", never a
      // fallback to session scope.
      const table = deriveTableName('collection', 'inv15-authority');
      const rogue = new PostgresCollection<TenantDoc>('inv15-authority', table, driver.pool);
      const counted = driver.getSystemScopeAudit().totalSystemScopeOperations;
      await assert.rejects(rogue.get('x1'), /fail-closed|system-scope authority/i);
      await assert.rejects(rogue.all(), /fail-closed|system-scope authority/i);
      await assert.rejects(rogue.put({ id: 'x2', tenantId: 'acme', payload: 'nope' }), /fail-closed|system-scope authority/i);
      await assert.rejects(rogue.cas('x1', () => true, (cur) => cur), /fail-closed|system-scope authority/i);
      await assert.rejects(rogue.replaceAll([]), /fail-closed|system-scope authority/i);
      // Denials grant NOTHING: the ledger must not advance for refused ops
      // (proves the fail-closed path never acquires system scope quietly).
      assert.equal(driver.getSystemScopeAudit().totalSystemScopeOperations, counted,
        'a rejected unscoped op must not acquire (or count) system-scope authority');
      // The rejected rogue.put must not have written anything either.
      assert.equal(await coll.get('x2'), undefined, 'refused rogue write must leave no row');
      // The sanctioned handle still works.
      assert.equal((await coll.get('x1'))?.payload, 'secret');
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('missing/blank/ambiguous/forged/conflicting tenant authority denies before any write', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      // (a) Invalid tenant identifiers deny at the API boundary.
      for (const bad of [' ', '', '\t', '*', 'bad id', "a'b", 'acme;DROP', 'tenant/slash']) {
        await assert.rejects(
          storage.atomically(async (scope) => {
            const coll = await scope.collection<TenantDoc>('inv15-deny');
            await coll.put({ id: `d-${bad.length}`, tenantId: bad || undefined, payload: 'x' });
          }, { tenantId: bad }),
          /tenant/i,
          `tenant id ${JSON.stringify(bad)} must fail closed before any write`,
        );
        await assert.rejects(
          driver.beginTransaction({ tenantId: bad }),
          /tenant/i,
          `beginTransaction with tenant id ${JSON.stringify(bad)} must fail closed`,
        );
      }

      // (b) Forged/conflicting tenant metadata inside a tenant-bound handle denies.
      await assert.rejects(
        storage.atomically(async (scope) => {
          const coll = await scope.collection<TenantDoc>('inv15-forge');
          await coll.put({ id: 'f1', tenantId: 'globex', payload: 'forged' });
        }, { tenantId: 'acme' }),
        /cross-tenant write refused/,
        'forged tenant metadata must deny',
      );

      // (c) Cross-tenant substitution (same id, other tenant) denies.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('inv15-subst');
        await coll.put({ id: 'shared', tenantId: 'acme', payload: 'mine' });
      }, { tenantId: 'acme' });
      await assert.rejects(
        storage.atomically(async (scope) => {
          const coll = await scope.collection<TenantDoc>('inv15-subst');
          await coll.put({ id: 'shared', tenantId: 'globex', payload: 'stolen' });
        }, { tenantId: 'globex' }),
        /cross-tenant write refused|different tenant/,
        'cross-tenant substitution must deny',
      );
      // The victim row is byte-intact.
      await storage.atomically(async (scope) => {
        const coll = await scope.collection<TenantDoc>('inv15-subst');
        assert.equal((await coll.get('shared'))?.payload, 'mine');
      }, { tenantId: 'acme' });
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('tenant isolation holds under concurrency while pool-path system ops interleave', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      // Warm the table + isolation DDL ONCE through the sanctioned system
      // scope so the concurrent fan-out below exercises data-plane isolation,
      // not first-create DDL contention (pre-existing capacity behavior of a
      // max-10 pool; unrelated to scope minimization).
      const warm = await storage.collection<TenantDoc>('inv15-conc');
      assert.equal(await warm.count(), 0);
      const tenants = ['acme', 'globex'];
      await Promise.all(
        tenants.flatMap((tenant) =>
          Array.from({ length: 4 }, (_, i) =>
            storage.atomically(async (scope) => {
              const coll = await scope.collection<TenantDoc>('inv15-conc');
              await coll.put({ id: `${tenant}-${i}`, tenantId: tenant, payload: `p${i}` });
              const seen = await coll.all();
              for (const doc of seen) {
                assert.equal(doc.tenantId, tenant, 'concurrent tenant tx must never observe another tenant row');
              }
            }, { tenantId: tenant }),
          )),
      );
      // Interleave unscoped pool-path traffic (system-scope transactions)
      // against the tenant data; isolation of tenant views must not change.
      const coll = await storage.collection<TenantDoc>('inv15-conc');
      assert.equal(await coll.count(), 8, 'system-scope pool path sees the union');
      await Promise.all(
        tenants.map((tenant) =>
          storage.atomically(async (scope) => {
            const tenantColl = await scope.collection<TenantDoc>('inv15-conc');
            assert.equal(await tenantColl.count(), 4, 'per-tenant view unaffected by concurrent system-scope traffic');
          }, { tenantId: tenant })),
      );
      const union = (await coll.all()).map((d) => d.tenantId);
      assert.equal(union.filter((t) => t === 'acme').length, 4);
      assert.equal(union.filter((t) => t === 'globex').length, 4);
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('enumeration survives restart; audit labels match the declared exception registry', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      // Exercise each choke point: pool-path op, system tx, tenant tx,
      // schema isolation (new collection ⇒ backfill path).
      const coll = await storage.collection<TenantDoc>('inv15-audit');
      await coll.put({ id: 'a1', tenantId: 'acme', payload: 'x' });
      await storage.atomically(async () => { /* unscoped system transaction */ });
      await storage.atomically(async (scope) => {
        const t = await scope.collection<TenantDoc>('inv15-audit');
        assert.equal((await t.get('a1'))?.payload, 'x');
      }, { tenantId: 'acme' });

      const audit = driver.getSystemScopeAudit();
      assert.equal(audit.ambientConnectScopePresent, false);
      assert.ok(audit.uses['poolpath:inv15-audit'] !== undefined, 'pool-path use enumerated per collection');
      assert.ok((audit.uses['transaction:system'] ?? 0) >= 1, 'explicit system transaction enumerated');
      assert.ok((audit.uses['schema:isolation'] ?? 0) >= 1, 'isolation DDL/backfill path enumerated');
      assert.deepEqual(audit.undeclaredLabels, []);
      for (const label of Object.keys(audit.uses)) {
        assert.ok(isDeclaredSystemScopeLabel(label), `observed label ${label} must match a declared exception`);
      }
      // The registry is exactly the three documented exception families.
      assert.deepEqual(
        ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS.map((e) => e.labelPrefix).sort(),
        ['poolpath:', 'schema:isolation', 'transaction:system'],
      );

      // Restart: a fresh driver keeps blindness AND the persisted rows are
      // still reachable only via explicit scope (tenant tx) or system scope.
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      const driverB = makeDriver(db.config);
      const bootedB = await bootStorage(driverB);
      try {
        assert.equal(await driverB.hasAmbientConnectScope(), false, 'blindness survives driver restart');
        assert.equal(driverB.getSystemScopeAudit().totalSystemScopeOperations >= 0, true);
        const collB = await bootedB.storage.collection<TenantDoc>('inv15-audit');
        assert.equal((await collB.get('a1'))?.payload, 'x', 'persisted rows survive restart via explicit system scope');
      } finally {
        await bootedB.shutdown().catch(() => undefined);
        await driverB.close().catch(() => undefined);
      }
    } finally {
      await dropTestDb(db.database);
    }
  });

  it('an UNDECLARED system-scope label is detected by the enumeration (boot-fail trigger)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      const before = driver.getSystemScopeAudit();
      assert.deepEqual(before.undeclaredLabels, []);
      // A future/malicious broad-scope pattern that bypasses the registry
      // naming convention is surfaced by the audit (and thus by the
      // production-posture invariant, which refuses boot on this).
      await driver.withSystemScope('sneaky:new-bypass', async (client) => {
        await client.query('SELECT 1');
      });
      const after = driver.getSystemScopeAudit();
      assert.deepEqual(after.undeclaredLabels, ['sneaky:new-bypass'],
        'undeclared labels must be enumerable for the boot gate');
      assert.ok(!isDeclaredSystemScopeLabel('sneaky:new-bypass'));
      assert.equal((after.uses['sneaky:new-bypass'] ?? 0), 1);
      // Declared labels remain clean, and the ledger is monotonic.
      assert.ok(after.totalSystemScopeOperations > before.totalSystemScopeOperations);
      void storage;
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });

  it('PG-5 boot-audit artifact is machine-readable and stable', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('newTestDb returned undefined'); return; }
    const driver = makeDriver(db.config);
    const { storage, shutdown } = await bootStorage(driver);
    try {
      const coll = await storage.collection<TenantDoc>('inv15-artifact');
      await coll.put({ id: 'q1', tenantId: 'acme', payload: 'q' });
      const first = driver.getSystemScopeAudit();
      const second = driver.getSystemScopeAudit();
      // Deterministic, stable, JSON-serializable record (no ops between the
      // two snapshots — they must agree exactly).
      assert.equal(second.totalSystemScopeOperations, first.totalSystemScopeOperations);
      assert.equal(JSON.stringify(first.uses), JSON.stringify(second.uses));
      const text = JSON.stringify(first);
      assert.ok(text.includes('"ambientConnectScopePresent":false'), 'artifact is greppable for the INV-15 marker');
      assert.ok(Array.isArray(first.undeclaredLabels));
      for (const exception of ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS) {
        assert.ok(typeof exception.labelPrefix === 'string' && exception.justification.length > 40,
          'every declared exception must carry a justification');
      }
    } finally {
      await shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await dropTestDb(db.database);
    }
  });
});
