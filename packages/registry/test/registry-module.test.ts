// RegistryModule kernel integration tests — multi-TLD, RDAP, escrow, reporting.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { RegistryModule, RegistryEvents } from '../src/index.js';

describe('RegistryModule', () => {
  let kernel: Kernel;
  let mod: RegistryModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new RegistryModule({ serve: false });
    kernel.register(mod);
    await kernel.boot();
    mod.addTld('.jq', { reserved: new Set(), reservedPatterns: [] });
    mod.addRegistrar('.jq', { id: 'reg-a', name: 'A', password: 'pw', active: true });
  });
  after(async () => { await kernel.shutdown(); });

  it('lists TLDs and resolves the registry for a name', () => {
    assert.deepEqual(mod.listTlds(), ['.jq']);
    assert.ok(mod.registryFor('foo.jq.'));
    assert.equal(mod.registryFor('foo.com.'), undefined);
  });

  it('creates a domain through the registry and emits an event', async () => {
    let fired = false;
    kernel.bus.on(RegistryEvents.DomainCreated, () => { fired = true; });
    mod.getTld('.jq')!.createDomain({ name: 'foo.jq.', registrarId: 'reg-a', registrant: 'c1', authInfo: 's' });
    await new Promise((r) => setImmediate(r));
    assert.ok(fired);
  });

  it('RDAP lookup returns the domain-of-record', () => {
    const r = mod.rdapLookup('foo.jq.');
    assert.equal(r.notFound, undefined);
    assert.equal(r.objectClassName, 'domain');
    assert.equal(r.ldhName, 'foo.jq');
  });

  it('RDAP reports notFound for unknown names', () => {
    assert.equal(mod.rdapLookup('nope.jq.').notFound, true);
  });

  it('builds and verifies an escrow deposit', () => {
    const deposit = mod.escrowDeposit('.jq');
    assert.equal(deposit.tld, '.jq');
    assert.equal(mod.verifyDeposit(deposit), true);
  });

  it('reports counts across TLDs', () => {
    const report = mod.report();
    assert.equal(report.length, 1);
    assert.ok(report[0]!.domains >= 1);
  });

  it('lists domains across TLDs with the TLD tag', () => {
    const all = mod.listAllDomains();
    assert.ok(all.some((d) => d.name === 'foo.jq.' && d.tld === '.jq'));
  });
});
