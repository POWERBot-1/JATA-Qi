import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/index.js';
import {
  extractPayload,
  isEventEnvelope,
  toEnvelopeFromCommercial,
  type CommercialEventLike,
  type EventEnvelope,
} from '../src/index.js';

function commercialPayload(): CommercialEventLike {
  return {
    id: 'evt-1',
    sequence: 1,
    eventType: 'commercial.decision.proposed',
    eventVersion: 1,
    schemaVersion: 1,
    tenantId: 'tenant-a',
    source: 'commercial-control-plane',
    timestamp: 1700000000000,
    correlationId: 'corr-1',
    payload: { decisionId: 'd1' },
    provenance: { source: 'commercial-control-plane', collectedAt: 1700000000000 },
    privacyClassification: 'INTERNAL',
  };
}

describe('F-01a enveloped bus: legacy compatibility', () => {
  it('legacy emit/on delivery is unchanged and enveloped subs do not affect listenerCount', () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    const off = bus.on('plain.topic', (p) => {
      seen.push(p);
    });
    assert.equal(bus.listenerCount('plain.topic'), 1);
    const offEnv = bus.onAnyEnveloped(() => {});
    assert.equal(bus.listenerCount(), 1); // enveloped listeners counted separately
    assert.equal(bus.envelopedListenerCount(), 1);
    offEnv();
    off();
    assert.equal(bus.listenerCount(), 0);
    assert.equal(bus.envelopedListenerCount(), 0);
    assert.deepEqual(seen, []);
  });

  it('legacy emit delivers the identical payload object shape to legacy handlers', async () => {
    const bus = new EventBus();
    const payload = { docId: 'd1', chunks: 4 };
    let received: unknown;
    bus.on('knowledge.document.ingested', (p) => {
      received = p;
    });
    await bus.emit('knowledge.document.ingested', payload);
    assert.deepEqual(received, { docId: 'd1', chunks: 4 });
  });

  it('once/off/clear semantics hold for enveloped listeners', async () => {
    const bus = new EventBus();
    let calls = 0;
    bus.onceEnveloped('t', () => {
      calls += 1;
    });
    const envelope = toEnvelopeFromCommercial('t', commercialPayload());
    await bus.emitEnveloped('t', envelope);
    await bus.emitEnveloped('t', envelope);
    assert.equal(calls, 1);

    let named = 0;
    const off = bus.onEnveloped('t', () => {
      named += 1;
    });
    off();
    await bus.emitEnveloped('t', envelope);
    assert.equal(named, 0);

    bus.onEnveloped('t', () => {
      named += 1;
    });
    bus.clear();
    await bus.emitEnveloped('t', envelope);
    assert.equal(named, 0);
    assert.equal(bus.envelopedListenerCount(), 0);
  });
});

describe('F-01a enveloped bus: enveloped delivery', () => {
  it('emitEnveloped reaches enveloped named + wildcard handlers with the topic', async () => {
    const bus = new EventBus();
    const envelope = toEnvelopeFromCommercial('commercial.decision.proposed', commercialPayload());
    const named: Array<[string, EventEnvelope]> = [];
    const wild: Array<[string, EventEnvelope]> = [];
    bus.onEnveloped('commercial.decision.proposed', (topic, env) => {
      named.push([topic, env]);
    });
    bus.onAnyEnveloped((topic, env) => {
      wild.push([topic, env]);
    });
    await bus.emitEnveloped('commercial.decision.proposed', envelope);
    assert.equal(named.length, 1);
    assert.equal(named[0]![0], 'commercial.decision.proposed');
    assert.equal(named[0]![1].id, 'evt-1');
    assert.equal(wild.length, 1);
    assert.equal(wild[0]![0], 'commercial.decision.proposed');
  });

  it('emitEnveloped preserves the exact legacy payload shape when legacyPayload is given', async () => {
    const bus = new EventBus();
    const legacyPayload = { capabilityId: 'c1', tenantId: 't1', lifecycleState: 'PROPOSED' };
    const envelope = toEnvelopeFromCommercial('jq.capability.registered', {
      ...commercialPayload(),
      id: 'evt-2',
      eventType: 'jq.capability.registered',
      tenantId: 't1',
      source: 'capability-fabric',
      payload: legacyPayload,
    });
    let legacySeen: unknown;
    bus.on('jq.capability.registered', (p) => {
      legacySeen = p;
    });
    const enveloped: EventEnvelope[] = [];
    bus.onAnyEnveloped((_topic, env) => {
      enveloped.push(env);
    });
    await bus.emitEnveloped('jq.capability.registered', envelope, { legacyPayload });
    assert.deepEqual(legacySeen, legacyPayload); // byte-identical legacy shape
    assert.equal(enveloped.length, 1);
    assert.equal(enveloped[0]!.id, 'evt-2');
  });

  it('legacy emit without legacyPayload delivers the envelope itself to legacy handlers', async () => {
    const bus = new EventBus();
    const envelope = toEnvelopeFromCommercial('t', commercialPayload());
    let legacySeen: unknown;
    bus.on('t', (p) => {
      legacySeen = p;
    });
    await bus.emitEnveloped('t', envelope);
    assert.equal(legacySeen, envelope);
  });

  it('enveloped handler errors are contained and do not block siblings', async () => {
    const bus = new EventBus();
    const envelope = toEnvelopeFromCommercial('t', commercialPayload());
    let survivor = 0;
    bus.onEnveloped('t', () => {
      throw new Error('boom');
    });
    bus.onEnveloped('t', () => {
      survivor += 1;
    });
    await bus.emitEnveloped('t', envelope);
    assert.equal(survivor, 1);
  });
});

describe('F-01a enveloped bus: bridge and wildcard classification (G-1/G-2)', () => {
  it('legacy plain emits are bridged with topic + legacy flag and stay classifiable', async () => {
    const bus = new EventBus();
    const seen: Array<[string, EventEnvelope]> = [];
    bus.onAnyEnveloped((topic, env) => { seen.push([topic, env]); });
    await bus.emit('knowledge.document.ingested', { docId: 'd1', chunks: 2 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]![0], 'knowledge.document.ingested');
    assert.equal(seen[0]![1].legacy, true);
    assert.equal(seen[0]![1].eventType, 'knowledge.document.ingested');
    // Legacy handler still got the raw payload.
    assert.deepEqual(extractPayload(seen[0]![1]), { docId: 'd1', chunks: 2 });
  });

  it('legacy commercial-shaped emits lift without the legacy flag', async () => {
    const bus = new EventBus();
    const seen: EventEnvelope[] = [];
    bus.onAnyEnveloped((_topic, env) => { seen.push(env); });
    await bus.emit('commercial.decision.proposed', commercialPayload());
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.legacy, undefined);
    assert.equal(seen[0]!.tenantId, 'tenant-a');
    assert.equal(isEventEnvelope(seen[0]), true);
  });

  it('mixed two-plane traffic is 100% classifiable from (topic, envelope)', async () => {
    const bus = new EventBus();
    const seen: Array<[string, EventEnvelope]> = [];
    bus.onAnyEnveloped((topic, env) => { seen.push([topic, env]); });
    await bus.emit('commercial.decision.proposed', commercialPayload());
    await bus.emit('knowledge.document.ingested', { docId: 'd1' });
    await bus.emit('kernel.booted', { moduleCount: 12 });
    await bus.emitEnveloped(
      'unified.loop.stage.completed',
      toEnvelopeFromCommercial('unified.loop.stage.completed', {
        ...commercialPayload(),
        id: 'evt-loop',
        eventType: 'unified.loop.stage.completed',
        tenantId: 'tenant-b',
        source: 'unified-loop',
        correlationId: 'loop:1',
        payload: { loopId: 'l1', stage: 'WAKE', status: 'COMPLETED' },
        privacyClassification: 'INTERNAL' as const,
      }),
    );
    assert.equal(seen.length, 4);
    for (const [topic, env] of seen) {
      assert.ok(topic.trim().length > 0);
      assert.ok(env.eventType.trim().length > 0);
      assert.ok(env.tenantId.trim().length > 0);
      assert.ok(env.correlationId.trim().length > 0);
      assert.equal(env.envelopeVersion, 1);
    }
    const byTopic = new Map(seen.map(([topic, env]) => [topic, env] as const));
    assert.equal(byTopic.get('knowledge.document.ingested')!.legacy, true);
    assert.equal(byTopic.get('commercial.decision.proposed')!.legacy, undefined);
    assert.equal(byTopic.get('unified.loop.stage.completed')!.tenantId, 'tenant-b');
  });

  it('topic names are preserved exactly (no renames in the migration window)', async () => {
    const bus = new EventBus();
    const topics = [
      'commercial.event.recorded',
      'jq.capability.registered',
      'unified.loop.completed',
      'loop-host.work.queued',
      'kernel.booted',
    ];
    const seen: string[] = [];
    bus.onAnyEnveloped((topic) => {
      seen.push(topic);
    });
    for (const topic of topics) await bus.emit(topic, { marker: 1 });
    assert.deepEqual(seen, topics);
  });
});
