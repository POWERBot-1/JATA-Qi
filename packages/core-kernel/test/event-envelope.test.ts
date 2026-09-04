import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_ENVELOPE_VERSION,
  SYSTEM_TENANT,
  extractPayload,
  hashEnvelopeV1,
  isCommercialEventLike,
  isEventEnvelope,
  sealEnvelopeChain,
  toEnvelopeFromCommercial,
  toEnvelopedDelivery,
  verifyEnvelopeChain,
  wrapPlainEnvelope,
  type CommercialEventLike,
} from '../src/index.js';
import { CANONICAL_HASH_VERSION, canonicalHash, canonicalJson } from '../src/index.js';

function commercialEvent(): CommercialEventLike {
  return {
    id: 'evt-1',
    sequence: 7,
    eventType: 'commercial.decision.proposed',
    eventVersion: 2,
    schemaVersion: 3,
    tenantId: 'tenant-a',
    source: 'commercial-control-plane',
    actor: 'actor-1',
    entityId: 'decision-1',
    timestamp: 1700000000000,
    correlationId: 'corr-1',
    causationId: 'cause-0',
    payload: { decisionId: 'decision-1' },
    provenance: { source: 'commercial-control-plane', collectedAt: 1700000000000 },
    privacyClassification: 'INTERNAL',
    idempotencyKey: 'idem-1',
  };
}

describe('F-01a EventEnvelope conformance', () => {
  it('wraps a commercial event preserving every field with envelopeVersion and topic', () => {
    const event = commercialEvent();
    const envelope = toEnvelopeFromCommercial('commercial.decision.proposed', event);
    assert.equal(envelope.envelopeVersion, EVENT_ENVELOPE_VERSION);
    assert.equal(envelope.topic, 'commercial.decision.proposed');
    assert.equal(envelope.id, event.id);
    assert.equal(envelope.sequence, 7);
    assert.equal(envelope.eventVersion, 2);
    assert.equal(envelope.schemaVersion, 3);
    assert.equal(envelope.tenantId, 'tenant-a');
    assert.equal(envelope.correlationId, 'corr-1');
    assert.equal(envelope.causationId, 'cause-0');
    assert.equal(envelope.actor, 'actor-1');
    assert.equal(envelope.idempotencyKey, 'idem-1');
    assert.deepEqual(envelope.payload, { decisionId: 'decision-1' });
    assert.equal(envelope.legacy, undefined);
    // The original is not mutated and the payload is a copy.
    assert.notEqual(envelope.payload, event.payload);
  });

  it('wraps plain payloads as legacy envelopes with tenant fallback chain', () => {
    const explicit = wrapPlainEnvelope('knowledge.document.ingested', { docId: 'd1' }, { tenantId: 't-9' });
    assert.equal(explicit.legacy, true);
    assert.equal(explicit.tenantId, 't-9');
    assert.equal(explicit.eventType, 'knowledge.document.ingested');
    assert.equal(explicit.topic, 'knowledge.document.ingested');

    const fromPayload = wrapPlainEnvelope('some.topic', { tenantId: 't-payload', v: 1 });
    assert.equal(fromPayload.tenantId, 't-payload');

    const fallback = wrapPlainEnvelope('kernel.booted', { moduleCount: 3 });
    assert.equal(fallback.tenantId, SYSTEM_TENANT);

    assert.equal(explicit.envelopeVersion, 1);
    assert.equal(explicit.eventVersion, 1);
    assert.equal(explicit.schemaVersion, 1);
  });

  it('guards accept and reject correctly', () => {
    const envelope = toEnvelopeFromCommercial('t', commercialEvent());
    assert.equal(isEventEnvelope(envelope), true);
    assert.equal(isCommercialEventLike(envelope), true); // envelopes are a superset
    assert.equal(isCommercialEventLike(commercialEvent()), true);
    assert.equal(isEventEnvelope(commercialEvent()), false); // no envelopeVersion/topic
    assert.equal(isEventEnvelope({ docId: 'd1' }), false);
    assert.equal(isEventEnvelope(undefined), false);
    assert.equal(isEventEnvelope('topic'), false);
    assert.equal(isEventEnvelope([]), false);
    assert.equal(isCommercialEventLike({ docId: 'd1' }), false);
  });

  it('extractPayload unwraps envelopes and passes plain payloads through', () => {
    const envelope = toEnvelopeFromCommercial('t', commercialEvent());
    assert.deepEqual(extractPayload(envelope), { decisionId: 'decision-1' });
    const plain = { docId: 'd1', chunks: 2 };
    assert.equal(extractPayload(plain), plain);
  });

  it('toEnvelopedDelivery refreshes stale topics and lifts commercial payloads', () => {
    const envelope = toEnvelopeFromCommercial('old.topic', commercialEvent());
    const refreshed = toEnvelopedDelivery('new.topic', envelope);
    assert.equal(refreshed.topic, 'new.topic');
    assert.equal(refreshed.legacy, undefined);

    const lifted = toEnvelopedDelivery('commercial.decision.proposed', commercialEvent());
    assert.equal(isEventEnvelope(lifted), true);
    assert.equal(lifted.legacy, undefined);
    assert.equal(lifted.tenantId, 'tenant-a');

    const bridged = toEnvelopedDelivery('knowledge.document.ingested', { docId: 'd1' });
    assert.equal(bridged.legacy, true);
    assert.equal(bridged.eventType, 'knowledge.document.ingested');
  });

  it('canonical JSON is key-order independent and drops undefined like persistence', () => {
    const a = canonicalJson({ b: 1, a: { y: [1, 2], x: undefined } });
    const b = canonicalJson({ a: { y: [1, 2] }, b: 1 });
    assert.equal(a, b);
    assert.equal(canonicalHash({ z: 1 }), canonicalHash({ z: 1 }));
    assert.notEqual(canonicalHash({ z: 1 }), canonicalHash({ z: 2 }));
  });

  it('v1 envelope hashing is deterministic and tamper-evident', () => {
    const envelope = toEnvelopeFromCommercial('t', commercialEvent());
    assert.equal(hashEnvelopeV1(envelope), hashEnvelopeV1({ ...envelope }));
    const tampered = { ...envelope, payload: { decisionId: 'other' } };
    assert.notEqual(hashEnvelopeV1(envelope), hashEnvelopeV1(tampered));
  });

  it('seals and verifies a hash chain, detecting forks, tampering, and gaps', () => {
    const base = (n: number) =>
      toEnvelopeFromCommercial('t', { ...commercialEvent(), id: `evt-${n}`, sequence: n });
    const e1 = sealEnvelopeChain(base(1), 'GENESIS');
    const e2 = sealEnvelopeChain(base(2), e1.hash!);
    const e3 = sealEnvelopeChain(base(3), e2.hash!);
    assert.equal(e1.hashVersion, CANONICAL_HASH_VERSION);
    assert.deepEqual(verifyEnvelopeChain([e1, e2, e3]), { valid: true });

    const tampered = { ...e2, payload: { decisionId: 'forged' } };
    const tamperResult = verifyEnvelopeChain([e1, tampered, e3]);
    assert.equal(tamperResult.valid, false);

    const forked = sealEnvelopeChain(base(3), e1.hash!);
    const forkResult = verifyEnvelopeChain([e1, e2, forked]);
    assert.equal(forkResult.valid, false);

    const gapped = sealEnvelopeChain(base(5), e2.hash!);
    const gapResult = verifyEnvelopeChain([e1, e2, gapped]);
    assert.equal(gapResult.valid, false);

    // Unchained envelopes are skipped, never failed.
    assert.deepEqual(verifyEnvelopeChain([base(1), base(2)]), { valid: true });
    assert.deepEqual(verifyEnvelopeChain([]), { valid: true });
  });

  it('rejects blank topics fail-closed', () => {
    assert.throws(() => wrapPlainEnvelope('   ', { a: 1 }), /topic is required/i);
    assert.throws(() => toEnvelopeFromCommercial('', commercialEvent()), /topic is required/i);
  });
});
