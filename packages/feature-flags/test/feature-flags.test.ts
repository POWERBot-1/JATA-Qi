import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { FeatureFlagsModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('FeatureFlagsModule (kernel integration)', () => {
  let kernel: Kernel;
  let ff: FeatureFlagsModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new FeatureFlagsModule());
    await kernel.boot();
    ff = kernel.getModule<FeatureFlagsModule>('feature-flags');
  });

  it('is off by default and on when enabled at full rollout', async () => {
    assert.equal(await ff.isEnabled('new-ui'), false);
    await ff.set('new-ui', true);
    assert.equal(await ff.isEnabled('new-ui'), true);
    assert.equal(await ff.isEnabled('new-ui', 'user-1'), true);
  });

  it('disabled flag is off regardless of rollout', async () => {
    await ff.set('x', false, 100);
    assert.equal(await ff.isEnabled('x', 'u'), false);
  });

  it('applies a deterministic percentage rollout per user', async () => {
    await ff.set('exp', true, 50);
    const on = [];
    const off = [];
    for (let i = 0; i < 200; i++) {
      const id = `u${i}`;
      (await ff.isEnabled('exp', id)) ? on.push(id) : off.push(id);
    }
    // ~50% of users see it; both buckets non-empty.
    assert.ok(on.length > 60 && on.length < 140, `on=${on.length}`);
    assert.ok(off.length > 60);
    // Determinism: same user always gets the same answer.
    const stable = await ff.isEnabled('exp', 'u42');
    for (let i = 0; i < 5; i++) assert.equal(await ff.isEnabled('exp', 'u42'), stable);
  });

  it('lists flags', async () => {
    await ff.set('a', true);
    await ff.set('b', false, 25);
    assert.equal((await ff.list()).length, 2);
  });
});
