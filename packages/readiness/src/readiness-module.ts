// ReadinessModule — the honest capability/readiness registry. Seeded from a
// truthful default matrix; queryable and updatable as the platform evolves.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { DEFAULT_CAPABILITIES } from './defaults.js';
import { ReadinessEvents } from './types.js';
import type { Capability, ReadinessStatus, ReadinessSummary } from './types.js';

export class ReadinessModule implements IModule {
  readonly id = 'readiness';
  readonly tags = ['core', 'governance'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private capabilities = new Map<string, Capability>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    for (const c of DEFAULT_CAPABILITIES) this.capabilities.set(c.id, c);
    kernel.container.registerValue('readiness', this);
    kernel.logger.info(`readiness registry initialized (${this.capabilities.size} capabilities)`);
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  list(category?: string): Capability[] {
    const all = [...this.capabilities.values()];
    return category ? all.filter((c) => c.category === category) : all;
  }

  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  /** Update a capability's status/evidence (used as the platform matures). */
  update(id: string, status: ReadinessStatus, evidence?: string[], notes?: string): Capability {
    const c = this.capabilities.get(id);
    if (!c) throw new Error(`readiness: capability "${id}" not found`);
    const updated: Capability = {
      ...c,
      status,
      updatedAt: Date.now(),
      ...(evidence ? { evidence } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
    this.capabilities.set(id, updated);
    void this.api.bus.emit(ReadinessEvents.CapabilityUpdated, { id, status });
    return updated;
  }

  summary(): ReadinessSummary {
    const byStatus: Record<string, number> = {};
    let productionReady = 0;
    let notImplemented = 0;
    for (const c of this.capabilities.values()) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      if (c.status === 'PRODUCTION_READY') productionReady += 1;
      if (c.status === 'NOT_IMPLEMENTED') notImplemented += 1;
    }
    const overall = productionReady > 0 && notImplemented === 0
      ? 'PRODUCTION_READY'
      : 'ALPHA — core implemented & tested; NOT production-ready (see byStatus)';
    return { total: this.capabilities.size, byStatus, productionReady, notImplemented, overall };
  }
}
