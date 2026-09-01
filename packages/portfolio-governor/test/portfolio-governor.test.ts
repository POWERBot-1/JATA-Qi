import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  PortfolioGovernorError,
  PortfolioGovernorModule,
  type PortfolioGovernorService,
  type ProductPerformanceInput,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let governor: PortfolioGovernorService;

function evidence(id = 'portfolio-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'portfolio-test', observedAt: now, confidence: 94,
    summary: 'Controlled portfolio evidence.', provenance: { source: 'portfolio-test', collectedAt: now, correlationId: 'portfolio-correlation' },
  };
}

function performance(overrides: Partial<ProductPerformanceInput> = {}): ProductPerformanceInput {
  return {
    productId: 'product-1', ventureId: 'venture-1', revenue: { amount: 100, currency: 'KES' },
    growthScore: 85, contributionMarginScore: 85, retentionScore: 85, pmfScore: 85, confidenceScore: 85, riskScore: 20,
    strategicValueScore: 70, capitalEfficiencyScore: 85, evidence: [evidence()], provenance: { source: 'portfolio-test', collectedAt: now },
    ...overrides,
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new PortfolioGovernorModule());
  await kernel.boot();
  governor = kernel.getModule<PortfolioGovernorModule>('portfolio-governor').getService();
});

describe('Portfolio governor', () => {
  it('classifies an evidenced, low-risk high-performing product as a winner and produces a non-executing allocation recommendation', async () => {
    const assessment = await governor.assess(operator, performance());
    assert.equal(assessment.classification, 'WINNER');
    assert.equal(assessment.decision, 'SCALE');
    const allocation = await governor.recommendAllocation(operator, {
      assessmentId: assessment.id,
      requestedResources: [{ resourceType: 'COMPUTE', amount: 10, unit: 'cpu-hours' }, { resourceType: 'MONEY', amount: 1000, unit: 'KES', currency: 'KES' }],
    });
    assert.equal(allocation.status, 'RECOMMENDATION_ONLY');
    assert.match(allocation.rationale, /separate Commercial Control Plane authorization/);
  });

  it('prevents high-risk scale even when performance would otherwise qualify as a winner', async () => {
    const assessment = await governor.assess(operator, performance({ riskScore: 80 }));
    assert.equal(assessment.classification, 'PROMISING');
    assert.equal(assessment.decision, 'EXPERIMENT');
  });

  it('recognizes weak PMF/retention as a pivot signal and weak performance as retirement', async () => {
    const pivot = await governor.assess(operator, performance({ growthScore: 20, contributionMarginScore: 25, retentionScore: 20, pmfScore: 20, strategicValueScore: 30, capitalEfficiencyScore: 30 }));
    assert.equal(pivot.classification, 'PIVOT');
    assert.equal(pivot.decision, 'CHANGE_THESIS');
    const retire = await governor.assess(operator, performance({ growthScore: 0, contributionMarginScore: 0, retentionScore: 50, pmfScore: 50, strategicValueScore: 0, capitalEfficiencyScore: 0, confidenceScore: 90 }));
    assert.equal(retire.classification, 'RETIRE');
    await assert.rejects(() => governor.recommendAllocation(operator, { assessmentId: retire.id, requestedResources: [{ resourceType: 'COMPUTE', amount: 1, unit: 'cpu-hour' }] }), PortfolioGovernorError);
  });

  it('holds low-confidence assessments despite strong scores and honors custom policy thresholds', async () => {
    await governor.configurePolicy(admin, { minimumConfidence: 90, winnerScore: 80, promisingScore: 60, stableScore: 40, pivotScore: 20, maximumScaleRisk: 30 });
    const held = await governor.assess(operator, performance({ confidenceScore: 70 }));
    assert.equal(held.decision, 'HOLD');
    assert.match(held.reason, /confidence/);
  });

  it('keeps assessment and allocation records tenant-isolated', async () => {
    const assessment = await governor.assess(operator, performance());
    assert.equal(await governor.getAssessment(other, assessment.id), undefined);
    assert.equal((await governor.listAssessments(other)).length, 0);
    assert.equal((await governor.listAllocations(other)).length, 0);
  });
});
