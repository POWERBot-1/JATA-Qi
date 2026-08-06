// Product Marketplace — installable product modules with lifecycle management.
//
// Packages JATA Qi products (MAZA AI, TANYA AI, SOMA AI, Moto X, Nyumbani
// Kitchen, ...) as installable modules with one-click provisioning, upgrades,
// dependency resolution, and version-compatibility checks. The marketplace is
// the commercial distribution layer: products map onto the platform's
// existing modules (commerce/MAZA, tanya, automation/SOMA, mobility/Moto X,
// restaurants/Nyumbani) and gate their activation.

import { randomUUID } from 'node:crypto';

export type ProductStatus = 'available' | 'installed' | 'upgrade_available' | 'disabled';
export type ProductKind = 'ai' | 'commerce' | 'mobility' | 'logistics' | 'game' | 'utility' | 'custom';

export interface ProductManifest {
  id: string;
  name: string;
  version: string;
  kind: ProductKind;
  description?: string;
  /** Platform module(s) this product activates (e.g. ['tanya']). */
  activates: string[];
  /** Product dependencies (ids). */
  dependencies?: string[];
  /** Minimum platform version required. */
  minPlatformVersion?: string;
  /** Compatible platform versions (semver-ish constraints, e.g. '>=1.0.0'). */
  platformConstraint?: string;
  /** Size estimate (MB) for provisioning UX. */
  sizeMb?: number;
}

export interface InstalledProduct {
  manifest: ProductManifest;
  installedAt: number;
  installedBy: string;
  status: ProductStatus;
  /** Last upgrade timestamp. */
  upgradedAt?: number;
  /** Runtime state: 'provisioned' | 'running' | 'stopped'. */
  runtime: 'provisioned' | 'running' | 'stopped';
}

export interface DependencyGraph {
  /** Product id → its (transitive) dependency ids, ordered install-first. */
  installOrder: string[];
  /** Product id → products that depend on it (reverse edges). */
  dependents: Record<string, string[]>;
  cycles: string[][];
}

const BUILTIN_PRODUCTS: ProductManifest[] = [
  { id: 'tanya', name: 'TANYA AI', version: '1.0.0', kind: 'ai', description: 'Conversational AI product layer', activates: ['tanya'], sizeMb: 42 },
  { id: 'maza', name: 'MAZA AI', version: '1.0.0', kind: 'commerce', description: 'Marketplace intelligence', activates: ['marketplace'], sizeMb: 18 },
  { id: 'soma', name: 'SOMA AI', version: '1.0.0', kind: 'ai', description: 'Automation engine', activates: ['automation'], dependencies: ['tanya'], sizeMb: 24 },
  { id: 'moto-x', name: 'Moto X', version: '1.0.0', kind: 'mobility', description: 'Mobility intelligence', activates: ['mobility'], sizeMb: 15 },
  { id: 'nyumbani', name: 'Nyumbani Kitchen', version: '1.0.0', kind: 'utility', description: 'Restaurant intelligence', activates: ['restaurants'], dependencies: ['maza'], sizeMb: 11 },
];

export class ProductMarketplaceEngine {
  private catalog = new Map<string, ProductManifest>();
  private installedMap = new Map<string, InstalledProduct>();
  private platformVersion: string;

  constructor(platformVersion = '1.0.0', products: ProductManifest[] = BUILTIN_PRODUCTS) {
    this.platformVersion = platformVersion;
    for (const p of products) this.catalog.set(p.id, p);
  }

  // ---- catalog ------------------------------------------------------------

  catalogList(): ProductManifest[] {
    return [...this.catalog.values()];
  }

  registerProduct(manifest: ProductManifest): ProductManifest {
    if (!manifest.id || !manifest.name || !manifest.version) throw new Error('id, name, and version are required');
    this.catalog.set(manifest.id, manifest);
    return manifest;
  }

  getProduct(id: string): ProductManifest | undefined {
    return this.catalog.get(id);
  }

  /** Products with an available newer version than installed. */
  upgradesAvailable(): ProductManifest[] {
    const out: ProductManifest[] = [];
    for (const [id, inst] of this.installedMap) {
      const manifest = this.catalog.get(id);
      if (manifest && manifest.version !== inst.manifest.version) out.push(manifest);
    }
    return out;
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Install a product: resolves + validates dependencies, checks platform
   * compatibility, and provisions. Returns the install order actually used.
   */
  install(productId: string, by: string): { installed: InstalledProduct; order: string[] } {
    const manifest = this.catalog.get(productId);
    if (!manifest) throw new Error(`unknown product ${productId}`);
    this.assertPlatformCompatible(manifest);
    const graph = this.resolveDependencies(productId);
    if (graph.cycles.length > 0) throw new Error(`dependency cycle: ${graph.cycles.map((c) => c.join('→')).join(', ')}`);
    // Install dependencies first (they may be auto-installed). The product
    // itself is the last element of the resolution order; de-dupe in case a
    // dependency edge also references it.
    const order: string[] = [];
    for (const depId of graph.installOrder) {
      if (order.includes(depId)) continue;
      if (this.installedMap.has(depId)) continue;
      const dep = this.catalog.get(depId)!;
      this.assertPlatformCompatible(dep);
      this.installedMap.set(depId, {
        manifest: dep, installedAt: Date.now(), installedBy: by,
        status: 'installed', runtime: 'provisioned',
      });
      order.push(depId);
    }
    if (!this.installedMap.has(productId)) {
      const record: InstalledProduct = {
        manifest, installedAt: Date.now(), installedBy: by,
        status: 'installed', runtime: 'provisioned',
      };
      this.installedMap.set(productId, record);
      order.push(productId);
    }
    const final = this.installedMap.get(productId)!;
    return { installed: final, order };
  }

  installedList(): InstalledProduct[] {
    return [...this.installedMap.values()];
  }

  installed(id: string): InstalledProduct | undefined {
    return this.installedMap.get(id);
  }

  /** Upgrade a product to the catalog version (dependencies re-validated). */
  upgrade(productId: string, by: string): InstalledProduct {
    const current = this.installedMap.get(productId);
    if (!current) throw new Error(`${productId} is not installed`);
    const manifest = this.catalog.get(productId);
    if (!manifest) throw new Error(`unknown product ${productId}`);
    if (manifest.version === current.manifest.version) throw new Error(`${productId} already at ${manifest.version}`);
    this.assertPlatformCompatible(manifest);
    for (const depId of manifest.dependencies ?? []) {
      if (!this.installedMap.has(depId)) throw new Error(`missing dependency ${depId} — install it first`);
    }
    const updated: InstalledProduct = {
      manifest, installedAt: current.installedAt, installedBy: current.installedBy,
      status: 'installed', runtime: 'running', upgradedAt: Date.now(),
    };
    this.installedMap.set(productId, updated);
    return updated;
  }

  uninstall(productId: string, by: string): { removed: boolean; blockedBy: string[] } {
    // Block uninstall while other installed products depend on this one.
    const dependents = this.dependentsOf(productId);
    if (dependents.length > 0) return { removed: false, blockedBy: dependents };
    const removed = this.installedMap.delete(productId);
    return { removed, blockedBy: [] };
  }

  setRuntime(productId: string, runtime: InstalledProduct['runtime']): InstalledProduct | undefined {
    const inst = this.installedMap.get(productId);
    if (!inst) return undefined;
    inst.runtime = runtime;
    return inst;
  }

  // ---- dependency resolution ---------------------------------------------------

  /**
   * Topological install order for a product (itself + transitive deps).
   * DFS with cycle detection.
   */
  resolveDependencies(productId: string): DependencyGraph {
    const state = new Map<string, 0 | 1 | 2>(); // 0=visiting 1=visited 2=done
    const order: string[] = [];
    const dependents: Record<string, string[]> = {};
    const cycles: string[][] = [];
    const stack: string[] = [];

    const visit = (id: string, path: string[]): void => {
      const s = state.get(id) ?? 0;
      if (s === 2) return;
      if (s === 1) {
        const idx = path.indexOf(id);
        if (idx >= 0) cycles.push([...path.slice(idx), id]);
        return;
      }
      state.set(id, 1);
      const manifest = this.catalog.get(id);
      if (!manifest) return;
      for (const dep of manifest.dependencies ?? []) {
        // Register reverse edge.
        (dependents[dep] ??= []).push(id);
        visit(dep, [...path, id]);
      }
      state.set(id, 2);
      order.push(id);
    };
    visit(productId, []);
    return { installOrder: order, dependents, cycles };
  }

  private dependentsOf(productId: string): string[] {
    const out = new Set<string>();
    for (const [id, inst] of this.installedMap) {
      for (const dep of inst.manifest.dependencies ?? []) {
        if (dep === productId) out.add(id);
      }
    }
    return [...out];
  }

  // ---- version compatibility -----------------------------------------------------

  assertPlatformCompatible(manifest: ProductManifest): void {
    if (manifest.minPlatformVersion && versionLess(this.platformVersion, manifest.minPlatformVersion)) {
      throw new Error(`${manifest.id} requires platform >= ${manifest.minPlatformVersion} (have ${this.platformVersion})`);
    }
    if (manifest.platformConstraint) {
      const ok = satisfiesConstraint(this.platformVersion, manifest.platformConstraint);
      if (!ok) throw new Error(`${manifest.id} incompatible with platform ${this.platformVersion} (constraint ${manifest.platformConstraint})`);
    }
  }

  stats(): { catalog: number; installed: number; running: number; upgradesAvailable: number } {
    return {
      catalog: this.catalog.size,
      installed: this.installedMap.size,
      running: [...this.installedMap.values()].filter((i) => i.runtime === 'running').length,
      upgradesAvailable: this.upgradesAvailable().length,
    };
  }
}

/** Simple semver compare: '1.2.3' < '1.2.10'. */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export function satisfiesConstraint(version: string, constraint: string): boolean {
  const c = constraint.trim();
  if (c.startsWith('>=')) return !versionLess(version, c.slice(2).trim());
  if (c.startsWith('<=')) return versionLess(version, c.slice(2).trim()) || version === c.slice(2).trim();
  if (c.startsWith('>')) return versionLess(c.slice(1).trim(), version);
  if (c.startsWith('<')) return versionLess(version, c.slice(1).trim());
  if (c.startsWith('^')) {
    const base = c.slice(1).trim();
    return !versionLess(version, base) && version.split('.')[0] === base.split('.')[0];
  }
  return version === c;
}
