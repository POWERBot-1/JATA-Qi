import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import { WorldModelModule } from '@jataqi/world-model';
import { CausalEngineError, CausalEngineModule, type CausalEngineService } from '../src/index.js';

let actor: CommercialActor;
let other: CommercialActor;
let engine: CausalEngineService;

function evidence(id = 'causal-evidence', source = 'causal-test', status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  const now = Date.now();
  return { id, status, source, observedAt: now, confidence: 90, summary: 'Controlled causal evidence.', provenance: { source, collectedAt: now } };
}
function provenance(source = 'causal-test') { return { source, collectedAt: Date.now(), correlationId: 'causal-correlation' }; }

beforeEach(async () => {
  actor = { id: 'scientist', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new WorldModelModule());
  kernel.register(new CausalEngineModule());
  await kernel.boot();
  engine = kernel.getModule<CausalEngineModule>('causal-engine').getService();
});

async function model() {
  return engine.createModel(actor, {
    name: 'Local commercial causal approximation',
    variables: [
      { id: 'spend', label: 'Measured spend', unit: 'KES', baseline: 0, bounds: { min: 0, max: 100 } },
      { id: 'leads', label: 'Qualified leads', unit: 'count', baseline: 10, bounds: { min: 0 } },
      { id: 'revenue', label: 'Verified revenue', unit: 'KES', baseline: 100, bounds: { min: 0 } },
    ],
    assumptions: ['Effects are local linear approximations.', 'Other confounders are not modeled.'],
    provenance: provenance(),
  });
}

describe('JQB Causal Engine', () => {
  it('requires evidence/method before causal edges and produces explicitly simulated intervention output', async () => {
    const created = await model();
    const withFirst = await engine.addEdge(actor, created.id, {
      fromVariableId: 'spend', toVariableId: 'leads', effect: 0.5, confidence: 70, status: 'CAUSAL_HYPOTHESIS', causalMethod: 'assumed local response', evidence: [evidence()], provenance: provenance(),
    });
    const completed = await engine.addEdge(actor, withFirst.id, {
      fromVariableId: 'leads', toVariableId: 'revenue', effect: 10, confidence: 85, status: 'CAUSAL_EVIDENCE', causalMethod: 'controlled cohort comparison',
      evidence: [evidence('e1', 'source-a'), evidence('e2', 'source-b', 'VERIFIED')], provenance: provenance(),
    });
    const scenario = await engine.simulate(actor, completed.id, {
      interventions: { spend: 20 }, evidence: [evidence('simulation-input')], assumptions: ['No capacity constraint during scenario.'],
    });
    assert.equal(scenario.simulated, true);
    assert.equal(scenario.method, 'CLASSICAL_LINEAR_STRUCTURAL_CAUSAL_MODEL');
    assert.equal(scenario.predictedValues.leads, 20);
    assert.equal(scenario.predictedValues.revenue, 200);
    assert.ok(scenario.uncertainty.some((item) => item.includes('Hypothesized causal edge')));
  });

  it('rejects unsupported causal evidence and directed cycles', async () => {
    const created = await model();
    await assert.rejects(() => engine.addEdge(actor, created.id, {
      fromVariableId: 'spend', toVariableId: 'leads', effect: 0.5, confidence: 70, status: 'CAUSAL_EVIDENCE', causalMethod: '', evidence: [evidence()], provenance: provenance(),
    }), CausalEngineError);
    const one = await engine.addEdge(actor, created.id, {
      fromVariableId: 'spend', toVariableId: 'leads', effect: 0.5, confidence: 70, status: 'CAUSAL_HYPOTHESIS', causalMethod: 'assumption', evidence: [evidence()], provenance: provenance(),
    });
    await assert.rejects(() => engine.addEdge(actor, one.id, {
      fromVariableId: 'leads', toVariableId: 'spend', effect: 0.5, confidence: 70, status: 'CAUSAL_HYPOTHESIS', causalMethod: 'cycle', evidence: [evidence('cycle')], provenance: provenance(),
    }), /directed cycle/);
  });

  it('enforces intervention bounds and tenant isolation', async () => {
    const created = await model();
    await assert.rejects(() => engine.simulate(actor, created.id, { interventions: { spend: 101 }, evidence: [evidence()] }), /violates bounds/);
    assert.equal(await engine.getModel(other, created.id), undefined);
    await assert.rejects(() => engine.listScenarios(other, created.id), CausalEngineError);
  });
});
