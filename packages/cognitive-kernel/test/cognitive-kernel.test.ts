import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { CognitiveKernelError, CognitiveKernelModule, type CognitiveKernelService } from '../src/index.js';

let actor: CommercialActor;
let other: CommercialActor;
let service: CognitiveKernelService;

function provenance(source = 'cognitive-test') {
  return { source, collectedAt: Date.now(), correlationId: 'cognitive-correlation' };
}

beforeEach(async () => {
  actor = { id: 'researcher', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CognitiveKernelModule());
  await kernel.boot();
  service = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
});

describe('JQB Cognitive Kernel', () => {
  it('creates a classical state and produces safe, evidence/uncertainty-aware assessment traces', async () => {
    const state = await service.createState(actor, { scope: 'commercial scenario analysis' });
    assert.equal(state.substrate, 'CLASSICAL');
    const observation = await service.recordObservation(actor, state.id, {
      modality: 'DOCUMENT', contentSummary: 'Sensitive source summary must not be copied into hidden reasoning.', epistemicStatus: 'OBSERVED', confidence: 85, provenance: provenance(),
    });
    const belief = await service.addBelief(actor, state.id, {
      proposition: 'Measured activation is improving.', probability: 0.7, confidence: 75, epistemicStatus: 'INFERRED', evidenceObservationIds: [observation.id], assumptions: ['Measurement window is representative.'],
    });
    await service.addGoal(actor, state.id, { description: 'Identify the next evidence need.', priority: 80, constraints: ['Do not execute actions.'] });
    const assessment = await service.assess(actor, state.id);
    assert.equal(assessment.highConfidenceBeliefs[0]?.id, belief.id);
    assert.ok(assessment.trace.uncertaintySummary.includes('No high-priority') || assessment.trace.uncertaintySummary.includes('Acquire'));
    assert.equal(JSON.stringify(assessment.trace).includes('Sensitive source summary'), false, 'trace is a safe summary, not hidden reasoning or raw content');
  });

  it('preserves explicit simulated and hypothesized status instead of promoting them to facts', async () => {
    const state = await service.createState(actor, { scope: 'simulation', substrate: 'QUANTUM_INSPIRED' });
    const observation = await service.recordObservation(actor, state.id, {
      modality: 'SIMULATION', contentSummary: 'Classical optimization simulation.', epistemicStatus: 'SIMULATED', confidence: 50, provenance: provenance(),
    });
    const belief = await service.addBelief(actor, state.id, {
      proposition: 'Candidate could reduce cost.', probability: 0.55, confidence: 45, epistemicStatus: 'HYPOTHESIZED', evidenceObservationIds: [observation.id],
    });
    const assessment = await service.assess(actor, state.id);
    assert.equal(assessment.state.substrate, 'QUANTUM_INSPIRED');
    assert.ok(assessment.uncertainBeliefs.some((item) => item.id === belief.id));
    assert.match(assessment.trace.conclusionSummary, /uncertain/);
  });

  it('marks materially conflicting versions of the same proposition rather than silently overwriting either belief', async () => {
    const state = await service.createState(actor, { scope: 'conflict' });
    const first = await service.addBelief(actor, state.id, { proposition: 'Channel X is viable.', probability: 0.9, confidence: 80, epistemicStatus: 'INFERRED' });
    const second = await service.addBelief(actor, state.id, { proposition: 'channel x is viable.', probability: 0.2, confidence: 80, epistemicStatus: 'INFERRED' });
    assert.equal(second.contradictionStatus, 'CONFLICTING');
    const beliefs = await service.listBeliefs(actor, state.id);
    assert.equal(beliefs.find((item) => item.id === first.id)?.contradictionStatus, 'CONFLICTING');
  });

  it('validates references and enforces tenant isolation', async () => {
    const state = await service.createState(actor, { scope: 'isolation' });
    await assert.rejects(() => service.addBelief(actor, state.id, {
      proposition: 'Bad reference', probability: 0.5, confidence: 50, epistemicStatus: 'UNKNOWN', evidenceObservationIds: ['missing'],
    }), CognitiveKernelError);
    assert.equal(await service.getState(other, state.id), undefined);
    await assert.rejects(() => service.listBeliefs(other, state.id), CognitiveKernelError);
  });

  it('persists cognitive state and safe records across a filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-cognitive-kernel-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new CognitiveKernelModule());
      await first.boot();
      const firstService = first.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
      const state = await firstService.createState(actor, { scope: 'persistent cognition' });
      await firstService.addGoal(actor, state.id, { description: 'Preserve state.', priority: 50 });
      await first.shutdown();

      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new CognitiveKernelModule());
      await second.boot();
      const secondService = second.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
      assert.equal((await secondService.getState(actor, state.id))?.scope, 'persistent cognition');
      assert.equal((await secondService.listTraces(actor, state.id)).length, 1);
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported runtime substrate claims', async () => {
    await assert.rejects(
      () => service.createState(actor, { scope: 'invalid', substrate: 'QUANTUM_CONSCIOUS' as never }),
      CognitiveKernelError,
    );
  });
});
