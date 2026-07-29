import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { ReadinessModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('ReadinessModule (kernel integration)', () => {
  let kernel: Kernel;
  let readiness: ReadinessModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new ReadinessModule());
    await kernel.boot();
    readiness = kernel.getModule<ReadinessModule>('readiness');
  });

  it('seeds an honest capability matrix', () => {
    const all = readiness.list();
    assert.ok(all.length >= 30);
    assert.ok(readiness.get('kernel'));
    assert.ok(readiness.get('finance'));
  });

  it('reports that the platform is NOT production-ready', () => {
    const s = readiness.summary();
    assert.equal(s.productionReady, 0);
    assert.ok(s.notImplemented > 0);
    assert.match(s.overall, /NOT production-ready/);
  });

  it('classifies frontier work as research-only, not implemented', () => {
    assert.equal(readiness.get('quantum')!.status, 'RESEARCH_ONLY');
    assert.equal(readiness.get('finance')!.status, 'NOT_IMPLEMENTED');
    assert.equal(readiness.get('kernel')!.status, 'TESTED');
  });

  it('updates a capability status with evidence', () => {
    const updated = readiness.update('commerce', 'IMPLEMENTED', ['commerce module', 'tests'], 'engine complete');
    assert.equal(updated.status, 'IMPLEMENTED');
    assert.equal(readiness.get('commerce')!.status, 'IMPLEMENTED');
  });

  it('filters by category', () => {
    assert.ok(readiness.list('frontier').length >= 2);
    assert.ok(readiness.list('foundation').length >= 5);
  });
});
