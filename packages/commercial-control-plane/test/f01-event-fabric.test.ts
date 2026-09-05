import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { isEventEnvelope, type EventEnvelope, type Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneEvents,
  CommercialControlPlaneModule,
  commercialEventFromEnvelope,
  type CommercialActor,
  type CommercialEvent,
  type CommercialControlPlaneService,
  type PublishCommercialEventInput,
} from '../src/index.js';

let now: number;
let kernel: Kernel;
let admin: CommercialActor;
let otherTenant: CommercialActor;
let service: CommercialControlPlaneService;

function eventInput(overrides: Partial<PublishCommercialEventInput> = {}): PublishCommercialEventInput {
  return {
    eventType: 'f01.test.event',
    source: 'f01-test',
    correlationId: 'corr-f01',
    payload: { marker: 'f01' },
    provenance: { source: 'f01-test', collectedAt: now, correlationId: 'corr-f01' },
    ...overrides,
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin-1', tenantId: 'acme', roles: ['admin'] };
  otherTenant = { id: 'other-admin', tenantId: 'other', roles: ['admin'] };
  kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  await kernel.boot();
  service = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
});

describe('F-01c CAS event sequencing (G-4)', () => {
  it('assigns unique contiguous per-tenant sequences under concurrent publish', async () => {
    const count = 30;
    const events = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        service.publishEvent(admin, eventInput({ idempotencyKey: `conc-${index}`, correlationId: `corr-${index}` })),
      ),
    );
    const sequences = events.map((event) => event.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(new Set(events.map((event) => event.id)).size, count);
  });

  it('sequences are per-tenant isolated', async () => {
    for (let index = 0; index < 5; index += 1) {
      await service.publishEvent(admin, eventInput({ idempotencyKey: `a-${index}` }));
    }
    for (let index = 0; index < 3; index += 1) {
      await service.publishEvent(otherTenant, eventInput({ idempotencyKey: `b-${index}` }));
    }
    const tenantA = (await service.replayEvents(admin, {})).map((event) => event.sequence);
    const tenantB = (await service.replayEvents(otherTenant, {})).map((event) => event.sequence);
    assert.deepEqual([...tenantA].sort((x, y) => x - y), [1, 2, 3, 4, 5]);
    assert.deepEqual([...tenantB].sort((x, y) => x - y), [1, 2, 3]);
  });

  it('initializes the counter from the pre-F-01 maximum sequence without collision', async () => {
    const storage = kernel.getModule<StorageModule>('storage');
    const events = await storage.collection<CommercialEvent>('commercial-control.events');
    const legacy = (sequence: number): CommercialEvent => ({
      id: `legacy-${sequence}`,
      sequence,
      eventType: 'f01.legacy',
      eventVersion: 1,
      tenantId: 'acme',
      source: 'legacy',
      actor: 'legacy',
      timestamp: now,
      correlationId: 'corr-legacy',
      payload: {},
      schemaVersion: 1,
      provenance: { source: 'legacy', collectedAt: now },
      privacyClassification: 'INTERNAL',
    });
    await events.put(legacy(10));
    await events.put(legacy(25));
    const next = await service.publishEvent(admin, eventInput({ idempotencyKey: 'post-legacy' }));
    assert.equal(next.sequence, 26);
  });

  it('idempotent republish returns the same event and a single unified-outbox record', async () => {
    const input = eventInput({ idempotencyKey: 'idem-once' });
    const first = await service.publishEvent(admin, input);
    const second = await service.publishEvent(admin, input);
    assert.equal(first.id, second.id);
    assert.equal(first.sequence, second.sequence);
    const replayed = await service.replayUnifiedOutbox(admin, { eventTypes: ['f01.test.event'] });
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]!.eventId, first.id);
  });
});

describe('F-01d unified durable outbox (G-5)', () => {
  it('persists every published event with envelope snapshot, chain links, and ordering', async () => {
    const published = [
      await service.publishEvent(admin, eventInput({ idempotencyKey: 'o-1' })),
      await service.publishEvent(admin, eventInput({ idempotencyKey: 'o-2', eventType: 'f01.other' })),
      await service.publishEvent(admin, eventInput({ idempotencyKey: 'o-3' })),
    ];
    const replayed = await service.replayUnifiedOutbox(admin, {});
    assert.equal(replayed.length, 3);
    assert.deepEqual(
      replayed.map((record) => record.eventId),
      published.map((event) => event.id),
    );
    for (const record of replayed) {
      assert.ok(isEventEnvelope(record.envelope));
      assert.equal(record.envelope.id, record.eventId);
      assert.equal(record.tenantId, 'acme');
      assert.equal(record.state, 'PENDING');
      assert.equal(record.hashVersion, 1);
      assert.ok(record.hash.trim().length > 0);
    }
    assert.deepEqual(await service.verifyUnifiedOutboxIntegrity(admin), {
      tenantId: 'acme',
      valid: true,
      entries: 3,
    });
  });

  it('supports afterSequence, eventTypes, channel, and state filters', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'f-1', eventType: 'f01.alpha' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'f-2', eventType: 'f01.beta' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'f-3', eventType: 'f01.alpha' }));
    const first = (await service.replayUnifiedOutbox(admin, {}))[0]!;
    assert.equal((await service.replayUnifiedOutbox(admin, { afterSequence: first.sequence })).length, 2);
    assert.equal((await service.replayUnifiedOutbox(admin, { eventTypes: ['f01.beta'] })).length, 1);
    assert.equal((await service.replayUnifiedOutbox(admin, { channel: 'f01.alpha' })).length, 2);
    assert.equal((await service.replayUnifiedOutbox(admin, { states: ['PENDING'] })).length, 3);
    assert.equal((await service.replayUnifiedOutbox(admin, { states: ['DELIVERED'] })).length, 0);
  });

  it('acks are tenant-guarded and idempotent; replay reflects delivery state', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'ack-1' }));
    const [record] = await service.replayUnifiedOutbox(admin, {});
    assert.ok(record);
    assert.equal(await service.getUnifiedOutbox().ack('other', record!.id), false);
    assert.equal(await service.getUnifiedOutbox().ack('acme', record!.id), true);
    assert.equal(await service.getUnifiedOutbox().ack('acme', record!.id), true);
    assert.equal((await service.replayUnifiedOutbox(admin, { states: ['PENDING'] })).length, 0);
    assert.equal((await service.replayUnifiedOutbox(admin, { states: ['DELIVERED'] })).length, 1);
  });

  it('detects tampering and deletion fail-closed', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 't-1' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 't-2' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 't-3' }));
    const storage = kernel.getModule<StorageModule>('storage');
    const records = await storage.collection<{
      id: string;
      envelope: EventEnvelope;
      hash: string;
    }>('commercial-control.unified-outbox');
    const all = await records.all();
    assert.equal(all.length, 3);
    // Tamper: flip a payload in the middle record.
    const middle = all[1]!;
    await records.put({
      ...middle,
      envelope: { ...middle.envelope, payload: { marker: 'forged' } },
    });
    const tampered = await service.verifyUnifiedOutboxIntegrity(admin);
    assert.equal(tampered.valid, false);
    assert.ok(tampered.brokenAt !== undefined);
    assert.match(tampered.reason ?? '', /hash does not match/);
  });

  it('detects deletion of a middle record via chain linkage', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'd-1' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'd-2' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'd-3' }));
    const storage = kernel.getModule<StorageModule>('storage');
    const records = await storage.collection<{ id: string }>('commercial-control.unified-outbox');
    const before = await service.replayUnifiedOutbox(admin, {});
    assert.equal(before.length, 3);
    await records.delete(before[1]!.id);
    const afterDelete = await service.verifyUnifiedOutboxIntegrity(admin);
    assert.equal(afterDelete.valid, false);
    assert.match(afterDelete.reason ?? '', /previous hash does not match/);
  });

  it('quarantines corrupt records without breaking integrity of the chain', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'q-1' }));
    const [record] = await service.replayUnifiedOutbox(admin, {});
    assert.ok(record);
    assert.equal(await service.getUnifiedOutbox().quarantine('acme', record!.id, 'envelope failed validation on read'), true);
    assert.equal((await service.replayUnifiedOutbox(admin, { states: ['PENDING'] })).length, 0);
    assert.equal((await service.replayUnifiedOutbox(admin, { states: ['QUARANTINED'] })).length, 1);
    assert.equal((await service.replayUnifiedOutbox(admin, {})).length, 1);
    assert.deepEqual(await service.verifyUnifiedOutboxIntegrity(admin), {
      tenantId: 'acme',
      valid: true,
      entries: 1,
    });
  });

  it('replay is tenant-isolated: other tenants see nothing', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'iso-1' }));
    assert.equal((await service.replayUnifiedOutbox(otherTenant, {})).length, 0);
    assert.deepEqual(await service.verifyUnifiedOutboxIntegrity(otherTenant), {
      tenantId: 'other',
      valid: true,
      entries: 0,
    });
  });

  it('rejects malformed envelopes fail-closed (G-9/constraint 19)', async () => {
    await assert.rejects(
      service.getUnifiedOutbox().publish({ docId: 'not-an-envelope' } as unknown as EventEnvelope),
      /valid EventEnvelope/,
    );
    await assert.rejects(service.publishEvent(admin, eventInput({ eventType: '   ' })), /Event type is required/);
  });
});

describe('F-01f commercialEventFromEnvelope reconstruction', () => {
  it('rebuilds the CommercialEvent view from a first-class envelope', async () => {
    const event = await service.publishEvent(admin, eventInput({ idempotencyKey: 'recon-1' }));
    const [record] = await service.replayUnifiedOutbox(admin, {});
    assert.ok(record);
    const rebuilt = commercialEventFromEnvelope(record!.envelope);
    assert.equal(rebuilt.id, event.id);
    assert.equal(rebuilt.sequence, event.sequence);
    assert.equal(rebuilt.eventType, event.eventType);
    assert.equal(rebuilt.eventVersion, event.eventVersion);
    assert.equal(rebuilt.schemaVersion, event.schemaVersion);
    assert.equal(rebuilt.tenantId, event.tenantId);
    assert.equal(rebuilt.source, event.source);
    assert.equal(rebuilt.actor, event.actor);
    assert.equal(rebuilt.timestamp, event.timestamp);
    assert.equal(rebuilt.correlationId, event.correlationId);
    assert.deepEqual(rebuilt.payload, event.payload);
    assert.deepEqual(rebuilt.provenance, event.provenance);
    assert.equal(rebuilt.privacyClassification, event.privacyClassification);
  });

  it('passes legacy-shaped content through unchanged', async () => {
    const event = await service.publishEvent(admin, eventInput({ idempotencyKey: 'recon-2' }));
    const legacyShaped = { ...event };
    const rebuilt = commercialEventFromEnvelope({
      ...(await service.replayUnifiedOutbox(admin, {}))[0]!.envelope,
      payload: legacyShaped,
    });
    assert.equal(rebuilt, legacyShaped);
  });
});

describe('F-01b enveloped commercial delivery (topic preservation + compat)', () => {
  it('emits under the original topics with legacy CommercialEvent payloads intact', async () => {
    const legacyByTopic = new Map<string, unknown[]>();
    kernel.bus.on('f01.dual', (payload: unknown) => {
      legacyByTopic.set('f01.dual', [...(legacyByTopic.get('f01.dual') ?? []), payload]);
    });
    kernel.bus.on(CommercialControlPlaneEvents.EventRecorded, (payload: unknown) => {
      legacyByTopic.set('audit', [...(legacyByTopic.get('audit') ?? []), payload]);
    });
    const enveloped: Array<[string, EventEnvelope]> = [];
    kernel.bus.onAnyEnveloped((topic: string, envelope: EventEnvelope) => {
      enveloped.push([topic, envelope]);
    });
    const event = await service.publishEvent(admin, eventInput({ idempotencyKey: 'dual-1', eventType: 'f01.dual' }));

    // Legacy subscribers observe the exact CommercialEvent shape (no envelope fields).
    assert.equal(legacyByTopic.get('f01.dual')?.length, 1);
    const legacyPayload = legacyByTopic.get('f01.dual')![0] as CommercialEvent;
    assert.equal(legacyPayload.id, event.id);
    assert.equal(legacyPayload.eventType, 'f01.dual');
    assert.equal((legacyPayload as unknown as Record<string, unknown>).envelopeVersion, undefined);
    assert.equal(legacyByTopic.get('audit')?.length, 1);

    // Enveloped observers see both emissions with preserved topics.
    assert.equal(enveloped.length, 2);
    const topics = enveloped.map(([topic]) => topic).sort();
    assert.deepEqual(topics, ['commercial.event.recorded', 'f01.dual']);
    for (const [, envelope] of enveloped) {
      assert.equal(isEventEnvelope(envelope), true);
      assert.equal(envelope.id, event.id);
      assert.equal(envelope.tenantId, 'acme');
      assert.equal(envelope.correlationId, 'corr-f01');
      assert.equal(envelope.legacy, undefined);
    }
    const auditEnvelope = enveloped.find(([topic]) => topic === 'commercial.event.recorded')![1];
    assert.equal(auditEnvelope.eventType, 'f01.dual');
  });
});
