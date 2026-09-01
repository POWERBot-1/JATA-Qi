import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { WorldModelService } from './world-model-service.js';

/** JQB World Model; tenant-bound symbolic/provenance layer with no external action capability. */
export class WorldModelModule implements IModule {
  readonly id = 'world-model';
  readonly tags = ['jqb', 'world-model', 'knowledge', 'causal', 'temporal'] as const;
  readonly dependsOn = ['storage'] as const;
  private readonly service = new WorldModelService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('world-model.service', this.service);
    kernel.container.registerValue('world-model', this.service);
    kernel.logger.info('world model initialized (tenant-bound symbolic/provenance state)');
  }

  getService(): WorldModelService {
    return this.service;
  }
}
