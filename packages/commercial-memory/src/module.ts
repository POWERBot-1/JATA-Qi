import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialMemoryService } from './commercial-memory-service.js';

/** Tenant-bound commercial memory and attribution graph; no cross-tenant graph bridge is enabled. */
export class CommercialMemoryModule implements IModule {
  readonly id = 'commercial-memory';
  readonly tags = ['commercial', 'memory', 'learning', 'attribution', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane'] as const;
  private readonly service = new CommercialMemoryService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-memory.service', this.service);
    kernel.container.registerValue('commercial-memory', this.service);
    kernel.logger.info('commercial memory initialized (tenant-isolated event and outcome memory)');
  }

  async stop(_kernel: KernelApi): Promise<void> {
    this.service.stop();
  }

  getService(): CommercialMemoryService {
    return this.service;
  }
}
