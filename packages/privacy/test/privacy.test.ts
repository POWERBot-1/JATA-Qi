import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PrivacyModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('PrivacyModule (kernel integration)', () => {
  let kernel: Kernel;
  let p: PrivacyModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new PrivacyModule({
      seedClassifications: [
        { dataKind: 'pii', sensitivity: 'confidential' },
        { dataKind: 'payment', sensitivity: 'restricted' },
        { dataKind: 'public-faq', sensitivity: 'public' },
      ],
      seedRetention: [
        { dataKind: 'pii', ttlDays: 365, action: 'anonymize' },
        { dataKind: 'audit', ttlDays: 2555, action: 'delete' },
      ],
    }));
    await kernel.boot();
    p = kernel.getModule<PrivacyModule>('privacy');
  });

  it('classifies data kinds and flags AI-restricted sensitivity', async () => {
    assert.equal((await p.classify('pii')).sensitivity, 'confidential');
    assert.equal(await p.isAIRestricted('pii'), true);
    assert.equal(await p.isAIRestricted('payment'), true);
    assert.equal(await p.isAIRestricted('public-faq'), false);
    // unknown kinds default to internal (AI-safe).
    assert.equal(await p.isAIRestricted('something-new'), false);
  });

  it('returns retention policies per data kind', async () => {
    const r = await p.retentionFor('pii');
    assert.equal(r!.ttlDays, 365);
    assert.equal(r!.action, 'anonymize');
  });

  it('records, updates and reads consent', async () => {
    await p.recordConsent('user-1', 'marketing', 'granted');
    assert.equal(await p.getConsent('user-1', 'marketing'), 'granted');
    await p.recordConsent('user-1', 'marketing', 'withdrawn');
    assert.equal(await p.getConsent('user-1', 'marketing'), 'withdrawn');
    assert.equal((await p.listConsent('user-1')).length, 1); // updated, not duplicated
  });

  it('handles subject-access requests (export + delete)', async () => {
    let requested = 0;
    kernel.bus.on('privacy.sar.requested', () => { requested++; });
    const sar = await p.requestSAR('user-2', 'export', 'GDPR request');
    assert.equal(requested, 1);
    const done = await p.fulfillSAR(sar.id, 'completed');
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt);
    const del = await p.requestSAR('user-2', 'delete');
    await p.fulfillSAR(del.id, 'completed');
    assert.equal((await p.listSARs('user-2')).length, 2);
  });
});

describe('Privacy engineering (PIA / RoPA / secure deletion / minimization)', () => {
  let kernel: Kernel;
  let p: PrivacyModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new PrivacyModule({
      seedClassifications: [
        { dataKind: 'pii', sensitivity: 'confidential' },
        { dataKind: 'payment', sensitivity: 'restricted' },
      ],
    }));
    await kernel.boot();
    p = kernel.getModule<PrivacyModule>('privacy');
  });

  it('submits a PIA with privacy-by-design scoring and risk classification', async () => {
    const pia = await p.submitPia({
      title: 'User registration flow', flow: 'user.registration',
      dataFlows: [{
        flow: 'user.registration', dataKinds: ['pii', 'payment'],
        recipients: ['internal', 'billing', 'support'],
        retentionDays: 720,
      }],
      assessedBy: 'dpo',
    });
    assert.equal(pia.status, 'review');
    assert.ok(pia.designScore < 100, 'AI-restricted kinds + retention reduce the score');
    assert.ok(pia.mitigations.some((m) => m.risk.includes('payment') || m.risk.includes('pii')));
    assert.equal(pia.risk, 'medium', 'score band 60..80 → medium');
  });

  it('requires an approver for PIA decisions and blocks unacceptable-risk approval', async () => {
    const risky = await p.submitPia({
      title: 'Shadow processing', flow: 'data.broker',
      dataFlows: [{
        flow: 'data.broker',
        // 5 restricted data kinds → -50 design score → unacceptable.
        dataKinds: ['payment', 'payment', 'payment', 'payment', 'payment'],
        recipients: ['r1', 'r2', 'r3', 'r4'], retentionDays: 2000,
      }],
      assessedBy: 'dpo',
    });
    assert.equal(risky.risk, 'unacceptable');
    // Cannot approve an unacceptable PIA without mitigation.
    if (risky.risk === 'unacceptable') {
      await assert.rejects(p.decidePia(risky.id, 'approved', 'ciso'), /unacceptable/);
    }
    const low = await p.submitPia({
      title: 'Public FAQ', flow: 'content.public',
      dataFlows: [{ flow: 'content.public', dataKinds: ['public-faq'], recipients: ['internal'], retentionDays: 30 }],
      assessedBy: 'dpo',
    });
    const decided = await p.decidePia(low.id, 'approved', 'ciso');
    assert.equal(decided!.status, 'approved');
    assert.equal(decided!.approvedBy, 'ciso');
    assert.equal((await p.listPias('approved')).length, 1);
  });

  it('registers processing activities (RoPA) with legal basis', async () => {
    const record = await p.registerProcessing({
      activity: 'Payments processing', controller: 'JATA Qi Ltd',
      dataKinds: ['payment'], purposes: ['billing'], legalBasis: 'contract',
      recipients: ['stripe'], transfers: ['US'], retentionDays: 365,
    });
    assert.equal(record.legalBasis, 'contract');
    assert.ok(record.transfers!.includes('US'));
    await assert.rejects(
      p.registerProcessing({ activity: 'X', controller: 'C', dataKinds: ['pii'], purposes: [], legalBasis: '', recipients: [] }),
      /legal basis/,
    );
    assert.equal((await p.listProcessing('JATA Qi Ltd')).length, 1);
  });

  it('crypto-shreds with verified evidence and enforces key destruction', async () => {
    const deletion = await p.secureDelete({ target: 'user:u-42', dataKind: 'pii', method: 'crypto_shred', performedBy: 'dpo', keyDestroyed: true });
    assert.equal(deletion.method, 'crypto_shred');
    assert.equal(deletion.keyDestroyed, true);
    assert.equal(deletion.verified, true);
    assert.ok(deletion.evidenceHash.length === 64, 'SHA-256 evidence');
    // Crypto-shred without key destruction is rejected.
    await assert.rejects(p.secureDelete({ target: 'user:u-43', dataKind: 'pii', method: 'crypto_shred', performedBy: 'dpo' }), /keyDestroyed/);
    // Overwrite method works without keys.
    const overwrite = await p.secureDelete({ target: 'log:audit-9', dataKind: 'audit', method: 'overwrite', performedBy: 'dpo' });
    assert.equal(overwrite.method, 'overwrite');
    assert.equal((await p.listDeletions('user:u-42')).length, 1);
  });

  it('enforces data minimization and reports violations', async () => {
    const ok = await p.minimizeCheck({ purpose: 'account_creation', collected: ['email', 'password'], necessary: ['email', 'password'] });
    assert.equal(ok.compliant, true);
    assert.deepEqual(ok.excess, []);
    const bad = await p.minimizeCheck({ purpose: 'account_creation', collected: ['email', 'password', 'national_id', 'biometrics'], necessary: ['email', 'password'] });
    assert.equal(bad.compliant, false);
    assert.deepEqual(bad.excess, ['national_id', 'biometrics']);
    const posture = p.privacyPosture();
    assert.equal(posture.minimizationViolations, 1);
    assert.equal(posture.minimizationChecks, 2);
    assert.equal(posture.pias, 0, 'fresh kernel per test');
    assert.equal(posture.cryptoShreds, 0);
  });
});
