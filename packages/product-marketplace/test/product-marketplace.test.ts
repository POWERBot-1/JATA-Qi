// ProductMarketplaceModule tests — commercial product marketplace.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import { ProductMarketplaceModule, ProductMarketplaceEvents, versionLess, satisfiesConstraint } from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('ProductMarketplaceEngine', () => {
  it('catalogs the built-in products (TANYA, MAZA, SOMA, Moto X, Nyumbani)', () => {
    const mod = new ProductMarketplaceModule('1.0.0');
    const ids = mod.catalog().map((p) => p.id);
    for (const id of ['tanya', 'maza', 'soma', 'moto-x', 'nyumbani']) assert.ok(ids.includes(id), `${id} in catalog`);
    assert.equal(mod.catalog().length, 5);
  });

  it('installs a product with dependency resolution in order', () => {
    const mod = new ProductMarketplaceModule('1.0.0');
    const result = mod.install('soma', 'admin');
    // SOMA depends on TANYA → install order: tanya first, then soma.
    assert.deepEqual(result.order, ['tanya', 'soma']);
    assert.equal(mod.installedList().length, 2);
    assert.equal(mod.installed('soma')!.runtime, 'provisioned');
  });

  it('one-click provisioning runs the product (runtime start)', () => {
    const mod = new ProductMarketplaceModule('1.0.0');
    mod.install('maza', 'admin');
    const running = mod.setRuntime('maza', 'running');
    assert.equal(running!.runtime, 'running');
    assert.equal(mod.stats().running, 1);
  });

  it('blocks uninstall while dependents exist and allows after removal', () => {
    const mod = new ProductMarketplaceModule('1.0.0');
    mod.install('nyumbani', 'admin'); // depends on maza
    const blocked = mod.uninstall('maza', 'admin');
    assert.equal(blocked.removed, false);
    assert.deepEqual(blocked.blockedBy, ['nyumbani']);
    mod.uninstall('nyumbani', 'admin');
    const ok = mod.uninstall('maza', 'admin');
    assert.equal(ok.removed, true);
  });

  it('upgrades to a newer catalog version and detects upgradesAvailable', () => {
    const mod = new ProductMarketplaceModule('1.0.0');
    mod.install('tanya', 'admin');
    mod.registerProduct({ id: 'tanya', name: 'TANYA AI', version: '1.1.0', kind: 'ai', activates: ['tanya'] });
    assert.equal(mod.upgradesAvailable().length, 1);
    const upgraded = mod.upgrade('tanya', 'admin');
    assert.equal(upgraded.manifest.version, '1.1.0');
    assert.ok(upgraded.upgradedAt);
    assert.equal(mod.upgradesAvailable().length, 0);
  });

  it('rejects platform-incompatible products and detects dependency cycles', () => {
    const mod = new ProductMarketplaceModule('1.0.0');
    mod.registerProduct({ id: 'future', name: 'Future', version: '1.0.0', kind: 'custom', activates: ['x'], minPlatformVersion: '2.0.0' });
    assert.throws(() => mod.install('future', 'admin'), /requires platform/);
    // Cyclic dependencies.
    mod.registerProduct({ id: 'a', name: 'A', version: '1', kind: 'custom', activates: ['x'], dependencies: ['b'] });
    mod.registerProduct({ id: 'b', name: 'B', version: '1', kind: 'custom', activates: ['x'], dependencies: ['a'] });
    assert.throws(() => mod.install('a', 'admin'), /cycle/);
  });

  it('version helpers compare semver and constraints', () => {
    assert.equal(versionLess('1.2.3', '1.2.10'), true);
    assert.equal(versionLess('1.2.3', '1.2.3'), false);
    assert.equal(satisfiesConstraint('1.4.0', '>=1.0.0'), true);
    assert.equal(satisfiesConstraint('1.4.0', '<2.0.0'), true);
    assert.equal(satisfiesConstraint('2.1.0', '^2.0.0'), true);
    assert.equal(satisfiesConstraint('3.0.0', '^2.0.0'), false);
  });
});

describe('ProductMarketplaceModule (kernel wiring + gateway)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new ProductMarketplaceModule('1.0.0'));
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits product lifecycle events', async () => {
    const mod = kernel.getModule<ProductMarketplaceModule>('product-marketplace');
    const events: string[] = [];
    kernel.bus.on(ProductMarketplaceEvents.ProductInstalled, () => { events.push(ProductMarketplaceEvents.ProductInstalled); });
    kernel.bus.on(ProductMarketplaceEvents.ProductUpgraded, () => { events.push(ProductMarketplaceEvents.ProductUpgraded); });
    mod.install('tanya', 'admin');
    mod.registerProduct({ id: 'tanya', name: 'TANYA AI', version: '1.2.0', kind: 'ai', activates: ['tanya'] });
    mod.upgrade('tanya', 'admin');
    assert.ok(events.includes(ProductMarketplaceEvents.ProductInstalled));
    assert.ok(events.includes(ProductMarketplaceEvents.ProductUpgraded));
  });
});

describe('Product marketplace gateway integration (vs real server)', () => {
  let qi: Awaited<ReturnType<CreateJataQi>>;
  let admin: JataQiClient;
  let port: number;
  let closeHandle: () => Promise<void>;

  before(async () => {
    const bootstrapPath = new URL('../../../cli/dist/src/bootstrap.js', import.meta.url).href;
    const mod = await import(bootstrapPath) as unknown as { createJataQi: CreateJataQi };
    qi = await mod.createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    const handle = await qi.gateway!.listen({ port: 0 });
    port = handle.port;
    closeHandle = handle.close;
    admin = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await admin.auth.login('admin', 'admin');
  });

  after(async () => {
    if (closeHandle) await closeHandle();
    if (qi) await qi.shutdown();
  });

  it('installs SOMA with its TANYA dependency, lists, and starts runtime end-to-end', async () => {
    const catalog = await admin.products.catalog();
    assert.equal((catalog.catalog as unknown[]).length, 5);
    const installed = await admin.products.install('soma');
    assert.deepEqual((installed as { order: string[] }).order, ['tanya', 'soma']);
    const list = await admin.products.installed();
    assert.equal((list.installed as unknown[]).length, 2);
    const running = await admin.products.setRuntime('soma', 'running');
    assert.equal((running.installed as { runtime: string }).runtime, 'running');
    const stats = await admin.products.stats();
    assert.equal((stats.stats as { running: number }).running, 1);
  });

  it('blocks uninstall of a depended-on product via gateway', async () => {
    const blocked = await admin.products.uninstall('tanya');
    assert.equal((blocked as { removed: boolean }).removed, false);
    assert.deepEqual((blocked as { blockedBy: string[] }).blockedBy, ['soma']);
  });
});
