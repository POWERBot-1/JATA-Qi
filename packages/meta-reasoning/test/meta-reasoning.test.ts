import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import {
  MultiAgentCognitionModule,
  type MultiAgentReviewer,
  type StructuredReviewMessage,
} from '@jataqi/multi-agent-cognition';
import type { CommercialActor, CommercialEvidence, ModelReference } from '@jataqi/commercial-control-plane';
import {
  MetaReasoningError,
  MetaReasoningModule,
  type MetaReasoningConfig,
  type MetaReasoningService,
  type RecordMetaForecastInput,
} from '../src/index.js';

const actor: CommercialActor = { id: 'meta-researcher', tenantId: 'acme', roles: ['operator'] };
const other: CommercialActor = { id: 'other-meta-researcher', tenantId: 'other', roles: ['operator'] };
const modelA: ModelReference = { id: 'model-a', version: '1.0.0', evaluationStatus: 'TESTED' };
const modelB: ModelReference = { id: 'model-b', version: '1.0.0', evaluationStatus: 'TESTED' };

function provenance(source = 'meta-reasoning-test') {
  return { source, collectedAt: Date.now(), correlationId: 'meta-reasoning-correlation' };
}

function evidence(id: string, status: CommercialEvidence['status'] = 'MEASURED', source = `source-${id}`): CommercialEvidence {
  const now = Date.now();
  return {
    id,
    status,
    source,
    observedAt: now,
    confidence: 90,
    summary: `Bounded ${status.toLowerCase()} evidence summary for ${id}.`,
    provenance: provenance(source),
  };
}

function structuredReview(overrides: Partial<StructuredReviewMessage> = {}): StructuredReviewMessage {
  return {
    hypothesis: 'The source hypothesis remains uncertain.',
    evidenceIds: ['deliberation-a', 'deliberation-b'],
    assumptions: ['The recorded measurement scope remains relevant.'],
    confidence: 50,
    proposedAction: { disposition: 'GATHER_EVIDENCE', summary: 'Gather independently measured evidence.' },
    uncertainty: ['The supplied evidence does not resolve all alternatives.'],
    verdict: 'INCONCLUSIVE',
    conclusionSummary: 'This deterministic test review remains inconclusive.',
    provenance: provenance('meta-reviewer'),
    ...overrides,
  };
}

function reviewer(id: string, role: 'RESEARCH_AGENT' | 'CRITIC_AGENT', response: StructuredReviewMessage): MultiAgentReviewer {
  return {
    id,
    role,
    capabilitySummary: 'Deterministic isolated test reviewer; no model, tool, or external-service invocation.',
    review: () => response,
  };
}

async function boot(
  options: { reviewers?: MultiAgentReviewer[]; meta?: MetaReasoningConfig; storage?: StorageModuleConfig } = {},
) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(options.storage));
  kernel.register(new CognitiveKernelModule());
  kernel.register(new MultiAgentCognitionModule({ reviewers: options.reviewers ?? [] }));
  kernel.register(new MetaReasoningModule(options.meta));
  await kernel.boot();
  return {
    kernel,
    cognitive: kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService(),
    multi: kernel.getModule<MultiAgentCognitionModule>('multi-agent-cognition').getService(),
    service: kernel.getModule<MetaReasoningModule>('meta-reasoning').getService(),
  };
}

async function forecastInput(
  cognitive: CognitiveKernelService,
  overrides: Partial<RecordMetaForecastInput> = {},
): Promise<RecordMetaForecastInput> {
  const state = await cognitive.createState(actor, { scope: 'meta-reasoning forecast test' });
  return {
    claimKey: 'activation-explanation',
    claimSummary: 'The measured activation change will be supported by a follow-up evaluation.',
    model: modelA,
    probability: 0.8,
    confidence: 70,
    evidence: [evidence(`forecast-evidence-${state.id}`)],
    assumptions: ['The follow-up uses the same target population.'],
    uncertainty: ['Unmeasured confounding may remain.'],
    provenance: provenance(),
    ...overrides,
    cognitiveStateId: state.id,
  };
}

async function scoreForecast(
  service: MetaReasoningService,
  cognitive: CognitiveKernelService,
  model: ModelReference,
  probability: number,
  outcome: 'SUPPORTED' | 'NOT_SUPPORTED',
  suffix: string,
) {
  const forecast = await service.recordForecast(actor, await forecastInput(cognitive, {
    claimKey: `calibration-${suffix}`,
    claimSummary: `Calibration claim ${suffix}.`,
    model,
    probability,
  }));
  const evaluation = await service.evaluateForecast(actor, forecast.id, {
    outcome,
    method: 'controlled supplied evaluation',
    outcomeSummary: `Supplied evaluation ${suffix} is ${outcome}.`,
    evidence: [evidence(`evaluation-${suffix}`, 'VERIFIED', `evaluation-source-${suffix}`)],
    provenance: provenance(`evaluation-${suffix}`),
  });
  return { forecast, evaluation };
}

describe('JQB meta-reasoning', () => {
  it('records supplied forecasts and immutable evidence-backed evaluations with transparent error metrics', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      const forecast = await service.recordForecast(actor, await forecastInput(cognitive));
      const evaluation = await service.evaluateForecast(actor, forecast.id, {
        outcome: 'SUPPORTED',
        method: 'supplied controlled observation',
        outcomeSummary: 'The supplied evaluation supports the scoped forecast without proving the general hypothesis.',
        evidence: [evidence('evaluation-a', 'VERIFIED')],
        provenance: provenance('evaluation-a'),
      });
      assert.equal(evaluation.scored, true);
      assert.ok(Math.abs((evaluation.brierError ?? 0) - 0.04) < 1e-12);
      assert.ok(Math.abs((evaluation.absoluteError ?? 0) - 0.2) < 1e-12);
      assert.equal((await service.getForecast(actor, forecast.id))?.status, 'SCORED');
      await assert.rejects(() => service.evaluateForecast(actor, forecast.id, {
        outcome: 'SUPPORTED', method: 'duplicate', outcomeSummary: 'Must not overwrite the first evaluation.', evidence: [evidence('duplicate', 'VERIFIED')], provenance: provenance(),
      }), MetaReasoningError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('calculates calibration only from sufficient scored history and compares models without automatic selection', async () => {
    const { kernel, cognitive, service } = await boot({ meta: { minimumCalibrationSampleSize: 3 } });
    try {
      await scoreForecast(service, cognitive, modelA, 1, 'SUPPORTED', 'a-1');
      await scoreForecast(service, cognitive, modelA, 0, 'NOT_SUPPORTED', 'a-2');
      await scoreForecast(service, cognitive, modelA, 1, 'SUPPORTED', 'a-3');
      await scoreForecast(service, cognitive, modelB, 0.4, 'SUPPORTED', 'b-1');
      await scoreForecast(service, cognitive, modelB, 0.6, 'NOT_SUPPORTED', 'b-2');
      await scoreForecast(service, cognitive, modelB, 0.4, 'SUPPORTED', 'b-3');

      const calibration = await service.calculateCalibration(actor, { model: modelA });
      assert.equal(calibration.sampleSize, 3);
      assert.equal(calibration.quality, 'WELL_CALIBRATED');
      assert.equal(calibration.brierScore, 0);
      const comparison = await service.compareModels(actor, { models: [modelB, modelA] });
      assert.equal(comparison.status, 'COMPARABLE');
      assert.equal(comparison.ranking[0]?.id, modelA.id);
      assert.equal(comparison.automaticSelection, false);
      assert.match(comparison.caveats[0] ?? '', /supplied scored evaluations/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('retains contradictory forecasts and contradictory scored evaluations for an exact caller-owned claim key', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      const first = await service.recordForecast(actor, await forecastInput(cognitive, { claimKey: 'same-scoped-claim', probability: 0.9, model: modelA }));
      const second = await service.recordForecast(actor, await forecastInput(cognitive, { claimKey: 'same-scoped-claim', probability: 0.1, model: modelB }));
      assert.ok((await service.listContradictions(actor, 'same-scoped-claim')).some((item) => item.kind === 'FORECAST_PROBABILITY_CONFLICT'));
      await service.evaluateForecast(actor, first.id, {
        outcome: 'SUPPORTED', method: 'supplied measured result', outcomeSummary: 'First scoped evaluation is supported.', evidence: [evidence('first-result', 'VERIFIED')], provenance: provenance(),
      });
      await service.evaluateForecast(actor, second.id, {
        outcome: 'NOT_SUPPORTED', method: 'supplied measured result', outcomeSummary: 'Second scoped evaluation is not supported.', evidence: [evidence('second-result', 'VERIFIED')], provenance: provenance(),
      });
      const contradictions = await service.listContradictions(actor, 'same-scoped-claim');
      assert.ok(contradictions.some((item) => item.kind === 'EVALUATION_OUTCOME_CONFLICT'));
      assert.ok(contradictions.every((item) => item.status === 'OPEN'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('maps an inconclusive stored multi-agent synthesis to an explicit I_DO_NOT_KNOW outcome with no action authorization', async () => {
    const research = reviewer('meta-research', 'RESEARCH_AGENT', structuredReview());
    const critic = reviewer('meta-critic', 'CRITIC_AGENT', structuredReview());
    const { kernel, cognitive, multi, service } = await boot({ reviewers: [research, critic] });
    try {
      const state = await cognitive.createState(actor, { scope: 'meta-assessment source state' });
      const deliberation = await multi.createDeliberation(actor, {
        cognitiveStateId: state.id,
        title: 'Inconclusive critique source',
        hypothesis: 'The source hypothesis remains uncertain.',
        evidence: [evidence('deliberation-a', 'MEASURED', 'source-a'), evidence('deliberation-b', 'VERIFIED', 'source-b')],
        assumptions: ['The supplied data is in scope.'],
        confidence: 60,
        proposedAction: { disposition: 'GATHER_EVIDENCE', summary: 'Gather more evidence.' },
        uncertainty: ['Alternatives remain plausible.'],
        requestedRoles: ['RESEARCH_AGENT', 'CRITIC_AGENT'],
        provenance: provenance(),
      });
      await multi.runRequestedReviews(actor, deliberation.id);
      const synthesis = await multi.synthesize(actor, deliberation.id);
      assert.equal(synthesis.status, 'INCONCLUSIVE');
      const assessment = await service.assessDeliberation(actor, { deliberationId: deliberation.id });
      assert.equal(assessment.status, 'I_DO_NOT_KNOW');
      assert.equal(assessment.recommendation, 'NO_ACTION');
      assert.equal(assessment.executionAuthorization, 'NOT_AUTHORIZED');
      assert.match(assessment.conclusionSummary, /I do not know/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('produces advisory-only autonomy reduction recommendations and cannot increase the supplied ceiling', async () => {
    const { kernel, service } = await boot();
    try {
      const recommendation = await service.recommendAutonomyReduction(actor, { model: modelA, currentAutonomyLevel: 6 });
      assert.equal(recommendation.status, 'REDUCTION_RECOMMENDED');
      assert.equal(recommendation.recommendedMaximumAutonomyLevel, 1);
      assert.ok(recommendation.recommendedMaximumAutonomyLevel <= recommendation.currentAutonomyLevel);
      assert.equal(recommendation.requiresHumanPolicyReview, true);
      assert.equal(recommendation.executionAuthorization, 'NOT_AUTHORIZED');
      assert.match(recommendation.reason, /scored forecast/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists forecasts, evaluations, and calibration reports across a filesystem restart while preserving tenant isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-meta-reasoning-'));
    try {
      const first = await boot({ storage: { driver: 'filesystem', fsRoot: root }, meta: { minimumCalibrationSampleSize: 3 } });
      const forecast = await first.service.recordForecast(actor, await forecastInput(first.cognitive));
      await first.service.evaluateForecast(actor, forecast.id, {
        outcome: 'SUPPORTED', method: 'supplied controlled observation', outcomeSummary: 'A supplied evidence-backed evaluation.', evidence: [evidence('persisted-result', 'VERIFIED')], provenance: provenance(),
      });
      const calibration = await first.service.calculateCalibration(actor, { model: modelA });
      await first.kernel.shutdown();

      const second = await boot({ storage: { driver: 'filesystem', fsRoot: root }, meta: { minimumCalibrationSampleSize: 3 } });
      assert.equal((await second.service.getForecast(actor, forecast.id))?.status, 'SCORED');
      assert.equal((await second.service.listEvaluations(actor, forecast.id)).length, 1);
      assert.equal((await second.service.listCalibrationReports(actor, modelA)).some((item) => item.id === calibration.id), true);
      assert.equal(await second.service.getForecast(other, forecast.id), undefined);
      await assert.rejects(() => second.service.listEvaluations(other, forecast.id), MetaReasoningError);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
