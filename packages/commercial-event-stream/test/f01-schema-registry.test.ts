import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CommercialControlPlaneModule, type CommercialActor } from '@jataqi/commercial-control-plane';
import {
  CommercialEventStreamError,
  CommercialEventStreamModule,
  type CommercialEventStreamService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let control: ReturnType<CommercialControlPlaneModule['getService']>;
let stream: CommercialEventStreamService;

beforeEach(async () => {
  now = 2_000_000;
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new CommercialEventStreamModule({ now: () => now }));
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService();
});

function registerV1() {
  stream.registerContract(admin, {
    eventType: 'governed.event', eventVersion: 1, schemaVersion: 1,
    validate: (event) => typeof event.payload.value === 'number' ? [] : ['payload.value must be numeric'],
  });
}

async function publishSchema(schemaVersion: number, key: string) {
  return control.publishEvent(operator, {
    eventType: 'governed.event', source: 'test', entityId: 'entity-1', correlationId: 'gov-correlation',
    schemaVersion,
    payload: { value: 7 },
    provenance: { source: 'test', collectedAt: now, correlationId: 'gov-correlation' },
    idempotencyKey: key,
  });
}

describe('F-01e schema registry version negotiation (G-8)', () => {
  it('resolves exact contracts and rejects unknown versions fail-closed by default', async () => {
    registerV1();
    assert.equal(stream.getCompatibilityPolicy('governed.event'), 'exact');
    const exact = stream.resolveContract('governed.event', 1, 1);
    assert.equal(exact?.fallback, false);
    assert.equal(exact?.contract.schemaVersion, 1);
    assert.equal(stream.resolveContract('governed.event', 1, 2), undefined);
    assert.equal(stream.resolveContract('governed.event', 2, 1), undefined);
    assert.equal(stream.resolveContract('unknown.event', 1, 1), undefined);
  });

  it('schema-rejects newer-schema events under the default exact policy', async () => {
    registerV1();
    let handled = 0;
    stream.registerHandler(admin, { id: 'handler-1', eventTypes: ['governed.event'], async handle() { handled++; } });
    await publishSchema(2, 'gov-new-schema');
    const result = await stream.pump(operator);
    assert.equal(result.delivered, 0);
    assert.equal(handled, 0);
    const [delivery] = await stream.listDeliveries(operator);
    assert.equal(delivery?.state, 'SCHEMA_REJECTED');
  });

  it('delivers newer-schema events through an explicit admin-registered fallback policy', async () => {
    registerV1();
    let handled = 0;
    stream.registerHandler(admin, { id: 'handler-1', eventTypes: ['governed.event'], async handle() { handled++; } });
    stream.setCompatibilityPolicy(admin, 'governed.event', 'fallback-previous-schema');
    const resolved = stream.resolveContract('governed.event', 1, 2);
    assert.equal(resolved?.fallback, true);
    assert.equal(resolved?.contract.schemaVersion, 1);
    await publishSchema(2, 'gov-fallback');
    const result = await stream.pump(operator);
    assert.equal(result.delivered, 1);
    assert.equal(handled, 1);
  });

  it('prefers the highest applicable lower schema and never a higher one', async () => {
    registerV1();
    stream.registerContract(admin, {
      eventType: 'governed.event', eventVersion: 1, schemaVersion: 3,
      validate: () => [],
    });
    stream.setCompatibilityPolicy(admin, 'governed.event', 'fallback-previous-schema');
    assert.equal(stream.resolveContract('governed.event', 1, 4)?.contract.schemaVersion, 3);
    assert.equal(stream.resolveContract('governed.event', 1, 2)?.contract.schemaVersion, 1);
    assert.equal(stream.resolveContract('governed.event', 1, 3)?.fallback, false);
  });

  it('restricts policy changes to administrators and known policies', async () => {
    assert.throws(
      () => stream.setCompatibilityPolicy(operator, 'governed.event', 'fallback-previous-schema'),
      CommercialEventStreamError,
    );
    assert.throws(
      () => stream.setCompatibilityPolicy(admin, 'governed.event', 'anything-goes' as never),
      /Unknown schema compatibility policy/,
    );
    assert.throws(() => stream.setCompatibilityPolicy(admin, '   ', 'exact'), /Event type is required/);
  });
});
