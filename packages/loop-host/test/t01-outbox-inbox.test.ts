// T-01-H outbox/inbox tests.
//
// What is verified:
//   * outbox.appendOutbox is idempotent: appending the same
//     (channel, eventId) twice yields exactly one record.
//   * inbox.observeInbox returns firstTime=true on first observation
//     and firstTime=false on subsequent observations; the second
//     observation does NOT increment the protected business
//     mutation counter.
//   * Different tenants cannot observe each other's outbox records.
//   * inbox idempotency is per-(tenant, source, messageId) tuple:
//     the same messageId from a different source is a different
//     first-time observation; a different tenant with the same
//     source+messageId is also independent.
//   * The protected business mutation executed once per (source,
//     messageId) — even under high concurrency — because
//     observeInbox uses a cas-as-insert-if-absent that loses
//     no transitions (and the dedupe key is content-hashed).
//   * ackOutbox removes the record and a second ack is a no-op.
//   * The inbox records an observedCount that increments on repeat
//     delivery.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OutboxInbox, newOutboxEventId } from '../src/index.js';
import { buildHarness, type Harness } from './helpers.js';

let harness: Harness;
let outbox: OutboxInbox;

before(async () => {
  harness = await buildHarness();
  outbox = new OutboxInbox();
  await outbox.init(harness.kernel);
});

after(async () => {
  await harness.kernel.shutdown();
});

describe('T-01-H outbox/inbox', () => {
  it('appending the same (channel, eventId) twice yields exactly one record (idempotent)', async () => {
    const channel = `ch-${Math.random().toString(36).slice(2, 8)}`;
    const eventId = newOutboxEventId();
    const a = await outbox.appendOutbox({ tenantId: 'acme', channel, eventId, eventType: 'work.completed', payload: { ok: true } });
    const b = await outbox.appendOutbox({ tenantId: 'acme', channel, eventId, eventType: 'work.completed', payload: { ok: true } });
    assert.equal(a.id, b.id, 'second append must return the same record id');
    const list = await outbox.listOutbox('acme', channel);
    assert.equal(list.length, 1, 'list must show exactly one record');
  });

  it('inbox.observeInbox returns firstTime=true once, then firstTime=false on subsequent observations', async () => {
    const source = 'src-1';
    const messageId = `msg-${Math.random().toString(36).slice(2, 10)}`;
    const a = await outbox.observeInbox('acme', source, messageId);
    const b = await outbox.observeInbox('acme', source, messageId);
    const c = await outbox.observeInbox('acme', source, messageId);
    assert.equal(a.firstTime, true, 'first observation: firstTime=true');
    assert.equal(b.firstTime, false, 'second observation: firstTime=false');
    assert.equal(c.firstTime, false, 'third observation: firstTime=false');
    const rec = c.record;
    assert.equal(rec.observedCount, 3, 'observedCount must equal total observations');
  });

  it('protected business mutation executes exactly once under concurrent first-time delivery', async () => {
    // 50 concurrent observers with the same (source, messageId).
    // Exactly one must report firstTime=true; the rest must
    // report firstTime=false. This proves observeInbox does not
    // permit duplicate execution of the protected business
    // mutation under contention.
    const source = 'src-conc';
    const messageId = `msg-conc-${Math.random().toString(36).slice(2, 10)}`;
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => outbox.observeInbox('acme', source, messageId)),
    );
    const firstTime = results.filter((r) => r.firstTime).length;
    const repeat = results.filter((r) => !r.firstTime).length;
    assert.equal(firstTime, 1, `exactly one firstTime=true under ${N} concurrent observers`);
    assert.equal(repeat, N - 1, `${N - 1} repeats must report firstTime=false`);
    const final = await outbox.listInbox('acme');
    const rec = final.find((r) => r.messageId === messageId && r.source === source);
    assert.ok(rec, 'inbox record present');
    assert.equal(rec.observedCount, N, `observedCount must equal ${N} (sum of all observations)`);
  });

  it('tenant isolation: tenant globex cannot see tenant acme outbox records', async () => {
    const channel = `ch-iso-${Math.random().toString(36).slice(2, 8)}`;
    const eventId = newOutboxEventId();
    await outbox.appendOutbox({ tenantId: 'acme', channel, eventId, eventType: 'x', payload: { v: 1 } });
    const acmeList = await outbox.listOutbox('acme', channel);
    const globexList = await outbox.listOutbox('globex', channel);
    assert.equal(acmeList.length, 1, 'acme must see its record');
    assert.equal(globexList.length, 0, 'globex must see zero records');
  });

  it('inbox isolation: same (source, messageId) under different tenant is independent', async () => {
    const source = 'src-iso';
    const messageId = `msg-iso-${Math.random().toString(36).slice(2, 10)}`;
    const a = await outbox.observeInbox('acme', source, messageId);
    const b = await outbox.observeInbox('globex', source, messageId);
    assert.equal(a.firstTime, true, 'acme: firstTime');
    assert.equal(b.firstTime, true, 'globex: firstTime (different tenant)');
  });

  it('inbox: same tenant + same messageId + different source is independent', async () => {
    const tenantId = 'acme';
    const messageId = `msg-srcdiff-${Math.random().toString(36).slice(2, 10)}`;
    const a = await outbox.observeInbox(tenantId, 'src-A', messageId);
    const b = await outbox.observeInbox(tenantId, 'src-B', messageId);
    assert.equal(a.firstTime, true, 'source A: firstTime');
    assert.equal(b.firstTime, true, 'source B: firstTime (different source)');
  });

  it('ackOutbox removes the record; second ack is a no-op', async () => {
    const channel = `ch-ack-${Math.random().toString(36).slice(2, 8)}`;
    const eventId = newOutboxEventId();
    const rec = await outbox.appendOutbox({ tenantId: 'acme', channel, eventId, eventType: 'x', payload: {} });
    assert.equal(await outbox.ackOutbox('acme', rec.id), true, 'first ack must succeed');
    assert.equal(await outbox.ackOutbox('acme', rec.id), false, 'second ack must be a no-op');
    const list = await outbox.listOutbox('acme', channel);
    assert.equal(list.length, 0, 'list must be empty after ack');
  });

  it('ackOutbox: tenant cannot ack a record owned by another tenant', async () => {
    const channel = `ch-acktenant-${Math.random().toString(36).slice(2, 8)}`;
    const eventId = newOutboxEventId();
    const rec = await outbox.appendOutbox({ tenantId: 'acme', channel, eventId, eventType: 'x', payload: {} });
    assert.equal(await outbox.ackOutbox('globex', rec.id), false, 'globex must not be able to ack acme record');
    const list = await outbox.listOutbox('acme', channel);
    assert.equal(list.length, 1, 'record must still be there');
  });
});
