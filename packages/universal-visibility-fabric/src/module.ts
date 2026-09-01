import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { UniversalVisibilityFabricService } from './visibility-fabric-service.js';

/** Universal Visibility Fabric module; it stores and governs assets but never publishes by itself. */
export class UniversalVisibilityFabricModule implements IModule {
  readonly id = 'universal-visibility-fabric';
  readonly tags = ['commercial', 'visibility', 'creative', 'claims', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane'] as const;
  private readonly service = new UniversalVisibilityFabricService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('universal-visibility-fabric.service', this.service);
    kernel.container.registerValue('universal-visibility-fabric', this.service);
    kernel.logger.info('universal visibility fabric initialized (asset registry only; no publisher active)');
  }

  getService(): UniversalVisibilityFabricService {
    return this.service;
  }
}
