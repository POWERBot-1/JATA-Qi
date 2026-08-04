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
