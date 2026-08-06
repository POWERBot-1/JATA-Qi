// ProductMarketplaceModule — kernel module for the product marketplace.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { ProductMarketplaceEngine } from './engine.js';
import type { InstalledProduct, ProductManifest, ProductStatus } from './engine.js';

export const ProductMarketplaceEvents = Object.freeze({
  ProductInstalled: 'pm.product.installed',
  ProductUpgraded: 'pm.product.upgraded',
  ProductUninstalled: 'pm.product.uninstalled',
  ProductRuntimeChanged: 'pm.product.runtime',
} as const);

export class ProductMarketplaceModule implements IModule {
  readonly id = 'product-marketplace';
  readonly tags = ['core', 'commercial', 'marketplace'] as const;
  readonly dependsOn = [] as const;

  readonly engine: ProductMarketplaceEngine;
  private api!: KernelApi;

  constructor(platformVersion = '1.0.0') {
    this.engine = new ProductMarketplaceEngine(platformVersion);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('product-marketplace', this);
    kernel.logger.info('product-marketplace module initialized (commercial product registry)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  catalog() { return this.engine.catalogList(); }
  registerProduct(manifest: ProductManifest) { return this.engine.registerProduct(manifest); }
  product(id: string) { return this.engine.getProduct(id); }
  upgradesAvailable() { return this.engine.upgradesAvailable(); }

  install(productId: string, by: string): { installed: InstalledProduct; order: string[] } {
    const result = this.engine.install(productId, by);
    try { void this.api?.bus.emit(ProductMarketplaceEvents.ProductInstalled, { id: productId, order: result.order, by }); } catch { /* noop */ }
    return result;
  }
  installedList() { return this.engine.installedList(); }
  installed(id: string) { return this.engine.installed(id); }

  upgrade(productId: string, by: string): InstalledProduct {
    const updated = this.engine.upgrade(productId, by);
    try { void this.api?.bus.emit(ProductMarketplaceEvents.ProductUpgraded, { id: productId, version: updated.manifest.version, by }); } catch { /* noop */ }
    return updated;
  }

  uninstall(productId: string, by: string) {
    const result = this.engine.uninstall(productId, by);
    if (result.removed) try { void this.api?.bus.emit(ProductMarketplaceEvents.ProductUninstalled, { id: productId, by }); } catch { /* noop */ }
    return result;
  }

  setRuntime(productId: string, runtime: InstalledProduct['runtime']) {
    const inst = this.engine.setRuntime(productId, runtime);
    if (inst) try { void this.api?.bus.emit(ProductMarketplaceEvents.ProductRuntimeChanged, { id: productId, runtime }); } catch { /* noop */ }
    return inst;
  }

  resolveDependencies(productId: string) { return this.engine.resolveDependencies(productId); }
  stats() { return this.engine.stats(); }
}

export { ProductMarketplaceEngine, versionLess, satisfiesConstraint } from './engine.js';
export type { ProductManifest, InstalledProduct, ProductStatus, ProductKind, DependencyGraph } from './engine.js';
