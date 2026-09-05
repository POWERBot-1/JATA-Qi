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
import {
  CommercialIntelligenceModule,
  type CommercialIntelligenceService,
  type CreateOpportunityInput,
  type ReadinessRequirementResult,
} from '../src/index.js';

let now: number;
let operator: CommercialActor;
let other: CommercialActor;
let intelligence: CommercialIntelligenceService;

function evidence(id = 'opportunity-evidence', status: CommercialEvidence['status'] = 'MEASURED', confidence = 90): CommercialEvidence {
  return {
    id, status, source: 'commercial-intelligence-test', observedAt: now, confidence,
    summary: 'Controlled market evidence.', provenance: { source: 'commercial-intelligence-test', collectedAt: now, correlationId: 'opportunity-correlation' },
  };
}

function opportunity(overrides: Partial<CreateOpportunityInput> = {}): CreateOpportunityInput {
  return {
    title: 'Workflow automation opportunity', description: 'Evidence-bound opportunity for a costly customer workflow.', market: 'KE', targetCustomer: 'small businesses',
    evidence: [evidence()],
    factors: { demand: 85, monetization: 80, marketSize: 70, competitionGap: 75, buildability: 80, distributionPotential: 65, retentionPotential: 75, grossMarginPotential: 85, capitalEfficiency: 80, timeToMarket: 70, defensibility: 55, technicalRisk: 20, regulatoryRisk: 15 },
    expectedRevenue: { low: 100, likely: 300, high: 600, currency: 'KES', evidenceStatus: 'ESTIMATED', calculationMethod: 'evidence-bound range' },
    expectedCost: { low: 50, likely: 100, high: 200, currency: 'KES', evidenceStatus: 'ESTIMATED', calculationMethod: 'cost range' },
    expectedTimeToRevenueDays: { low: 30, likely: 60, high: 120, evidenceStatus: 'ESTIMATED', calculationMethod: 'delivery estimate' },
    provenance: { source: 'commercial-intelligence-test', collectedAt: now, correlationId: 'opportunity-correlation' },
    ...overrides,
  };
}

function readiness(passed = true, hardBlocker = false): ReadinessRequirementResult[] {
  const names: ReadinessRequirementResult['requirement'][] = ['PRODUCT_READY', 'PMF_READY', 'TRUST_READY', 'PROOF_READY', 'CONVERSION_READY', 'PAYMENT_READY', 'IDENTITY_READY', 'PLATFORM_READY', 'PERMISSIONS_READY', 'COMPLIANCE_READY', 'TELEMETRY_READY', 'ECONOMICS_READY', 'SECURITY_READY', 'RECOVERY_READY', 'GOVERNANCE_READY', 'KILL_SWITCH_READY', 'SUPPORT_READY'];
  return names.map((requirement, index) => ({ requirement, passed: index === 0 ? passed : true, hardBlocker: index === 0 ? hardBlocker : false, evidence: [evidence(`readiness-${requirement}`)], remediation: passed ? undefined : 'Resolve the blocking requirement.', owner: 'product', priority: hardBlocker ? 'CRITICAL' : 'HIGH' }));
}

beforeEach(async () => {
  now = Date.now();
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
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
  await kernel.boot();
  intelligence = kernel.getModule<CommercialIntelligenceModule>('commercial-intelligence').getService();
});

describe('Commercial intelligence', () => {
  it('scores evidence-bound opportunities using ranges and recommends bounded validation, not automatic launch', async () => {
    const result = await intelligence.createOpportunity(operator, opportunity());
    assert.ok(result.opportunityScore >= 70);
    assert.ok(result.confidenceScore >= 70);
    assert.equal(result.recommendation, 'PURSUE_VALIDATION');
    assert.equal(result.state, 'VALIDATING');
    assert.deepEqual(result.expectedRevenue, { low: 100, likely: 300, high: 600, currency: 'KES', evidenceStatus: 'ESTIMATED', calculationMethod: 'evidence-bound range' });
  });

  it('treats unsupported evidence as a reason to wait rather than a market fact', async () => {
    const result = await intelligence.createOpportunity(operator, opportunity({ evidence: [evidence('assumption', 'ASSUMPTION', 95)] }));
    assert.equal(result.recommendation, 'WAIT_FOR_EVIDENCE');
    assert.equal(result.state, 'DISCOVERED');
  });

  it('requires human review for high-consequence technical/regulatory risk', async () => {
    const input = opportunity();
    input.factors.technicalRisk = 90;
    input.factors.regulatoryRisk = 95;
    const result = await intelligence.createOpportunity(operator, input);
    assert.equal(result.recommendation, 'HUMAN_REVIEW');
    assert.equal(result.state, 'APPROVAL_REQUIRED');
  });

  it('does not let a high readiness score override a failed hard blocker', async () => {
    const report = await intelligence.evaluateReadiness(operator, {
      productId: 'product-1', requirements: readiness(false, true), provenance: { source: 'readiness-test', collectedAt: now },
    });
    assert.ok(report.score > 90);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.requirements[0]?.requirement, 'PRODUCT_READY');
  });

  it('exposes current analytics without fabricating economics and preserves tenant isolation', async () => {
    const snapshot = await intelligence.currentEconomics(operator);
    assert.equal(snapshot.currencies.length, 0);
    const result = await intelligence.createOpportunity(operator, opportunity());
    assert.equal(await intelligence.getOpportunity(other, result.id), undefined);
    assert.equal((await intelligence.listOpportunities(other)).length, 0);
  });
});
