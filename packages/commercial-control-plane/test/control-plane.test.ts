import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneError,
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
  type CreateAutonomyPolicyInput,
  type CreateCommercialDecisionInput,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let approver: CommercialActor;
let agent: CommercialActor;
let otherTenant: CommercialActor;
let service: CommercialControlPlaneService;

function evidence(id = 'evidence-1'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'controlled-test',
    observedAt: now,
    confidence: 92,
    summary: 'Measured controlled evidence.',
    provenance: { source: 'controlled-test', collectedAt: now, correlationId: 'corr-1' },
  };
}

function decisionInput(overrides: Partial<CreateCommercialDecisionInput> = {}): CreateCommercialDecisionInput {
  return {
    tenantId: 'acme',
    productId: 'product-1',
    ventureId: 'venture-1',
    objective: 'Validate controlled commercial delivery.',
    proposedAction: 'Publish a verified product announcement.',
    actionType: 'PUBLISH_CONTENT',
    estimatedCost: { amount: 20, currency: 'KES' },
    evidence: [evidence()],
    evidenceStrength: 88,
    riskScore: 20,
    complianceScore: 95,
    confidence: 82,
    authorizationLevel: 3,
    decisionReason: 'Evidence supports a bounded, policy-governed action.',
    provenance: { source: 'controlled-test', collectedAt: now, correlationId: 'corr-1' },
    ...overrides,
  };
}

async function allowPolicy(overrides: Partial<CreateAutonomyPolicyInput> = {}) {
  return service.createPolicy(admin, {
    version: 'test-policy-v1',
    scope: { tenantId: 'acme' },
    maximumAutonomyLevel: 4,
    allowExecution: true,
    allowedActionTypes: ['PUBLISH_CONTENT'],
    maximumRiskScore: 90,
    minimumComplianceScore: 80,
    minimumEvidenceStrength: 70,
    ...overrides,
  });
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin-1', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator-1', tenantId: 'acme', roles: ['operator'] };
  approver = { id: 'approver-1', tenantId: 'acme', roles: ['approver'] };
  agent = { id: 'agent-1', tenantId: 'acme', roles: ['agent'], agentId: 'agent-1', modelId: 'model-v1' };
  otherTenant = { id: 'other-admin', tenantId: 'other', roles: ['admin'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  await kernel.boot();
  service = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
});

describe('Commercial Control Plane', () => {
  it('defaults to human approval and simulation when no policy authorizes execution', async () => {
    const decision = await service.proposeDecision(agent, decisionInput());
    const authorization = await service.authorizeDecision(agent, decision.id);

    assert.equal(authorization.outcome, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(authorization.allowed, false);
    assert.equal(authorization.simulationOnly, true);
    assert.equal(authorization.approvalState, 'PENDING');
    assert.equal((await service.getDecision(agent, decision.id))?.executionState, 'WAITING_FOR_APPROVAL');
    assert.deepEqual(await service.verifyLedgerIntegrity(agent), { valid: true, entries: 3 });
  });

  it('enforces policy, approval, action verification, idempotency, and a tamper-evident ledger', async () => {
    await allowPolicy({ approvalRiskThreshold: 50 });
    const decision = await service.proposeDecision(operator, decisionInput({ riskScore: 60 }));
    const initial = await service.authorizeDecision(operator, decision.id);
    assert.equal(initial.outcome, 'HUMAN_APPROVAL_REQUIRED');

    const request = await service.requestApproval(operator, decision.id, 'Risk threshold requires an independent review.');
    await service.resolveApproval(approver, request.id, 'APPROVED', 'Bounded action is approved.');
    const authorized = await service.authorizeDecision(operator, decision.id);
    assert.equal(authorized.outcome, 'ALLOW');
    assert.equal(authorized.allowed, true);

    const planned = await service.planAction(operator, decision.id, {
      targetSystem: 'sandbox-distribution',
      targetResource: 'announcement-1',
      idempotencyKey: 'publish-announcement-1',
      dryRun: false,
      rollbackStrategy: 'withdraw publication through the provider adapter',
    });
    assert.equal(planned.executionStatus, 'QUEUED');
    assert.equal(planned.dryRun, false);
    const samePlan = await service.planAction(operator, decision.id, {
      targetSystem: 'sandbox-distribution',
      idempotencyKey: 'publish-announcement-1',
      dryRun: false,
    });
    assert.equal(samePlan.id, planned.id, 'idempotency key returns the original planned action');

    const running = await service.startAction(operator, planned.id);
    assert.equal(running.executionStatus, 'EXECUTING');
    const reported = await service.reportActionResult(operator, planned.id, {
      reportedSuccess: true,
      summary: 'Provider accepted the controlled request.',
      externalResponse: { requestId: 'provider-123' },
      resourceConsumption: [{ resourceType: 'MONEY', amount: 18, unit: 'KES', currency: 'KES' }],
      financialCost: { amount: 18, currency: 'KES' },
    });
    assert.equal(reported.executionStatus, 'VERIFYING');
    assert.notEqual(reported.executionStatus, 'COMPLETED', 'provider acceptance is not verification');

    const completed = await service.verifyAction(operator, planned.id, {
      verified: true,
      evidence: [evidence('verification-1')],
      summary: 'External state and internal telemetry confirmed publication.',
      externalState: { providerStatus: 'published' },
    });
    assert.equal(completed.executionStatus, 'COMPLETED');
    assert.equal(completed.verificationStatus, 'VERIFIED');
    assert.equal((await service.verifyLedgerIntegrity(operator)).valid, true);
  });

  it('blocks actions that exceed a scoped money budget before planning', async () => {
    await allowPolicy();
    await service.createBudget(admin, {
      scope: { tenantId: 'acme', productId: 'product-1' },
      resourceType: 'MONEY',
      period: 'DAILY',
      limit: 50,
      unit: 'KES',
      currency: 'KES',
    });
    const decision = await service.proposeDecision(operator, decisionInput({ estimatedCost: { amount: 60, currency: 'KES' } }));
    const authorization = await service.authorizeDecision(operator, decision.id);

    assert.equal(authorization.outcome, 'DENY');
    assert.ok(authorization.budgetChecks.some((check) => !check.allowed));
    await assert.rejects(
      () => service.planAction(operator, decision.id, { targetSystem: 'sandbox', idempotencyKey: 'over-budget', dryRun: false }),
      CommercialControlPlaneError,
    );
  });

  it('enforces connector health and consent before external communication is authorized', async () => {
    await allowPolicy();
    const connector = await service.registerConnector(admin, {
      providerId: 'email-provider',
      providerType: 'email',
      supportedActions: ['PUBLISH_CONTENT'],
      authenticationMethod: 'oauth',
      requiredPermissions: ['send'],
      rollbackSupport: true,
      webhookSupport: true,
      sandboxSupport: true,
      productionSupport: true,
      health: 'HEALTHY',
    });
    const communicationDecision = await service.proposeDecision(operator, decisionInput({
      connectorId: connector.id,
      communication: { subjectId: 'prospect-hash-1', channel: 'email', purpose: 'marketing' },
    }));
    const withoutConsent = await service.authorizeDecision(operator, communicationDecision.id);
    assert.equal(withoutConsent.outcome, 'DENY');
    assert.ok(withoutConsent.checks.some((check) => check.name === 'consent' && !check.passed));

    await service.recordConsent(operator, {
      subjectId: 'prospect-hash-1',
      channel: 'email',
      purpose: 'marketing',
      consentState: 'GRANTED',
      source: 'double-opt-in',
      provenance: { source: 'double-opt-in', collectedAt: now, correlationId: 'consent-1' },
    });
    const withConsent = await service.authorizeDecision(operator, communicationDecision.id);
    assert.equal(withConsent.outcome, 'ALLOW');

    await service.updateConnectorHealth(operator, connector.id, 'CREDENTIAL_EXPIRED', 'OAuth grant expired.');
    const expiredCredential = await service.authorizeDecision(operator, communicationDecision.id);
    assert.equal(expiredCredential.outcome, 'DENY');
  });

  it('applies product/campaign state machines and records explicit transitions', async () => {
    await service.initializeProduct(operator, 'product-1', 'venture-1');
    const productTransition = await service.transitionProduct(operator, 'product-1', {
      newState: 'DISCOVERED', trigger: 'evidence-collected', evidence: [evidence()], reason: 'First evidence package is recorded.',
    });
    assert.equal(productTransition.previousState, 'IDEA');
    assert.equal(productTransition.newState, 'DISCOVERED');
    await assert.rejects(
      () => service.transitionProduct(operator, 'product-1', { newState: 'COLD_START', trigger: 'skip', reason: 'Invalid skip.' }),
      /not allowed/,
    );

    await service.initializeCampaign(operator, 'campaign-1', 'product-1');
    const campaignTransition = await service.transitionCampaign(operator, 'campaign-1', 'product-1', {
      newState: 'HYPOTHESIS', trigger: 'hypothesis-authored', reason: 'Campaign hypothesis is explicit.',
    });
    assert.equal(campaignTransition.newState, 'HYPOTHESIS');
    assert.equal((await service.getCampaignState(operator, 'campaign-1'))?.state, 'HYPOTHESIS');
  });

  it('supports explicitly approved, bounded experiments and automatic stop on a limit', async () => {
    const experiment = await service.createExperiment(operator, {
      hypothesis: 'Verified proof improves qualified signup conversion.',
      productId: 'product-1',
      campaignId: 'campaign-1',
      control: 'existing landing content',
      variant: 'evidence-backed landing content',
      objective: 'Measure qualified signup conversion.',
      primaryMetric: 'qualified_signup_rate',
      sampleDefinition: 'consented prospect segment only',
      durationMs: 60_000,
      budget: {
        maximumMonetaryCost: { amount: 10, currency: 'KES' },
        maximumDurationMs: 60_000,
        maximumAudienceExposure: 100,
        maximumAcceptableDownside: 0.05,
        stoppingRule: 'Stop at monetary cap or unacceptable downside.',
      },
    });
    assert.equal(experiment.state, 'APPROVAL_REQUIRED');
    await service.approveExperiment(approver, experiment.id);
    await service.startExperiment(operator, experiment.id);
    await assert.rejects(
      () => service.createExperiment(operator, {
        hypothesis: 'Verified proof improves qualified signup conversion.', productId: 'product-1', campaignId: 'campaign-1',
        control: 'same control', variant: 'same variant', objective: 'same objective', primaryMetric: 'qualified_signup_rate',
        sampleDefinition: 'same population', durationMs: 1_000,
        budget: { maximumDurationMs: 1_000, stoppingRule: 'stop' },
      }),
      CommercialControlPlaneError,
    );
    const stopped = await service.recordExperimentCost(operator, experiment.id, {
      cost: [{ resourceType: 'MONEY', amount: 10, unit: 'KES', currency: 'KES' }],
      result: { measured: true },
    });
    assert.equal(stopped.state, 'STOPPED');
    assert.equal(stopped.endTime, now);
  });

  it('retains classified experiment measurements, stops only on non-simulated configured limits, and finalizes an auditable conclusion', async () => {
    const experiment = await service.createExperiment(operator, {
      hypothesis: 'An evidence-backed variant improves qualified signup conversion.',
      productId: 'product-1',
      control: 'baseline content',
      variant: 'evidence-backed content',
      objective: 'Measure qualified signup conversion.',
      primaryMetric: 'qualified_signup_rate',
      sampleDefinition: 'consented prospect segment only',
      durationMs: 60_000,
      budget: {
        maximumDurationMs: 60_000,
        maximumAudienceExposure: 100,
        successThreshold: 0.8,
        failureThreshold: 0.2,
        primaryMetricDirection: 'HIGHER_IS_BETTER',
        stoppingRule: 'Stop at configured exposure, success, or failure threshold.',
      },
    });
    await service.approveExperiment(approver, experiment.id);
    await service.startExperiment(operator, experiment.id);
    const simulated = await service.recordExperimentMeasurement(operator, experiment.id, {
      kind: 'PRIMARY_METRIC', metric: 'qualified_signup_rate', value: 0.9, unit: 'ratio', classification: 'SIMULATED',
      evidence: [evidence('simulated-experiment-measurement')], provenance: { source: 'simulation', collectedAt: now, correlationId: experiment.id },
    });
    assert.equal(simulated.experiment.state, 'RUNNING', 'a simulation cannot stop a live experiment');
    const stopped = await service.recordExperimentMeasurement(operator, experiment.id, {
      kind: 'AUDIENCE_EXPOSURE', metric: 'audience_exposure', value: 100, unit: 'people', classification: 'MEASURED',
      evidence: [evidence('exposure-experiment-measurement')], provenance: { source: 'telemetry', collectedAt: now, correlationId: experiment.id },
    });
    assert.equal(stopped.experiment.state, 'STOPPED');
    assert.match(stopped.experiment.stopReason ?? '', /audience exposure/i);
    assert.equal((await service.listExperimentMeasurements(operator, experiment.id)).length, 2);
    const finalized = await service.finalizeExperiment(operator, experiment.id, {
      state: 'SCALED', result: { primaryMetric: 0.9, classification: 'MEASURED_RESULT_REVIEWED' }, confidence: 75,
      uncertainty: 'The conclusion is limited to the measured sample.', causalMethod: 'bounded experiment comparison',
      decision: 'Consider separate governed scale authorization.', learning: 'Evidence-backed content warrants further governed review.',
      reusableInsight: 'Keep claim evidence attached to creative variants.', evidence: [evidence('experiment-finalization')],
      provenance: { source: 'experiment-review', collectedAt: now, correlationId: experiment.id },
    });
    assert.equal(finalized.state, 'SCALED');
    assert.equal(finalized.decision, 'Consider separate governed scale authorization.');
    const events = await service.replayEvents(operator, { eventTypes: ['commercial.experiment.changed'] });
    assert.ok(events.some((event) => event.payload.scaleAuthorization === 'NOT_AUTHORIZED'), 'a SCALED conclusion is not an execution authorization');
  });

  it('persists versioned events with idempotency and protects tenant boundaries', async () => {
    const first = await service.publishEvent(operator, {
      eventType: 'campaign.telemetry.received', source: 'test', entityId: 'campaign-1', correlationId: 'corr-event-1',
      payload: { clicks: 10 }, schemaVersion: 1, eventVersion: 1,
      provenance: { source: 'test', collectedAt: now, correlationId: 'corr-event-1' }, idempotencyKey: 'telemetry-1',
    });
    const duplicate = await service.publishEvent(operator, {
      eventType: 'campaign.telemetry.received', source: 'test', entityId: 'campaign-1', correlationId: 'corr-event-1',
      payload: { clicks: 10 }, schemaVersion: 1, eventVersion: 1,
      provenance: { source: 'test', collectedAt: now, correlationId: 'corr-event-1' }, idempotencyKey: 'telemetry-1',
    });
    assert.equal(duplicate.id, first.id);
    assert.equal((await service.replayEvents(operator, { eventTypes: ['campaign.telemetry.received'] })).length, 1);

    const decision = await service.proposeDecision(agent, decisionInput());
    assert.equal(await service.getDecision(otherTenant, decision.id), undefined);
    assert.equal((await service.listDecisions(otherTenant)).length, 0);
  });

  it('persists decisions and their tamper-evident tenant ledger through a filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-commercial-control-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new CommercialControlPlaneModule({ now: () => now }));
      await first.boot();
      const firstService = first.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
      const stored = await firstService.proposeDecision(agent, decisionInput({ productId: 'persistent-product' }));
      await first.shutdown();

      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new CommercialControlPlaneModule({ now: () => now }));
      await second.boot();
      const secondService = second.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
      assert.equal((await secondService.getDecision(agent, stored.id))?.productId, 'persistent-product');
      assert.equal((await secondService.verifyLedgerIntegrity(agent)).valid, true);
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('makes a matching kill switch override otherwise valid policy authorization', async () => {
    await allowPolicy();
    await service.setKillSwitch(admin, {
      scopeType: 'PRODUCT', scope: { tenantId: 'acme', productId: 'product-1' }, active: true, reason: 'Emergency commercial pause.',
    });
    const decision = await service.proposeDecision(operator, decisionInput());
    const authorization = await service.authorizeDecision(operator, decision.id);
    assert.equal(authorization.outcome, 'DENY');
    assert.ok(authorization.checks.some((check) => check.name === 'kill_switch' && !check.passed));
  });
});
