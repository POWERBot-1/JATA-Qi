import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { TemporalEngineService } from './temporal-engine-service.js';

/** JQB temporal model; stores timelines/scenarios but makes no future prediction claim. */
export class TemporalEngineModule implements IModule {
  readonly id = 'temporal-engine';
  readonly tags = ['jqb', 'temporal', 'replay', 'scenario'] as const;
  readonly dependsOn = ['storage', 'world-model'] as const;
  private readonly service = new TemporalEngineService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('temporal-engine.service', this.service);
    kernel.container.registerValue('temporal-engine', this.service);
    kernel.logger.info('temporal engine initialized (observed timelines and simulated scenarios)');
  }

  getService(): TemporalEngineService {
    return this.service;
  }
}
