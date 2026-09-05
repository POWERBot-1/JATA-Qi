import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CommercialControlPlaneModule, type CommercialActor } from '@jataqi/commercial-control-plane';
import {
  CommercialEventStreamModule,
  type CommercialEventStreamService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: ReturnType<CommercialControlPlaneModule['getService']>;
let stream: CommercialEventStreamService;

beforeEach(async () => {
  now = 1_000_000;
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  // Worker-semantics tests drive delivery through explicit pump() calls only
  // (no post-commit wake-up) so every claim/ack/retry transition is observable.
  kernel.register(new CommercialEventStreamModule({ now: () => now, wakeOnPublish: false }));
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService();
});

function registerContract() {
  stream.registerContract(admin, {
    eventType: 'test.event', eventVersion: 1, schemaVersion: 1,
    validate: (event) => typeof event.payload.value === 'number' ? [] : ['payload.value must be numeric'],
  });
}

async function event(value: unknown = 1) {
  return control.publishEvent(operator, {
    eventType: 'test.event', source: 'test', entityId: 'entity-1', correlationId: 'test-correlation', payload: { value },
    provenance: { source: 'test', collectedAt: now, correlationId: 'test-correlation' }, idempotencyKey: `event:${String(value)}:${now}`,
  });
}

describe('Commercial event stream', () => {
  it('validates a versioned contract and delivers each event to a handler exactly once', async () => {
    registerContract();
    let handled = 0;
    stream.registerHandler(admin, { id: 'handler-1', eventTypes: ['test.event'], async handle() { handled++; } });
    await event(3);
    const first = await stream.pump(operator);
    assert.equal(first.delivered, 1);
    assert.equal(handled, 1);
    const second = await stream.pump(operator);
    assert.equal(second.delivered, 0);
    assert.equal(handled, 1);
    assert.equal((await stream.listDeliveries(operator))[0]?.state, 'DELIVERED');
  });

  it('persists bounded retry state and retries only after exponential backoff', async () => {
    registerContract();
    let attempts = 0;
    stream.registerHandler(admin, {
      id: 'retry-handler', eventTypes: ['test.event'], maxAttempts: 3,
      async handle() { attempts++; if (attempts === 1) throw new Error('temporary failure'); },
    });
    await event(4);
    const first = await stream.pump(operator);
    assert.equal(first.retried, 1);
    assert.equal(attempts, 1);
    const pending = (await stream.listDeliveries(operator))[0]!;
    assert.equal(pending.state, 'RETRYING');
    assert.equal(pending.nextAttemptAt, now + 1_000);
    now += 999;
    await stream.pump(operator);
    assert.equal(attempts, 1);
    now += 1;
    const retried = await stream.pump(operator);
    assert.equal(retried.delivered, 1);
    assert.equal(attempts, 2);
  });

  it('moves repeated handler failures to a persisted dead-letter state', async () => {
    registerContract();
    stream.registerHandler(admin, { id: 'dead-handler', eventTypes: ['test.event'], maxAttempts: 2, async handle() { throw new Error('permanent failure'); } });
    await event(5);
    await stream.pump(operator);
    now += 1_000;
    const second = await stream.pump(operator);
    assert.equal(second.deadLettered, 1);
    const deadLetters = await stream.listDeadLetters(operator);
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]?.state, 'DEAD_LETTER');
  });

  it('records an invalid event contract as schema-rejected without invoking the handler', async () => {
    registerContract();
    let handled = 0;
    stream.registerHandler(admin, { id: 'schema-handler', eventTypes: ['test.event'], async handle() { handled++; } });
    await event('not-a-number');
    const result = await stream.pump(operator);
    assert.equal(result.schemaRejected, 1);
    assert.equal(handled, 0);
    assert.equal((await stream.listDeadLetters(operator))[0]?.state, 'SCHEMA_REJECTED');
  });

  it('keeps delivery records tenant-isolated', async () => {
    registerContract();
    stream.registerHandler(admin, { id: 'tenant-handler', eventTypes: ['test.event'], async handle() {} });
    await event(6);
    await stream.pump(operator);
    assert.equal((await stream.listDeliveries(other)).length, 0);
  });
});
