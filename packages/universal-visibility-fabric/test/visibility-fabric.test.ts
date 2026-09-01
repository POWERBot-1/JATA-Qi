import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import {
  UniversalVisibilityFabricModule,
  VisibilityFabricError,
  type CreateCreativeAssetInput,
  type UniversalVisibilityFabricService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let approver: CommercialActor;
let other: CommercialActor;
let visibility: UniversalVisibilityFabricService;

function evidence(id = 'visibility-evidence', status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  return {
    id, status, source: 'visibility-test', observedAt: now, confidence: 95,
    summary: 'Controlled asset evidence.', provenance: { source: 'visibility-test', collectedAt: now, correlationId: 'visibility-correlation' },
  };
}

function assetInput(overrides: Partial<CreateCreativeAssetInput> = {}): CreateCreativeAssetInput {
  return {
    productId: 'product-1', title: 'JATA Qi proof', content: 'JATA Qi has measured product evidence.', contentType: 'text/markdown',
    source: 'controlled-author', language: 'en', locale: 'en-KE', inputEvidence: [evidence()],
    claims: [{ id: 'claim-1', text: 'Measured customer activation improved.', evidenceStatus: 'VERIFIED', evidence: [evidence('claim-evidence', 'VERIFIED')], confidence: 92, provenance: { source: 'controlled-study', collectedAt: now } }],
    ...overrides,
  };
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
  kernel.register(new UniversalVisibilityFabricModule());
  await kernel.boot();
  visibility = kernel.getModule<UniversalVisibilityFabricModule>('universal-visibility-fabric').getService();
});

describe('Universal Visibility Fabric', () => {
  it('blocks an unsupported claim rather than converting it into a verified marketing fact', async () => {
    const asset = await visibility.createAsset(operator, assetInput({
      claims: [{ id: 'unverified', text: 'Guaranteed global reach.', evidenceStatus: 'UNVERIFIED', evidence: [evidence('unverified-evidence', 'UNVERIFIED')], confidence: 20, provenance: { source: 'guess', collectedAt: now } }],
    }));
    const validation = await visibility.validateAsset(operator, asset.id);
    assert.equal(validation.passed, false);
    assert.match(validation.reasons.join(' '), /cannot be approved/);
    assert.equal((await visibility.getAsset(operator, asset.id))?.status, 'BLOCKED');
  });

  it('enforces brand policy, human approval, and confirmation evidence before distributed state', async () => {
    await visibility.createBrandPolicy(admin, {
      productId: 'product-1', version: 'brand-v1', requiredBrandTerms: ['JATA Qi'], blockedPhrases: ['guaranteed reach'], allowedLocales: ['en-KE'], minimumClaimConfidence: 80,
    });
    const asset = await visibility.createAsset(operator, assetInput());
    const validation = await visibility.validateAsset(operator, asset.id);
    assert.equal(validation.passed, true);
    const approved = await visibility.approveAsset(approver, asset.id, validation.id);
    assert.equal(approved.status, 'APPROVED');

    const simulated = await visibility.recordDistribution(operator, asset.id, { channel: 'sandbox-social', simulated: true, confirmed: false, evidence: [] });
    assert.equal(simulated.status, 'APPROVED');
    assert.equal(simulated.distributionHistory[0]?.result, 'SIMULATED');
    await assert.rejects(() => visibility.recordDistribution(operator, asset.id, { channel: 'sandbox-social', confirmed: true, evidence: [] }), VisibilityFabricError);

    const distributed = await visibility.recordDistribution(operator, asset.id, { channel: 'sandbox-social', connectorId: 'connector-1', externalReference: 'post-1', confirmed: true, evidence: [evidence('distribution-verification', 'VERIFIED')] });
    assert.equal(distributed.status, 'DISTRIBUTED');
    assert.equal(distributed.distributionHistory.at(-1)?.result, 'CONFIRMED');
  });

  it('blocks phrases and incompatible locales through active brand governance', async () => {
    await visibility.createBrandPolicy(admin, { version: 'brand-v1', blockedPhrases: ['misleading'], allowedLocales: ['en-KE'] });
    const asset = await visibility.createAsset(operator, assetInput({ content: 'JATA Qi makes misleading claims.', locale: 'fr-FR' }));
    const validation = await visibility.validateAsset(operator, asset.id);
    assert.equal(validation.passed, false);
    assert.ok(validation.reasons.some((reason) => reason.includes('blocked phrase')));
    assert.ok(validation.reasons.some((reason) => reason.includes('not allowed')));
  });

  it('makes asset records tenant-isolated and content-addressed', async () => {
    const first = await visibility.createAsset(operator, assetInput());
    const second = await visibility.createAsset(operator, assetInput());
    assert.equal(first.contentHash, second.contentHash);
    assert.equal(await visibility.getAsset(other, first.id), undefined);
    assert.equal((await visibility.listAssets(other)).length, 0);
  });
});
