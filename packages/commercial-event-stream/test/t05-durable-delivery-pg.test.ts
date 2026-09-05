// T-05 canonical durable delivery over REAL PostgreSQL and REAL OS processes.
//
// Evidence for section E/F/G/H/L of T-05:
//   - transactional publication (rollback leaves no event, no outbox, no seq)
//   - exactly one process wins a claim; the loser never runs the effect
//   - hard crash while LEASED -> lease expiry -> another owner reclaims once
//   - the stale (crashed / superseded) owner cannot ack, retry, dead-letter,
//     quarantine or release the reclaimed record (durable fence, checked in
//     the same CAS as the write — not merely at start)
//   - crash AFTER the subscriber effect but BEFORE ack -> redelivery reaches
//     the idempotent effect once more (at-least-once, no exactly-once claim)
//     and the durable inbox row keeps a stable identity across processes
//   - the inbox identity `${eventId}:${handlerId}` survives a restart: a
//     fresh process never re-runs a DELIVERED handler
//   - tenant + principal provenance survive producer -> outbox -> worker ->
//     subscriber unchanged; a handler never receives another tenant's event
//
// PostgreSQL is a hard requirement (no silent skip).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { CommercialActor, CommercialEvent, UnifiedOutboxLease } from '@jataqi/commercial-control-plane';
import { inboxIdFor } from '../src/index.js';
import { bootWorkerKernel, dropDb, freshDb, pgAvailable, stopPg } from './pg-harness.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 't05-delivery-worker.mjs');

interface WorkerLine {
  workerId: string;
  event: string;
  [key: string]: unknown;
}

function runWorker(connectionString: string, mode: string, workerId: string, extra?: string): Promise<{ code: number | null; lines: WorkerLine[] }> {
  return new Promise((resolve, reject) => {
    const args = [WORKER, connectionString, mode, workerId];
    if (extra !== undefined) args.push(extra);
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (err += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = out
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as WorkerLine;
          } catch {
            return { workerId, event: 'unparseable', error: line };
          }
        });
      if (err.trim() && process.env.JATAQI_DEBUG_WORKER) console.warn(`[worker ${workerId}] ${err}`);
      resolve({ code, lines });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const operator: CommercialActor = { id: 'operator-acme', tenantId: 'acme', roles: ['operator'] };
const otherOperator: CommercialActor = { id: 'operator-other', tenantId: 'other', roles: ['operator'] };
const system: CommercialActor = { id: 't05-system', tenantId: 'system', roles: ['system'] };

let available = false;

before(async () => {
  available = await pgAvailable();
});

after(async () => {
  await stopPg();
});

function publishInput(eventType: string, key: string, payload: Record<string, unknown> = {}) {
  return {
    eventType,
    source: 't05-test',
    entityId: `entity:${key}`,
    correlationId: `corr:${key}`,
    payload: { marker: key, ...payload },
    provenance: { source: 't05-test', collectedAt: Date.now(), correlationId: `corr:${key}` },
    idempotencyKey: key,
  };
}

describe('T-05 durable delivery over real PostgreSQL (in-process workers, independent pools)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(available, 'DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  });

  it('B: a failure inside the composed publish rolls back event, outbox record and sequence together', async () => {
    const db = await freshDb();
    const node = await bootWorkerKernel(db.config, { wakeOnPublish: false }, () => Date.now());
    try {
      await node.control.publishEvent(operator, publishInput('t05.tx', 'tx-1'));
      // Compose a domain write with a publish, then fail AFTER the publish
      // inside the same scope: nothing may remain visible.
      await assert.rejects(
        node.storage.atomically(async (scope) => {
          const domain = await scope.collection<{ id: string; tenantId: string }>('t05.domain');
          await domain.put({ id: 'row-1', tenantId: 'acme' });
          await node.control.publishEvent(operator, publishInput('t05.tx', 'tx-2'), { scope });
          throw new Error('injected failure after publish');
        }),
        /injected failure after publish/,
      );
      const domain = await node.storage.collection<{ id: string; tenantId: string }>('t05.domain');
      assert.equal(await domain.get('row-1'), undefined, 'domain row must be rolled back');
      const outbox = await node.control.replayUnifiedOutbox(operator, {});
      assert.deepEqual(outbox.map((record) => record.envelope.idempotencyKey ?? (record.envelope.payload as { marker: string }).marker), ['tx-1']);
      const events = await node.control.replayEvents(operator, {});
      assert.equal(events.length, 1);
      // The per-tenant sequence did not advance for the rolled-back publish.
      const next = await node.control.publishEvent(operator, publishInput('t05.tx', 'tx-3'));
      assert.equal(next.sequence, 2);
      const integrity = await node.control.verifyUnifiedOutboxIntegrity(operator);
      assert.equal(integrity.valid, true);
      // The publish lock was released on rollback (a second publish did not deadlock above).
    } finally {
      await node.close();
      await dropDb(db.database);
    }
  });

  it('B: a committed composed write makes state + event + outbox visible together and the bus fires only after commit', async () => {
    const db = await freshDb();
    const node = await bootWorkerKernel(db.config, { wakeOnPublish: false }, () => Date.now());
    try {
      const seen: Array<{ topic: string; committed: boolean }> = [];
      const domain = await node.storage.collection<{ id: string; tenantId: string; state: string }>('t05.domain');
      const unsubscribe = node.kernel.bus.onEnveloped('t05.tx.committed', async () => {
        // When the bus fires, the domain row must already be committed.
        const row = await domain.get('row-c');
        seen.push({ topic: 't05.tx.committed', committed: row?.state === 'WRITTEN' });
      });
      await node.storage.atomically(async (scope) => {
        const scoped = await scope.collection<{ id: string; tenantId: string; state: string }>('t05.domain');
        await scoped.put({ id: 'row-c', tenantId: 'acme', state: 'WRITTEN' });
        await node.control.publishEvent(operator, publishInput('t05.tx.committed', 'tx-c'), { scope });
        // Not visible to another connection before commit.
        assert.equal(await domain.get('row-c'), undefined);
        assert.equal(seen.length, 0, 'bus must not fire inside the transaction');
      });
      unsubscribe();
      assert.deepEqual(seen, [{ topic: 't05.tx.committed', committed: true }]);
      assert.equal((await domain.get('row-c'))?.state, 'WRITTEN');
      assert.equal((await node.control.replayUnifiedOutbox(operator, {})).length, 1);
    } finally {
      await node.close();
      await dropDb(db.database);
    }
  });

  it('E/G: two independent workers deliver each event exactly once to the handler; the inbox row is the durable proof', async () => {
    const db = await freshDb();
    let clock = Date.now();
    const now = () => clock;
    const a = await bootWorkerKernel(db.config, { workerId: 'worker-a', wakeOnPublish: false }, now);
    const b = await bootWorkerKernel(db.config, { workerId: 'worker-b', wakeOnPublish: false }, now);
    try {
      const handled = new Map<string, number>();
      for (const [node, name] of [[a, 'a'], [b, 'b']] as const) {
        node.stream.registerHandler(system, {
          id: 't05.counter',
          eventTypes: ['t05.race'],
          async handle(event) {
            handled.set(event.id, (handled.get(event.id) ?? 0) + 1);
            void name;
          },
        });
      }
      const events: CommercialEvent[] = [];
      for (let i = 0; i < 12; i += 1) events.push(await a.control.publishEvent(operator, publishInput('t05.race', `race-${i}`)));
      // Both workers pump concurrently, several rounds.
      for (let round = 0; round < 3; round += 1) {
        await Promise.all([a.stream.pump(system, { allTenants: true }), b.stream.pump(system, { allTenants: true })]);
      }
      for (const event of events) assert.equal(handled.get(event.id), 1, `event ${event.id} must be handled exactly once`);
      const records = await a.control.replayUnifiedOutbox(operator, {});
      assert.equal(records.length, 12);
      assert.ok(records.every((record) => record.state === 'DELIVERED'));
      assert.ok(records.every((record) => record.leaseGeneration === 1), 'every record was claimed exactly once');
      const inbox = await a.stream.listDeliveries(operator);
      assert.equal(inbox.length, 12);
      for (const event of events) {
        const row = await b.stream.getDelivery(operator, event.id, 't05.counter');
        assert.equal(row?.id, inboxIdFor(event.id, 't05.counter'));
        assert.equal(row?.state, 'DELIVERED');
        assert.equal(row?.attemptCount, 1);
      }
    } finally {
      await a.close();
      await b.close();
      await dropDb(db.database);
    }
  });

  it('F: a stale owner (expired + re-claimed lease) cannot ack, retry, dead-letter, quarantine or release; the fresh owner can', async () => {
    const db = await freshDb();
    let clock = Date.now();
    const now = () => clock;
    const a = await bootWorkerKernel(db.config, { workerId: 'worker-a', wakeOnPublish: false }, now);
    const b = await bootWorkerKernel(db.config, { workerId: 'worker-b', wakeOnPublish: false }, now);
    try {
      const event = await a.control.publishEvent(operator, publishInput('t05.fence', 'fence-1'));
      const outboxA = a.control.getUnifiedOutbox();
      const outboxB = b.control.getUnifiedOutbox();
      const [first] = await outboxA.claim({ owner: 'worker-a', now: clock, leaseTtlMs: 1_000, limit: 5, eventTypes: ['t05.fence'] });
      assert.ok(first);
      assert.equal(first.lease.leaseGeneration, 1);
      // Still leased and unexpired: nobody else can claim it.
      assert.equal((await outboxB.claim({ owner: 'worker-b', now: clock + 500, leaseTtlMs: 1_000, limit: 5, eventTypes: ['t05.fence'] })).length, 0);
      // Expiry: worker-b re-claims with a new generation + token.
      clock += 2_000;
      const [second] = await outboxB.claim({ owner: 'worker-b', now: clock, leaseTtlMs: 1_000, limit: 5, eventTypes: ['t05.fence'] });
      assert.ok(second);
      assert.equal(second.lease.leaseGeneration, 2);
      assert.notEqual(second.lease.leaseToken, first.lease.leaseToken);
      assert.equal(second.lease.attemptCount, 2);
      // The stale owner's lease is refused for every finalising transition.
      const stale: UnifiedOutboxLease = first.lease;
      assert.equal(await outboxA.ackLeased(stale, clock), false);
      assert.equal(await outboxA.scheduleRetry(stale, 'stale', clock + 1_000, clock), false);
      assert.equal(await outboxA.deadLetterLeased(stale, 'stale', clock), false);
      assert.equal(await outboxA.quarantineLeased(stale, 'stale', clock), false);
      assert.equal(await outboxA.release(stale, clock), false);
      // A forged lease with the right generation but wrong token is refused too.
      assert.equal(await outboxA.ackLeased({ ...second.lease, leaseToken: 'forged' }, clock), false);
      // Admin-style ack (generation-0 only) is refused on a claimed record.
      assert.equal(await outboxA.ack('acme', second.record.id, clock), false);
      const current = (await a.control.replayUnifiedOutbox(operator, {})).find((record) => record.eventId === event.id);
      assert.equal(current?.state, 'LEASED');
      assert.equal(current?.leaseOwner, 'worker-b');
      // The fresh owner finalises; afterwards even it cannot finalise twice.
      assert.equal(await outboxB.ackLeased(second.lease, clock), true);
      assert.equal(await outboxB.ackLeased(second.lease, clock), false);
      const delivered = (await a.control.replayUnifiedOutbox(operator, {})).find((record) => record.eventId === event.id);
      assert.equal(delivered?.state, 'DELIVERED');
      assert.equal(delivered?.leaseOwner, undefined);
      assert.equal(delivered?.leaseGeneration, 2);
      assert.equal((await a.control.verifyUnifiedOutboxIntegrity(operator)).valid, true);
    } finally {
      await a.close();
      await b.close();
      await dropDb(db.database);
    }
  });

  it('F/G: a worker whose lease was re-claimed mid-delivery cannot settle the inbox or the outbox for the newer attempt', async () => {
    const db = await freshDb();
    let clock = Date.now();
    const now = () => clock;
    const a = await bootWorkerKernel(db.config, { workerId: 'worker-a', wakeOnPublish: false }, now);
    const b = await bootWorkerKernel(db.config, { workerId: 'worker-b', wakeOnPublish: false }, now);
    try {
      const invocations: string[] = [];
      let releaseSlow: (() => void) | undefined;
      const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
      // Worker A's handler stalls (models a GC pause / network stall longer than the lease).
      a.stream.registerHandler(system, {
        id: 't05.slow',
        eventTypes: ['t05.stall'],
        async handle(event) {
          invocations.push(`a:${event.id}`);
          await slowGate;
        },
      });
      b.stream.registerHandler(system, {
        id: 't05.slow',
        eventTypes: ['t05.stall'],
        async handle(event) {
          invocations.push(`b:${event.id}`);
        },
      });
      const event = await a.control.publishEvent(operator, publishInput('t05.stall', 'stall-1'));
      const pumpA = a.stream.pump(system, { allTenants: true, leaseTtlMs: 200 });
      // Wait until A is inside the handler.
      while (!invocations.some((entry) => entry.startsWith('a:'))) await sleep(5);
      // Lease expires; B re-claims (generation 2) and completes delivery.
      clock += 1_000;
      const resultB = await b.stream.pump(system, { allTenants: true });
      assert.equal(resultB.delivered, 1);
      assert.deepEqual(invocations, [`a:${event.id}`, `b:${event.id}`]);
      // A resumes and tries to settle: every write is refused by the fence.
      releaseSlow!();
      const resultA = await pumpA;
      assert.equal(resultA.delivered, 0);
      assert.ok(resultA.fenceRejected >= 1, `stale owner must be fence-rejected, got ${JSON.stringify(resultA)}`);
      const row = await a.stream.getDelivery(operator, event.id, 't05.slow');
      assert.equal(row?.state, 'DELIVERED');
      assert.equal(row?.leaseOwner, 'worker-b');
      assert.equal(row?.leaseGeneration, 2);
      assert.equal(row?.attemptCount, 2, 'attempts are counted at claim: A then B');
      const record = (await a.control.replayUnifiedOutbox(operator, {})).find((entry) => entry.eventId === event.id);
      assert.equal(record?.state, 'DELIVERED');
      assert.equal(record?.leaseGeneration, 2);
    } finally {
      await a.close();
      await b.close();
      await dropDb(db.database);
    }
  });

  it('H: retry is bounded with backoff, dead-letters after maxAttempts, and a poison record is quarantined — all durable and visible read-only', async () => {
    const db = await freshDb();
    let clock = Date.now();
    const now = () => clock;
    const a = await bootWorkerKernel(db.config, { workerId: 'worker-a', wakeOnPublish: false }, now);
    try {
      let attempts = 0;
      a.stream.registerHandler(system, {
        id: 't05.flaky',
        eventTypes: ['t05.flaky'],
        maxAttempts: 2,
        async handle() {
          attempts += 1;
          throw new Error(`boom ${attempts}`);
        },
      });
      const event = await a.control.publishEvent(operator, publishInput('t05.flaky', 'flaky-1'));
      const first = await a.stream.pump(system, { allTenants: true });
      assert.equal(first.retried, 1);
      let record = (await a.control.replayUnifiedOutbox(operator, {}))[0]!;
      assert.equal(record.state, 'RETRYING');
      assert.equal(record.nextAttemptAt, clock + 1_000);
      assert.equal(record.lastError, 'boom 1');
      // Not due yet: nothing claimed, handler not invoked.
      clock += 999;
      assert.equal((await a.stream.pump(system, { allTenants: true })).examined, 0);
      assert.equal(attempts, 1);
      clock += 1;
      const second = await a.stream.pump(system, { allTenants: true });
      assert.equal(second.deadLettered, 1);
      assert.equal(attempts, 2);
      record = (await a.control.replayUnifiedOutbox(operator, {}))[0]!;
      assert.equal(record.state, 'DEAD_LETTER');
      assert.equal(record.attemptCount, 2);
      assert.equal(record.lastError, 'boom 2');
      // Dead letter is terminal: further pumps never invoke the handler again.
      clock += 100_000;
      assert.equal((await a.stream.pump(system, { allTenants: true })).examined, 0);
      assert.equal(attempts, 2);
      const dead = await a.stream.listDeadLetters(operator);
      assert.equal(dead.length, 1);
      assert.equal(dead[0]?.id, inboxIdFor(event.id, 't05.flaky'));
      assert.equal(dead[0]?.state, 'DEAD_LETTER');

      // Poison: tamper with a record's envelope hash; the worker quarantines it under its lease.
      const poisoned = await a.control.publishEvent(operator, publishInput('t05.flaky', 'poison-1'));
      const raw = await a.storage.collection<{ id: string; eventId: string; hash: string }>('commercial-control.unified-outbox');
      const target = (await raw.all()).find((row) => row.eventId === poisoned.id)!;
      await raw.put({ ...target, hash: 'f'.repeat(64) });
      const third = await a.stream.pump(system, { allTenants: true });
      assert.equal(third.quarantined, 1);
      assert.equal(attempts, 2, 'a corrupt record never reaches a handler');
      const quarantined = (await a.control.replayUnifiedOutbox(operator, {})).find((row) => row.eventId === poisoned.id);
      assert.equal(quarantined?.state, 'QUARANTINED');
      assert.match(quarantined?.lastError ?? '', /hash/i);
      clock += 100_000;
      assert.equal((await a.stream.pump(system, { allTenants: true })).examined, 0, 'quarantine is never auto-redelivered');
    } finally {
      await a.close();
      await dropDb(db.database);
    }
  });

  it('L/G: after a restart a fresh process adopts the same inbox identity and never re-runs a DELIVERED handler', async () => {
    const db = await freshDb();
    const clock = () => Date.now();
    let first = await bootWorkerKernel(db.config, { workerId: 'worker-restart-1', wakeOnPublish: false }, clock);
    const calls: string[] = [];
    const register = (node: typeof first, tag: string) =>
      node.stream.registerHandler(system, { id: 't05.restart', eventTypes: ['t05.restart'], async handle(event) { calls.push(`${tag}:${event.id}`); } });
    try {
      register(first, 'first');
      const event = await first.control.publishEvent(operator, publishInput('t05.restart', 'restart-1'));
      await first.stream.pump(system, { allTenants: true });
      assert.deepEqual(calls, [`first:${event.id}`]);
      await first.close();
      // "Restart": a brand-new process-equivalent with a new pool and a new worker id.
      const second = await bootWorkerKernel(db.config, { workerId: 'worker-restart-2', wakeOnPublish: false }, clock);
      first = second;
      register(second, 'second');
      const result = await second.stream.pump(system, { allTenants: true });
      assert.equal(result.examined, 0);
      assert.deepEqual(calls, [`first:${event.id}`], 'a DELIVERED event is never redelivered after restart');
      const row = await second.stream.getDelivery(operator, event.id, 't05.restart');
      assert.equal(row?.id, `${event.id}:t05.restart`);
      assert.equal(row?.state, 'DELIVERED');
      // A new event after the restart is delivered by the new process.
      const next = await second.control.publishEvent(operator, publishInput('t05.restart', 'restart-2'));
      await second.stream.pump(system, { allTenants: true });
      assert.deepEqual(calls, [`first:${event.id}`, `second:${next.id}`]);
    } finally {
      await first.close();
      await dropDb(db.database);
    }
  });

  it('J: tenant and principal provenance survive producer -> outbox -> worker -> subscriber; a per-tenant pump never delivers foreign events', async () => {
    const db = await freshDb();
    const clock = () => Date.now();
    const node = await bootWorkerKernel(db.config, { workerId: 'worker-tenant', wakeOnPublish: false }, clock);
    try {
      const received: CommercialEvent[] = [];
      node.stream.registerHandler(system, { id: 't05.tenant', eventTypes: ['t05.tenant'], async handle(event) { received.push(event); } });
      const acme = await node.control.publishEvent(operator, publishInput('t05.tenant', 'acme-1'));
      const other = await node.control.publishEvent(otherOperator, publishInput('t05.tenant', 'other-1'));
      // An operator-scoped pump only touches its own tenant.
      const acmePump = await node.stream.pump(operator);
      assert.equal(acmePump.delivered, 1);
      assert.deepEqual(received.map((event) => event.id), [acme.id]);
      assert.equal(received[0]?.tenantId, 'acme');
      assert.equal(received[0]?.actor, operator.id);
      assert.equal(received[0]?.correlationId, 'corr:acme-1');
      assert.equal(received[0]?.provenance.source, 't05-test');
      assert.equal(received[0]?.sequence, acme.sequence);
      assert.deepEqual(received[0]?.payload, acme.payload);
      // Cross-tenant pump without the system role is refused fail-closed.
      await assert.rejects(node.stream.pump(operator, { allTenants: true }), /system or global_admin/);
      // The other tenant's record is still PENDING and invisible to acme's reads.
      assert.equal((await node.control.replayUnifiedOutbox(otherOperator, {}))[0]?.state, 'PENDING');
      assert.equal((await node.stream.listDeliveries(operator)).every((row) => row.tenantId === 'acme'), true);
      assert.equal((await node.stream.listDeliveries(otherOperator)).length, 0);
      // The system worker delivers the rest under the RECORD's tenant.
      await node.stream.pump(system, { allTenants: true });
      assert.deepEqual(received.map((event) => event.id), [acme.id, other.id]);
      assert.equal(received[1]?.tenantId, 'other');
      assert.equal(received[1]?.actor, otherOperator.id);
      assert.equal((await node.stream.getDelivery(otherOperator, other.id, 't05.tenant'))?.tenantId, 'other');
      assert.equal(await node.stream.getDelivery(operator, other.id, 't05.tenant'), undefined, 'tenant reads never cross');
    } finally {
      await node.close();
      await dropDb(db.database);
    }
  });
});

describe('T-05 durable delivery across REAL OS processes (one authoritative PostgreSQL)', () => {
  it('E: two separate processes racing the same outbox records: every event is delivered by exactly one process', async () => {
    assert.ok(available, 'DATABASE INTEGRATION NOT EXECUTED');
    const db = await freshDb();
    const producer = await bootWorkerKernel(db.config, { wakeOnPublish: false }, () => Date.now());
    try {
      // The child processes' effect collection is created up front so the
      // race below measures delivery ownership, not first-boot DDL.
      await producer.storage.collection('t05.effects');
      const events: CommercialEvent[] = [];
      for (let i = 0; i < 10; i += 1) events.push(await producer.control.publishEvent(operator, publishInput('t05.mp.race', `mp-race-${i}`)));
      const [a, b] = await Promise.all([
        runWorker(db.connectionString, 'compete', 'proc-a', 't05.mp.race'),
        runWorker(db.connectionString, 'compete', 'proc-b', 't05.mp.race'),
      ]);
      assert.equal(a.code, 0, JSON.stringify(a.lines));
      assert.equal(b.code, 0, JSON.stringify(b.lines));
      const effects = [...a.lines, ...b.lines].filter((line) => line.event === 'effect');
      const byEvent = new Map<string, string[]>();
      for (const effect of effects) byEvent.set(String(effect.eventId), [...(byEvent.get(String(effect.eventId)) ?? []), effect.workerId]);
      for (const event of events) assert.deepEqual((byEvent.get(event.id) ?? []).length, 1, `event ${event.id} delivered by exactly one process (got ${JSON.stringify(byEvent.get(event.id))})`);
      const durable = await producer.storage.collection<{ id: string; eventId: string; workerId: string; times: number }>('t05.effects');
      const rows = await durable.all();
      assert.equal(rows.length, 10);
      assert.ok(rows.every((row) => row.times === 1));
      const records = await producer.control.replayUnifiedOutbox(operator, {});
      assert.ok(records.every((record) => record.state === 'DELIVERED' && record.leaseGeneration === 1));
      const pumped = [...a.lines, ...b.lines].filter((line) => line.event === 'pumped').map((line) => line.result as { delivered: number });
      assert.equal(pumped.reduce((sum, result) => sum + result.delivered, 0), 10);
    } finally {
      await producer.close();
      await dropDb(db.database);
    }
  });

  it('E/F/L: a process that dies HARD while holding leases is reclaimed exactly once after expiry, and the dead owner\'s lease is fenced forever', async () => {
    assert.ok(available, 'DATABASE INTEGRATION NOT EXECUTED');
    const db = await freshDb();
    const producer = await bootWorkerKernel(db.config, { wakeOnPublish: false }, () => Date.now());
    try {
      const events: CommercialEvent[] = [];
      for (let i = 0; i < 3; i += 1) events.push(await producer.control.publishEvent(operator, publishInput('t05.mp.crash', `mp-crash-${i}`)));
      const crashed = await runWorker(db.connectionString, 'crash', 'proc-crash', 't05.mp.crash');
      assert.equal(crashed.code, 9, JSON.stringify(crashed.lines));
      const leased = crashed.lines.find((line) => line.event === 'leased-then-crashing');
      assert.ok(leased);
      const leases = leased.leases as Array<{ recordId: string; generation: number }>;
      assert.equal(leases.length, 3);
      // Immediately after the crash the leases are still live: a survivor claims nothing.
      const early = await runWorker(db.connectionString, 'compete', 'proc-early', 't05.mp.crash');
      assert.equal(early.code, 0);
      assert.equal(early.lines.filter((line) => line.event === 'effect').length, 0, 'an unexpired lease of a dead process is not stolen');
      let records = await producer.control.replayUnifiedOutbox(operator, {});
      assert.ok(records.every((record) => record.state === 'LEASED' && record.leaseOwner === 'proc-crash'));
      // Lease TTL in the worker is 1.5 s; wait for expiry, then a survivor reclaims exactly once.
      await sleep(1_700);
      const survivor = await runWorker(db.connectionString, 'compete', 'proc-survivor', 't05.mp.crash');
      assert.equal(survivor.code, 0, JSON.stringify(survivor.lines));
      assert.equal(survivor.lines.filter((line) => line.event === 'effect').length, 3);
      records = await producer.control.replayUnifiedOutbox(operator, {});
      assert.ok(records.every((record) => record.state === 'DELIVERED' && record.leaseGeneration === 2 && record.attemptCount === 2));
      // The dead process "comes back" with its old leases (token unknown to it, generation 1): every finalising write is refused.
      const stale = crashed.lines.find((line) => line.event === 'leased-then-crashing')!;
      void stale;
      const staleLease: UnifiedOutboxLease = {
        recordId: leases[0]!.recordId,
        tenantId: 'acme',
        eventId: events.find((event) => records.find((record) => record.id === leases[0]!.recordId)?.eventId === event.id)!.id,
        leaseOwner: 'proc-crash',
        leaseToken: 'unknown-token',
        leaseGeneration: 1,
        leaseExpiry: 0,
        attemptCount: 1,
      };
      const zombie = await runWorker(db.connectionString, 'stale-ack', 'proc-crash', JSON.stringify(staleLease));
      assert.equal(zombie.code, 0, JSON.stringify(zombie.lines));
      const attempts = zombie.lines.find((line) => line.event === 'stale-attempts')!;
      assert.deepEqual(
        { acked: attempts.acked, deadLettered: attempts.deadLettered, quarantined: attempts.quarantined, retried: attempts.retried, released: attempts.released },
        { acked: false, deadLettered: false, quarantined: false, retried: false, released: false },
      );
      records = await producer.control.replayUnifiedOutbox(operator, {});
      assert.ok(records.every((record) => record.state === 'DELIVERED'));
      assert.equal((await producer.control.verifyUnifiedOutboxIntegrity(operator)).valid, true);
    } finally {
      await producer.close();
      await dropDb(db.database);
    }
  });

  it('H: crash AFTER the subscriber effect but BEFORE ack -> redelivery reaches the idempotent effect again (at-least-once) and finalises once', async () => {
    assert.ok(available, 'DATABASE INTEGRATION NOT EXECUTED');
    const db = await freshDb();
    const producer = await bootWorkerKernel(db.config, { wakeOnPublish: false }, () => Date.now());
    try {
      const event = await producer.control.publishEvent(operator, publishInput('t05.mp.effect', 'mp-effect-1'));
      const crashed = await runWorker(db.connectionString, 'crash-after-effect', 'proc-effect', 't05.mp.effect');
      assert.equal(crashed.code, 9, JSON.stringify(crashed.lines));
      assert.ok(crashed.lines.some((line) => line.event === 'effect' && line.eventId === event.id));
      const effects = await producer.storage.collection<{ id: string; eventId: string; workerId: string; times: number }>('t05.effects');
      assert.equal((await effects.get(`${event.id}:proc-effect`))?.times, 1, 'the effect committed before the crash');
      // Durable state after the crash: inbox CLAIMED (attempt 1), outbox LEASED by the dead process.
      const inboxAfterCrash = await producer.stream.getDelivery(operator, event.id, 't05.process-effect');
      assert.equal(inboxAfterCrash?.state, 'CLAIMED');
      assert.equal(inboxAfterCrash?.attemptCount, 1);
      assert.equal(inboxAfterCrash?.leaseOwner, 'proc-effect');
      let record = (await producer.control.replayUnifiedOutbox(operator, {}))[0]!;
      assert.equal(record.state, 'LEASED');
      assert.equal(record.leaseOwner, 'proc-effect');
      await sleep(1_700);
      // The SAME worker id restarts: its idempotent effect is re-applied (times=2 proves at-least-once, not exactly-once),
      // and the inbox/outbox finalise under generation 2.
      const restarted = await runWorker(db.connectionString, 'compete', 'proc-effect', 't05.mp.effect');
      assert.equal(restarted.code, 0, JSON.stringify(restarted.lines));
      assert.equal(restarted.lines.filter((line) => line.event === 'effect').length, 1);
      assert.equal((await effects.get(`${event.id}:proc-effect`))?.times, 2, 'at-least-once: the effect ran again; the subscriber keyed it idempotently');
      const inbox = await producer.stream.getDelivery(operator, event.id, 't05.process-effect');
      assert.equal(inbox?.state, 'DELIVERED');
      assert.equal(inbox?.attemptCount, 2);
      assert.equal(inbox?.leaseGeneration, 2);
      record = (await producer.control.replayUnifiedOutbox(operator, {}))[0]!;
      assert.equal(record.state, 'DELIVERED');
      assert.equal(record.leaseGeneration, 2);
      // A third process finds nothing to do.
      const later = await runWorker(db.connectionString, 'compete', 'proc-late', 't05.mp.effect');
      assert.equal(later.lines.filter((line) => line.event === 'effect').length, 0);
      assert.equal((await effects.get(`${event.id}:proc-effect`))?.times, 2);
    } finally {
      await producer.close();
      await dropDb(db.database);
    }
  });
});
