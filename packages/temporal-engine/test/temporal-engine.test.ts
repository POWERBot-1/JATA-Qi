import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import { WorldModelModule } from '@jataqi/world-model';
import { TemporalEngineError, TemporalEngineModule, type TemporalEngineService } from '../src/index.js';

let actor: CommercialActor;
let other: CommercialActor;
let service: TemporalEngineService;

function evidence(id = 'temporal-evidence'): CommercialEvidence {
  const now = Date.now();
  return { id, status: 'MEASURED', source: 'temporal-test', observedAt: now, confidence: 90, summary: 'Controlled temporal evidence.', provenance: { source: 'temporal-test', collectedAt: now } };
}
function provenance() { return { source: 'temporal-test', collectedAt: Date.now(), correlationId: 'temporal-correlation' }; }

beforeEach(async () => {
  actor = { id: 'planner', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new WorldModelModule());
  kernel.register(new TemporalEngineModule());
  await kernel.boot();
  service = kernel.getModule<TemporalEngineModule>('temporal-engine').getService();
});

describe('JQB Temporal Engine', () => {
  it('records temporal causation and replays by occurrence time rather than insertion order', async () => {
    const timeline = await service.createTimeline(actor, { name: 'product timeline' });
    const later = await service.recordEvent(actor, timeline.id, { type: 'outcome', occurredAt: 200, epistemicStatus: 'OBSERVED', confidence: 90, evidence: [evidence('later')], provenance: provenance() });
    const earlier = await service.recordEvent(actor, timeline.id, { type: 'action', occurredAt: 100, epistemicStatus: 'OBSERVED', confidence: 90, evidence: [evidence('earlier')], provenance: provenance() });
    const caused = await service.recordEvent(actor, timeline.id, { type: 'revenue', occurredAt: 300, causationEventIds: [earlier.id, later.id], epistemicStatus: 'INFERRED', confidence: 70, evidence: [evidence('caused')], provenance: provenance() });
    const replay = await service.replay(actor, timeline.id);
    assert.deepEqual(replay.map((event) => event.id), [earlier.id, later.id, caused.id]);
  });

  it('rejects invalid temporal causation and invalid ranges', async () => {
    const timeline = await service.createTimeline(actor, { name: 'validation' });
    const later = await service.recordEvent(actor, timeline.id, { type: 'later', occurredAt: 200, epistemicStatus: 'OBSERVED', confidence: 90, evidence: [evidence()], provenance: provenance() });
    await assert.rejects(() => service.recordEvent(actor, timeline.id, { type: 'earlier', occurredAt: 100, causationEventIds: [later.id], epistemicStatus: 'OBSERVED', confidence: 90, evidence: [evidence('bad')], provenance: provenance() }), TemporalEngineError);
    await assert.rejects(() => service.replay(actor, timeline.id, { from: 10, until: 1 }), TemporalEngineError);
  });

  it('stores supplied future branches as simulation and never adds them to observed replay', async () => {
    const timeline = await service.createTimeline(actor, { name: 'scenario' });
    await service.recordEvent(actor, timeline.id, { type: 'baseline', occurredAt: 100, epistemicStatus: 'OBSERVED', confidence: 90, evidence: [evidence()], provenance: provenance() });
    const scenario = await service.createScenario(actor, timeline.id, {
      name: 'Alternative future', horizonStart: 200, horizonEnd: 400, probability: 0.3, assumptions: ['No policy change.'], provenance: provenance(),
      projectedEvents: [{ type: 'projected-growth', occurredAt: 300, epistemicStatus: 'HYPOTHESIZED', confidence: 40, evidence: [evidence('scenario')], provenance: provenance() }],
    });
    assert.equal(scenario.simulated, true);
    assert.equal(scenario.projectedEvents[0]?.epistemicStatus, 'SIMULATED');
    assert.equal((await service.replay(actor, timeline.id)).length, 1);
    assert.equal((await service.listScenarios(actor, timeline.id)).length, 1);
  });

  it('enforces tenant isolation and persists timelines/events across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-temporal-engine-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new WorldModelModule());
      first.register(new TemporalEngineModule());
      await first.boot();
      const firstService = first.getModule<TemporalEngineModule>('temporal-engine').getService();
      const timeline = await firstService.createTimeline(actor, { name: 'persisted timeline' });
      await firstService.recordEvent(actor, timeline.id, { type: 'event', occurredAt: 100, epistemicStatus: 'OBSERVED', confidence: 90, evidence: [evidence()], provenance: provenance() });
      await first.shutdown();
      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new WorldModelModule());
      second.register(new TemporalEngineModule());
      await second.boot();
      const secondService = second.getModule<TemporalEngineModule>('temporal-engine').getService();
      assert.equal((await secondService.replay(actor, timeline.id)).length, 1);
      assert.equal(await secondService.getTimeline(other, timeline.id), undefined);
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
