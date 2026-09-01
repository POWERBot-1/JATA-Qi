import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import { WorldModelError, WorldModelModule, type WorldModelService } from '../src/index.js';

let actor: CommercialActor;
let other: CommercialActor;
let service: WorldModelService;

function evidence(id = 'world-evidence', source = 'world-test', status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  const now = Date.now();
  return { id, status, source, observedAt: now, confidence: 90, summary: 'Controlled world-model evidence.', provenance: { source, collectedAt: now } };
}
function provenance(source = 'world-test') { return { source, collectedAt: Date.now(), correlationId: 'world-correlation' }; }

beforeEach(async () => {
  actor = { id: 'researcher', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new WorldModelModule());
  await kernel.boot();
  service = kernel.getModule<WorldModelModule>('world-model').getService();
});

describe('JQB World Model', () => {
  it('stores observed/inferred entities, association relations, events, and bounded paths', async () => {
    const model = await service.createModel(actor, { name: 'Commercial world', description: 'Tenant-bound model.' });
    const market = await service.addEntity(actor, model.id, { type: 'Market', name: 'Kenya SMB', epistemicStatus: 'OBSERVED', confidence: 90, provenance: provenance() });
    const hypothesis = await service.addEntity(actor, model.id, { type: 'Hypothesis', name: 'Onboarding friction', epistemicStatus: 'HYPOTHESIZED', confidence: 50, provenance: provenance() });
    const relation = await service.addRelation(actor, model.id, { subjectId: market.id, predicate: 'mayHave', objectId: hypothesis.id, status: 'ASSOCIATION', confidence: 60, evidence: [evidence()], provenance: provenance() });
    const event = await service.recordEvent(actor, model.id, { type: 'feedback.received', entityIds: [market.id, hypothesis.id], epistemicStatus: 'OBSERVED', confidence: 80, payload: { category: 'onboarding' }, evidence: [evidence('event-evidence')], provenance: provenance() });
    assert.equal(hypothesis.epistemicStatus, 'HYPOTHESIZED');
    assert.equal(relation.status, 'ASSOCIATION');
    assert.equal(event.entityIds.length, 2);
    const paths = await service.traverse(actor, model.id, market.id);
    assert.equal(paths.length, 1);
    assert.equal(paths[0]?.entities.at(-1)?.id, hypothesis.id);
  });

  it('requires explicit methodology and independent strong evidence before causal-evidence relation', async () => {
    const model = await service.createModel(actor, { name: 'causality' });
    const a = await service.addEntity(actor, model.id, { type: 'Action', name: 'A', epistemicStatus: 'OBSERVED', confidence: 90, provenance: provenance() });
    const b = await service.addEntity(actor, model.id, { type: 'Outcome', name: 'B', epistemicStatus: 'OBSERVED', confidence: 90, provenance: provenance() });
    await assert.rejects(() => service.addRelation(actor, model.id, { subjectId: a.id, predicate: 'causes', objectId: b.id, status: 'CAUSAL_EVIDENCE', confidence: 80, evidence: [evidence()], provenance: provenance() }), WorldModelError);
    const causal = await service.addRelation(actor, model.id, {
      subjectId: a.id, predicate: 'causes', objectId: b.id, status: 'CAUSAL_EVIDENCE', confidence: 80, causalMethod: 'controlled comparison',
      evidence: [evidence('e1', 'source-a'), evidence('e2', 'source-b', 'VERIFIED')], provenance: provenance(),
    });
    assert.equal(causal.status, 'CAUSAL_EVIDENCE');
  });

  it('enforces model/tenant boundaries', async () => {
    const model = await service.createModel(actor, { name: 'tenant scope' });
    const entity = await service.addEntity(actor, model.id, { type: 'Thing', name: 'A', epistemicStatus: 'OBSERVED', confidence: 80, provenance: provenance() });
    assert.equal(await service.getModel(other, model.id), undefined);
    await assert.rejects(() => service.listEntities(other, model.id), WorldModelError);
    await assert.rejects(() => service.recordEvent(actor, model.id, { type: 'bad', entityIds: [entity.id, 'missing'], epistemicStatus: 'OBSERVED', confidence: 80, evidence: [evidence()], provenance: provenance() }), WorldModelError);
  });

  it('persists models and entities across filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-world-model-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new WorldModelModule());
      await first.boot();
      const firstService = first.getModule<WorldModelModule>('world-model').getService();
      const model = await firstService.createModel(actor, { name: 'persisted world' });
      const entity = await firstService.addEntity(actor, model.id, { type: 'Concept', name: 'Persistence', epistemicStatus: 'INFERRED', confidence: 70, provenance: provenance() });
      await first.shutdown();
      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new WorldModelModule());
      await second.boot();
      const secondService = second.getModule<WorldModelModule>('world-model').getService();
      assert.equal((await secondService.getModel(actor, model.id))?.name, 'persisted world');
      assert.equal((await secondService.listEntities(actor, model.id))[0]?.id, entity.id);
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
