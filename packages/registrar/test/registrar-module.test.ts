// RegistrarModule kernel integration tests.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { RegistryModule, hashSecret } from '@jataqi/registry';
import { RegistrarModule } from '../src/index.js';

describe('RegistrarModule', () => {
  let kernel: Kernel;
  let mod: RegistrarModule;

  before(async () => {
    kernel = createTestKernel();
    const reg = new RegistryModule({ serve: false });
    kernel.register(reg);
    kernel.register(new RegistrarModule());
    await kernel.boot();
    reg.addTld('.jq', { reserved: new Set(), reservedPatterns: [] });
    reg.addRegistrar('.jq', { id: 'reg-1', name: 'Reg 1', password: 'pw', active: true });
    mod = kernel.getModule<RegistrarModule>('registrar');
    mod.addRegistrar({ id: 'reg-1', name: 'Reg 1', tld: '.jq', priceBook: { baseCreate: 10, baseRenew: 10, baseRestore: 60, currency: 'USD' } });
  });
  after(async () => { await kernel.shutdown(); });

  it('lists registered registrars', () => {
    const list = mod.listRegistrars();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'reg-1');
  });

  it('registers a domain through the module-wired registrar', async () => {
    const reg = mod.getRegistrar('reg-1')!;
    const owner = reg.identities.register({ name: 'Jane', email: 'j@x' });
    const order = await reg.register({ name: 'via-module.jq', registrantId: owner.id, periodYears: 1 });
    assert.equal(order.status, 'completed');
  });

  it('refuses duplicate registrar ids', () => {
    assert.throws(() => mod.addRegistrar({ id: 'reg-1', name: 'dup' }));
  });
});
