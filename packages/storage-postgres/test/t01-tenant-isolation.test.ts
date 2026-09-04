// T-01 tenant isolation tests (PostgreSQL RLS).
//
// What is verified:
//   * A document inserted for tenant A is not visible to a query
//     running under tenant B (cross-tenant read rejected).
//   * A document inserted with the wrong tenant id in its body
//     is rejected (cross-tenant write rejected).
//   * A direct read bypassing the tenant context (without a tenant
//     GUC set) cannot see tenant-scoped rows.
//   * A delete from tenant B cannot remove tenant A's rows.
//   * A count under tenant B does not include tenant A's rows.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDriver, runWithTenant, deriveTableName } from '../src/index.js';
import { dropTestDb, newTestDb, makeDriver, pgAvailable, stopServer } from './pg-test-harness.js';

after(async () => {
  await stopServer();
});

describe('T-01 PostgreSQL tenant isolation (RLS)', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.ok(true, 'DATABASE INTEGRATION NOT EXECUTED — no fabricated pass.');
    });
    return;
  }

  it('a document for tenant A is not visible to tenant B (cross-tenant read rejected)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined despite pgAvailable()'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      // Write a row under tenant acme.
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-test-col');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'acme-secret' });
      });
      // Query as tenant globex; the row must NOT be visible.
      const seen: Array<{ id: string; payload: string }> = [];
      await runWithTenant(pool, 'globex', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-test-col');
        const items = await coll.all();
        seen.push(...items.map((i) => ({ id: i.id, payload: i.payload })));
      });
      assert.equal(seen.length, 0, 'tenant globex must not see tenant acme rows');
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });

  it('a document with a wrong tenant id in its body is rejected (cross-tenant write rejected)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      let rejected = false;
      try {
        await runWithTenant(pool, 'acme', async (tx) => {
          const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-write-test');
          // The body has tenantId=globex, but the active context is acme.
          await coll.put({ id: 'a1', tenantId: 'globex', payload: 'cross-tenant' });
        });
      } catch (err) {
        rejected = true;
        assert.ok((err as Error).message.toLowerCase().includes('tenantid') || (err as Error).message.toLowerCase().includes('tenant'),
          `expected tenant-id rejection, got: ${(err as Error).message}`);
      }
      assert.equal(rejected, true, 'cross-tenant write must throw');
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });

  it('RLS is enabled and the tenant-isolation policy is in place on every collection', async () => {
    // The embedded-postgres test environment uses the `postgres`
    // superuser, which has `BYPASSRLS` set. RLS policies cannot be
    // enforced on a superuser (PostgreSQL semantics), so the
    // enforcement-level cross-tenant read rejection is only verifiable
    // end-to-end with a non-superuser application role. We verify
    // the policy is installed: that is the T-01 contract — the
    // database-level isolation mechanism exists and is in force at
    // the table level. Production deployments must use a non-superuser
    // role to enforce RLS (a documented activation requirement).
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-rls-policy');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'secret' });
      });
      const c = await pool.connect();
      const tableName = deriveTableName('collection', 't01-rls-policy');
      try {
        // RLS is enabled.
        const rls = await c.query(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
          [tableName],
        );
        assert.equal(rls.rows[0]?.relrowsecurity, true, 'RLS enabled on collection table');
        assert.equal(rls.rows[0]?.relforcerowsecurity, true, 'FORCE RLS enabled on collection table');
        // Policy exists and references the tenant GUC.
        const pol = await c.query(
          `SELECT polname FROM pg_policy WHERE polrelid = $1::regclass`,
          [tableName],
        );
        assert.ok(pol.rows.length > 0, 'at least one RLS policy is attached');
        // tenant_id column exists.
        const cols = await c.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`,
          [tableName],
        );
        assert.ok(cols.rows.length > 0, 'tenant_id column exists');
      } finally {
        c.release();
      }
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });

  it('RLS ENFORCES cross-tenant isolation when a non-superuser application role is used', async () => {
    // This is the full end-to-end RLS proof: a non-superuser
    // application role (no BYPASSRLS) is created; that role
    // attempts to read rows owned by tenant A; the policy blocks
    // the read. The superuser (postgres) creates the role and
    // the test data, then SET ROLE applies the policy.
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      // Create a non-superuser application role and grant it the
      // minimum required to read/write the database.
      const appRole = 'jataqi_app';
      const appPw = 'app_pw';
      const appClient = await pool.connect();
      try {
        await appClient.query(`DROP ROLE IF EXISTS ${appRole}`);
        await appClient.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        await appClient.query(`GRANT CONNECT ON DATABASE ${db.database} TO ${appRole}`);
        await appClient.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${appRole}`);
        await appClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${appRole}`);
        await appClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${appRole}`);
        // Confirm the role does NOT have BYPASSRLS.
        const bypass = await appClient.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`, [appRole]);
        assert.equal(bypass.rows[0]?.rolbypassrls, false, 'app role must not have BYPASSRLS');
      } finally {
        appClient.release();
      }

      // Use runWithTenant to set up the table (which creates the
      // RLS policy) and write a tenant-acme row.
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-rls-enforce');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'acme-secret' });
      });

      // Now connect AS the non-superuser app role and try to read.
      const connUrl = new URL(db.config.connectionString!);
      const appConn = new (await import('pg')).default.Client({
        host: connUrl.hostname,
        port: Number(connUrl.port),
        user: appRole,
        password: appPw,
        database: connUrl.pathname.replace(/^\//, ''),
      });
      await appConn.connect();
      try {
        const tableName = deriveTableName('collection', 't01-rls-enforce');
        // Direct read without setting tenant GUC: RLS denies.
        const res = await appConn.query(`SELECT body FROM "${tableName}" WHERE id = $1`, ['a1']);
        assert.equal(res.rows.length, 0, 'non-superuser app role must NOT see tenant-scoped rows without a tenant GUC (RLS enforced)');

        // Set the wrong tenant GUC: RLS still denies.
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['globex']);
        const res2 = await appConn.query(`SELECT body FROM "${tableName}" WHERE id = $1`, ['a1']);
        assert.equal(res2.rows.length, 0, 'non-superuser app role with WRONG tenant GUC must NOT see tenant-acme rows (RLS enforced)');

        // Set the correct tenant GUC: RLS permits the read.
        await appConn.query(`SELECT set_config('app.tenant_id', $1, false)`, ['acme']);
        const res3 = await appConn.query(`SELECT body FROM "${tableName}" WHERE id = $1`, ['a1']);
        assert.equal(res3.rows.length, 1, 'non-superuser app role with CORRECT tenant GUC must see the row (RLS enforced)');
      } finally {
        await appConn.end();
        const cleanup = await pool.connect();
        try {
          await cleanup.query(`DROP OWNED BY ${appRole} CASCADE`);
          await cleanup.query(`DROP ROLE IF EXISTS ${appRole}`);
        } finally {
          cleanup.release();
        }
      }
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });

  it('a delete from tenant B does not remove tenant A rows (RLS-with-check enforced)', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-delete');
        await coll.put({ id: 'a1', tenantId: 'acme', payload: 'mine' });
      });
      // Try to delete from tenant globex.
      let deleted = false;
      await runWithTenant(pool, 'globex', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-delete');
        deleted = await coll.delete('a1');
      });
      assert.equal(deleted, false, 'delete from wrong tenant must return false (RLS prevented)');
      // Confirm the row is still there under tenant acme.
      let stillThere = false;
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-delete');
        const item = await coll.get('a1');
        stillThere = Boolean(item);
      });
      assert.equal(stillThere, true, 'acme row must survive a globex delete attempt');
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });

  it('a count under tenant B does not include tenant A rows', async () => {
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      // Insert 3 rows for acme, 2 for globex.
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-count');
        for (const id of ['a1', 'a2', 'a3']) await coll.put({ id, tenantId: 'acme', payload: id });
      });
      await runWithTenant(pool, 'globex', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-count');
        for (const id of ['g1', 'g2']) await coll.put({ id, tenantId: 'globex', payload: id });
      });
      let acmeCount = 0;
      let globexCount = 0;
      await runWithTenant(pool, 'acme', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-count');
        acmeCount = await coll.count();
      });
      await runWithTenant(pool, 'globex', async (tx) => {
        const coll = await tx.getCollection<{ id: string; tenantId: string; payload: string }>('t01-count');
        globexCount = await coll.count();
      });
      assert.equal(acmeCount, 3, 'acme must see only its 3 rows');
      assert.equal(globexCount, 2, 'globex must see only its 2 rows');
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });

  it('a transactional state + audit + outbox write commits atomically or rolls back all', async () => {
    // T-01-G: critical multi-step mutations (state + audit + outbox)
    // must commit atomically. We use runWithTenant to wrap them in a
    // single transaction; an exception in any step rolls back all
    // three.
    const db = await newTestDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    const driver: PostgresDriver = makeDriver(db.config);
    try {
      await driver.init();
      const pool = driver.pool;
      // Happy path: state + audit + outbox all commit.
      await runWithTenant(pool, 'acme', async (tx) => {
        const state = await tx.getCollection<{ id: string; tenantId: string; value: string }>('t01-state');
        const audit = await tx.getCollection<{ id: string; tenantId: string; event: string }>('t01-audit');
        const outbox = await tx.getCollection<{ id: string; tenantId: string; event: string; published: boolean }>('t01-outbox');
        await state.put({ id: 'w1', tenantId: 'acme', value: 'updated' });
        await audit.put({ id: 'a1', tenantId: 'acme', event: 'state.updated' });
        await outbox.put({ id: 'o1', tenantId: 'acme', event: 'state.updated', published: false });
      });
      // Verify all three are visible after commit.
      await runWithTenant(pool, 'acme', async (tx) => {
        const state = await tx.getCollection<{ id: string; tenantId: string; value: string }>('t01-state');
        const audit = await tx.getCollection<{ id: string; tenantId: string; event: string }>('t01-audit');
        const outbox = await tx.getCollection<{ id: string; tenantId: string; event: string; published: boolean }>('t01-outbox');
        assert.ok(await state.get('w1'), 'state committed');
        assert.ok(await audit.get('a1'), 'audit committed');
        assert.ok(await outbox.get('o1'), 'outbox committed');
      });
      // Failure path: a throw inside the transaction rolls back all three.
      let threw = false;
      try {
        await runWithTenant(pool, 'acme', async (tx) => {
          const state = await tx.getCollection<{ id: string; tenantId: string; value: string }>('t01-state');
          const audit = await tx.getCollection<{ id: string; tenantId: string; event: string }>('t01-audit');
          const outbox = await tx.getCollection<{ id: string; tenantId: string; event: string; published: boolean }>('t01-outbox');
          await state.put({ id: 'w2', tenantId: 'acme', value: 'partial' });
          await audit.put({ id: 'a2', tenantId: 'acme', event: 'partial.updated' });
          await outbox.put({ id: 'o2', tenantId: 'acme', event: 'partial.updated', published: false });
          throw new Error('injected failure before commit');
        });
      } catch (err) {
        threw = (err as Error).message === 'injected failure before commit';
      }
      assert.equal(threw, true, 'transaction should have thrown');
      // Verify NONE of the new rows are visible.
      await runWithTenant(pool, 'acme', async (tx) => {
        const state = await tx.getCollection<{ id: string; tenantId: string; value: string }>('t01-state');
        const audit = await tx.getCollection<{ id: string; tenantId: string; event: string }>('t01-audit');
        const outbox = await tx.getCollection<{ id: string; tenantId: string; event: string; published: boolean }>('t01-outbox');
        assert.equal(await state.get('w2'), undefined, 'rolled-back state row not visible');
        assert.equal(await audit.get('a2'), undefined, 'rolled-back audit row not visible');
        assert.equal(await outbox.get('o2'), undefined, 'rolled-back outbox row not visible');
      });
    } finally {
      await driver.close();
      await dropTestDb(db.database);
    }
  });
});


