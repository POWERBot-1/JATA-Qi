import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { PaymentsModule } from '@jataqi/payments';
import { BillingModule } from '@jataqi/billing';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import { CommercialAnalyticsModule } from '@jataqi/commercial-analytics';
import { CommercialIntelligenceModule, type CommercialIntelligenceService, type ReadinessRequirementResult } from '@jataqi/commercial-intelligence';
import { AutonomousVentureFactoryModule, VentureFactoryError, type AutonomousVentureFactoryService } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let approver: CommercialActor;
let other: CommercialActor;
let control: ReturnType<CommercialControlPlaneModule['getService']>;
let intelligence: CommercialIntelligenceService;
let factory: AutonomousVentureFactoryService;

function evidence(id = 'venture-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'venture-factory-test', observedAt: now, confidence: 95,
    summary: 'Controlled venture evidence.', provenance: { source: 'venture-factory-test', collectedAt: now, correlationId: 'venture-correlation' },
  };
}

function blueprint() {
  return {
    businessModel: 'subscription', targetCustomers: ['small businesses'], valueProposition: 'Reduce workflow time.', pricingStrategy: 'tiered monthly pricing',
    distributionStrategy: 'evidence-backed direct channels', retentionStrategy: 'outcome-driven onboarding', unitEconomicsSummary: 'Measure contribution margin.', costStructureSummary: 'Track AI, infrastructure, and support costs.',
  };
}

function readiness(): ReadinessRequirementResult[] {
  const requirements: ReadinessRequirementResult['requirement'][] = ['PRODUCT_READY', 'PMF_READY', 'TRUST_READY', 'PROOF_READY', 'CONVERSION_READY', 'PAYMENT_READY', 'IDENTITY_READY', 'PLATFORM_READY', 'PERMISSIONS_READY', 'COMPLIANCE_READY', 'TELEMETRY_READY', 'ECONOMICS_READY', 'SECURITY_READY', 'RECOVERY_READY', 'GOVERNANCE_READY', 'KILL_SWITCH_READY', 'SUPPORT_READY'];
  return requirements.map((requirement) => ({ requirement, passed: true, hardBlocker: true, evidence: [evidence(`ready-${requirement}`)] }));
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  approver = { id: 'approver', tenantId: 'acme', roles: ['approver'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule({ now: () => now }));
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  kernel.register(new CommercialAnalyticsModule());
  kernel.register(new CommercialIntelligenceModule());
  kernel.register(new AutonomousVentureFactoryModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  intelligence = kernel.getModule<CommercialIntelligenceModule>('commercial-intelligence').getService();
  factory = kernel.getModule<AutonomousVentureFactoryModule>('autonomous-venture-factory').getService();
});

async function venture() {
  return factory.createVenture(operator, {
    name: 'Workflow OS', productId: 'product-1', blueprint: blueprint(), evidence: [evidence()], provenance: { source: 'venture-factory-test', collectedAt: now },
  });
}

async function approvedDecision() {
  const decision = await control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Approve governed venture progression.', proposedAction: 'Advance venture state after review.', actionType: 'VENTURE_APPROVAL',
    evidence: [evidence()], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2, requiredApproval: true,
    decisionReason: 'Venture transition is bounded by evidence and review.', provenance: { source: 'venture-factory-test', collectedAt: now, correlationId: 'venture-correlation' },
  });
  const request = await control.requestApproval(operator, decision.id, 'Independent venture approval required.');
  await control.resolveApproval(approver, request.id, 'APPROVED', 'Evidence and state transition reviewed.');
  return decision;
}

describe('Autonomous Venture Factory', () => {
  it('creates an evidence-backed discovered venture and prevents hidden lifecycle skips', async () => {
    const created = await venture();
    assert.equal(created.state, 'DISCOVERED');
    assert.equal((await control.getProductState(operator, 'product-1'))?.state, 'DISCOVERED');
    await assert.rejects(() => factory.transition(operator, created.id, { newState: 'BUILDING', reason: 'skip state', evidence: [evidence()] }), VentureFactoryError);
    const validated = await factory.transition(operator, created.id, { newState: 'VALIDATED', reason: 'Validation evidence reviewed.', evidence: [evidence('validated')] });
    assert.equal(validated.state, 'VALIDATED');
    assert.equal(validated.stateHistory.length, 1);
  });

  it('records a blocked state when approval evidence is missing instead of entering approved state', async () => {
    const created = await venture();
    await factory.transition(operator, created.id, { newState: 'VALIDATED', reason: 'Validated.', evidence: [evidence()] });
    const blocked = await factory.transition(operator, created.id, { newState: 'APPROVED', reason: 'Attempt approval without decision.', evidence: [evidence()] });
    assert.equal(blocked.state, 'BLOCKED');
    assert.match(blocked.stateHistory.at(-1)?.reason ?? '', /requires an explicit approved/);
  });

  it('requires both approved decision and GO readiness before production', async () => {
    const created = await venture();
    const decision = await approvedDecision();
    for (const state of ['VALIDATED', 'APPROVED', 'DESIGNED', 'BUILDING', 'TESTING', 'SANDBOX', 'STAGING'] as const) {
      await factory.transition(operator, created.id, { newState: state, reason: `Advance to ${state}.`, decisionId: state === 'APPROVED' ? decision.id : undefined, evidence: [evidence(`state-${state}`)] });
    }
    const blocked = await factory.transition(operator, created.id, { newState: 'PRODUCTION', reason: 'No readiness report.', decisionId: decision.id, evidence: [evidence('no-ready')] });
    assert.equal(blocked.state, 'BLOCKED');

    const second = await venture();
    for (const state of ['VALIDATED', 'APPROVED', 'DESIGNED', 'BUILDING', 'TESTING', 'SANDBOX', 'STAGING'] as const) {
      await factory.transition(operator, second.id, { newState: state, reason: `Advance to ${state}.`, decisionId: state === 'APPROVED' ? decision.id : undefined, evidence: [evidence(`second-${state}`)] });
    }
    const readinessReport = await intelligence.evaluateReadiness(operator, { productId: 'product-1', requirements: readiness(), provenance: { source: 'venture-readiness', collectedAt: now } });
    const production = await factory.transition(operator, second.id, { newState: 'PRODUCTION', reason: 'Readiness is GO.', decisionId: decision.id, readinessReportId: readinessReport.id, evidence: [evidence('production')] });
    assert.equal(production.state, 'PRODUCTION');
  });

  it('rejects opportunities whose evidence-adjusted recommendation is do-not-pursue', async () => {
    const opportunity = await intelligence.createOpportunity(operator, {
      title: 'Weak opportunity', description: 'No viable evidence-adjusted return.', evidence: [evidence('weak')],
      factors: { demand: 0, monetization: 0, marketSize: 0, competitionGap: 0, buildability: 50, distributionPotential: 0, retentionPotential: 50, grossMarginPotential: 0, capitalEfficiency: 0, timeToMarket: 0, defensibility: 0, technicalRisk: 10, regulatoryRisk: 10 },
      expectedRevenue: { low: 0, likely: 0, high: 0, evidenceStatus: 'ESTIMATED', calculationMethod: 'test' }, expectedCost: { low: 1, likely: 2, high: 3, evidenceStatus: 'ESTIMATED', calculationMethod: 'test' },
      expectedTimeToRevenueDays: { low: 1, likely: 2, high: 3, evidenceStatus: 'ESTIMATED', calculationMethod: 'test' }, provenance: { source: 'venture-factory-test', collectedAt: now },
    });
    assert.equal(opportunity.recommendation, 'DO_NOT_PURSUE');
    await assert.rejects(() => factory.createVenture(operator, { name: 'Weak', productId: 'weak-product', opportunityId: opportunity.id, blueprint: blueprint(), evidence: [evidence()], provenance: { source: 'test', collectedAt: now } }), VentureFactoryError);
  });

  it('keeps ventures tenant-isolated', async () => {
    const created = await venture();
    assert.equal(await factory.getVenture(other, created.id), undefined);
    assert.equal((await factory.listVentures(other)).length, 0);
  });
});
