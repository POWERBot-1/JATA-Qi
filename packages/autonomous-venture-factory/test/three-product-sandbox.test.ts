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
import { CommercialIntelligenceModule } from '@jataqi/commercial-intelligence';
import { AutonomousVentureFactoryModule, type AutonomousVentureFactoryService } from '../src/index.js';

let now: number;
let operator: CommercialActor;
let approver: CommercialActor;
let control: ReturnType<CommercialControlPlaneModule['getService']>;
let factory: AutonomousVentureFactoryService;

function evidence(id: string): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'three-product-sandbox', observedAt: now, confidence: 90,
    summary: 'Sandbox acceptance evidence only; not a live external outcome.',
    provenance: { source: 'three-product-sandbox', collectedAt: now, correlationId: 'three-product-sandbox' },
  };
}

beforeEach(async () => {
  now = Date.now();
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  approver = { id: 'approver', tenantId: 'acme', roles: ['approver'] };
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
  factory = kernel.getModule<AutonomousVentureFactoryModule>('autonomous-venture-factory').getService();
});

async function approvedDecision(productId: string) {
  const decision = await control.proposeDecision(operator, {
    tenantId: 'acme', productId, objective: 'Advance a sandbox-only venture lifecycle.', proposedAction: 'Advance after independent review.', actionType: 'VENTURE_APPROVAL',
    evidence: [evidence(`decision-${productId}`)], evidenceStrength: 85, riskScore: 15, complianceScore: 95, confidence: 80, authorizationLevel: 2, requiredApproval: true,
    decisionReason: 'This authorizes state progression only, not external deployment or production operation.', provenance: { source: 'three-product-sandbox', collectedAt: now, correlationId: productId },
  });
  const request = await control.requestApproval(operator, decision.id, 'Sandbox lifecycle approval.');
  await control.resolveApproval(approver, request.id, 'APPROVED', 'Sandbox state transition reviewed.');
  return decision;
}

async function runSandboxLifecycle(product: { name: string; productId: string; businessModel: string; customers: string[]; value: string }) {
  const decision = await approvedDecision(product.productId);
  const venture = await factory.createVenture(operator, {
    name: product.name,
    productId: product.productId,
    blueprint: {
      businessModel: product.businessModel,
      targetCustomers: product.customers,
      valueProposition: product.value,
      pricingStrategy: 'sandbox pricing hypothesis',
      distributionStrategy: 'sandbox distribution plan only',
      retentionStrategy: 'sandbox outcome feedback only',
      unitEconomicsSummary: 'No live revenue; economics remain simulated.',
      costStructureSummary: 'No live infrastructure/payment costs are claimed.',
      productSpecificationReference: `sandbox://specifications/${product.productId}`,
      engineeringPlanReference: `sandbox://engineering/${product.productId}`,
    },
    evidence: [evidence(`venture-${product.productId}`)],
    provenance: { source: 'three-product-sandbox', collectedAt: now, correlationId: product.productId },
  });
  for (const state of ['VALIDATED', 'APPROVED', 'DESIGNED', 'BUILDING', 'TESTING', 'SANDBOX'] as const) {
    await factory.transition(operator, venture.id, {
      newState: state,
      reason: `Sandbox acceptance transition to ${state}.`,
      decisionId: state === 'APPROVED' ? decision.id : undefined,
      evidence: [evidence(`${product.productId}-${state}`)],
    });
  }
  return factory.getVenture(operator, venture.id);
}

describe('Three-product sandbox acceptance', () => {
  it('coordinates e-commerce, school-management, and restaurant-ordering ventures through evidence-gated sandbox states only', async () => {
    const commerce = await runSandboxLifecycle({ name: 'E-commerce Platform', productId: 'ecommerce-platform', businessModel: 'transaction and subscription', customers: ['merchants', 'shoppers'], value: 'Enable legitimate online ordering and fulfillment.' });
    const school = await runSandboxLifecycle({ name: 'School Management Platform', productId: 'school-management', businessModel: 'institutional subscription', customers: ['schools', 'parents', 'teachers'], value: 'Improve school administration and communication.' });
    const restaurant = await runSandboxLifecycle({ name: 'Restaurant Ordering Platform', productId: 'restaurant-ordering', businessModel: 'subscription and order commission', customers: ['restaurants', 'diners'], value: 'Support menu, ordering, and fulfillment workflows.' });

    for (const venture of [commerce, school, restaurant]) {
      assert.equal(venture?.state, 'SANDBOX');
      assert.ok(venture?.stateHistory.some((transition) => transition.newState === 'TESTING'));
      assert.equal(venture?.stateHistory.some((transition) => transition.newState === 'PRODUCTION'), false);
      assert.match(venture?.blueprint.unitEconomicsSummary ?? '', /No live revenue/);
    }
  });
});
