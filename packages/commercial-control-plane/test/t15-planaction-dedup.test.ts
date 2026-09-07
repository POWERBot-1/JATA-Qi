import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  type CommercialAction,
  type CommercialActionLedgerEntry,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CreateCommercialDecisionInput,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

// T-15 planAction exactly-once election over real PostgreSQL. Fail-hard: if
// PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let storage: StorageModule;
let service: CommercialControlPlaneService;
let admin: CommercialActor;
let operator: CommercialActor;
let now: number;

function decisionInput(overrides: Partial<CreateCommercialDecisionInput> = {}): CreateCommercialDecisionInput {
  return {
    tenantId: 'acme',
    productId: 'product-1',
    ventureId: 'venture-1',
    objective: 'Validate T-15 exactly-once planning.',
    proposedAction: 'Publish a verified product announcement.',
    actionType: 'PUBLISH_CONTENT',
    estimatedCost: { amount: 20, currency: 'KES' },
    evidence: [
      {
        id: 'evidence-t15',
        status: 'MEASURED',
        source: 'controlled-test',
        observedAt: now,
        confidence: 92,
        summary: 'Measured controlled evidence.',
        provenance: { source: 'controlled-test', collectedAt: now, correlationId: 'corr-t15' },
      },
    ],
    evidenceStrength: 88,
    riskScore: 20,
    complianceScore: 95,
    confidence: 82,
    authorizationLevel: 3,
    decisionReason: 'Evidence supports a bounded, policy-governed action.',
    provenance: { source: 'controlled-test', collectedAt: now, correlationId: 'corr-t15' },
    ...overrides,
  };
}

async function authorizedDecisionId(): Promise<string> {
  await service.createPolicy(admin, {
    version: `t15-policy-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    scope: { tenantId: 'acme' },
    maximumAutonomyLevel: 4,
    allowExecution: true,
    allowedActionTypes: ['PUBLISH_CONTENT'],
    maximumRiskScore: 90,
    minimumComplianceScore: 80,
    minimumEvidenceStrength: 70,
  });
  const decision = await service.proposeDecision(operator, decisionInput());
  const authorization = await service.authorizeDecision(operator, decision.id);
  assert.equal(authorization.outcome, 'ALLOW');
  return decision.id;
}

before(async () => {
  pg = await bootR2Postgres('r2t15', 59700);
  now = Date.now();
  admin = { id: 'admin-1', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator-1', tenantId: 'acme', roles: ['operator'] };
  const booted = await bootR2StorageKernel(pg.connectionString);
  const kernel = createTestKernel();
  storage = new StorageModule({ driverInstance: booted.driver });
  kernel.register(storage);
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  await kernel.boot();
  service = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
});

after(async () => {
  await pg.stop();
});

describe('T-15 planAction exactly-once election over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('binds the action id to the key (same key, same id; distinct keys, distinct ids)', async () => {
    const decisionId = await authorizedDecisionId();
    const a = await service.planAction(operator, decisionId, {
      targetSystem: 'sandbox-distribution',
      idempotencyKey: `t15-bind-a-${process.pid}`,
    });
    const b = await service.planAction(operator, decisionId, {
      targetSystem: 'sandbox-distribution',
      idempotencyKey: `t15-bind-b-${process.pid}`,
    });
    assert.ok(a.id.startsWith('action:'));
    assert.notEqual(a.id, b.id);
    const aAgain = await service.planAction(operator, decisionId, {
      targetSystem: 'sandbox-distribution',
      idempotencyKey: `t15-bind-a-${process.pid}`,
    });
    assert.equal(aAgain.id, a.id);
  });

  it('elects one winner across concurrent planners (single action row + single ACTION_QUEUED)', async () => {
    const decisionId = await authorizedDecisionId();
    const key = `t15-race-${process.pid}`;
    const plans = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.planAction(operator, decisionId, {
          targetSystem: 'sandbox-distribution',
          targetResource: 'announcement-t15',
          idempotencyKey: key,
        }),
      ),
    );
    const ids = new Set(plans.map((p) => p.id));
    assert.equal(ids.size, 1, 'all concurrent planners must return the same action');
    // Exactly one action row exists for the key (no duplicates from the race).
    const actions = await storage.collection<CommercialAction>('commercial-control.actions');
    const rows = await actions.query({ where: (a) => a.idempotencyKey === key });
    assert.equal(rows.length, 1);
    // Exactly one ACTION_QUEUED ledger entry: losers perform zero writes.
    const ledger = await storage.collection<CommercialActionLedgerEntry>('commercial-control.action-ledger');
    const queued = await ledger.query({
      where: (e) => e.kind === 'ACTION_QUEUED' && e.actionId === plans[0]?.id,
    });
    assert.equal(queued.length, 1);
    assert.equal((await service.verifyLedgerIntegrity(admin)).valid, true);
    assert.equal((await service.getDecision(operator, decisionId))?.executionState, 'QUEUED');
  });

  it('returns the same record on sequential repeat (fast path, no new writes)', async () => {
    const decisionId = await authorizedDecisionId();
    const input = {
      targetSystem: 'sandbox-distribution',
      targetResource: 'announcement-t15-repeat',
      idempotencyKey: `t15-repeat-${process.pid}`,
    };
    const first = await service.planAction(operator, decisionId, input);
    const before = await service.verifyLedgerIntegrity(admin);
    const second = await service.planAction(operator, decisionId, input);
    assert.equal(second.id, first.id);
    const after = await service.verifyLedgerIntegrity(admin);
    assert.equal(after.entries, before.entries);
  });
});
