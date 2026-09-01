import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { PermanenceFabricService } from './permanence-fabric-service.js';

/**
 * JQPF: classical public-key identity, signed reference, lineage, and runtime
 * continuity metadata. It does not provision, migrate, execute, discover over
 * a network, or guarantee permanent availability of any JATA Qi runtime.
 */
export class PermanenceFabricModule implements IModule {
  readonly id = 'permanence-fabric';
  readonly tags = ['jqb', 'identity', 'permanence', 'runtime', 'lineage', 'governance'] as const;
  readonly dependsOn = ['storage'] as const;
  private readonly service = new PermanenceFabricService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('permanence-fabric.service', this.service);
    kernel.container.registerValue('permanence-fabric', this.service);
    kernel.logger.info('permanence fabric initialized (classical public-key continuity metadata; no runtime migration active)');
  }

  getService(): PermanenceFabricService {
    return this.service;
  }
}
