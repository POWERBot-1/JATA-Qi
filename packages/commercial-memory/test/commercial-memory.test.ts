import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import {
  CommercialMemoryError,
  CommercialMemoryModule,
  type CommercialMemoryService,
} from '../src/index.js';

let now: number;
let operator: CommercialActor;
let other: CommercialActor;
let memory: CommercialMemoryService;
let control: ReturnType<CommercialControlPlaneModule['getService']>;

function evidence(id = 'memory-evidence', source = 'memory-test', status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  return {
    id, status, source, observedAt: now, confidence: 90,
    summary: 'Controlled commercial memory evidence.', provenance: { source, collectedAt: now, correlationId: 'memory-correlation' },
  };
}

beforeEach(async () => {
  now = Date.now();
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new CommercialMemoryModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  memory = kernel.getModule<CommercialMemoryModule>('commercial-memory').getService();
});

describe('Commercial memory', () => {
  it('records expected-versus-actual outcomes, reusable learning, and correlation links', async () => {
    const result = await memory.recordDecisionOutcome(operator, {
      decisionId: 'decision-1', actionId: 'action-1', productId: 'product-1', channel: 'search',
      expected: { metric: 'conversion_rate', value: 0.1, unit: 'ratio', method: 'pre-action estimate' },
      actual: { metric: 'conversion_rate', value: 0.12, unit: 'ratio', status: 'MEASURED', observedAt: now, method: 'verified analytics snapshot' },
      evidence: [evidence()], conclusion: 'Measured conversion exceeded the bounded expectation.', learning: 'Retain evidence-backed copy for the next controlled experiment.',
    });
    assert.equal(result.outcome.kind, 'OUTCOME');
    assert.equal(result.learning.kind, 'LEARNING');
    assert.equal(result.links.length, 2);
    assert.equal((await memory.query(operator, { kind: 'LEARNING', reusableOnly: true })).length, 1);
    assert.equal((await memory.verifyIntegrity(operator)).valid, true);
  });

  it('never upgrades correlation to causal evidence without method and independent measured sources', async () => {
    const linkInput = {
      from: { type: 'EXPOSURE' as const, entityId: 'exposure-1', productId: 'product-1' },
      to: { type: 'CONVERSION' as const, entityId: 'conversion-1', productId: 'product-1' },
      relation: 'CAUSAL_EVIDENCE' as const,
      confidence: 80,
      evidence: [evidence('single-source')],
      provenance: { source: 'memory-test', collectedAt: now },
    };
    await assert.rejects(() => memory.recordAttribution(operator, linkInput), CommercialMemoryError);
    const link = await memory.recordAttribution(operator, {
      ...linkInput,
      causalMethod: 'controlled cohort comparison',
      evidence: [evidence('source-a', 'analytics-a'), evidence('source-b', 'analytics-b', 'VERIFIED')],
    });
    assert.equal(link.relation, 'CAUSAL_EVIDENCE');
    assert.equal(link.causalMethod, 'controlled cohort comparison');
  });

  it('captures selected versioned commercial events as raw event memory records with deduplication', async () => {
    await control.publishEvent(operator, {
      eventType: 'revenue.recorded', source: 'test-revenue', entityId: 'ledger-entry-1', correlationId: 'revenue-correlation',
      payload: { amount: 100, currency: 'KES' }, provenance: { source: 'test-revenue', collectedAt: now, correlationId: 'revenue-correlation' },
      idempotencyKey: 'revenue-event-1',
    });
    const records = await memory.query(operator, { kind: 'RAW_EVENT' });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.title, 'revenue.recorded');
    assert.equal(records[0]?.tags.includes('revenue.recorded'), true);
  });

  it('retains prohibited strategies as queryable commercial memory', async () => {
    await memory.record(operator, {
      kind: 'PROHIBITED_STRATEGY', productId: 'product-1', title: 'No unsupported testimonials',
      summary: 'Do not publish testimonials without explicit customer permission and evidence.', tags: ['claims', 'prohibited'],
      evidence: [evidence()], confidence: 100, provenance: { source: 'governance-policy', collectedAt: now }, reusable: true,
    });
    const records = await memory.query(operator, { tags: ['prohibited'], reusableOnly: true });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, 'PROHIBITED_STRATEGY');
  });

  it('persists commercial memory across a filesystem restart and prevents tenant leakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-commercial-memory-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new CommercialControlPlaneModule({ now: () => now }));
      first.register(new CommercialMemoryModule());
      await first.boot();
      const firstMemory = first.getModule<CommercialMemoryModule>('commercial-memory').getService();
      const record = await firstMemory.record(operator, {
        kind: 'LEARNING', productId: 'product-persistent', title: 'Persistent learning', summary: 'Persisted commercial learning.',
        evidence: [evidence('persistent')], confidence: 80, provenance: { source: 'test', collectedAt: now }, reusable: true,
      });
      await first.shutdown();
      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new CommercialControlPlaneModule({ now: () => now }));
      second.register(new CommercialMemoryModule());
      await second.boot();
      const secondMemory = second.getModule<CommercialMemoryModule>('commercial-memory').getService();
      assert.equal((await secondMemory.query(operator, { productId: 'product-persistent' }))[0]?.id, record.id);
      assert.equal((await secondMemory.verifyIntegrity(operator)).valid, true);
      assert.equal((await secondMemory.query(other)).length, 0);
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
