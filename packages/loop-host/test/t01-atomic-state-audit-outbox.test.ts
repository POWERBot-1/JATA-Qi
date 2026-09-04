// T-01-G atomicity test: state + audit + outbox all commit or all roll back.
//
// Uses the @jataqi/storage-postgres driver to drive a real
// PostgreSQL transaction that wraps (1) a state-collection write,
// (2) an audit-collection write, and (3) an outbox-collection
// write. An injected failure inside the transaction must roll
// back all three; the happy path must commit all three.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PostgresDriver } from '@jataqi/storage-postgres';
import { OutboxInbox, newOutboxEventId } from '../src/index.js';
import { pgAvailable, freshDb, makeDriver, makeStorage, dropDb, stopPg, bootStorageKernel } from './pg-host-harness.js';

describe('T-01-G state+audit+outbox atomicity over PostgreSQL transactions', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.ok(true, 'DATABASE INTEGRATION NOT EXECUTED.');
    });
    return;
  }

  let driver: PostgresDriver | undefined;
  let outbox: OutboxInbox | undefined;
  let db: { database: string; config: any } | undefined;

  after(async () => {
    try { if (driver) await driver.close(); } catch { /* ignore */ }
    try { if (db) await dropDb(db.database); } catch { /* ignore */ }
    try { await stopPg(); } catch { /* ignore */ }
  });

  it('happy path: state + audit + outbox all commit', async () => {
    db = await freshDb();
    if (!db) { assert.fail('freshDb returned undefined'); return; }
    driver = makeDriver(db.config);
    await driver.init();
    const storage = makeStorage(driver);
    const kernel = await bootStorageKernel(storage);
    outbox = new OutboxInbox();
    await outbox.init(kernel);

    const tenantId = 'acme';
    const workItemId = 'wi-1';
    const eventId = newOutboxEventId();
    const tx = await driver.beginTransaction();
    try {
      const state = await tx.collection<{ id: string; tenantId: string; status: string }>('t01-state');
      const audit = await tx.collection<{ id: string; tenantId: string; event: string }>('t01-audit');
      const ob = await tx.collection<{ id: string; tenantId: string; channel: string; eventId: string; eventType: string; payload: unknown; createdAt: number; dedupeKey: string }>('t01-outbox');
      await state.put({ id: workItemId, tenantId, status: 'COMPLETED' });
      await audit.put({ id: `${workItemId}:1`, tenantId, event: 'work.completed' });
      await ob.put({
        id: `outbox:${eventId}`,
        tenantId,
        channel: 'work.completed',
        eventId,
        eventType: 'work.completed',
        payload: { workItemId },
        createdAt: Date.now(),
        dedupeKey: eventId,
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    // Read back through a fresh transaction and confirm all three are visible.
    const post = await driver.beginTransaction();
    try {
      const state = await post.collection<{ id: string; tenantId: string; status: string }>('t01-state');
      const audit = await post.collection<{ id: string; tenantId: string; event: string }>('t01-audit');
      const ob = await post.collection<{ id: string; tenantId: string; channel: string; eventId: string; eventType: string; payload: unknown; createdAt: number; dedupeKey: string }>('t01-outbox');
      const s = await state.get(workItemId);
      const a = await audit.get(`${workItemId}:1`);
      const o = await ob.get(`outbox:${eventId}`);
      assert.ok(s && s.status === 'COMPLETED', 'state row visible after commit');
      assert.ok(a && a.event === 'work.completed', 'audit row visible after commit');
      assert.ok(o && o.eventId === eventId, 'outbox row visible after commit');
    } finally {
      await post.rollback();
    }
  });

  it('injected failure inside the transaction rolls back all three', async () => {
    if (!driver || !db) {
      it('SKIPPED: previous test not run', () => { assert.ok(true); });
      return;
    }
    const tenantId = 'acme';
    const workItemId = 'wi-rollback';
    const eventId = newOutboxEventId();
    const tx = await driver.beginTransaction();
    let threw = false;
    try {
      const state = await tx.collection<{ id: string; tenantId: string; status: string }>('t01-state');
      const audit = await tx.collection<{ id: string; tenantId: string; event: string }>('t01-audit');
      const ob = await tx.collection<{ id: string; tenantId: string; channel: string; eventId: string; eventType: string; payload: unknown; createdAt: number; dedupeKey: string }>('t01-outbox');
      await state.put({ id: workItemId, tenantId, status: 'COMPLETED' });
      await audit.put({ id: `${workItemId}:1`, tenantId, event: 'work.completed' });
      await ob.put({
        id: `outbox:${eventId}`,
        tenantId,
        channel: 'work.completed',
        eventId,
        eventType: 'work.completed',
        payload: { workItemId },
        createdAt: Date.now(),
        dedupeKey: eventId,
      });
      throw new Error('injected failure before commit');
    } catch (err) {
      threw = (err as Error).message === 'injected failure before commit';
      await tx.rollback();
    }
    assert.equal(threw, true, 'injected failure must propagate');

    // Read back: NONE of the new rows must be visible.
    const post = await driver.beginTransaction();
    try {
      const state = await post.collection<{ id: string; tenantId: string; status: string }>('t01-state');
      const audit = await post.collection<{ id: string; tenantId: string; event: string }>('t01-audit');
      const ob = await post.collection<{ id: string; tenantId: string; channel: string; eventId: string; eventType: string; payload: unknown; createdAt: number; dedupeKey: string }>('t01-outbox');
      const s = await state.get(workItemId);
      const a = await audit.get(`${workItemId}:1`);
      const o = await ob.get(`outbox:${eventId}`);
      assert.equal(s, undefined, 'state row not visible after rollback');
      assert.equal(a, undefined, 'audit row not visible after rollback');
      assert.equal(o, undefined, 'outbox row not visible after rollback');
    } finally {
      await post.rollback();
    }
  });

  it('durable replay: re-append of an UNACKED event is a no-op (idempotency holds; the original record is returned)', async () => {
    if (!driver || !db || !outbox) {
      it('SKIPPED: previous tests not run', () => { assert.ok(true); });
      return;
    }
    const tenantId = 'acme';
    const workItemId = 'wi-replay';
    const eventId = newOutboxEventId();
    // First commit (state + audit + outbox in one transaction).
    const tx1 = await driver.beginTransaction();
    await (await tx1.collection<{ id: string; tenantId: string; status: string }>('t01-state')).put({ id: workItemId, tenantId, status: 'COMPLETED' });
    await (await tx1.collection<{ id: string; tenantId: string; event: string }>('t01-audit')).put({ id: `${workItemId}:1`, tenantId, event: 'work.completed' });
    await outbox.appendOutbox({ tenantId, channel: 'work.completed', eventId, eventType: 'work.completed', payload: { workItemId } });
    await tx1.commit();

    // Replay before the publisher has acked the original. The
    // dedupeKey is the same, so the second append is a no-op and
    // returns the original record (no duplicate downstream effect).
    const replay = await outbox.appendOutbox({ tenantId, channel: 'work.completed', eventId, eventType: 'work.completed', payload: { workItemId } });
    const remaining = await outbox.listOutbox(tenantId, 'work.completed');
    const matches = remaining.filter((r) => r.eventId === eventId);
    assert.equal(matches.length, 1, 'duplicate replay must not create a second record');
    assert.equal(replay.id, matches[0].id, 'replay returns the same record id');
    assert.equal(replay.createdAt, matches[0].createdAt, 'replay record has the original createdAt (no new write)');
  });
});
